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

import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

import { JevClient, estimateTokens } from './jev.js'
import { JEV_PRUNE_MARKER, isToolIn, parseLimit, pruneSessionWithJev } from './prune.js'
import {
  DEFAULT_COMPACT_TOOLS,
  DEFAULT_EVIDENCE_PATTERNS,
  DEFAULT_FLOOR_THRESHOLD,
  DEFAULT_MIN_CANDIDATES_FOR_FLOOR,
  DEFAULT_MIN_CANDIDATES_FOR_RELATIVE,
  DEFAULT_NEVER_COMPACT_TOOLS,
  DEFAULT_NEVER_PRUNE_TOOLS,
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

// ---------------------------------------------------------------- 宿主版本探测
/**
 * 探测宿主 DSH 的版本号。
 *
 * 为什么要有这个：package.json 里写明了 testedAgainst 0.1.5-rc.2，而 DSH 0.1.x 是
 * 预发布线，事件形状与服务名在 rc 之间会漂移——这是本插件最大的结构性风险。
 * 靠"人肉记得升级后重跑测试"不可靠，所以在加载时把版本读出来：
 *   · 记进心跳与状态（可观测）
 *   · major.minor 与测试版本不一致时打一次 warning（不拒绝加载——也许只是字段没变）
 */
const TESTED_DSH_VERSION = '0.1.5-rc.2'
const TESTED_DSH_SERIES = '0.1'

function detectDshVersion() {
  const readVersionAt = (path) => {
    try {
      return JSON.parse(readFileSync(path, 'utf8'))?.version ?? 'unknown'
    } catch {
      return null
    }
  }
  // 路径 ①：走 require.resolve（尊重 exports map）
  try {
    const require = createRequire(import.meta.url)
    const found = readVersionAt(require.resolve('@deepseek-ai/dsh/package.json'))
    if (found != null) return found
  } catch { /* exports 没暴露 package.json 时走路径 ② */ }
  // 路径 ②：插件通常与宿主包同级安装（<prefix>/node_modules/ 下）
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    const found = readVersionAt(join(here, '..', '@deepseek-ai', 'dsh', 'package.json'))
    if (found != null) return found
  } catch { /* 都找不到就如实报 unknown */ }
  return 'unknown'
}

const dshVersion = detectDshVersion()
const dshVersionMatches = dshVersion === 'unknown'
  ? null // 探测不到 ≠ 不匹配，不吓唬人，只如实上报
  : dshVersion.split('.').slice(0, 2).join('.') === TESTED_DSH_SERIES

/**
 * `freezeMessage` 来自 @deepseek-ai/dsh-llm。用**动态导入**而不是静态导入：
 * 静态导入一旦解析不到，整个插件会加载失败（连带 DSH 起不来）；
 * 动态导入失败只退化成一个浅拷贝，插件照常工作。
 */
let freezeMessageImpl = (message) => ({ ...message })
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

/**
 * 已废弃键的 schema 默认值。
 *
 * 为什么要把默认值提出来：宿主（cordis）会先用 `Config` schema 校验用户配置、
 * **把默认值填进去**，再把结果传给 `apply()`（见 cordis 的 `resolveConfig(runtime, config)`
 * → `Config['~standard'].validate(config).value`）。所以到了我们这里，
 * "用户没配" 与 "用户配成了默认值" 已经**不可区分** —— 两者都是 8192 / 0。
 *
 * ⇒ 这两个废弃键的告警只能靠"值 ≠ 默认值"来判断"用户是否真的显式改过"。
 * 直接判 `!= null` 会让**每一个用户、每一次运行**都被报"你配置了废弃键"（实测确认）。
 */
export const DEFAULT_VOLUME_BUDGET_THRESHOLD_CHARS = 8192
export const DEFAULT_BUDGET_MIN_CHARS = 0

export const Config = z.object({
  enabled: z.boolean().default(true),
  /** TypeSafe key；留空则读环境变量 TYPESAFE_API_KEY */
  apiKey: z.string().default(''),
  model: z.string().default('jev-latest'),
  baseUrl: z.string().default('https://api.typesafe.ai/v1/systemone'),
  /** P(保留) ≥ 该值 → 不裁（budget 模式下这是**保护上限**：达到即不进候选池） */
  keepThreshold: z.number().min(0).max(1).default(0.5),
  /** always 模式（judgeOn: 'always'）没有压力信号时的固定裁剪比例：裁掉候选池这个比例的字符增益（0.5 = 一半）。pressure 模式下由缺口自动算，与此无关。 */
  alwaysTrimRatio: z.number().min(0).max(1).default(0.5),
  /**
   * 第一层裁决模式（P0-1）：
   *   · `budget`（默认）——"**裁多少**"由**压力缺口比例**决定（ratio = (used − threshold)/window，
   *     由 judgePass 每轮自动算并缓存；预算 = ratio × 候选池总字符增益），"**裁哪些**"由 Jev 概率
   *     **排序**决定（从最低开始裁，裁到省够预算即停）；`keepThreshold` 退居保护上限。
   *   · `absolute` —— 旧行为：逐节点 `prob >= keepThreshold` 判。
   * 为什么必须换：实测 Jev 概率是**窄带**（真实会话 42/42 条低于 0.5、P50=0.13），
   * 固定 0.5 会把所有判定过的结果都判成"可裁"；而纯相对分位又会"每轮必裁固定比例"
   * （不需要压缩时也在动刀，且比例与宿主需要腾多少空间无关）。两条路都不成立，
   * 所以拆成正交的两件事：省多少 = 压力缺口，裁哪些 = Jev 排序。
   */
  keepMode: z.string().default('budget'),
  /** budget 模式小样本降级用的绝对下限（口径与第二层 floorThreshold 一致） */
  keepFloorThreshold: z.number().min(0).max(1).default(0.2),
  /** budget 模式：候选少于此数则降级为绝对下限（小样本上排序没有意义） */
  minCandidatesForBudget: z.number().min(1).default(4),
  /** @deprecated 已废弃：budget 模式改为压力分位（ratio 由 judgePass 自动算），不再错定体积规则。保留仅为向后兼容。 */
  volumeBudgetThresholdChars: z.number().min(0).default(DEFAULT_VOLUME_BUDGET_THRESHOLD_CHARS),
  /** @deprecated 已废弃：同上，保留仅为向后兼容。 */
  budgetMinChars: z.number().min(0).default(DEFAULT_BUDGET_MIN_CHARS),
  /** 值得动手的最小收益（与 sliceWithBudget 的 minGain 同口径；小于它不进候选池） */
  minGainChars: z.number().min(0).default(40),
  /** 最近 N 个 surface 节点永不裁剪（含正在进行的工具调用） */
  preserveRecent: z.number().min(0).default(4),
  /** 裁到多少字符就够：留头 + 标记 + 留尾 */
  headChars: z.number().min(0).default(600),
  tailChars: z.number().min(0).default(200),
  /** 小于该长度的结果即使 Jev 说过期也不裁（省不到东西、还丢信息） */
  minCharsToPrune: z.number().min(0).default(400),
  /** 何时开始判定：pressure（上下文超软阈值才判）| always */
  judgeOn: z.string().default('pressure'),
  softLimit: z.string().default('55%'),
  /** state 预算（Jev 上限 32k） */
  maxStateTokens: z.number().min(1).default(25000),
  maxRequestTokens: z.number().min(1).default(30000),
  textHead: z.number().min(0).default(400),
  textTail: z.number().min(0).default(150),
  inputChars: z.number().min(0).default(300),
  /**
   * state 里每个工具结果的**摘录预算**（字符，P0-2）。
   * 0 = 关闭（回到旧的 `ok, N chars (内容省略)`）。
   * 为什么需要：判断者此前只看得到体积、看不到内容——Claude 版的教训（256 条结果
   * 无一过阈值、与假评分器打平）说明盲判≈抛硬币；我们自己的 in-vivo 实测里
   * 42/42 判"过期"，被误判的正是后续修 bug 要用的那条结果。
   * 摘录内容 = 头 2 行 + 命中证据词的行（报错栈/失败断言**往往在中段**，恰是被掐掉的位置）。
   */
  resultExcerptChars: z.number().min(0).default(240),
  judgeTimeoutMs: z.number().min(1).default(60000),
  /**
   * 单次 ask 内最多重试几次（issue #34）。只对可重试失败生效：
   * 网络异常 / 超时 / 429 / 5xx。4xx 与响应形状错误立刻放弃（重试没意义）。
   * 0 = 关闭重试（退化为旧行为）。
   */
  judgeMaxRetries: z.number().min(0).default(2),
  /** 重试退避基数（ms）；实际等待为 base × 2^attempt。0 = 不等待（测试用） */
  judgeRetryBaseMs: z.number().min(0).default(300),
  /** 只判定不裁剪，用来先观察行为 */
  dryRun: z.boolean().default(false),
  /** 提问措辞：goal（默认，实测区分度最高）| legacy（上游原味，几乎无区分度）| contrast | consequence */
  wording: z.string().default('goal'),
  /** state 历史最少保留的行数（避免为了塞进预算把上下文丢空） */
  minHistoryLines: z.number().min(1).default(8),
  /** 结果永不裁剪的工具。比第二层的 neverCompactTools **窄**（见 receipt.js 的说明） */
  // 第一层只截断（可逆），所以默认只守"参数即内容"的写文件类工具；
  // 差异型编辑工具（Edit / ApplyPatch …）第一层可裁，第二层仍守。
  neverPruneTools: z.array(z.string()).default(DEFAULT_NEVER_PRUNE_TOOLS),

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
   * 固定阈值 0.5 会把全部候选判成"可丢"（开发期实测，数据未随仓库提交；
   * 结论见 README 的设计说明。issue #13：此前出处写作 probe_effect.js，该文件不存在）。
   * absolute 只留给换判断后端（例如本地分类器）时用。
   */
  compactMode: z.string().default('relative'),
  /** relative 模式：两轴各取尾部这个比例，**取交集** */
  compactQuantile: z.number().min(0).max(1).default(0.34),
  /**
   * relative 模式需要的最小总体规模；小于它则**降级为绝对下限模式**（不是我原本设想的"直接不做"）。
   *
   * issue #27：只读工具在写/执行密集会话里往往只占极少数（实测只读 1/6 → 总体仅 2 条），
   * 而此前低于这个数就返回空集 → **第二层在绝大多数真实会话里静默不工作**，
   * 报错文案却说"需要 ≥4 个"，看着像"样本确实不够"而不像 bug。
   */
  minCandidatesForRelative: z.number().min(2).default(DEFAULT_MIN_CANDIDATES_FOR_RELATIVE),
  /** 降级模式（总体 < minCandidatesForRelative）用的绝对下限，**明显严于** compactThreshold */
  floorThreshold: z.number().min(0).max(1).default(DEFAULT_FLOOR_THRESHOLD),
  /** 降级模式仍要求的最低样本量；低于它连分布都谈不上，仍然不做 */
  minCandidatesForFloor: z.number().min(1).default(DEFAULT_MIN_CANDIDATES_FOR_FLOOR),
  /** absolute 模式用的阈值 */
  compactThreshold: z.number().min(0).max(1).default(0.5),
  /**
   * 允许整对移出的工具（白名单）。**默认 = `DSH_READONLY_TOOLS`（只读工具集），即默认就带白名单。**
   *
   * 为什么默认是"只读白名单"而不是空：白名单失效的后果是"功能静默死亡"（加载成功、
   * 接管成功、判定在跑，只是什么都不做），所以宁可让它默认就窄；黑名单只用来额外
   * 保护改写型调用。实测教训：最初把 Claude Code 风格的 PascalCase 名字当默认白名单，
   * 而真实 DSH 的工具名是 **`pwsh` / `read` / `glob`**（全小写、shell 叫 pwsh）——
   * **命中 0/11，第二层静默地永不触发**。
   * 比较时做归一化（小写 + 去掉 `_`/`-`），所以 `MultiEdit` 与 `multi_edit` 等价。
   * 想放宽就配成 `[]`（只受 neverCompactTools 约束）——那是显式 opt-in 的不安全模式，
   * shell 调用也会被整对移出。
   */
  compactTools: z.array(z.string()).default(DEFAULT_COMPACT_TOOLS),
  /** 永不整对移出的工具（改写型调用是承重信息） */
  neverCompactTools: z.array(z.string()).default(DEFAULT_NEVER_COMPACT_TOOLS),
  /** 证据守卫：结果里命中这些词就不整对移出（仍允许第一层截断） */
  evidenceGuard: z.boolean().default(true),
  evidencePatterns: z.array(z.string()).default(DEFAULT_EVIDENCE_PATTERNS),
  /**
   * assistant 消息里**用户可见文本**（`text` 块）超过这个长度的步骤不整对移出——它在交代结论。
   * 默认值按真实会话标定：实测 DeepSeek 每步 text 仅 0~287 字符，1200 有充分余量。
   *
   * ⚠️ 这个阈值**不含 `reasoning`**（issue #26：此前两者累加，导致阈值被思考草稿主导）。
   * reasoning 有独立阈值 `maxStepReasoningChars`。
   */
  maxStepTextChars: z.number().min(0).default(1200),
  /**
   * assistant 消息里**思考草稿**（`reasoning` 块）超过这个长度的步骤不整对移出。
   *
   * 为什么单独一个键、且默认值明显更宽：`detail` 级别的会话里 reasoning 天然很长
   * （实测 0~1207 字符，且会随任务复杂度溢出到数千），它是模型的草稿而不是承重结论。
   * 与 text 共用一个阈值时，reasoning 只要多写几百字就会把整层压缩静默关掉——
   * 这是"第二层用不到"的主因。取 4000 是给"确实想了很久、这步大概不平凡"留余地，
   * 同时让绝大多数正常步骤通过。想彻底关掉这道门就配成一个很大的数。
   */
  maxStepReasoningChars: z.number().min(0).default(4000),
  /** 一段范围至少要能省下这么多字符，才值得开一次压缩事务 */
  compactMinChars: z.number().min(0).default(2000),
  /** 回执必须是原内容 token 的这个比例以下才动手（服务端硬要求 <1.0，我们更严） */
  receiptMaxRatio: z.number().min(0).max(1).default(0.5),
  /**
   * 一次 pass 最多做几次压缩事务（issue #35）。
   *
   * 旧默认值是 1：一次 pass 只回收一段，大上下文要靠**多轮 pre-step** 慢慢挤，
   * 而每一轮都要重新走压力门、重新判定、重新选段——收敛慢且多花 Jev 调用。
   * 单次 compactRegion 的成本是"一次摘要调用"（我们注入确定性回执，所以其实
   * 不含模型生成），排队做 3 段与做 1 段的边际成本很低，于是默认提到 3。
   *
   * 上限仍是可配的：想完全回到旧行为就设成 1。
   */
  maxCompactionsPerPass: z.number().min(1).default(3),
  /** 回执里每行入参截断到多少字符 */
  receiptArgChars: z.number().min(0).default(120),

  /**
   * 心跳文件路径。非空时，插件会在加载完成、每次判定 pass、每次裁剪后写一份 JSON 快照。
   * 用途有两个：①运维可观测（宿主会吞掉插件的 logger 输出，只能靠落盘看状态）
   * ②**验证接管是否真的发生**——这是唯一能从外部确证"插件在真实宿主里起作用"的手段。
   */
  heartbeatFile: z.string().default(''),
  logLevel: z.string().default('info'),
})

/**
 * `resolveConfig` 把越界配置的说明挂在这个键下（普通字符串键，不是 Symbol——
 * 心跳要 JSON 序列化，Symbol 存不进去）。调用方按需取用：
 *
 *   const cfg = resolveConfig(raw)
 *   for (const w of cfg[CONFIG_WARNINGS] ?? []) log('warn', w)
 *
 * 它不是 `Config` schema 的键，所以 `check.js` 里"schema 键必须有兜底"的断言不受影响。
 */
export const CONFIG_WARNINGS = '__configWarnings'

/**
 * 数值配置的**合法区间表**。`[min, max]`，`Infinity` 表示"上不封顶"。
 *
 * 为什么必须有这张表（issue #28）：`Config` 的 schema 只写了 `.default()`，没有 `.min()/.max()`，
 * 而 `resolveConfig` 又只做 `?? 兜底`（只挡 undefined/null）。于是**任何越界值都原样穿透**
 * 到运行时，且后果往往不是报错而是**静默失效**。实测（未修前）：
 *
 *   - `preserveRecent = -5` → `lastAllowed = surface.length - 1 - (-5)` 反而**变大**，
 *     最近区保护**完全失效**。这是最危险的一条：两层都会去动正在进行的工具调用。
 *   - `maxStepTextChars = -1` → 每一步都 `text > -1` → 第二层**永久静默失效**。
 *   - `compactMinChars = -100` → 该门形同不存在（"省得够不够"永远为真）。
 *   - `receiptMaxRatio = 5` → 回执比原文大 5 倍也放行（安全门失效）。
 *   - `keepThreshold = 2` → 第一层所有节点都裁（`prob >= 2` 恒假）。
 *
 * 分档的意义：
 *   · `float01` —— 概率/比例，越界后果是"判据恒真或恒假"，一律钳到 [0,1]。
 *   · `nonNeg`  —— **0 是合法值**（如 headChars=0 = 不留头），只挡负数。
 *   · `count`   —— 计数类，下界 1（配成 0 等于把该功能关掉，那是布尔开关的职责）。
 *   · `positive`—— 严格正数，下界取一个很小的正数而非 0（避免除零/无穷循环）。
 *
 * 上界为什么普遍设 1e9：这些键都是"越大越宽松"的方向（多留一点、多等一会），
 * 钳住它们是在替用户做一个他没要求的决定，收益远小于风险。真正需要上界的是
 * **会转化为内存/时间开销**的那几个（见各自注释与 MAX_* 常量）。
 */
const CONFIG_RANGES = {
  // 概率 / 比例：越界会让判据恒真或恒假
  keepThreshold: [0, 1],
  keepFloorThreshold: [0, 1],
  alwaysTrimRatio: [0, 1],
  compactQuantile: [0, 1],
  compactThreshold: [0, 1],
  floorThreshold: [0, 1],
  // receiptMaxRatio 不只是比例，它同时是"回执不得比原文大"的安全门：
  // >1 就等于允许"压缩后反而更占地方"，所以上界收在 1。
  // 注释里写的"服务端硬要求 <1.0，我们更严"指的是默认值 0.5，不是上界。
  receiptMaxRatio: [0, 1],
  // 非负（0 合法）
  preserveRecent: [0, 1e9],
  headChars: [0, 1e9],
  tailChars: [0, 1e9],
  textHead: [0, 1e9],
  textTail: [0, 1e9],
  minCharsToPrune: [0, 1e9],
  compactMinChars: [0, 1e9],
  receiptArgChars: [0, 1e9],
  inputChars: [0, 1e9],
  maxStepTextChars: [0, 1e9],
  maxStepReasoningChars: [0, 1e9],
  // P0-1 预算模式 / P0-2 摘录（0 合法：摘录 0 = 关闭；budgetMinChars 0 = 严格跟随体积规则）
  volumeBudgetThresholdChars: [0, 1e9],
  budgetMinChars: [0, 1e9],
  minGainChars: [0, 1e9],
  resultExcerptChars: [0, 1e9],
  // 计数类
  minHistoryLines: [1, 1e9],
  minCandidatesForRelative: [2, 1e9],
  minCandidatesForFloor: [1, 1e9],
  minCandidatesForBudget: [1, 1e9],
  maxCompactionsPerPass: [1, 1e9],
  // 预算 / 超时（正数）
  maxStateTokens: [1, 1e9],
  maxRequestTokens: [1, 1e9],
  judgeTimeoutMs: [1, 1e9],
  judgeMaxRetries: [0, 1e9],
  judgeRetryBaseMs: [0, 1e9],
}

/**
 * `keepMode` 的白名单校验（review 修复）：此前是 `z.string()` + `?? 'budget'`，
 * 拼错（如 `'budgt'`）会静默穿过两层校验直达 `planTrims`——而 `planTrims` 对
 * 未知模式返回 null，等于**静默退回旧行为**，与仓库"越界配置必须留痕"的约定相悖。
 * schemastery 没有 enum 构造器（const/union 语义均不符），故按 #28 的
 * "回落默认 + configWarnings 留痕"模式在这里做白名单。
 */
export function resolveKeepMode(raw, onWarn) {
  if (raw == null || raw === '') return 'budget'
  if (raw === 'budget' || raw === 'absolute') return raw
  onWarn?.(`配置 keepMode=${JSON.stringify(String(raw))} 不在 ['budget','absolute'] 内 → 已改为 'budget'（拼错的模式会静默退回旧行为，必须留痕）`)
  return 'budget'
}

/**
 * 按区间表钳制配置值；越界时通过 `onWarn` 报告**改动前后**的值。
 *
 * 返回 `[钳制后的值, 是否发生过钳制]`。非有限值（NaN / Infinity / 字符串）一律回落到
 * `fallback`（即默认值）——因为"改了多少"在这个语义下不可解释，"打到默认"才可解释。
 * 这正是 `Number.isFinite` 而不是 `typeof === 'number'` 的理由：`typeof NaN === 'number'`。
 */
export function clampConfigNumber(key, value, fallback, onWarn) {
  const [lo, hi] = CONFIG_RANGES[key] ?? [Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY]
  const warn = (kind, got) => {
    onWarn?.(`配置 ${key}=${got} 非法（${kind}）→ 已改为 ${fallback}（合法区间 ${lo}~${hi}）`)
    return fallback
  }
  // 值缺失（undefined/null/''）不是"非法"，是"没配"→ 静默用默认值，不打扰用户
  if (value == null || value === '') return [fallback, false]
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return [warn('不是有限数值', JSON.stringify(value) ?? String(value)), true]
  }
  if (value < lo) return [warn(`低于下限 ${lo}`, value), true]
  if (value > hi) return [warn(`高于上限 ${hi}`, value), true]
  return [value, false]
}

export function resolveConfig(config = {}) {
  const warnings = []
  // 废弃键的运行时信号（review 反馈）：只标 @deprecated 会让用户配了却静默空转，
  // 违反仓库"静默退回必须留痕"的约定（resolveKeepMode 同理）。
  //
  // ⚠️ 判据必须是"值 ≠ 默认值"，不能是 `!= null`：宿主已经用 schema 填过默认值，
  // 到了这里 `undefined` 不可能出现（实测：空配置也会被报"配置了废弃键"）。
  // 代价是"显式写成默认值"不会告警 —— 那种写法本来也是空操作，不算漏报。
  if (config.volumeBudgetThresholdChars != null
    && config.volumeBudgetThresholdChars !== DEFAULT_VOLUME_BUDGET_THRESHOLD_CHARS) {
    warnings.push('配置 volumeBudgetThresholdChars 已废弃（budget 模式改为压力分位，由 judgePass 每轮自动计算），该键不再生效')
  }
  if (config.budgetMinChars != null && config.budgetMinChars !== DEFAULT_BUDGET_MIN_CHARS) {
    warnings.push('配置 budgetMinChars 已废弃（同上），该键不再生效')
  }
  return {
    ...config,
    enabled: config.enabled ?? true,
    apiKey: config.apiKey ?? '',
    model: config.model ?? 'jev-latest',
    // 维护约定：Config schema 的每个 default 都必须在这里有对应兜底（本键此前遗漏；
    // 影响为零是因为 JevClient 的默认参数会在 undefined 时生效，但约定不该靠下游兜底）。
    baseUrl: config.baseUrl ?? 'https://api.typesafe.ai/v1/systemone',
    preserveRecent: clampConfigNumber('preserveRecent', config.preserveRecent, 4, (w) => warnings.push(w))[0],
    keepThreshold: clampConfigNumber('keepThreshold', config.keepThreshold, 0.5, (w) => warnings.push(w))[0],
    alwaysTrimRatio: clampConfigNumber('alwaysTrimRatio', config.alwaysTrimRatio, 0.5, (w) => warnings.push(w))[0],
    keepMode: resolveKeepMode(config.keepMode, (w) => warnings.push(w)),
    keepFloorThreshold: clampConfigNumber('keepFloorThreshold', config.keepFloorThreshold, 0.2, (w) => warnings.push(w))[0],
    minCandidatesForBudget: clampConfigNumber('minCandidatesForBudget', config.minCandidatesForBudget, 4, (w) => warnings.push(w))[0],
    volumeBudgetThresholdChars: clampConfigNumber('volumeBudgetThresholdChars', config.volumeBudgetThresholdChars, DEFAULT_VOLUME_BUDGET_THRESHOLD_CHARS, (w) => warnings.push(w))[0],
    budgetMinChars: clampConfigNumber('budgetMinChars', config.budgetMinChars, DEFAULT_BUDGET_MIN_CHARS, (w) => warnings.push(w))[0],
    minGainChars: clampConfigNumber('minGainChars', config.minGainChars, 40, (w) => warnings.push(w))[0],
    resultExcerptChars: clampConfigNumber('resultExcerptChars', config.resultExcerptChars, 240, (w) => warnings.push(w))[0],
    headChars: clampConfigNumber('headChars', config.headChars, 600, (w) => warnings.push(w))[0],
    tailChars: clampConfigNumber('tailChars', config.tailChars, 200, (w) => warnings.push(w))[0],
    minCharsToPrune: clampConfigNumber('minCharsToPrune', config.minCharsToPrune, 400, (w) => warnings.push(w))[0],
    judgeOn: config.judgeOn ?? 'pressure',
    softLimit: config.softLimit ?? '55%',
    neverPruneTools: config.neverPruneTools ?? DEFAULT_NEVER_PRUNE_TOOLS,
    compactReceipts: config.compactReceipts ?? true,
    compactOn: config.compactOn ?? 'pressure',
    compactSoftLimit: config.compactSoftLimit ?? '70%',
    compactMode: config.compactMode ?? 'relative',
    compactQuantile: clampConfigNumber('compactQuantile', config.compactQuantile, 0.34, (w) => warnings.push(w))[0],
    minCandidatesForRelative: clampConfigNumber('minCandidatesForRelative', config.minCandidatesForRelative, DEFAULT_MIN_CANDIDATES_FOR_RELATIVE, (w) => warnings.push(w))[0],
    floorThreshold: clampConfigNumber('floorThreshold', config.floorThreshold, DEFAULT_FLOOR_THRESHOLD, (w) => warnings.push(w))[0],
    minCandidatesForFloor: clampConfigNumber('minCandidatesForFloor', config.minCandidatesForFloor, DEFAULT_MIN_CANDIDATES_FOR_FLOOR, (w) => warnings.push(w))[0],
    compactThreshold: clampConfigNumber('compactThreshold', config.compactThreshold, 0.5, (w) => warnings.push(w))[0],
    compactTools: config.compactTools ?? DEFAULT_COMPACT_TOOLS,
    neverCompactTools: config.neverCompactTools ?? DEFAULT_NEVER_COMPACT_TOOLS,
    evidenceGuard: config.evidenceGuard ?? true,
    evidencePatterns: config.evidencePatterns ?? DEFAULT_EVIDENCE_PATTERNS,
    maxStepTextChars: clampConfigNumber('maxStepTextChars', config.maxStepTextChars, 1200, (w) => warnings.push(w))[0],
    maxStepReasoningChars: clampConfigNumber('maxStepReasoningChars', config.maxStepReasoningChars, 4000, (w) => warnings.push(w))[0],
    compactMinChars: clampConfigNumber('compactMinChars', config.compactMinChars, 2000, (w) => warnings.push(w))[0],
    receiptMaxRatio: clampConfigNumber('receiptMaxRatio', config.receiptMaxRatio, 0.5, (w) => warnings.push(w))[0],
    maxCompactionsPerPass: clampConfigNumber('maxCompactionsPerPass', config.maxCompactionsPerPass, 3, (w) => warnings.push(w))[0],
    receiptArgChars: clampConfigNumber('receiptArgChars', config.receiptArgChars, 120, (w) => warnings.push(w))[0],
    dryRun: config.dryRun ?? false,
    wording: config.wording ?? 'goal',
    minHistoryLines: clampConfigNumber('minHistoryLines', config.minHistoryLines, 8, (w) => warnings.push(w))[0],
    // issue #4：这 6 个键此前只在 Config schema 里有 default，resolveConfig 漏了——
    // config 未经 schemastery 归一化时（冒烟测试的 PLUGIN_CFG、被 patch 直接注入的对象），
    // abridge 拿到 undefined → head+tail+40 是 NaN → 同一段文本输出两遍、state 带 "NaN"。
    // 维护约定：Config schema 的每个 default 都必须在这里有对应兜底。
    textHead: clampConfigNumber('textHead', config.textHead, 400, (w) => warnings.push(w))[0],
    textTail: clampConfigNumber('textTail', config.textTail, 150, (w) => warnings.push(w))[0],
    inputChars: clampConfigNumber('inputChars', config.inputChars, 300, (w) => warnings.push(w))[0],
    maxStateTokens: clampConfigNumber('maxStateTokens', config.maxStateTokens, 25000, (w) => warnings.push(w))[0],
    maxRequestTokens: clampConfigNumber('maxRequestTokens', config.maxRequestTokens, 30000, (w) => warnings.push(w))[0],
    judgeTimeoutMs: clampConfigNumber('judgeTimeoutMs', config.judgeTimeoutMs, 60000, (w) => warnings.push(w))[0],
    judgeMaxRetries: clampConfigNumber('judgeMaxRetries', config.judgeMaxRetries, 2, (w) => warnings.push(w))[0],
    judgeRetryBaseMs: clampConfigNumber('judgeRetryBaseMs', config.judgeRetryBaseMs, 300, (w) => warnings.push(w))[0],
    heartbeatFile: config.heartbeatFile ?? '',
    logLevel: config.logLevel ?? 'info',
    // 越界配置的**审计出口**（issue #28）：钳制是静默改写用户意图的动作，
    // 必须留下痕迹——否则用户配了 preserveRecent=-5 以为"更宽"，实际拿到的却是默认值，
    // 而他对"为什么和在文档里读到的行为不一样"完全没有线索。
    [CONFIG_WARNINGS]: warnings,
  }
}

/**
 * 一个工具名是否**有可能**被第二层整对移出。口径必须与 `selectReceiptRanges`
 * 里的工具门逐条一致，否则分位总体与实际可压缩集合不符。
 *
 * 为什么需要它：第一层的判定缓存复用了 `selectCandidates` 的结果，而那份候选只
 * 排除 `neverPruneTools`（黑名单）——第一层没有白名单，所以 shell 之类不可整对
 * 移出的调用也会正常进缓存。若第二层直接拿整份缓存当分位总体，这些节点的概率
 * 会占掉 `compactQuantile` 的尾部名额，随后又被工具门全部拒绝 → **第二层静默地
 * 少压缩**（尾部全被不可移出的工具占满时，表现为 0 段可压）。
 *
 * @param {string} tool 工具名
 * @param {{compactTools:string[], neverCompactTools:string[]}} cfg
 * @returns {boolean}
 */
export function isCompactableTool(tool, cfg) {
  if (isToolIn(cfg.neverCompactTools, tool)) return false
  if (cfg.compactTools.length > 0 && !isToolIn(cfg.compactTools, tool)) return false
  return true
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

  if (dshVersionMatches === false) {
    ctx.logger?.info?.(`[jev-prune] DSH ${dshVersion} 与测试版本 ${TESTED_DSH_VERSION} 不同系列 —— 事件字段可能已漂移，建议先跑 jev_probe_shapes 核对`)
  }

  void loadFreeze() // 异步取 freezeMessage，失败就退化成浅拷贝

  const envKey = typeof process !== 'undefined' ? process.env?.TYPESAFE_API_KEY : undefined
  const judge = deps.judge ?? new JevClient({
    apiKey: cfg.apiKey || envKey || '',
    model: cfg.model,
    baseUrl: cfg.baseUrl,
    timeoutMs: cfg.judgeTimeoutMs,
    maxRetries: cfg.judgeMaxRetries,
    retryBaseMs: cfg.judgeRetryBaseMs,
  })

  /** session → Map(结果 seq → {keep, prob, effectProb, chars, tool}) */
  const decisions = new WeakMap()
  /**
   * session → 压力缺口比例（0~1）。judgePass（异步，能拿到 used/window）算好存这里，
   * pruneSession（同步，DSH 调）读它来决定「这一轮裁多少」。读不到 = 0 = 不裁。
   */
  const pressureRatios = new WeakMap()
  const stats = {
    judged: 0,
    requests: 0,
    prunedByJev: 0,
    prunedByVolume: 0,
    savedChars: 0,
    // keep 的三个来源分开计数（issue #8）：keptByJev 此前混入了最近区/黑名单保护
    keptByJev: 0,
    keptByTail: 0,
    keptByBlacklist: 0,
    /**
     * P0-1：被**预算**（而不是判定）留下来的条数。
     * budget 模式下"Jev 说过期但预算已经用完"是常态——不单独计数的话，
     * 用户会看到"Jev 裁掉 0"却不知道为什么，也无法判断预算是不是太紧。
     */
    keptByBudget: 0,
    /** P0-1/P0-3：最近一次裁剪的预算分析（planTrims 的返回值），心跳里可见 */
    lastBudget: null,
    /** P0-3：最近若干条逐节点决策（含原因），让"为什么没裁/裁了"可复核 */
    decisions: [],
    skipped: 0,
    errors: 0,
    lastNote: '',
    /**
     * P0-1/P0-3 遥测：keep 概率的累计分布。
     * 为什么必须落盘：本插件历史上最大的问题都是"静默失效"，而这个分布是判断
     * "阈值与分布是否匹配"的唯一依据——真实会话实测 42/42 低于 0.5（P50=0.13），
     * 固定阈值等于"把每一轮判定都读成可裁"。没有这份数据，这个问题在运行时不可见。
     */
    probSum: 0,
    probCount: 0,
    keepAboveThreshold: 0,
    keepBelowThreshold: 0,
    /** P0-3：最近一次判定 pass 的门控快照（used/窗口/阈值/为什么跳过） */
    lastGate: null,
    /**
     * 判定批次失败次数（issue #34）。旧实现一处失败就冒泡、后续批次不再问，
     * 已经能拿到的概率被一起丢掉；现在逐批容错，失败批数如实上报，
     * 好判断"这轮少判了几批"而不是只看到一句笼统的失败。
     */
    judgeBatchFailures: 0,
    // 第二层
    compactions: 0,
    compactedSeqs: 0,
    compactedChars: 0,
    receiptSummaries: 0,
    /**
     * 回执因**竞态**没能注入的次数（issue #29）。
     *
     * 为什么必须单独计数：竞态的表现是"回执被别处的并发压缩抢走"，而结果看起来
     * 只是"这次压缩用了模型摘要"——与"我们没打算压缩它"完全无法区分。
     * 不复数上报的话，这个 bug 只能靠读代码发现。
     */
    receiptFenceMisses: 0,
    compactSkipped: 0,
    lastCompactNote: '',
  }

  /**
   * P0-3：keep 概率的分布快照（最近至多 500 个样本）。
   * 落盘的理由：这个插件最大的历史问题是"静默失效"，而"阈值与分布是否匹配"
   * 只有看到分布本身才能判断——真实会话实测 42/42 低于 0.5（P50=0.13），
   * 固定阈值等于把每一轮判定都读成"可裁"。
   */
  const probSamples = []
  function probSummary() {
    if (stats.probCount === 0) return null
    const sorted = [...probSamples].sort((a, b) => a - b)
    const q = (p) => (sorted.length === 0 ? null : sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))])
    return {
      n: stats.probCount,
      sampled: sorted.length,
      mean: Number((stats.probSum / stats.probCount).toFixed(4)),
      p10: q(0.1), p25: q(0.25), p50: q(0.5), p75: q(0.75), p90: q(0.9),
      aboveKeepThreshold: stats.keepAboveThreshold,
      belowKeepThreshold: stats.keepBelowThreshold,
      keepThreshold: cfg.keepThreshold,
      keepMode: cfg.keepMode,
    }
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
        dshVersion: { version: dshVersion, testedAgainst: TESTED_DSH_VERSION, matchesTested: dshVersionMatches },
        judgeReady: judge.ready !== false,
        model: cfg.model,
        // 越界配置被钳制的记录（issue #28）。空数组 = 配置全部合法。
        // 落盘的原因是"钳制"本身就是一种静默行为差异，必须以可观测的方式留痕。
        configWarnings: cfg[CONFIG_WARNINGS] ?? [],
        keepThreshold: cfg.keepThreshold,
        // P0-1/P0-3：第一层的裁决模式与压力分位口径（判据落盘，否则"为什么没裁"不可复核）
        keep: {
          mode: cfg.keepMode,
          keepThreshold: cfg.keepThreshold,
          floor: cfg.keepFloorThreshold,
          minCandidates: cfg.minCandidatesForBudget,
          // 压力缺口比例由 judgePass 每轮算好，裁剪时随 lastPrune.budget 一起落盘；
          // volumeBudgetThresholdChars / budgetMinChars 已废弃（保留仅为兼容），不再出现在这里。
        },
        stateExcerptChars: cfg.resultExcerptChars,
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
  // contextWindow 按 provider+model 缓存：模型信息是静态的，每轮都问 llm 是浪费。
  // 方案 B（压力门移到 fresh 检查前）要求即使 fresh=0 也每轮算 ratio，所以这个缓存
  // 让"每轮算"不再有额外开销。只缓存非 null 结果，失败/null 时下次重试，与未缓存行为一致。
  const windowCache = new Map()
  async function resolveWindow(agent) {
    try {
      const header = agent.session?.requestHeader?.()?.config
      const provider = header?.provider || agent.options?.provider
      const model = header?.model || agent.options?.model
      const llm = ctx.get('llm')
      if (llm == null || !provider || !model || typeof llm.resolveModelInfo !== 'function') return null
      const key = `${provider}\u0000${model}`
      if (windowCache.has(key)) return windowCache.get(key)
      const info = await llm.resolveModelInfo(provider, model)
      const windowTokens = info?.context?.contextWindow ?? null
      if (windowTokens != null) windowCache.set(key, windowTokens)
      return windowTokens
    } catch {
      return null
    }
  }

  async function judgePass(agent, signal) {
    const session = agent?.session
    // P0-3：把"没判定"的原因也落盘。此前这条路径是完全静默的——judged=0 时无法区分
    // "门没开"（有 lastGate）/"没有候选"（有 surface 但都不可判）/"session 形态不对"，
    // 而这三者的处置完全不同。
    // session 真的可能不存在：宿主在会话挂上之前也会发 pre-step，而 compactPass 对同一
    // 情况的处置是 `report.blocked = '没有活动会话'`——契约就是"优雅退出"，不是抛错。
    //
    // ⚠️ 必须与下面那个分支分开判断：`WeakMap.set` 的键必须是对象，`set(undefined)` 会抛
    // `TypeError: Invalid value used as weak map key`。抛出点落在 pre-step 的 try 里，
    // 会被吞成 `stats.errors` / `最近（第一层）: 判定失败：…`——第一层行为其实没坏，
    // 只有账本在说谎（与 #29 的 startRequests 同一类缺陷）。所以守卫不能省：
    // 条件写 `session?.` 却在这一行无条件 set，等于把"受支持的路径"变成"抛错路径"。
    if (session == null) {
      stats.judgePassSkipped = (stats.judgePassSkipped ?? 0) + 1
      stats.lastJudgeSkipReason = '没有活动会话'
      return
    }
    if (session.surface?.nodes == null || judge.ready === false) {
      // 早退也刷新压力比例（review 反馈）：否则沿用上一轮的值，陈旧。
      pressureRatios.set(session, 0)
      stats.judgePassSkipped = (stats.judgePassSkipped ?? 0) + 1
      stats.lastJudgeSkipReason = judge.ready === false ? 'judge 未就绪' : 'session.surface.nodes 不可用'
      return
    }

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
    // 压力门控：不到软阈值就不花 Jev 的钱
    //
    // 失败方向（issue #32）：第一层与第二层的压力门必须**同向关闭**。
    // 旧实现是不对称的——第二层解析不出阈值时 `return`（不做），第一层却直接
    // **穿透**（照做）；更隐蔽的是 meter 缺失/抛错时 `used` 恒为 0，
    // 于是 `0 < threshold` 永远成立 → 判定**每一轮都跑**，压力门等于不存在。
    // 对一个"省 Jev 调用钱"的门来说，"解析不出来就别花钱"才是安全方向。
    //
    // 但"关闭"只对**真的算不出来**的情形成立（PR #28 review 修正）：
    // `softLimit` 配成绝对 token 数时，threshold 由 limit.value 直接给出，
    // **根本不需要 meter**。早期实现在这里无条件要求 `measured`，于是绝对阈值
    // 分支也被挡掉——把"该省的钱省下来"升级成了"功能静默消失"，
    // 比旧行为更糟。所以只要阈值本身能定出来（`threshold != null`），
    // meter 不可用就只是"压力门降级为不设防"，而不是"什么都不做"。
    //
    // 方案 B：压力门**移到 fresh 检查之前**。这样即使 fresh=0（没有新候选），ratio 也是
    // "当前"压力缺口比例，不是清成 0（会"该裁不裁"）也不是沿用旧值（陈旧）。代价是
    // fresh=0 的轮次也多调一次 resolveWindow（已按 provider+model 缓存）/ meter.measure
    // （本地计算），可忽略。
    // P0-1 修正：压力缺口比例（0~1）。judgePass 算出后缓存给 pruneSession 决定「这一轮裁多少」。
    // 默认 0 = 不裁（失败方向：算不出压力就不动手）。
    let pressureRatio = 0
    if (cfg.judgeOn !== 'always') {
      const meter = ctx.get('tokenMeter')
      let used = 0
      let measured = false
      try {
        if (typeof meter?.measure === 'function') {
          const measuredTokens = meter.measure(session)?.totalTokens
          if (typeof measuredTokens === 'number' && Number.isFinite(measuredTokens)) {
            used = measuredTokens
            measured = true
          }
        }
      } catch {
        measured = false
      }
      const windowTokens = await resolveWindow(agent)
      const limit = parseLimit(cfg.softLimit)
      const threshold = limit.kind === 'ratio'
        ? (windowTokens == null ? null : Math.floor(windowTokens * limit.value))
        : limit.value
      // P0-3：门控快照。三道门里这是第一道（插件判定门）；宿主的压缩门（compaction-basic
      // 的 thresholdRatio，默认 0.8）决定了第一层有没有写入权——两者都落盘才看得清全貌。
      stats.lastGate = {
        used, measured, windowTokens, limitRaw: cfg.softLimit, threshold,
        skip: false, reason: '', candidates: fresh.length,
      }
      if (threshold == null) {
        // 阈值算不出来（ratio 模式 + 窗口未知）→ 与第二层同向：不做判定，不花钱
        pressureRatios.set(session, 0)
        stats.skipped += fresh.length
        stats.lastGate = { ...stats.lastGate, skip: true, reason: '窗口未知（ratio 模式算不出阈值）' }
        stats.lastNote = '解析不出上下文窗口，第一层保守跳过（与第二层同向）'
        log('info', stats.lastNote)
        return
      }
      if (!measured) {
        // 阈值能定出来但拿不到用量 → 无法比较，只能不设防地继续。
        // 这里**不 return**：绝对阈值分支下 meter 本来就无关，return 等于把功能关掉。
        // ratio 算不出缺口 → 保持 0（不裁），由块后的统一 set 落盘。
        stats.lastGate = { ...stats.lastGate, reason: 'meter 不可用，本次不设防' }
        stats.lastNote = `拿不到 token 用量（meter 缺失或抛错），压力门本次不设防（阈值 ${threshold}）`
        log('warn', stats.lastNote)
      } else if (used < threshold) {
        pressureRatios.set(session, 0)
        stats.skipped += fresh.length
        stats.lastGate = { ...stats.lastGate, skip: true, reason: `压力不足（${used} < ${threshold}）` }
        return
      } else {
        // 通过压力门：缺口 = used - threshold（token），比例 = 缺口 / 窗口。窗口未知时保守 0。
        pressureRatio = windowTokens != null && windowTokens > 0
          ? Math.min(1, Math.max(0, (used - threshold) / windowTokens))
          : 0
      }
    } else {
      // always 模式没有压力信号，按配置的固定比例裁（默认 0.5 = 裁掉池子一半增益）。
      pressureRatio = cfg.alwaysTrimRatio
    }
    pressureRatios.set(session, pressureRatio)

    if (fresh.length === 0) {
      // 早退②：没有新候选。ratio 已在上面每轮算好（压力门在 fresh 检查之前），
      // 这里不需要再 set 0——pruneSession 拿到的是"当前"压力比例，不是陈旧的。
      // P0-3：区分"没有候选"与"候选都已判定过"——前者说明筛选条件把结果全排除了
      // （preserveRecent / 黑名单 / 已裁标记），需要看见 surface 规模才能判断是否配置过紧。
      stats.judgePassSkipped = (stats.judgePassSkipped ?? 0) + 1
      stats.lastJudgeSkipReason = candidates.length === 0
        ? `无候选（surface ${surface.length} 节点：可能全落在最近区/黑名单/已裁剪）`
        : `候选全部已判定（候选 ${candidates.length}，缓存 ${cache.size}）`
      return
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
        // P0-2：结果摘录预算（0 = 关闭）。判断者能看到"里面是什么"再决定留不留。
        resultExcerptChars: cfg.resultExcerptChars,
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

    const bySeq = new Map(fresh.map((c) => [c.seq, c]))
    const freshSeqs = [...bySeq.keys()]
    // 本轮开始时的请求数，用于把 `stats.requests` 只加上**本轮真正发出**的部分。
    // （这里曾经漏了声明：结算行读一个不存在的 `startRequests`，在严格模式下抛
    // ReferenceError，被 pre-step 的 catch 吞成「判定失败：startRequests is not defined」。
    // 危害在于**判定结果已经写进 decisions，第一层裁剪照常执行**——功能看起来完全正常，
    // 只有 errors 计数与心跳在说谎。smoke 的 J 块现在钉住了"成功路径不得留下被吞的错误"。）
    const startRequests = judge.requests
    // 批级容错（issue #34）：旧实现让第一处失败冒泡到调用方，于是**后续批次也不会再问**——
    // 已经能问出来的概率被一起丢掉。现在逐批 try：失败的批记一笔、继续问下一批。
    // 只有**所有**批都失败才把错误抛出去（那种情况确实等于整轮没判定）。
    let batchFailures = 0
    let lastBatchError = null
    let succeeded = 0
    for (const batch of batches) {
      let answers
      try {
        answers = await judge.ask(state, batch, { signal })
      } catch (error) {
        batchFailures += 1
        lastBatchError = error
        stats.judgeBatchFailures += 1
        log('info', `判定批次失败（${batchFailures}/${batches.length}）：${error?.message ?? String(error)}`)
        continue
      }
      succeeded += 1
      // 遍历本批里的**候选**（一个候选有两个题号 result_sN / effect_sN）。
      // 注意：两轴可能落在**不同批**（预算小的时候每题一批），所以本批只写
      // 它带来的那一轴，另一轴留给它自己的批——合并写在下面按候选统一结算，
      // 避免"同一候选被两批各记一次"。
      const seqsInBatch = new Set()
      for (const id of Object.keys(batch)) {
        const seq = Number(id.slice(id.indexOf('_s') + 2))
        if (Number.isFinite(seq)) seqsInBatch.add(seq)
      }
      for (const seq of seqsInBatch) {
        const candidate = bySeq.get(seq)
        if (candidate == null) continue
        const prob = answers[`result_s${seq}`]
        const effectProb = answers[`effect_s${seq}`]
        const previous = cache.get(seq)
        // 局部合并：本批给出的轴覆盖，未给出的轴沿用已有值
        const merged = {
          keep: typeof prob === 'number'
            ? prob >= cfg.keepThreshold
            : (previous?.keep ?? (typeof effectProb === 'number' ? effectProb >= cfg.keepThreshold : true)),
          prob: typeof prob === 'number' ? prob : (previous?.prob ?? null),
          effectProb: typeof effectProb === 'number' ? effectProb : (previous?.effectProb ?? null),
          chars: candidate.chars,
          tool: candidate.tool,
        }
        cache.set(seq, merged)
      }
    }
    // 结算本轮的判定条数：按**候选**去重后统计（两轴齐了才算这一条判完）。
    // 旧实现是"每批都遍历整个 fresh，能查到旧值就再累加一次"，条数按批数虚报。
    for (const seq of freshSeqs) {
      const value = cache.get(seq)
      if (value != null && (typeof value.prob === 'number' || typeof value.effectProb === 'number')) {
        stats.judged += 1
        // P0-3 遥测：把概率分布记下来（这是判断"阈值是否失配"的唯一依据）
        if (typeof value.prob === 'number') {
          stats.probSum += value.prob
          stats.probCount += 1
          if (value.prob >= cfg.keepThreshold) stats.keepAboveThreshold += 1
          else stats.keepBelowThreshold += 1
          probSamples.push(value.prob)
          if (probSamples.length > 500) probSamples.shift()
        }
      }
    }
    stats.requests += judge.requests - startRequests
    if (batches.length > 0 && succeeded === 0) {
      // 全部失败：这确实等于整轮没判定，如实抛出（调用方会记进 stats.errors）
      throw lastBatchError ?? new Error('全部判定批次失败')
    }
    stats.lastNote = `判定 ${fresh.length} 个候选，state ≈ ${estimateTokens(state)} tokens`
      + (batchFailures > 0 ? `（${batchFailures}/${batches.length} 批失败，已跳过）` : '')
    log('debug', stats.lastNote)
    writeHeartbeat({
      lastJudgePass: {
        candidates: fresh.length,
        stateTokens: estimateTokens(state),
        nameIndexSize: nameByCallId.size,
        events: describeEvents(session),
        // 逐候选明细（seq/工具/概率）——viewer 画散点、排查"为什么裁这条"用
        rows: fresh.map((c) => {
          const v = cache.get(c.seq) ?? {}
          return { seq: c.seq, tool: c.tool, chars: c.chars, prob: v.prob ?? null, effectProb: v.effectProb ?? null }
        }),
      },
      // P0-3：判定依据落盘（分布 + 门控快照），否则"阈值失配/门没开"在运行时不可见
      probSummary: probSummary(),
      // 原始样本（最近 200 个）——viewer 用它画直方图；分位数只能看形状不能看尾巴
      probSamples: probSamples.slice(-200),
      gate: stats.lastGate,
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
      cfg: { ...cfg, marker: JEV_PRUNE_MARKER, pressureRatio: pressureRatios.get(session) ?? 0 },
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
      // P0-1/P0-3：预算分析与逐节点决策落盘——"裁了哪些、为什么、预算够不够"可复核
      budget: out.plan ?? null,
      decisions: out.decisions ?? [],
    })
    // 供 jev_prune_status / 心跳汇总使用（只留最近一批，避免无限增长）
    if (Array.isArray(out.decisions) && out.decisions.length > 0) stats.decisions = out.decisions.slice(0, 50)
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
    // 越界配置必须在加载时就喊出来（issue #28）：钳制后的行为与用户写下的配置不一致，
    // 若不提示，用户会一直以为"我配了但没生效"是插件的 bug。
    for (const w of cfg[CONFIG_WARNINGS] ?? []) log('warn', w)
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
  // ⚠️ 竞态（issue #29）：`compactRegion` 是异步的，`summarize` 的入参里**没有区间身份**
  // （只有 `input` / `agent` / `signal`，我们无法从中看出"这次摘要对应哪个区间"）。
  // 所以只要按 session 存一个待用回执，在 `await compactRegion(...)` 期间**任何**别处
  // 发起的压缩（DSH 自己的自动压缩、另一条并发路径）都会调到 summarize，把回执抢走——
  // 结果是"别人那段被换成了我们的确定性回执，而我们要压的那段反而用了模型摘要"。
  //
  // 修法分两层，缺一不可：
  //   ① **归属令牌（fencing token）**：每次 compactRegion 前发一个新令牌，并把它记在
  //      `activeFence` 上。summarize 只在「当前 activeFence === 待用回执的令牌」时才注入——
  //      即证明"这次 summarize 是在我们那次 compactRegion 的调用栈/时序内发生的"。
  //      await 期间若被别处的调用抢先，activeFence 会被对方改写，我们自然不注入。
  //   ② **一次性领取（claim-once）**：回执被消费后立刻 delete，且令牌是一次性的，
  //      防止同一次压缩里 summarize 被调用多次时重复注入。
  //   ③ **归属校验（owner check）**：compactRegion 返回后核对令牌是否仍属于本次调用，
  //      不属于则说明中途被打断，如实记进 action，不谎报成功。
  let fenceCounter = 0
  /**
   * 当前"活跃"的压缩令牌。每次我们要调 compactRegion 时自增并置为最新值；
   * summarize 只在待用回执的令牌与之相等时才注入。它是"归属证明"：
   * 我们那次 compactRegion 里面派发的 summarize 一定看到自己的令牌，
   * 而 await 期间被别处抢先发起的压缩会把它改写成对方的令牌。
   */
  let activeFence = 0
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
      // 三道闸都要过才算"这是我们的那一次"（issue #29）：
      //   · entry 存在、未过期
      //   · 未被领取（claimed）—— 同一次压缩里 summarize 若被多次调用，只注入一次
      //   · 令牌仍是当前活跃令牌 —— 证明这次 summarize 发生在我们那次 compactRegion 之内，
      //     而不是被 await 期间别处的并发压缩抢先调用
      if (entry != null
        && !entry.claimed
        && entry.fence === activeFence
        && Date.now() - entry.at < 5 * 60 * 1000) {
        entry.claimed = true
        stats.receiptSummaries += 1
        return {
          summary: [{ type: 'text', text: entry.text }],
          provider: 'jev-receipt',
          model: 'deterministic',
        }
      }
      // 不是我们的：如实退回原实现，绝不吞掉别人的摘要。
      // 若 entry 存在但令牌不匹配，说明恰好撞上竞态 —— 记一笔，让"回执被抢"可观测。
      if (entry != null && !entry.claimed && entry.fence !== activeFence) {
        stats.receiptFenceMisses += 1
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
    // 失败方向与第一层一致（issue #32）：解析不出阈值、或拿不到用量，都**不做**。
    if (!force && cfg.compactOn !== 'always') {
      const meter = ctx.get?.('tokenMeter')
      let used = 0
      let measured = false
      try {
        if (typeof meter?.measure === 'function') {
          const measuredTokens = meter.measure(session)?.totalTokens
          if (typeof measuredTokens === 'number' && Number.isFinite(measuredTokens)) {
            used = measuredTokens
            measured = true
          }
        }
      } catch {
        measured = false
      }
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
      if (!measured) {
        // 与第一层同口径（PR #28 review）：阈值能定出来时不因 meter 缺失而放弃，
        // 只是压力门本次不设防。绝对阈值分支下 meter 本来就无关，
        // 早期实现无条件 return 会把"保守"变成"功能静默消失"。
        report.blocked = `拿不到 token 用量（meter 缺失或抛错），压力门本次不设防（阈值 ${threshold}）`
        log('warn', report.blocked)
      } else if (used < threshold) {
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
    // 分位总体必须只含**可整对移出**的节点：判定的缓存同时服务第一层（无白名单），
    // 若把白名单外/黑名单内的节点也算进总体，尾部名额会被它们占掉后被工具门白拒。
    const verdicts = [...cache.entries()]
      .filter(([seq, value]) => onSurface.has(seq) && isCompactableTool(value.tool, cfg))
      .map(([seq, value]) => ({ seq, ...value }))
    report.verdicts = verdicts.length

    let eligibleSeqs
    if (cfg.compactMode === 'relative') {
      eligibleSeqs = computeEligibleSeqs(verdicts, {
        quantile: cfg.compactQuantile,
        minCandidates: cfg.minCandidatesForRelative,
        minCandidatesForAbsolute: cfg.minCandidatesForFloor,
        floorThreshold: cfg.floorThreshold,
        // 降级模式的说明必须能被看到：否则用户只会看到"交集为空"，
        // 又回到"分不清是样本不够还是功能坏了"的老问题（issue #27）
        onNote: (note) => { report.quantileNote = note },
      })
    } else {
      eligibleSeqs = new Set(verdicts
        .filter((v) => typeof v.prob === 'number' && v.prob < cfg.compactThreshold
          && typeof v.effectProb === 'number' && v.effectProb < cfg.compactThreshold)
        .map((v) => v.seq))
    }
    report.eligible = [...eligibleSeqs].sort((a, b) => a - b)
    if (eligibleSeqs.size === 0) {
      // 降级模式的说明优先展示：它比"交集为空"更具体（issue #27）
      report.blocked = report.quantileNote
        ?? (cfg.compactMode === 'relative'
          ? `两轴尾部交集为空（候选 ${verdicts.length} 个，需要 ≥${cfg.minCandidatesForRelative} 个）`
          : '没有同时低于阈值的候选')
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

      // 发一个一次性令牌并抢占 activeFence（issue #29）。
      // 之后若别处的并发压缩改写了 activeFence，我们这次的 summarize 就不会注入回执，
      // 也就不会把别人的区间替换成我们的回执——那是原实现最危险的失败模式。
      const fence = (fenceCounter += 1)
      activeFence = fence
      pendingReceipt.set(session, { text: receipt, at: Date.now(), fence, claimed: false })
      try {
        const result = await compaction.compactRegion(range.start, range.end, agent, options.signal)
        // 归属校验：compactRegion 返回时令牌若已被别人改写，说明这次压缩中途被打断
        // （或我们的回执被别人消费了）。此时不能谎报成功——如实记下来。
        if (activeFence !== fence) {
          stats.receiptFenceMisses += 1
          action.fenceLost = true
        }
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
        // 只清理**自己**的令牌：若期间已被别人改写，那个令牌归对方管，不要去动它
        // （原实现无论谁覆盖都无条件 delete(session)，会把别人的待用回执一起清掉）
        const current = pendingReceipt.get(session)
        if (current?.fence === fence) pendingReceipt.delete(session)
        if (activeFence === fence) activeFence = 0
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
        // 分位总体太小而走降级时的说明；为空即正常走相对分位（issue #27 的可观测出口）
        quantileNote: report.quantileNote ?? null,
        selection: report.selection == null ? null : {
          skippedTail: report.selection.skippedTail,
          skippedTool: report.selection.skippedTool,
          skippedVerdict: report.selection.skippedVerdict,
          skippedGuard: report.selection.skippedGuard,
          skippedText: report.selection.skippedText,
          skippedReasoning: report.selection.skippedReasoning,
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
    // P0-3：判定链条的最外层计数。没有它时，"一次性零判定"无法区分
    // 「事件没触发」/「提前 return」/「门控跳过」——三者的排查方向完全不同。
    stats.preStepEvents = (stats.preStepEvents ?? 0) + 1
    // 双保险：如果 apply() 时服务还没就绪，每次 pre-step 再试一次。
    // 依赖时序这种东西不该让插件"看起来加载成功、实际什么都没做"。
    if (!takeover.installed) installPrunerOverride()
    if (!summaryHook.installed) installSummaryHook()
    if (judge.ready === false) {
      stats.errors += 1
      stats.lastNote = '未配置 TYPESAFE_API_KEY，跳过判定'
      writeHeartbeat()
      return next()
    }
    try {
      // signal 透传（issue #9）：中断后判定请求要能被取消，而不是继续占连接/计费
      await judgePass(agent, signal)
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
    // P0-3：**每步必落盘**。此前只有「判定真的跑了 / 压缩真的做了」才写心跳——
    // 于是「门控跳过 / 没有候选 / session 形态不对」这类最需要排查的路径恰好不落盘，
    // 文件里永远是启动快照（实测踩坑：softLimit 未到时 bootedAt==now，
    // 外部无法区分「事件没触发」和「触发了但门没开」）。合并写下每步一次写成本可接受。
    writeHeartbeat()
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
      `DSH 版本: ${dshVersion}（针对 ${TESTED_DSH_VERSION} 测试）`
        + (dshVersionMatches === false
          ? '  ⚠️ 版本系列不匹配——事件字段可能已变，请先跑一次 jev_probe_shapes 核对'
          : ''),
      `第一层 模式=${cfg.keepMode}${cfg.keepMode === 'budget'
        ? `（压力分位：裁掉池子总增益的「压力缺口比例」，由 judgePass 每轮自动计算；保护上限 prob≥${cfg.keepThreshold}）`
        : `（绝对阈值 keep≥${cfg.keepThreshold}）`}   preserveRecent=${cfg.preserveRecent}   minChars=${cfg.minCharsToPrune}   摘录=${cfg.resultExcerptChars}字符`,
      // 越界配置被钳制时必须显式列出：否则"我配了却没生效"会被误当成插件 bug（issue #28）
      ...(cfg[CONFIG_WARNINGS]?.length > 0
        ? [`⚠️ 配置修正 ${cfg[CONFIG_WARNINGS].length} 处（越界值已被钳制，实际生效值见上）：`,
          ...cfg[CONFIG_WARNINGS].map((w) => `    · ${w}`)]
        : []),
      `第一层：判定 ${stats.judged} 次 / 请求 ${stats.requests} 次   `
        + `Jev 保留 ${stats.keptByJev} / Jev 裁掉 ${stats.prunedByJev} / 按体积兜底裁 ${stats.prunedByVolume}`
        + `（最近区保护 ${stats.keptByTail} / 黑名单保护 ${stats.keptByBlacklist} / 预算用尽保留 ${stats.keptByBudget} 不计入 Jev）`,
      // P0-3：概率分布 + 门控快照。这两行是"阈值是否失配 / 门为什么没开"的唯一现场证据，
      // 过去缺失导致 P0-1/P0-1b 只能在外部用探针挖出来。
      probSummary() == null
        ? '第一层：keep 概率分布（暂无样本）'
        : `第一层：keep 概率 P10/P50/P90 = ${probSummary().p10}/${probSummary().p50}/${probSummary().p90}`
          + `（样本 ${probSummary().n}，高于阈值 ${probSummary().aboveKeepThreshold} / 低于 ${probSummary().belowKeepThreshold}）`
          + (probSummary().n >= 10 && probSummary().aboveKeepThreshold === 0 && cfg.keepMode === 'absolute'
            ? '   ⚠️ 全部低于阈值——绝对阈值与 Jev 窄带失配，建议保持 keepMode=budget' : ''),
      stats.lastGate == null
        ? '第一层门控：尚未评估'
        : `第一层门控：used=${stats.lastGate.used}（measured=${stats.lastGate.measured}）`
          + ` / 窗口=${stats.lastGate.windowTokens ?? '未知'} / 阈值=${stats.lastGate.threshold ?? '算不出'}`
          + `   ${stats.lastGate.skip ? `本次跳过：${stats.lastGate.reason}` : '已放行'}`,
      stats.lastBudget == null
        ? '第一层预算：尚未裁剪'
        : `第一层预算：${stats.lastBudget.note}`,
      // 口径：stats.skipped 累加的是**候选个数**（`+= fresh.length`），不是事件次数。
      // 这里的量词必须写"个"，否则 7 个候选被同一道门挡下会显示成"跳过 7 次"，
      // 与旁边同为计数的 `errors N 次`、以及事件计数的 `judgePassSkipped` 混淆。
      `第一层：累计省下 ${stats.savedChars} 字符   压力门控跳过候选 ${stats.skipped} 个   错误 ${stats.errors} 次`,
      // P0-3 记下的"为什么一次都没判定"此前只落进心跳 JSON，人类可读的这份报告里没有——
      // 而 judged=0 时它恰恰是唯一有价值的一行：不引用它，「门没开 / 没有候选 /
      // session 形态不对」三者完全不可区分，只能靠猜。仅在"零判定且确实跳过过"时出现。
      ...((stats.judged ?? 0) === 0 && (stats.judgePassSkipped ?? 0) > 0
        ? [`判定 pass：已跳过 ${stats.judgePassSkipped} 次；最近原因：${stats.lastJudgeSkipReason ?? '（未记录）'}`]
        : []),
      // 批次失败与重试计数只在异常时出现（issue #34）：常态下不该占版面。
      // 口径修正（PR #28 review）：这里要的是"最近一次 pass 重试了几次"（lastRetries），
      // 而不是 client 从建起来到现在的累计量——后者一旦抖动过就永久 >0，
      // 会让这一行在之后每一份报告里都出现，且数字只增不减。
      ...(stats.judgeBatchFailures > 0 || judge.lastRetries > 0
        ? [`判定请求：重试 ${judge.lastRetries ?? 0} 次   失败批次 ${stats.judgeBatchFailures} 个`
          + (judge.lastError ? `   最近错误：${judge.lastError}` : '')]
        : []),
      // 累计重试只在真的发生过时出现，且与上面区分开，避免把历史当成现状
      ...(judge.retries > 0 && judge.lastRetries === 0
        ? [`判定请求：本 pass 无重试（本会话累计重试 ${judge.retries} 次、累计请求 ${judge.requests} 次）`]
        : []),
      `第二层：summarize=${summaryHook.installed ? '已接管' : `未接管(${summaryHook.reason || '未尝试'})`}   `
        + `compactOn=${cfg.compactOn}   ${cfg.compactMode}${cfg.compactMode === 'relative' ? `(quantile=${cfg.compactQuantile})` : `(<${cfg.compactThreshold})`}`,
      `第二层：回执压缩 ${stats.compactions} 段 / 移出 ${stats.compactedSeqs} 节点 / 省约 ${stats.compactedChars} 字符   `
        + `回执摘要被消费 ${stats.receiptSummaries} 次   压力跳过 ${stats.compactSkipped} 次`
        // 竞态计数只在非零时出现：它是异常路径，常态下不该占版面（issue #29）
        + (stats.receiptFenceMisses > 0
          ? `   ⚠️ 回执因并发压缩被抢 ${stats.receiptFenceMisses} 次（已退回模型摘要，未污染他人区间）`
          : ''),
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
    // 降级模式单独一行说明：与"未执行"分开，因为降级**可能仍然成功压缩了**（issue #27）
    if (report.quantileNote) lines.push(`分位说明：${report.quantileNote}`)
    if (report.selection) {
      const s = report.selection
      lines.push(`排除计数：最近区 ${s.skippedTail} / 工具不允许 ${s.skippedTool} / 判定不通过 ${s.skippedVerdict}`
        + ` / 证据守卫 ${s.skippedGuard} / 结论文本过长 ${s.skippedText} / 思考草稿过长 ${s.skippedReasoning}`
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
        // prob 可能是 null（Jev 只回了两轴之一，judgePass 容忍这种情况）——
        // 此前直接 .toFixed() 抛 TypeError，而裁剪其实已经执行完了（issue #3）
        const judgedSeqs = [...cache.entries()].map(([seq, v]) =>
          `s${seq}:${v.keep ? '保留' : '裁'}(${typeof v.prob === 'number' ? v.prob.toFixed(2) : 'n/a'})`)
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
          // P0-3 记下的"为什么没判定"此前只落进心跳 JSON，人类可读的状态里看不到——
          // 而"judged=0 时无法区分门没开/没有候选/session 形态不对"正是它要解决的。
          // 这两个字段是唯一的事实来源，就地引用，不要再让使用者去猜。
          const skipCount = stats.judgePassSkipped ?? 0
          if (skipCount > 0) {
            lines.push(`判定 pass 已跳过 ${skipCount} 次；最近原因：${stats.lastJudgeSkipReason ?? '（未记录）'}`)
          }
          if (stats.lastGate?.skip === true) {
            lines.push(`压力门快照：used=${stats.lastGate.used} measured=${stats.lastGate.measured}`
              + ` window=${stats.lastGate.windowTokens} threshold=${stats.lastGate.threshold ?? '算不出'}`
              + `（${stats.lastGate.reason || '未知'}）`)
          }
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
