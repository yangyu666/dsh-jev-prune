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

const TOKEN_PIECES = /[A-Za-z]+|\d+|[^\sA-Za-z\d]/g

/** 词 = 1 + ⌊(len-1)/6⌋；数字串 = len/2；其他字符（含中文）各 0.9。 */
export function estimateTokens(text) {
  let total = 0
  for (const match of String(text).matchAll(TOKEN_PIECES)) {
    const piece = match[0]
    const code = piece.charCodeAt(0)
    if (code >= 48 && code <= 57) total += piece.length / 2
    else if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122)) {
      total += 1 + Math.floor((piece.length - 1) / 6)
    } else total += 0.9
  }
  return Math.ceil(total)
}

export class JevError extends Error {
  constructor(message, options) {
    super(message, options)
    this.name = 'JevError'
  }
}

export class JevClient {
  /**
   * @param {object} params
   * @param {string} params.apiKey - TypeSafe key；空则不发起请求（插件退化为不干预）
   * @param {string} [params.model]
   * @param {string} [params.baseUrl]
   * @param {number} [params.timeoutMs]
   * @param {typeof fetch} [params.fetchImpl]
   */
  constructor({ apiKey, model = DEFAULT_JEV_MODEL, baseUrl = SYSTEM_ONE_URL, timeoutMs = 60000, fetchImpl } = {}) {
    this.apiKey = typeof apiKey === 'string' ? apiKey.trim() : ''
    this.model = model
    this.baseUrl = baseUrl
    this.timeoutMs = timeoutMs
    this.fetchImpl = fetchImpl ?? globalThis.fetch
    this.requests = 0
    this.usage = { input_tokens: 0, output_tokens: 0 }
    this.lastError = ''
  }

  get ready() {
    return this.apiKey.length > 0 && typeof this.fetchImpl === 'function'
  }

  /**
   * 一次请求问完一批 noul 问题。
   * @param {string} state 会话状态文本
   * @param {Record<string,string>} questions 问题 id → 待判定陈述
   * @returns {Promise<Record<string, number>>} 问题 id → P(陈述成立)
   */
  async ask(state, questions) {
    const ids = Object.keys(questions)
    if (!this.ready || ids.length === 0) return {}
    const payload = {
      model: this.model,
      state,
      questions: Object.fromEntries(ids.map((id) => [id, { type: 'noul', instructions: questions[id] }])),
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    let body
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
      if (!response.ok) throw new JevError(`Jev 请求失败 (${response.status}): ${text.slice(0, 200)}`)
      body = JSON.parse(text)
    } finally {
      clearTimeout(timer)
    }
    this.requests += 1
    const usage = body?.usage ?? {}
    this.usage.input_tokens += Number(usage.input_tokens ?? 0)
    this.usage.output_tokens += Number(usage.output_tokens ?? 0)

    const answers = body?.answers
    if (answers == null || typeof answers !== 'object') throw new JevError('Jev 响应缺少 answers')
    const out = {}
    for (const id of ids) {
      const value = answers[id]?.noul
      if (typeof value !== 'number' || !Number.isFinite(value)) continue
      out[id] = value
    }
    return out
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
