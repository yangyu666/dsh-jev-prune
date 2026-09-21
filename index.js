/**
 * dsh-jev-prune —— 用 Jev 判断驱动 DSH 的上下文压缩。**两层。**
 *
 * ── 第一层：工具结果裁剪（接管 `ctx.toolResultPruner.pruneSession`）
 * DSH 自带规则：内容超过 thresholdChars 就掐掉中间、留头尾。纯体积、零语义。
 *   Jev 说「还要」      → **不裁**（哪怕它很大 —— DSH 现在会误裁这类）
 *   Jev 说「过期了」    → **裁**（哪怕它不大 —— DSH 现在完全不碰这类，纯增量）
 *   没有判定            → 退回 DSH 原来的按体积裁决（安全兜底）
 *   落在最近 preserveRecent 个节点里 / 永不裁剪工具 → 一律不碰
 *
 * ── 第二层：整对调用的「回执压缩」（接管 `ctx.compaction.summarize` + `compactRegion`）
 * DSH 自带做法：让主模型读原始历史、**写一段摘要**顶替被压缩的区间。摘要会幻觉。
 * 我们改成注入一段**确定性回执** —— 工具名、命令、路径、输出字符数、seq 全部由代码算出，
 * **不可能包含模型推断**。代价是它不解释、只开收据（原始事件仍在会话日志里，可恢复）。
 * 门控（满足全部才动）：两轴相对分位取交集 + 工具白名单 + 证据守卫 + 最近区保护 + 文本长度门控。
 *
 * 判定时机：`agent/pre-step` 里**异步**预判好、缓存按 seq；
 * 因为 `pruneSession(session)` 是**同步**方法，里面不能 await；
 * 而 `compactRegion` 是异步的、且要求处在打开的 turn 内（`agent/pre-step` 满足）。
 *
 * shadow-price 协议（compaction/prune 事件 + tool/result replace）与 DSH 自带实现逐字一致，
 * 保证纯消费者能按同一套账本扣减 token。第二层则完全交给 `compactRegion` 的
 * `compaction/summary` + 替换 user/message 那套既有协议，不自己 append。
 *
 * @module dsh-jev-prune
 */

import { writeFileSync } from 'node:fs'

import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

import { JevClient, estimateTokens } from './jev.js'
import { JEV_PRUNE_MARKER, parseLimit, pruneSessionWithJev } from './prune.js'
import {
  DEFAULT_COMPACT_TOOLS,
  DEFAULT_EVIDENCE_PATTERNS,
  DEFAULT_NEVER_COMPACT_TOOLS,
  DSH_READONLY_TOOLS,
  RECEIPT_MARKER,
  computeEligibleSeqs,
  renderReceipt,
  selectReceiptRanges,
} from './receipt.js'
import {
  STATE_CONTEXT,
  buildJevState,
  buildToolNameIndex,
  callIdOf,
  eventText,
  isCheckpointEvent,
  probeShapes,
  probeToolNames,
  questionsFor,
  recentGoal,
  selectCandidates,
  sessionEvents,
  toolNameOf,
} from './state.js'

/**
 * `freezeMessage` 来自 @deepseek-ai/dsh-llm。用**动态导入**而不是静态导入：
 * 静态导入一旦解析不到，整个插件会加载失败（连带 DSH 起不来）；
 * 动态导入失败只退化成一个浅拷贝，插件照常工作。
 */
let freezeMessageImpl = (message) => message
let freezeLoaded = false

async function loadFreeze() {
  if (freezeLoaded) return
  freezeLoaded = true
  try {
    const mod = await import('@deepseek-ai/dsh-llm')
    if (typeof mod?.freezeMessage === 'function') freezeMessageImpl = mod.freezeMessage
  } catch {
    // 保持浅拷贝兜底
  }
}

export const name = 'jev-prune'

/**
 * Cordis 的依赖声明。**这一步是整个插件能否生效的关键。**
 *
 * 实测踩过：只写 `['tools']` 时，Cordis 等到 tools 就绪就调用 apply()，
 * 而那会 `ctx.get('toolResultPruner')` 返回 null —— 服务还没注册
 * （pruner 由 base bundle 的 tool-result-pruner 条目提供）。结果插件加载成功、
 * 配置正确、installPrunerOverride 也跑了，但**静默地没接管任何东西**。
 * 这类失败在宿主日志里完全看不见，只能靠心跳文件/落盘才能发现。
 *
 * 把 pruner 也声明进来，Cordis 才会等它就绪再调 apply()。
 */
export const inject = ['tools', 'toolResultPruner']

/** 裁剪标记与裁剪机制从 prune.js 复用（那边才能被单测覆盖）。 */
export { JEV_PRUNE_MARKER }

export const Config = z.object({
  enabled: z.boolean().default(true),
  /** TypeSafe key；留空则读环境变量 TYPESAFE_API_KEY */
  apiKey: z.string().default(''),
  model: z.string().default('jev-latest'),
  baseUrl: z.string().default('https://api.typesafe.ai/v1/systemone'),
  /** P(保留) ≥ 该值 → 不裁 */
  keepThreshold: z.number().default(0.5),
  /** 最近 N 个 surface 节点永不裁剪（含正在进行的工具调用） */
  preserveRecent: z.number().default(4),
  /** 裁到多少字符就够：留头 + 标记 + 留尾 */
  headChars: z.number().default(600),
  tailChars: z.number().default(200),
  /** 小于该长度的结果即使 Jev 说过期也不裁（省不到东西、还丢信息） */
  minCharsToPrune: z.number().default(400),
  /** 何时开始判定：pressure（上下文超软阈值才判）| always */
  judgeOn: z.string().default('pressure'),
  softLimit: z.string().default('55%'),
  /** state 预算（Jev 上限 32k） */
  maxStateTokens: z.number().default(25000),
  maxRequestTokens: z.number().default(30000),
  textHead: z.number().default(400),
  textTail: z.number().default(150),
  inputChars: z.number().default(300),
  judgeTimeoutMs: z.number().default(60000),
  /** 只判定不裁剪，用来先观察行为 */
  dryRun: z.boolean().default(false),
  /** 提问措辞：goal（默认，实测区分度最高）| legacy（上游原味，几乎无区分度）| contrast | consequence */
  wording: z.string().default('goal'),
  /** state 历史最少保留的行数（避免为了塞进预算把上下文丢空） */
  minHistoryLines: z.number().default(8),
  /** 结果永不裁剪的工具 */
  neverPruneTools: z.array(z.string()).default(['Edit', 'Write', 'MultiEdit', 'ApplyPatch']),

  // ---------------------------------------------------------------- 第二层：回执压缩
  /** 第二层总开关 */
  compactReceipts: z.boolean().default(true),
  /** 何时做整对移出：pressure（到软阈值才做）| always | off */
  compactOn: z.string().default('pressure'),
  /** 第二层的压力门（比第一层保守：整对删除比截断风险大） */
  compactSoftLimit: z.string().default('70%'),
  /**
   * 门控模式：relative（默认）| absolute。
   * **Jev 必须用 relative** —— 实测它的两轴概率都落在 0.05~0.37 的窄带里，
   * 固定阈值 0.5 会把全部候选判成"可丢"（见 probe_effect.js 与 README）。
   * absolute 只留给换判断后端（例如本地分类器）时用。
   */
  compactMode: z.string().default('relative'),
  /** relative 模式：两轴各取尾部这个比例，**取交集** */
  compactQuantile: z.number().default(0.34),
  /** relative 模式需要的最小样本量；小于它则不做整对移出（排序在小样本上没有意义） */
  minCandidatesForRelative: z.number().default(4),
  /** absolute 模式用的阈值 */
  compactThreshold: z.number().default(0.5),
  /**
   * 允许整对移出的工具（白名单）。**默认空 = 不设白名单，只用黑名单。**
   *
   * 为什么默认不用白名单（实测教训）：我最初把 `Read`/`Grep`/`Bash` 这套 PascalCase 名字当默认白名单，
   * 而真实 DSH 的工具名是 **`pwsh` / `read` / `glob`**（全小写、shell 叫 pwsh）——
   * **命中 0/11，第二层静默地永不触发**（加载成功、接管成功、判定在跑，只是什么都没做）。
   * 白名单失效的后果是"功能静默死亡"，黑名单失效的后果只是"少保护"（还有副作用轴/证据守卫/最近区兜着）。
   * 想收紧就配上 `DSH_READONLY_TOOLS`（已从会话日志取证的真实名字）或你自己的名字。
   * 比较时做归一化（小写 + 去掉 `_`/`-`），所以 `MultiEdit` 与 `multi_edit` 等价。
   */
  compactTools: z.array(z.string()).default(DEFAULT_COMPACT_TOOLS),
  /** 永不整对移出的工具（改写型调用是承重信息） */
  neverCompactTools: z.array(z.string()).default(DEFAULT_NEVER_COMPACT_TOOLS),
  /** 证据守卫：结果里命中这些词就不整对移出（仍允许第一层截断） */
  evidenceGuard: z.boolean().default(true),
  evidencePatterns: z.array(z.string()).default(DEFAULT_EVIDENCE_PATTERNS),
  /**
   * assistant 消息文本（含 reasoning 块）超过这个长度的步骤不整对移出——它在推理，不是纯探查。
   * 默认值是按真实会话标定的：实测 DeepSeek 每步 text 0~287 字符、reasoning 0~1207 字符，
   * 早先的 240 会把绝大多数正常步骤拦掉（第二层因此在自然压力下 0 段可压）。
   */
  maxStepTextChars: z.number().default(1200),
  /** 一段范围至少要能省下这么多字符，才值得开一次压缩事务 */
  compactMinChars: z.number().default(2000),
  /** 回执必须是原内容 token 的这个比例以下才动手（服务端硬要求 <1.0，我们更严） */
  receiptMaxRatio: z.number().default(0.5),
  /** 一次 pass 最多做几次压缩事务 */
  maxCompactionsPerPass: z.number().default(1),
  /** 回执里每行入参截断到多少字符 */
  receiptArgChars: z.number().default(120),

  /**
   * 心跳文件路径。非空时，插件会在加载完成、每次判定 pass、每次裁剪后写一份 JSON 快照。
   * 用途有两个：①运维可观测（宿主会吞掉插件的 logger 输出，只能靠落盘看状态）
   * ②**验证接管是否真的发生**——这是唯一能从外部确证"插件在真实宿主里起作用"的手段。
   */
  heartbeatFile: z.string().default(''),
  logLevel: z.string().default('info'),
})

export function resolveConfig(config = {}) {
  return {
    ...config,
    enabled: config.enabled ?? true,
    apiKey: config.apiKey ?? '',
    model: config.model ?? 'jev-latest',
    preserveRecent: config.preserveRecent ?? 4,
    keepThreshold: config.keepThreshold ?? 0.5,
    headChars: config.headChars ?? 600,
    tailChars: config.tailChars ?? 200,
    minCharsToPrune: config.minCharsToPrune ?? 400,
    judgeOn: config.judgeOn ?? 'pressure',
    softLimit: config.softLimit ?? '55%',
    neverPruneTools: config.neverPruneTools ?? ['Edit', 'Write', 'MultiEdit', 'ApplyPatch'],
    compactReceipts: config.compactReceipts ?? true,
    compactOn: config.compactOn ?? 'pressure',
    compactSoftLimit: config.compactSoftLimit ?? '70%',
    compactMode: config.compactMode ?? 'relative',
    compactQuantile: config.compactQuantile ?? 0.34,
    minCandidatesForRelative: config.minCandidatesForRelative ?? 4,
    compactThreshold: config.compactThreshold ?? 0.5,
    compactTools: config.compactTools ?? DEFAULT_COMPACT_TOOLS,
    neverCompactTools: config.neverCompactTools ?? DEFAULT_NEVER_COMPACT_TOOLS,
    evidenceGuard: config.evidenceGuard ?? true,
    evidencePatterns: config.evidencePatterns ?? DEFAULT_EVIDENCE_PATTERNS,
    maxStepTextChars: config.maxStepTextChars ?? 1200,
    compactMinChars: config.compactMinChars ?? 2000,
    receiptMaxRatio: config.receiptMaxRatio ?? 0.5,
    maxCompactionsPerPass: config.maxCompactionsPerPass ?? 1,
    receiptArgChars: config.receiptArgChars ?? 120,
    dryRun: config.dryRun ?? false,
    wording: config.wording ?? 'goal',
    minHistoryLines: config.minHistoryLines ?? 8,
    heartbeatFile: config.heartbeatFile ?? '',
    logLevel: config.logLevel ?? 'info',
  }
}

// ------------------------------------------------------------------ 主插件

/**
 * @param {object} ctx Cordis 上下文
 * @param {object} config 插件配置（schemastery 已校验）
 * @param {object} [deps] 可选的依赖注入，仅用于测试：`{ judge }` 可替换真实的 JevClient。
 *   DSH 只传前两个参数，所以加第三个是向后兼容的；但有了它，
 *   "预置一组概率 → 断言裁决结果"就能跑在**真实的 apply + 真实的 pruneSession 接管**上，
 *   而不是另写一份模拟逻辑。
 */
export function apply(ctx, config, deps = {}) {
  const cfg = resolveConfig(config)
  if (!cfg.enabled) return

  void loadFreeze() // 异步取 freezeMessage，失败就退化成浅拷贝

  const envKey = typeof process !== 'undefined' ? process.env?.TYPESAFE_API_KEY : undefined
  const judge = deps.judge ?? new JevClient({
    apiKey: cfg.apiKey || envKey || '',
    model: cfg.model,
    baseUrl: cfg.baseUrl,
    timeoutMs: cfg.judgeTimeoutMs,
  })

  /** session → Map(结果 seq → {keep, prob, effectProb, chars, tool}) */
  const decisions = new WeakMap()
  const stats = {
    judged: 0,
    requests: 0,
    prunedByJev: 0,
    prunedByVolume: 0,
    savedChars: 0,
    keptByJev: 0,
    skipped: 0,
    errors: 0,
    lastNote: '',
    // 第二层
    compactions: 0,
    compactedSeqs: 0,
    compactedChars: 0,
    receiptSummaries: 0,
    compactSkipped: 0,
    lastCompactNote: '',
  }

  const log = (level, message) => {
    if (cfg.logLevel === 'silent') return
    if (level === 'debug' && cfg.logLevel !== 'debug') return
    const line = `[jev-prune] ${message}`
    if (typeof ctx.logger?.info === 'function') ctx.logger.info(line)
    else console.error(line) // 走 stderr，绝不污染 stdout
  }

  const decisionsOf = (session) => {
    let map = decisions.get(session)
    if (map == null) {
      map = new Map()
      decisions.set(session, map)
    }
    return map
  }

  /**
   * 描述事件访问的真实形态。
   *
   * 为什么需要：实测活的 DSH 会话对象上 **`session.events` 是 undefined**，
   * 导致之前所有 `session.events ?? []` 都拿到空数组——工具名索引建出 0 条、
   * 任务目标也丢了。这里同时报"原始访问器"与"回退链解析结果"两者，
   * 好一眼看清是哪一种情况。
   */
  function describeEvents(session) {
    const raw = session?.events
    const resolved = sessionEvents(session)
    const first = resolved?.[0]
    return {
      raw: {
        isArray: Array.isArray(raw),
        ctor: raw == null ? 'null' : (raw.constructor?.name ?? typeof raw),
      },
      resolved: {
        isArray: Array.isArray(resolved),
        length: resolved.length,
        firstKind: first == null ? 'null' : (first.type ?? typeof first),
      },
      hasEventAt: typeof session?.eventAt === 'function',
    }
  }

  // ---------------------------------------------------------- 心跳（可观测性）
  // 宿主会吞掉插件的 logger 输出，所以状态要落盘才能从外部观察。
  // 这同时是"接管是否真的发生"的唯一外部证据。
  const bootedAt = new Date().toISOString()
  let takeover = { attempted: false, installed: false, reason: 'not yet' }
  let summaryHook = { attempted: false, installed: false, reason: 'not yet' }
  /**
   * 心跳是**合并**不是覆写。
   * 之前每次调用都整份重写文件，而 pre-step 里 judgePass 在 compactPass 之后跑，
   * 于是 compactPass 刚写下的 lastCompact 立刻被 judgePass 的 lastJudgePass 冲掉——
   * 正好把"第二层为什么没触发"这个最关键的证据丢了。现在各调用方只更新自己的键。
   */
  const heartbeatState = {}
  function writeHeartbeat(extra = {}) {
    if (!cfg.heartbeatFile) return
    try {
      Object.assign(heartbeatState, extra)
      const payload = {
        plugin: name,
        bootedAt,
        now: new Date().toISOString(),
        pid: typeof process !== 'undefined' ? process.pid : null,
        judgeReady: judge.ready !== false,
        model: cfg.model,
        keepThreshold: cfg.keepThreshold,
        preserveRecent: cfg.preserveRecent,
        wording: cfg.wording,
        compact: {
          enabled: cfg.compactReceipts,
          on: cfg.compactOn,
          mode: cfg.compactMode,
          quantile: cfg.compactQuantile,
        },
        takeover,
        summaryHook,
        stats,
        ...heartbeatState,
      }
      writeFileSync(cfg.heartbeatFile, JSON.stringify(payload, null, 1), 'utf8')
    } catch (error) {
      log('debug', `心跳写入失败：${error?.message ?? String(error)}`)
    }
  }

  // ---------------------------------------------------------- 判定 pass（异步）
  async function resolveWindow(agent) {
    try {
      const header = agent.session?.requestHeader?.()?.config
      const provider = header?.provider || agent.options?.provider
      const model = header?.model || agent.options?.model
      const llm = ctx.get('llm')
      if (llm == null || !provider || !model || typeof llm.resolveModelInfo !== 'function') return null
      const info = await llm.resolveModelInfo(provider, model)
      return info?.context?.contextWindow ?? null
    } catch {
      return null
    }
  }

  async function judgePass(agent) {
    const session = agent?.session
    if (session?.surface?.nodes == null || judge.ready === false) return

    const surface = [...session.surface.nodes]
    const eventAt = (seq) => session.eventAt(seq)
    const nameByCallId = buildToolNameIndex(sessionEvents(session))
    const candidates = selectCandidates({
      surface,
      eventAt,
      events: sessionEvents(session),
      preserveRecent: cfg.preserveRecent,
      neverPruneTools: cfg.neverPruneTools,
      marker: JEV_PRUNE_MARKER,
      nameByCallId,
    })
    const cache = decisionsOf(session)
    const fresh = candidates.filter((c) => !cache.has(c.seq))
    if (fresh.length === 0) return

    // 压力门控：不到软阈值就不花 Jev 的钱
    if (cfg.judgeOn !== 'always') {
      const meter = ctx.get('tokenMeter')
      const used = typeof meter?.measure === 'function' ? (meter.measure(session)?.totalTokens ?? 0) : 0
      const windowTokens = await resolveWindow(agent)
      const limit = parseLimit(cfg.softLimit)
      const threshold = limit.kind === 'ratio'
        ? (windowTokens == null ? null : Math.floor(windowTokens * limit.value))
        : limit.value
      if (threshold != null && used < threshold) {
        stats.skipped += fresh.length
        return
      }
    }

    const goal = recentGoal(sessionEvents(session))
    const { state, fitted, stateTokens } = buildJevState({
      surface,
      eventAt,
      goal,
      context: STATE_CONTEXT,
      options: {
        textHead: cfg.textHead,
        textTail: cfg.textTail,
        maxStateTokens: cfg.maxStateTokens,
        inputChars: cfg.inputChars,
        minHistoryLines: cfg.minHistoryLines,
      },
    })
    if (!fitted) {
      log('info', `state ≈ ${stateTokens} tokens 仍超预算 ${cfg.maxStateTokens}（行数地板 ${cfg.minHistoryLines}），本批可能被服务端拒绝`)
    }
    const questions = questionsFor(fresh, cfg.wording)
    const batches = judge.batch(state, questions, {
      maxRequestTokens: cfg.maxRequestTokens,
      overheadTokens: 40,
    })

    const startRequests = judge.requests
    for (const batch of batches) {
      const answers = await judge.ask(state, batch)
      for (const candidate of fresh) {
        const prob = answers[`result_s${candidate.seq}`]
        const effectProb = answers[`effect_s${candidate.seq}`]
        if (typeof prob !== 'number' && typeof effectProb !== 'number') continue
        const previous = cache.get(candidate.seq)
        cache.set(candidate.seq, {
          keep: typeof prob === 'number' ? prob >= cfg.keepThreshold : (previous?.keep ?? true),
          prob: typeof prob === 'number' ? prob : (previous?.prob ?? null),
          effectProb: typeof effectProb === 'number' ? effectProb : (previous?.effectProb ?? null),
          chars: candidate.chars,
          tool: candidate.tool,
        })
        stats.judged += 1
      }
    }
    stats.requests += judge.requests - startRequests
    stats.lastNote = `判定 ${fresh.length} 个候选，state ≈ ${estimateTokens(state)} tokens`
    log('debug', stats.lastNote)
    writeHeartbeat({
      lastJudgePass: {
        candidates: fresh.length,
        stateTokens: estimateTokens(state),
        nameIndexSize: nameByCallId.size,
        events: describeEvents(session),
      },
    })
  }

  // ---------------------------------------------------------- 裁剪（同步）
  // 逐节点裁决逻辑放在 prune.js 里（纯函数 + 依赖注入），这样才能脱离 DSH 单测。
  // 这里只负责补齐它需要的依赖。
  function pruneViaJev(pruner, session) {
    const nameByCallId = buildToolNameIndex(sessionEvents(session))
    const out = pruneSessionWithJev({
      pruner,
      session,
      cache: decisions.get(session),
      cfg: { ...cfg, marker: JEV_PRUNE_MARKER },
      stats,
      freeze: freezeMessageImpl,
      toolNameOf: (event) => toolNameOf(event, nameByCallId),
      callIdOf,
    })
    writeHeartbeat({
      lastPrune: {
        nodes: session.surface?.nodes?.length ?? null,
        pruned: out.pruned.length,
        charsRemoved: out.charsRemoved,
        seqs: out.pruned.map((p) => p.originalSeq),
      },
    })
    return out
  }

  function installPrunerOverride() {
    if (takeover.installed) return () => {}
    takeover = { attempted: true, installed: false, reason: '' }
    const pruner = ctx.get('toolResultPruner') ?? ctx.toolResultPruner
    if (pruner == null || typeof pruner.pruneSession !== 'function') {
      takeover.reason = pruner == null
        ? 'ctx.toolResultPruner 不存在 —— 需加载 @deepseek-ai/dsh-compaction-tool-result-pruner'
        : 'pruner.pruneSession 不是函数'
      log('info', `${takeover.reason}；本次不介入（若服务稍后才就绪，会在下一次 pre-step 重试）`)
      writeHeartbeat()
      return () => {}
    }
    const originalSession = pruner.pruneSession.bind(pruner)
    pruner.pruneSession = (session) => pruneViaJev(pruner, session)
    takeover = { attempted: true, installed: true, reason: 'ok' }
    log('info', `已接管 ctx.toolResultPruner.pruneSession（keepThreshold=${cfg.keepThreshold}, preserveRecent=${cfg.preserveRecent}, dryRun=${cfg.dryRun}）`)
    writeHeartbeat()
    return () => {
      pruner.pruneSession = originalSession
    }
  }

  // ---------------------------------------------------------- 第二层：回执压缩
  //
  // 接入点：`ctx.compaction.summarize`。DSH 的压缩后端把 summarize 当**唯一的子类定制钩子**
  // （源码原话："summarize() is the sole subclass customization hook"），且 `compactRegion`
  // 内部是通过 `this.summarize(...)` **动态派发**的 —— 所以在实例上猴补丁它就够了，
  // 不需要 fork 后端、也不需要另写一个 CompactionEngine。
  //
  // 补丁只认「我们自己刚放进 pending 的那一次调用」：带 5 分钟有效期，
  // 且无论成功失败都在 finally 里清掉，避免影响别处（例如自动压缩）的摘要生成。
  const pendingReceipt = new WeakMap()

  function summaryService() {
    return ctx.get?.('compaction') ?? ctx.compaction ?? null
  }

  function installSummaryHook() {
    if (summaryHook.installed) return () => {}
    summaryHook = { attempted: true, installed: false, reason: '' }
    const compaction = summaryService()
    if (compaction == null || typeof compaction.summarize !== 'function') {
      summaryHook.reason = compaction == null
        ? 'ctx.compaction 不存在 —— 需加载 @deepseek-ai/dsh-compaction-basic'
        : 'compaction.summarize 不是函数（该压缩后端不暴露这个接入点）'
      log('info', `${summaryHook.reason}；第二层不介入`)
      writeHeartbeat()
      return () => {}
    }
    const original = compaction.summarize.bind(compaction)
    compaction.summarize = async (input, agent, signal) => {
      const entry = pendingReceipt.get(agent?.session)
      if (entry != null && Date.now() - entry.at < 5 * 60 * 1000) {
        pendingReceipt.delete(agent.session)
        stats.receiptSummaries += 1
        return {
          summary: [{ type: 'text', text: entry.text }],
          provider: 'jev-receipt',
          model: 'deterministic',
        }
      }
      return original(input, agent, signal)
    }
    summaryHook = { attempted: true, installed: true, reason: 'ok' }
    log('info', `已接管 ctx.compaction.summarize（回执模式；compactOn=${cfg.compactOn}, quantile=${cfg.compactQuantile}）`)
    writeHeartbeat()
    return () => {
      compaction.summarize = original
    }
  }

  /** 用宿主自己的 token meter 量一段 surface 跨度的 token 数。 */
  function spanTokens(agent, seqs) {
    const meter = ctx.get?.('tokenMeter')
    if (meter == null || typeof meter.measure !== 'function') return null
    try {
      const wanted = new Set(seqs)
      const nodes = meter.measure(agent.session)?.nodes ?? []
      let total = 0
      let seen = 0
      for (const node of nodes) {
        if (!wanted.has(node.seq)) continue
        total += node.tokens ?? node.heuristicTokens ?? 0
        seen += 1
      }
      return seen > 0 ? total : null
    } catch {
      return null
    }
  }

  /** 从事件里捞出 checkpoint 对应的原始文本（`jev_restore` 用）。 */
  function findCompactionRecord(session, { seq, start, end }) {
    const events = sessionEvents(session)
    if (seq != null) {
      const event = typeof session.eventAt === 'function' ? session.eventAt(seq) : events.find((e) => e.seq === seq)
      if (event?.type === 'compaction/summary') return event
      if (isCheckpointEvent(event)) {
        const id = event.data?.source?.compactionId
        return [...events].reverse().find((e) => e.type === 'compaction/summary' && e.data?.compactionId === id) ?? null
      }
    }
    return [...events].reverse().find((e) => e.type === 'compaction/summary'
      && (start == null || e.data?.shadowedRange?.start === start)
      && (end == null || e.data?.shadowedRange?.end === end)) ?? null
  }

  /**
   * 做一次回执压缩。返回结构化报告（既给工具输出，也给心跳）。
   *
   * @param {object} agent
   * @param {{force?:boolean, dryRun?:boolean, signal?:AbortSignal}} [options]
   */
  async function compactPass(agent, options = {}) {
    const force = options.force === true
    const dryRun = options.dryRun ?? cfg.dryRun
    const report = { blocked: '', verdicts: 0, eligible: [], considered: 0, selection: null, actions: [] }

    if (!cfg.compactReceipts) {
      report.blocked = 'compactReceipts=false'
      return report
    }
    if (cfg.compactOn === 'off' && !force) {
      report.blocked = 'compactOn=off'
      return report
    }
    const session = agent?.session
    if (session?.surface?.nodes == null) {
      report.blocked = '没有活动会话'
      return report
    }
    const compaction = summaryService()
    if (compaction == null || typeof compaction.compactRegion !== 'function') {
      report.blocked = 'ctx.compaction 不可用（compactRegion 缺失）'
      return report
    }
    if (!summaryHook.installed) {
      // 没有 summarize 接入点 = 我们的回执注不进去 = 会退化成模型摘要。宁可不做。
      report.blocked = `summarize 未接管（${summaryHook.reason || '未尝试'}）—— 不做第二层，避免退化成模型摘要`
      return report
    }
    if (judge.ready === false) {
      report.blocked = '未配置 TYPESAFE_API_KEY'
      return report
    }

    // 压力门：整对删除比截断风险大，所以默认阈值更高（70% vs 第一层的 55%）
    if (!force && cfg.compactOn !== 'always') {
      const used = (() => {
        const meter = ctx.get?.('tokenMeter')
        try {
          return typeof meter?.measure === 'function' ? (meter.measure(session)?.totalTokens ?? 0) : 0
        } catch {
          return 0
        }
      })()
      const limit = parseLimit(cfg.compactSoftLimit)
      const windowTokens = await resolveWindow(agent)
      const threshold = limit.kind === 'ratio'
        ? (windowTokens == null ? null : Math.floor(windowTokens * limit.value))
        : limit.value
      if (threshold == null) {
        report.blocked = '解析不出上下文窗口，保守跳过第二层'
        stats.compactSkipped += 1
        return report
      }
      if (used < threshold) {
        report.blocked = `压力不足（${used} < ${threshold}）`
        stats.compactSkipped += 1
        return report
      }
    }

    const cache = decisions.get(session)
    if (cache == null || cache.size === 0) {
      report.blocked = '还没有任何 Jev 判定（判定在 agent/pre-step 里跑）'
      stats.compactSkipped += 1
      return report
    }
    const surface = [...session.surface.nodes]
    const onSurface = new Set(surface)
    const verdicts = [...cache.entries()]
      .filter(([seq]) => onSurface.has(seq))
      .map(([seq, value]) => ({ seq, ...value }))
    report.verdicts = verdicts.length

    let eligibleSeqs
    if (cfg.compactMode === 'relative') {
      eligibleSeqs = computeEligibleSeqs(verdicts, {
        quantile: cfg.compactQuantile,
        minCandidates: cfg.minCandidatesForRelative,
      })
    } else {
      eligibleSeqs = new Set(verdicts
        .filter((v) => typeof v.prob === 'number' && v.prob < cfg.compactThreshold
          && typeof v.effectProb === 'number' && v.effectProb < cfg.compactThreshold)
        .map((v) => v.seq))
    }
    report.eligible = [...eligibleSeqs].sort((a, b) => a - b)
    if (eligibleSeqs.size === 0) {
      report.blocked = cfg.compactMode === 'relative'
        ? `两轴尾部交集为空（候选 ${verdicts.length} 个，需要 ≥${cfg.minCandidatesForRelative} 个）`
        : '没有同时低于阈值的候选'
      stats.compactSkipped += 1
      return report
    }

    const eventAt = (seq) => session.eventAt(seq)
    const { ranges, stats: selection } = selectReceiptRanges({
      surface,
      eventAt,
      cache,
      dropVerdict: (seq) => eligibleSeqs.has(seq),
      cfg,
    })
    report.selection = selection
    report.considered = ranges.length
    if (ranges.length === 0) {
      report.blocked = '没有合格的连续只读步骤段（见 selection 的各条排除计数）'
      stats.compactSkipped += 1
      return report
    }

    let done = 0
    for (const range of ranges) {
      if (done >= cfg.maxCompactionsPerPass) break
      const spanSeqs = surface.slice(range.startIdx, range.endIdx + 1)
      const receipt = renderReceipt(range, { eventAt, argChars: cfg.receiptArgChars })
      const receiptTokens = estimateTokens(receipt)
      const shadowedTokens = spanTokens(agent, spanSeqs)
      const action = {
        start: range.start,
        end: range.end,
        nodes: spanSeqs.length,
        calls: range.steps.reduce((sum, step) => sum + step.calls.length, 0),
        resultChars: range.chars,
        receiptTokens,
        shadowedTokens,
        receipt,
      }
      if (shadowedTokens != null && receiptTokens > shadowedTokens * cfg.receiptMaxRatio) {
        action.skipped = `回执 ${receiptTokens} tokens 相对原内容 ${shadowedTokens} 太大（上限 ${(cfg.receiptMaxRatio * 100).toFixed(0)}%）`
        report.actions.push(action)
        continue
      }
      if (dryRun) {
        action.dryRun = true
        report.actions.push(action)
        done += 1
        continue
      }

      pendingReceipt.set(session, { text: receipt, at: Date.now() })
      try {
        const result = await compaction.compactRegion(range.start, range.end, agent, options.signal)
        done += 1
        stats.compactions += 1
        stats.compactedSeqs += result?.shadowedSeqs?.length ?? spanSeqs.length
        stats.compactedChars += range.chars
        action.ok = true
        action.shadowedSeqs = result?.shadowedSeqs?.length ?? null
        action.compactionId = String(result?.compactionId ?? '')
        report.actions.push(action)
        // surface 已经变了，这些判定不再对应任何节点 → 从缓存里清掉
        for (const seq of spanSeqs) cache.delete(seq)
      } catch (error) {
        stats.errors += 1
        action.error = error?.message ?? String(error)
        report.actions.push(action)
      } finally {
        pendingReceipt.delete(session)
      }
    }

    const okCount = report.actions.filter((a) => a.ok).length
    const dry = report.actions.filter((a) => a.dryRun).length
    stats.lastCompactNote = okCount > 0
      ? `回执压缩 ${okCount} 段：移出 ${report.actions.reduce((sum, a) => sum + (a.nodes ?? 0), 0)} 个节点、省约 ${report.actions.reduce((sum, a) => sum + (a.resultChars ?? 0), 0)} 字符`
      : (dry > 0 ? `dry-run：${dry} 段可压（未执行）` : (report.blocked || '未执行'))
    log('debug', stats.lastCompactNote)
    writeHeartbeat({
      lastCompact: {
        blocked: report.blocked,
        eligible: report.eligible,
        selection: report.selection == null ? null : {
          skippedTail: report.selection.skippedTail,
          skippedTool: report.selection.skippedTool,
          skippedVerdict: report.selection.skippedVerdict,
          skippedGuard: report.selection.skippedGuard,
          skippedText: report.selection.skippedText,
          skippedIncomplete: report.selection.skippedIncomplete,
          skippedShort: report.selection.skippedShort,
          // 工具名如实落盘：这是"白名单没配上"唯一能自查的证据
          blockedToolNames: report.selection.blockedToolNames,
          allowedToolNames: report.selection.allowedToolNames,
        },
        actions: report.actions.map((a) => ({
          start: a.start, end: a.end, ok: a.ok ?? null, dryRun: a.dryRun ?? null,
          calls: a.calls, resultChars: a.resultChars, receiptTokens: a.receiptTokens,
          shadowedTokens: a.shadowedTokens, error: a.error ?? null, skipped: a.skipped ?? null,
        })),
      },
    })
    return report
  }

  // ---------------------------------------------------------- 装配
  ctx.effect(() => installPrunerOverride())
  ctx.effect(() => installSummaryHook())

  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    // 双保险：如果 apply() 时服务还没就绪，每次 pre-step 再试一次。
    // 依赖时序这种东西不该让插件"看起来加载成功、实际什么都没做"。
    if (!takeover.installed) installPrunerOverride()
    if (!summaryHook.installed) installSummaryHook()
    if (judge.ready === false) {
      stats.errors += 1
      stats.lastNote = '未配置 TYPESAFE_API_KEY，跳过判定'
      return next()
    }
    try {
      await judgePass(agent)
    } catch (error) {
      stats.errors += 1
      stats.lastNote = `判定失败：${error?.message ?? String(error)}`
      log('info', stats.lastNote)
    }
    try {
      await compactPass(agent, { signal })
    } catch (error) {
      stats.errors += 1
      stats.lastCompactNote = `回执压缩失败：${error?.message ?? String(error)}`
      log('info', stats.lastCompactNote)
    }
    return next()
  })

  function renderStatus(agent) {
    const session = agent?.session
    const cache = session != null ? (decisions.get(session) ?? new Map()) : new Map()
    const meter = ctx.get('tokenMeter')
    const used = session != null && typeof meter?.measure === 'function' ? (meter.measure(session)?.totalTokens ?? 0) : 0
    // 工具名索引诊断：白名单不命中时，这一行能立刻告诉你"是名字没配上"
    const nameProbe = session?.surface?.nodes != null
      ? probeToolNames({
        surface: [...session.surface.nodes],
        eventAt: (seq) => session.eventAt(seq),
        events: sessionEvents(session),
        limit: 6,
      })
      : { indexSize: 0, resolved: 0, unresolved: 0, names: [] }
    const lines = [
      `jev-prune  usage: ${used} tokens   model=${cfg.model}   ready=${judge.ready !== false}`,
      `第一层 阈值 keep≥${cfg.keepThreshold}   preserveRecent=${cfg.preserveRecent}   minChars=${cfg.minCharsToPrune}`,
      `第一层：判定 ${stats.judged} 次 / 请求 ${stats.requests} 次   Jev 保留 ${stats.keptByJev} / Jev 裁掉 ${stats.prunedByJev} / 按体积兜底裁 ${stats.prunedByVolume}`,
      `第一层：累计省下 ${stats.savedChars} 字符   压力门控跳过 ${stats.skipped} 次   错误 ${stats.errors} 次`,
      `第二层：summarize=${summaryHook.installed ? '已接管' : `未接管(${summaryHook.reason || '未尝试'})`}   `
        + `compactOn=${cfg.compactOn}   ${cfg.compactMode}${cfg.compactMode === 'relative' ? `(quantile=${cfg.compactQuantile})` : `(<${cfg.compactThreshold})`}`,
      `第二层：回执压缩 ${stats.compactions} 段 / 移出 ${stats.compactedSeqs} 节点 / 省约 ${stats.compactedChars} 字符   `
        + `回执摘要被消费 ${stats.receiptSummaries} 次   压力跳过 ${stats.compactSkipped} 次`,
      `工具名：索引 ${nameProbe.indexSize} 条，解析成功 ${nameProbe.resolved} / 失败 ${nameProbe.unresolved}   `
        + `compactTools=${cfg.compactTools.length === 0 ? '[]（只用黑名单）' : JSON.stringify(cfg.compactTools)}`,
      `本会话工具名：${nameProbe.names.length > 0 ? nameProbe.names.join(', ') : '（无）'}`,
      `session.events 形态：${JSON.stringify(describeEvents(session))}`,
      '',
      '已缓存判定（seq  tool  P(保留)  P(副作用)  字符）:',
    ]
    const rows = [...cache.entries()].sort((a, b) => a[0] - b[0])
    if (rows.length === 0) lines.push('  (空 —— 未到软阈值或还没有候选)')
    const fmt = (value) => (typeof value === 'number' ? value.toFixed(3) : ' n/a ')
    for (const [seq, item] of rows) {
      lines.push(`  s${String(seq).padStart(5)}  ${String(item.tool).padEnd(12)} `
        + `${item.keep ? '保留 ' : '裁掉 '} ${fmt(item.prob)}  ${fmt(item.effectProb)}  ${item.chars}`)
    }
    if (stats.lastNote) lines.push('', `最近（第一层）: ${stats.lastNote}`)
    if (stats.lastCompactNote) lines.push(`最近（第二层）: ${stats.lastCompactNote}`)
    return lines.join('\n')
  }

  /** 把 compactPass 的报告渲染成人可读的多行文本。 */
  function renderCompactReport(report, { dryRun }) {
    const lines = [
      `${dryRun ? 'dry-run（未执行任何压缩）' : '回执压缩 pass 完成'}`,
      `候选判定 ${report.verdicts} 个；两轴尾部交集 ${report.eligible.length} 个`
        + `${report.eligible.length > 0 ? ` → [${report.eligible.map((s) => `s${s}`).join(',')}]` : ''}`,
      `合格范围 ${report.considered} 段`,
    ]
    if (report.blocked) lines.push(`未执行：${report.blocked}`)
    if (report.selection) {
      const s = report.selection
      lines.push(`排除计数：最近区 ${s.skippedTail} / 工具不允许 ${s.skippedTool} / 判定不通过 ${s.skippedVerdict}`
        + ` / 证据守卫 ${s.skippedGuard} / 推理文本过长 ${s.skippedText}`
        + ` / 配对不完整 ${s.skippedIncomplete} / 省得太少 ${s.skippedShort}`)
      // 工具名如实列出：白名单不命中时，这里能一眼看出"是名字没配上"而不是"模型判断不对"
      const allow = Object.entries(s.allowedToolNames ?? {})
      const block = Object.entries(s.blockedToolNames ?? {})
      if (allow.length > 0) lines.push(`通过工具门的调用名：${allow.map(([n, c]) => `${n}×${c}`).join(' ')}`)
      if (block.length > 0) {
        lines.push(`被工具门拦下的调用名：${block.map(([n, c]) => `${n}×${c}`).join(' ')}`
          + `（当前 compactTools=${cfg.compactTools.length === 0 ? '[] 已放宽' : '只读白名单'}）`)
      }
      if (s.guardHits?.length > 0) {
        lines.push(`证据守卫命中：${s.guardHits.map((h) => `s${h.headSeq}(${h.matches.slice(0, 3).join('/')})`).join(' ')}`)
      }
    }
    for (const action of report.actions) {
      const head = `· s${action.start}–s${action.end}：${action.calls} 次调用，${action.nodes} 个节点，`
        + `原输出 ${action.resultChars} 字符 / ${action.shadowedTokens ?? '?'} tokens → 回执 ${action.receiptTokens} tokens`
      if (action.ok) lines.push(`${head}  ✅ 已压缩（compactionId ${action.compactionId?.slice(0, 8) ?? '?'}）`)
      else if (action.dryRun) lines.push(`${head}  （dry-run，未执行）`)
      else if (action.error) lines.push(`${head}  ❌ ${action.error}`)
      else if (action.skipped) lines.push(`${head}  ⏭ ${action.skipped}`)
    }
    const first = report.actions.find((a) => a.receipt)
    if (first != null && (dryRun || first.dryRun)) {
      lines.push('', '回执全文：', first.receipt)
    }
    return lines.join('\n')
  }

  const commands = ctx.get('commands')
  if (commands != null && typeof commands.register === 'function') {
    commands.register({
      name: 'jev',
      description: '查看 Jev 裁剪判定状态',
      async handler(invocation) {
        return { kind: 'success', text: renderStatus(invocation.agent) }
      },
    })
  }

  // 工具注册要容错：`inject: ['tools']` 在真实 DSH 里保证 ctx.tools 存在，
  // 但如果注入没成（服务缺失/被禁用），不该让整个插件加载崩掉——
  // 判断与裁剪能力本身不依赖 tools 服务。
  const toolsService = ctx.tools ?? ctx.get?.('tools')
  if (toolsService != null && typeof toolsService.register === 'function') {
    toolsService.register(defineTool({
      name: 'jev_prune_status',
      description: 'Show Jev-driven tool-result pruning status: thresholds, cached per-node judgments, and savings.',
      parameters: {},
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      async execute(_args, exec) {
        return renderStatus(exec?.agent)
      },
    }))

    toolsService.register(defineTool({
      name: 'jev_prune_now',
      description: 'Force one Jev-scored tool-result pruning pass on the current session and report what happened. Normally pruning is driven by context pressure; this triggers it explicitly so the behaviour can be inspected.',
      parameters: {},
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      async execute(_args, exec) {
        const session = exec?.agent?.session
        if (session?.surface?.nodes == null) return '没有活动会话'
        const pruner = ctx.get('toolResultPruner') ?? ctx.toolResultPruner
        if (pruner == null) return 'ctx.toolResultPruner 不可用'
        const cache = decisions.get(session) ?? new Map()
        const judgedSeqs = [...cache.entries()].map(([seq, v]) => `s${seq}:${v.keep ? '保留' : '裁'}(${v.prob.toFixed(2)})`)
        let out
        try {
          out = pruner.pruneSession(session)
        } catch (error) {
          return `裁剪失败：${error?.message ?? String(error)}`
        }
        const lines = [
          `裁剪完成：处理 ${out.pruned.length} 条，省下 ${out.charsRemoved} 字符`,
          `本会话已有判定：${judgedSeqs.length > 0 ? judgedSeqs.join('  ') : '（无）'}`,
          `累计：Jev 保留 ${stats.keptByJev} / Jev 裁掉 ${stats.prunedByJev} / 按体积兜底裁 ${stats.prunedByVolume}`,
        ]
        if (out.pruned.length > 0) {
          lines.push('逐条：')
          for (const p of out.pruned) lines.push(`  s${p.originalSeq} (${p.callId ?? '?'})  ${p.charsBefore} → ${p.charsAfter} 字符`)
        } else if (judgedSeqs.length === 0) {
          lines.push('没有任何判定，所以全部退回按体积裁决。判定发生在 agent/pre-step；若刚才是首轮，先再做一次工具调用让判定跑起来。')
        }
        return lines.join('\n')
      },
    }))

    toolsService.register(defineTool({
      name: 'jev_compact_now',
      description: 'Force one Jev-driven receipt compaction pass: pick spent read-only tool-call ranges and replace them with a deterministic receipt instead of a model-written summary. Normally driven by context pressure; this triggers it explicitly so the behaviour can be inspected. Pass dryRun to only report what would be compacted.',
      parameters: {
        dryRun: { type: 'boolean', description: 'Only report the chosen ranges and the receipt text; do not compact.' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      async execute(args, exec) {
        const agent = exec?.agent
        if (agent?.session == null) return '没有活动会话'
        const dryRun = args?.dryRun ?? cfg.dryRun
        let report
        try {
          report = await compactPass(agent, { force: true, dryRun, signal: exec?.signal })
        } catch (error) {
          return `回执压缩失败：${error?.message ?? String(error)}`
        }
        return renderCompactReport(report, { dryRun })
      },
    }))

    toolsService.register(defineTool({
      name: 'jev_restore',
      description: 'Return the original text hidden by a compaction checkpoint (read-only safety valve). The originals always stay in the session log; this surfaces them again without restoring the surface.',
      parameters: {
        seq: { type: 'integer', description: 'Checkpoint surface seq, or the seq of a compaction/summary event' },
        start: { type: 'integer', description: 'Original shadowed range start seq' },
        end: { type: 'integer', description: 'Original shadowed range end seq' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      async execute(args, exec) {
        const session = exec?.agent?.session
        if (session == null) return '没有活动会话'
        let record
        try {
          record = findCompactionRecord(session, {
            seq: args?.seq ?? null,
            start: args?.start ?? null,
            end: args?.end ?? null,
          })
        } catch (error) {
          return `查找失败：${error?.message ?? String(error)}`
        }
        if (record == null) return '没有匹配的压缩检查点（给 seq，或给 start/end，或都不给则取最近一个）'
        const range = record.data?.shadowedRange ?? {}
        const seqs = record.data?.shadowedSeqs ?? []
        const parts = [`还原 s${range.start}–s${range.end}（共 ${seqs.length} 个节点，只读，不恢复 surface）：`, '']
        for (const seq of seqs) {
          const event = session.eventAt(seq)
          if (event == null) continue
          const text = eventText(event)
          parts.push(`# s${seq} ${event.type}`, text.length > 4000 ? `${text.slice(0, 4000)}\n…（截断，原始事件仍可用 dsh 日志查看）` : text, '')
        }
        if (parts.length <= 2) parts.push('（原始事件已不在日志中 —— 会话可能被裁剪过）')
        return parts.join('\n')
      },
    }))

    toolsService.register(defineTool({
      name: 'jev_probe_shapes',
      description: 'Dump the real DSH event shapes on the current surface (types, block types, key names). Use to verify field assumptions such as tool name and callId.',
      parameters: {
        limit: { type: 'integer', description: 'Max surface nodes to inspect (default 40)' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      async execute(args, exec) {
        const session = exec?.agent?.session
        if (session?.surface?.nodes == null) return '没有活动会话'
        const surface = [...session.surface.nodes]
        const eventAt = (seq) => session.eventAt(seq)
        const lines = []
        const { rows, summary } = probeShapes(surface, eventAt, args?.limit ?? 40)
        lines.push('事件形状汇总（type | blocks | data keys | source keys  → 出现次数）:')
        for (const item of summary) lines.push(`  ${item.key}   ×${item.count}`)
        lines.push('', '逐节点:')
        for (const row of rows) {
          lines.push(`  s${row.seq}  ${row.type}  blocks=[${row.blocks.join(',')}]  data=[${row.dataKeys.join(',')}]  source=[${row.sourceKeys.join(',')}]`)
        }

        // 工具名解析取证 —— 这一段才是"白名单为什么不命中"的答案所在
        const probe = probeToolNames({ surface, eventAt, events: sessionEvents(session), limit: 12 })
        lines.push('', `工具名解析：索引 ${probe.indexSize} 条，解析成功 ${probe.resolved} / 失败 ${probe.unresolved}`)
        lines.push(`本会话出现过的工具名（来自 tool/call 事件的 data.name）：${probe.names.length > 0 ? probe.names.join(', ') : '（无）'}`)
        for (const row of probe.rows) {
          lines.push(`  s${row.seq}  callId=${row.callId ?? '?'}  解析工具名=${row.tool}`)
        }
        if (probe.unresolved > 0) {
          lines.push(`⚠️ 有 ${probe.unresolved} 条解析不出工具名 —— 这时白名单会一律拒绝，第二层将永不触发。`
            + '请把上面出现的真实工具名配进 compactTools，或把 compactTools 设为 [] 只用黑名单。')
        }
        lines.push('', `compactTools = ${JSON.stringify(cfg.compactTools)}`
          + `${cfg.compactTools.length === 0 ? '（空 = 不设白名单，只受 neverCompactTools 约束）' : ''}`)
        lines.push(`neverCompactTools = ${JSON.stringify(cfg.neverCompactTools)}（比较时归一化：小写 + 去掉 _ 与 -）`)
        lines.push('', `如想只用只读工具，可把 compactTools 配成：${JSON.stringify(DSH_READONLY_TOOLS)}`)
        return lines.join('\n')
      },
    }))
  } else {
    log('info', 'ctx.tools 不可用 —— 跳过状态/探针工具注册（判定与裁剪不受影响）')
  }

  if (judge.ready === false) {
    ctx.logger?.info?.('[jev-prune] 未配置 TYPESAFE_API_KEY —— 插件已加载但不介入裁剪')
  }
}
