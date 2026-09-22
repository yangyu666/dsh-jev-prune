/**
 * Jev 判定客户端 + token 估算。纯 Node，无 DSH 依赖。
 *
 * 关键设计（来自 dsh-compact 的实测结论）：
 * · **用 Jev 的结构化批量接口**（一次请求问 N 题、返回 问题→noul 概率），
 *   不要用 chat 模型模拟——chat 模型的概率只能从"某个被采样位置"读，会被采样前缀污染。
 * · token 估算沿用上游 fast-jev-compaction 的逐词校正算法（对过真实 usage，偏保守）。
 * · 概率永远只从 `answers[name].noul` 读，绝不采信自报文本。
 */

export const SYSTEM_ONE_URL = 'https://api.typesafe.ai/v1/systemone'
export const DEFAULT_JEV_MODEL = 'jev-latest'

/**
 * token 估算：用逐词校正算法，常数经真实 BPE（gpt-tokenizer）标定过。
 *
 * 为什么不能"差不多就行"（issue #33）：这个值喂给两个门。
 *   · `receiptMaxRatio` 用 `estimateTokens(receipt)` 与真实 `shadowedTokens` 比，
 *     估偏大 → 门过严 → 该压的不压；估偏小 → 门过松 → 回执可能比原文还大。
 *   · `maxRequestTokens` 用它切批，估偏小会让请求超服务端上限被拒。
 * 所以方向性很重要，而旧实现是**系统性偏大**（实测纯英文 +37%、路径 +44%）——
 * 也就是把两层的门都收紧了，与"尽量多省上下文"的意图相反。
 *
 * 标定方法：拿 22 组样本（英文散文/驼峰长词/JSON/Windows 与 Unix 路径/Git diff/
 * 中文散文/中英混合/代码块/日志/纯符号/十六进制/表格行/单字/空白）跑 gpt-tokenizer，
 * 对 7 个常数做网格搜索，目标取"拟合集 + 留出集"加权 MAE 最小（防过拟合）。
 * 结果：全集平均绝对偏差 20.5% → **10.7%**，留出集 20.5% → **14.4%**，
 * 整体偏置从 +11% 收到 −0.3%（旧实现偏大，新实现基本无偏）。
 *
 * 各常数的含义（都来自标定，不要凭直觉改）：
 *   · 英文词 ≤ 6 字母算 0.9 个 token（BPE 里常见词基本是 1 片，前导空格并入词所以取 <1），
 *     超出部分每字母 0.16 片（长标识符/驼峰名才真的会被切碎）
 *   · 数字串按 1.8 个/片（BPE 对数字是 1~3 位一组）
 *   · CJK 每字 1.0 片（现代 BPE 对中文接近 1 字 1 片）
 *   · 符号：单独出现算 1.0 片，成串时 0.65 片/字符（`===` 这种会被合并）
 *   · 空白不计（BPE 的前导空格附着在前一个词上，已由"词"那一项覆盖）
 */
const TOKEN_PIECES = /[A-Za-z]+|\d+|[^\sA-Za-z\d]+/g

/** 标定出的常数（见上方说明；改动需重跑标定脚本，不要手调）。 */
export const TOKEN_ESTIMATE_CONSTANTS = {
  wordShort: 0.9,
  wordFree: 6,
  wordSlope: 0.16,
  digitDiv: 1.8,
  cjkWeight: 1,
  symSingle: 1,
  symRunSlope: 0.65,
}

export function estimateTokens(text) {
  const c = TOKEN_ESTIMATE_CONSTANTS
  const source = String(text)
  // 空串必须返回 0（沿用旧契约；下游拿它做比例计算时会单独护零）
  if (source.length === 0) return 0
  let total = 0
  for (const match of source.matchAll(TOKEN_PIECES)) {
    const piece = match[0]
    const code = piece.charCodeAt(0)
    // 数字串：按固定位数分组
    if (code >= 48 && code <= 57) {
      total += piece.length / c.digitDiv
      continue
    }
    // 拉丁词：短词按 1 片计，超出部分按斜率累加
    if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122)) {
      total += piece.length <= c.wordFree
        ? c.wordShort
        : c.wordShort + (piece.length - c.wordFree) * c.wordSlope
      continue
    }
    // 纯 CJK 串：逐字计
    let cjk = 0
    for (const ch of piece) {
      const cc = ch.charCodeAt(0)
      if (cc >= 0x4e00 && cc <= 0x9fff) cjk += 1
    }
    if (cjk === piece.length) {
      total += piece.length * c.cjkWeight
      continue
    }
    // 其余符号串：单个按 1 片，成串会被 BPE 合并
    total += Math.max(c.symSingle, piece.length * c.symRunSlope)
  }
  // 非空但全是空白时 total 可能是 0；下游会拿它当除数，兜成 1
  return Math.max(1, Math.ceil(total))
}

export class JevError extends Error {
  constructor(message, options) {
    super(message, options)
    this.name = 'JevError'
    /** HTTP 状态码（有的话），用于判断能不能重试 */
    this.status = options?.status ?? null
    /** 是否值得重试（网络抖动 / 5xx / 429 值得；4xx 与响应形状错误不值得） */
    this.retryable = options?.retryable ?? false
  }
}

/**
 * 可被中断的等待（重试退避用）。signal 一旦 abort 就立刻结束等待，
 * 不让插件在用户已经走开的情况下还空转着等下一次重试。
 * @param {number} ms
 * @param {AbortSignal} [signal]
 */
function sleep(ms, signal) {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms)
    function done() {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    signal?.addEventListener('abort', done, { once: true })
  })
}

/**
 * 哪些失败值得重试（issue #34）：
 *   · 网络层异常（fetch 抛错、超时 abort）—— 值得，抖动是常态
 *   · 429 / 5xx —— 值得，服务端暂时不可用
 *   · 其他 4xx（401 密钥错 / 400 请求本身有问题）—— 不值得，重试只是浪费时间和额度
 *   · 响应形状不对（缺 answers）—— 不值得，重试大概率还是同一份坏响应
 */
function isRetryableStatus(status) {
  return status === 429 || (status >= 500 && status <= 599)
}

export class JevClient {
  /**
   * @param {object} params
   * @param {string} params.apiKey - TypeSafe key；空则不发起请求（插件退化为不干预）
   * @param {string} [params.model]
   * @param {string} [params.baseUrl]
   * @param {number} [params.timeoutMs]
   * @param {number} [params.maxRetries] - 单次 ask 内最多重试几次（默认 2，即最多 3 次尝试）
   * @param {number} [params.retryBaseMs] - 退避基数（指数退避，默认 300ms）
   * @param {typeof fetch} [params.fetchImpl]
   */
  constructor({
    apiKey,
    model = DEFAULT_JEV_MODEL,
    baseUrl = SYSTEM_ONE_URL,
    timeoutMs = 60000,
    maxRetries = 2,
    retryBaseMs = 300,
    fetchImpl,
  } = {}) {
    this.apiKey = typeof apiKey === 'string' ? apiKey.trim() : ''
    this.model = model
    this.baseUrl = baseUrl
    this.timeoutMs = timeoutMs
    this.maxRetries = Number.isFinite(maxRetries) && maxRetries >= 0 ? Math.floor(maxRetries) : 2
    this.retryBaseMs = Number.isFinite(retryBaseMs) && retryBaseMs >= 0 ? retryBaseMs : 300
    this.fetchImpl = fetchImpl ?? globalThis.fetch
    this.requests = 0
    this.retries = 0
    this.usage = { input_tokens: 0, output_tokens: 0 }
    this.lastError = ''
  }

  get ready() {
    return this.apiKey.length > 0 && typeof this.fetchImpl === 'function'
  }

  /**
   * 单次 HTTP 尝试（不含重试）。把上一次的 AbortController 完整回收后再抛错。
   * @returns {Promise<object>} 解析后的响应体
   */
  async #attempt(state, questions, ids, options) {
    const payload = {
      model: this.model,
      state,
      questions: Object.fromEntries(ids.map((id) => [id, { type: 'noul', instructions: questions[id] }])),
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    const onAbort = () => controller.abort()
    options.signal?.addEventListener('abort', onAbort, { once: true })
    try {
      const response = await this.fetchImpl(this.baseUrl, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      })
      const text = await response.text()
      if (!response.ok) {
        throw new JevError(`Jev 请求失败 (${response.status}): ${text.slice(0, 200)}`, {
          status: response.status,
          retryable: isRetryableStatus(response.status),
        })
      }
      return JSON.parse(text)
    } catch (error) {
      // fetch 自身抛错（DNS / 连接重置 / 超时 abort）——网络层，值得重试。
      // 注意要先排除"外部 signal 已 abort"：那是用户主动中断，不该重试。
      if (error instanceof JevError) throw error
      if (options.signal?.aborted) {
        throw new JevError('判定已被中断（signal 已 abort）', { retryable: false })
      }
      const timedOut = controller.signal.aborted
      throw new JevError(
        timedOut ? `Jev 请求超时（${this.timeoutMs}ms）` : `Jev 请求网络异常：${error?.message ?? String(error)}`,
        { retryable: true },
      )
    } finally {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
    }
  }

  /**
   * 一次请求问完一批 noul 问题。
   *
   * 重试语义（issue #34）：旧实现单次失败就丢掉**整轮判定**——一次网络抖动
   * 会让本次 pass 的所有候选都没有概率，两层随即静默不动。
   * 现在对可重试失败做指数退避重试（默认 2 次，共 3 次尝试），
   * 且每次尝试都重新检查外部 signal（用户中断后不再重试）。
   *
   * @param {string} state 会话状态文本
   * @param {Record<string,string>} questions 问题 id → 待判定陈述
   * @param {{signal?:AbortSignal}} [options] 外部中断信号（issue #9：此前判定请求
   *   不接收 agent 的 signal，宿主/用户中断后请求继续占连接、可能继续计费）
   * @returns {Promise<Record<string, number>>} 问题 id → P(陈述成立)
   */
  async ask(state, questions, options = {}) {
    const ids = Object.keys(questions)
    if (!this.ready || ids.length === 0) return {}
    if (options.signal?.aborted) throw new JevError('判定已被中断（signal 已 abort）')

    let lastError = null
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      if (options.signal?.aborted) throw new JevError('判定已被中断（signal 已 abort）')
      try {
        const body = await this.#attempt(state, questions, ids, options)
        this.requests += 1
        const usage = body?.usage ?? {}
        this.usage.input_tokens += Number(usage.input_tokens ?? 0)
        this.usage.output_tokens += Number(usage.output_tokens ?? 0)

        const answers = body?.answers
        // 形状错误不重试：换一次大概率还是坏响应，不如如实抛出去让上层记一笔
        if (answers == null || typeof answers !== 'object') throw new JevError('Jev 响应缺少 answers')
        const out = {}
        for (const id of ids) {
          const value = answers[id]?.noul
          if (typeof value !== 'number' || !Number.isFinite(value)) continue
          out[id] = value
        }
        return out
      } catch (error) {
        lastError = error
        const retryable = error instanceof JevError ? error.retryable : true
        if (!retryable || attempt === this.maxRetries || options.signal?.aborted) break
        this.retries += 1
        // 指数退避；被中断时立即结束等待（不白等）
        await sleep(this.retryBaseMs * 2 ** attempt, options.signal)
      }
    }
    this.lastError = lastError?.message ?? String(lastError)
    throw lastError ?? new JevError('Jev 请求失败（未知原因）')
  }

  /**
   * 把问题按 state 占用切成能装进单次请求的批。
   * @param {string} state
   * @param {Record<string,string>} questions
   * @param {{maxRequestTokens:number, overheadTokens:number}} limits
   * @returns {Array<Record<string,string>>}
   */
  batch(state, questions, limits) {
    const stateTokens = estimateTokens(state)
    const budget = limits.maxRequestTokens - stateTokens - (limits.overheadTokens ?? 40)
    const batches = []
    let current = {}
    let currentTokens = 0
    for (const [id, text] of Object.entries(questions)) {
      const cost = estimateTokens(JSON.stringify({ [id]: { type: 'noul', instructions: text } }))
      if (Object.keys(current).length > 0 && currentTokens + cost > budget) {
        batches.push(current)
        current = {}
        currentTokens = 0
      }
      if (Object.keys(current).length === 0 && cost > budget) continue // 单题都装不下，跳过（不抛错）
      current[id] = text
      currentTokens += cost
    }
    if (Object.keys(current).length > 0) batches.push(current)
    return batches
  }
}
