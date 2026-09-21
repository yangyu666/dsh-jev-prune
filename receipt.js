/**
 * receipt.js —— 第二层：**整对调用的「回执压缩」**（纯函数，无 DSH 依赖）。
 *
 * 第一层（prune.js）只裁工具结果的**正文**，调用记录与结果的外壳都留着。
 * 这一层把**整个工具调用对**（assistant 消息里的 tool-call + 对应的 tool/result）
 * 移出 surface，用一个**确定性回执**顶替原本由模型写的摘要。
 *
 * 为什么值得做：
 *   DSH 自带的压缩会让主模型读原始历史、**写一段摘要**。摘要会幻觉——它可能写出
 *   「我们确认了 bug 在 X」这种历史里并没有的断言。而回执的每一行都是代码算出来的
 *   事实（工具名、命令、路径、字符数、seq），**不可能包含模型推断**。
 *   代价是它不解释、不总结——它是一个**可索引的收据**，不是一个摘要。
 *
 * 为什么敢删整对：
 *   ① 原始事件仍在会话日志里（`compactRegion` 只把它们移出 surface，不销毁）
 *   ② 回执**逐字记录了命令/路径**，所以"发生过什么副作用"这个事实不会丢
 *   ③ 只处理只读探查类工具，且 Jev 必须同时判定"结果可丢"且"没有副作用"
 *
 * 为什么不能随便删（实测教训，见 README）：
 *   · `Edit`/`Write` 这类改写型调用是承重信息，判错一次就丢失关键改动 → 硬规则排除
 *   · 含 error/assert/fail 等**证据词**的结果可能正是根因所在 → 证据守卫生效时不删
 *   · 落在最近 preserveRecent 个节点内的（含正在进行的调用）→ 一律不碰
 *   · 有**副作用**的调用（写文件、提交、安装、删除）→ 结果可能很短，但"发生过"是承重的
 *
 * 工具配对平衡：镜像 DSH 的 `@deepseek-ai/dsh-compaction/tool-pairing`。
 * `compactRegion` 会在服务端再做一次同样的校验并抛错；我们自己先算一遍，
 * 是为了**在花钱之前**就把非法范围筛掉，而不是等 API 报错。
 */

import { countChars, isToolIn, normalizeToolName } from './prune.js'

// 归一化工具在 prune.js（依赖链最底层）——两层的安全黑名单共用同一套比较。
// 这里转出以保持既有 import 路径（check.js / 调用方）不变。
export { isToolIn, normalizeToolName }

/** 回执文本的识别前缀（用于判断某个 checkpoint 是不是我们写的）。 */
export const RECEIPT_MARKER = '[已压缩 · 确定性回执]'

/**
 * 真实 DSH 只读探查类工具名（**取证得到，不是猜的**：解压会话日志读到的是 `read` / `glob` / `grep`）。
 *
 * ⚠️ **刻意不含 shell**（`pwsh` / `bash` / `sh` / `shell`）：shell 能做任何事，
 * `pwsh: Remove-Item important.txt` 就是合法调用 —— 外部审查复现过这个案例。
 * "整对移出 shell 调用"不是只读安全操作，哪怕回执逐字记录了命令。
 *
 * 这份清单就是 `DEFAULT_COMPACT_TOOLS` 的内容（默认生效）。
 * 想放宽就把它配成 `[]`（只受 neverCompactTools 约束）—— 那是显式 opt-in 的不安全模式。
 *
 * 历史教训（保留给维护者）：我最初把 Claude Code 风格的 PascalCase 名字当默认白名单，
 * 在真实 DSH 里**命中 0/11** —— 第二层静默地永不触发。所以白名单比较必须走
 * `normalizeToolName`，且命中/拦截的名字都要进 `selectReceiptRanges` 的 stats 上报，
 * 让"白名单没配上"可观测。
 */
export const DSH_READONLY_TOOLS = [
  'read', 'view', 'cat', 'glob', 'grep', 'list', 'ls', 'search', 'find', 'tree', 'stat',
  'fetch', 'websearch', 'web_search',
  'getcontent', 'getchilditem', 'getitem', 'selectstring', 'testpath', 'measureobject', 'resolvepath',
]

/** 默认白名单 = 上面的只读工具集（安全默认）。设为 `[]` 可放宽为只受黑名单约束。 */
export const DEFAULT_COMPACT_TOOLS = [...DSH_READONLY_TOOLS]

/** 永不整对移出的工具：改写型调用是承重信息（第一版实测 Jev 误删过 Edit）。比较时归一化。 */
export const DEFAULT_NEVER_COMPACT_TOOLS = [
  'Edit', 'Write', 'MultiEdit', 'ApplyPatch', 'NotebookEdit',
  'str_replace_editor', 'str_replace_based_edit_tool', 'apply_patch',
]

/**
 * 证据守卫的默认词表。命中即**不整对删除**（仍允许第一层截断，那是有损但可逆的）。
 * 方向性说明：这里宁可误守（少省一点）也不能漏守（丢证据）。
 * 命中数量会如实上报到状态里，如果发现守得过宽可以直接改配置。
 * 匹配口径见 scanEvidence —— 要求命中落在标识符段开头，所以 `bug` 不会被 `debug` 触发。
 */
export const DEFAULT_EVIDENCE_PATTERNS = [
  'error', 'exception', 'traceback', 'stack trace', 'assertion',
  'failed', 'fail:', 'panic', 'unexpected', 'mismatch',
  'todo', 'fixme', 'bug',
]

// ---------------------------------------------------------------- 工具配对平衡

/** 一个 surface 事件对"未闭合工具调用数"的增量（与 DSH 同口径）。 */
export function eventDelta(event) {
  if (event?.type === 'assistant/message') {
    const content = event.data?.message?.content
    if (!Array.isArray(content)) return 0
    return content.filter((block) => block?.type === 'tool-call').length
  }
  if (event?.type === 'tool/result') return -1
  return 0
}

/**
 * 计算每个切点的平衡性。N 个 surface 节点有 N+1 个切点：
 * 下标 i 表示"第 i 个节点之前"的切点，下标 N 表示"尾部之后"。
 *
 * @returns {Array<{balanced:boolean, inProgress:number}>} 长度为 N+1
 * @throws 当 surface 损坏（节点的 seq 无对应事件 / 出现无主的 tool/result）时
 */
export function computeCuts(surface, eventAt) {
  const cuts = [{ balanced: true, inProgress: 0 }]
  let inProgress = 0
  for (const seq of surface) {
    const event = eventAt(seq)
    if (event == null || event.seq !== seq) {
      throw new Error(`tool-pairing: surface seq ${seq} 没有对应的会话事件（surface 损坏）`)
    }
    inProgress += eventDelta(event)
    if (inProgress < 0) {
      throw new Error(`tool-pairing: surface seq ${seq} 的 tool/result 没有对应的 tool-call（surface 损坏）`)
    }
    cuts.push({ balanced: inProgress === 0, inProgress })
  }
  return cuts
}

/** 第 index 个节点之前的切点是否平衡（等价于 DSH 的 toolPairingBalancedBefore）。 */
export function balancedBefore(cuts, index) {
  return cuts[index]?.balanced === true
}

/** 第 index 个节点之后的切点是否平衡（等价于 DSH 的 toolPairingBalancedAfter）。 */
export function balancedAfter(cuts, index) {
  return cuts[index + 1]?.balanced === true
}

// ---------------------------------------------------------------- 事件解析

/** assistant 消息里的 tool-call 块（带 seq 以便定位）。 */
function toolCallsOf(event) {
  if (event?.type !== 'assistant/message') return []
  const content = event.data?.message?.content
  if (!Array.isArray(content)) return []
  return content.filter((block) => block?.type === 'tool-call')
}

/**
 * assistant 消息里的文本长度（用于"这段推理不该被吞掉"的门控）。
 *
 * ⚠️ 必须把 `reasoning` 块算进来：实测 DSH 的 assistant 消息块是
 * `[reasoning, tool-call]`（模型把思考写在 reasoning 里，text 常常只有一句"看一下。"）。
 * 只数 text 会让这个门控形同虚设——一条思考了两千字的步骤会被当成纯探查删掉。
 */
function assistantTextChars(event) {
  const content = event.data?.message?.content
  if (!Array.isArray(content)) return 0
  let chars = 0
  for (const block of content) {
    if ((block?.type === 'text' || block?.type === 'reasoning') && typeof block.text === 'string') {
      chars += Array.from(block.text).length
    }
  }
  return chars
}

/** tool-call 块的 id（不同版本字段名不同，逐个容忍）。
 *  已删除：callBlockId 此前导出但全仓无引用（issue #14 死代码）。 */

/**
 * 把一次调用的入参渲染成一行可读文本。
 *
 * 先取"最有信息量"的字段（命令 / 路径 / 模式），再补上**取值很短的其它字段**
 * （例如 Bash 的 `cwd`）—— 后者对"能不能重跑这条命令"是必要的，不该被静默丢掉。
 * 体积型字段（正文/替换内容/子任务提示词）刻意跳过：那些是载荷，不是可复现性信息。
 */
const ARG_PRIORITY = ['command', 'file_path', 'notebook_path', 'pattern', 'query', 'path', 'url', 'glob']
const ARG_IGNORED = new Set(['content', 'old_string', 'new_string', 'prompt', 'description'])
const ARG_SECONDARY_MAX_CHARS = 40

export function renderCallArgs(block, maxChars = 120) {
  let args = block?.arguments
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args)
    } catch {
      return clip(args, maxChars)
    }
  }
  if (args == null) return ''
  if (typeof args !== 'object') return clip(String(args), maxChars)

  const parts = []
  const used = new Set()
  for (const key of ARG_PRIORITY) {
    if (args[key] == null) continue
    parts.push(String(args[key]))
    used.add(key)
    if (parts.length >= 3) break
  }
  if (parts.length < 3) {
    for (const [key, value] of Object.entries(args)) {
      if (used.has(key) || ARG_IGNORED.has(key) || value == null) continue
      const text = String(value)
      if (text.length > ARG_SECONDARY_MAX_CHARS) continue
      // 次要字段带 key 前缀：不写 key 的话，光看值不知道它是哪个参数
      parts.push(`${key}=${text}`)
      if (parts.length >= 3) break
    }
  }
  if (parts.length === 0) {
    // 没有任何可用字段（全是载荷型）→ 整体序列化，至少让形状可见
    return clip(JSON.stringify(args), maxChars)
  }
  return clip(parts.join(' '), maxChars)
}

function clip(text, maxChars) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim()
  const points = Array.from(value)
  if (points.length <= maxChars) return value
  return `${points.slice(0, maxChars).join('')}…`
}

// ---------------------------------------------------------------- 证据守卫

/**
 * 找出文本命中的证据词。
 *
 * 匹配口径：命中必须落在**一个标识符段的开头** —— 串首、非字母数字之后，
 * 或者驼峰分界（小写字母之后的大写开头）。这样：
 *   · `TypeError` 里的 `error` 命中（真证据）
 *   · `debug` / `__debug__` / `this.debug` 里的 `bug` **不**命中（子串误报，issue #1）
 * 为什么不是"整词匹配"（词首词尾都要求边界）：那会让 `errors`、`bugfix`、
 * `failures` 这类真证据一起漏掉，而本守卫的方向性是宁可误守也不能漏守。
 * 代价是 `myerror` 这种无分隔符的复合标识符不再命中 —— 与 `debug` 同类，属于有意取舍。
 *
 * @returns {{hit:boolean, matches:string[]}}
 */
export function scanEvidence(text, patterns) {
  const haystack = String(text ?? '') // 保持原始大小写：驼峰分界只能对原文判定
  const matches = []
  for (const pattern of patterns ?? []) {
    const needle = String(pattern).toLowerCase()
    if (needle.length === 0) continue
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const atSegmentStart = new RegExp(`(?<=^|[^A-Za-z0-9])${escaped}`, 'i')
    const camelFirst = escaped.charAt(0).toUpperCase() + escaped.slice(1)
    const atCamelBoundary = new RegExp(`(?<=[a-z])${camelFirst}`)
    if (atSegmentStart.test(haystack) || atCamelBoundary.test(haystack)) matches.push(needle)
  }
  return { hit: matches.length > 0, matches }
}

// ---------------------------------------------------------------- 相对分位门控
/**
 * **为什么不能用一个固定的绝对阈值**（开发期实测，数据未随仓库提交，结论与 README 一致）：
 *
 *   在 10 个真假已知的调用上（5 个有副作用、5 个纯只读）：
 *     轴        有副作用组均值   纯只读组均值   间距      排序正确率
 *     result       0.076          0.160      -0.084        0%
 *     effect       0.274          0.068      +0.206      100%
 *
 *   effect 轴的**排序是完美的**（有副作用组最低 0.220 > 只读组最高 0.080），
 *   但**所有值都落在 0.5 以下** —— 拿 0.5 当阈值会把 10 条全判成"无副作用"。
 *   这是 Jev 概率被压在一个窄带里的必然结果（同 dsh-compact 实测：分布密集区
 *   不能放阈值）。所以第二层用**相对分位**：只在"本次会话已判定集合"的尾部取。
 *
 * 另一条实测结论：`result` 轴被**体量**污染（只读结果往往更大，于是"要保留"的分更高）。
 * 相对分位能抵消掉一部分全局偏置，但不能抵消这种相关性——所以两轴取**交集**
 * （必须同时在两轴的尾部），而不是取并集。
 *
 * @param {Array<{seq:number, prob?:number, effectProb?:number}>} verdicts
 * @param {{quantile:number, minCandidates:number}} options
 * @returns {Set<number>} 同时落在两轴尾部 quantile 的 seq 集合
 * @throws quantile 非法时抛错（issue #6：此前 NaN/undefined 会静默返回空集——
 *   第二层"功能静默死亡"，而 compactPass 还会把它渲染成"样本不够"，误导排查）
 */
export function computeEligibleSeqs(verdicts, { quantile, minCandidates }) {
  if (!Number.isFinite(quantile) || quantile < 0 || quantile > 1) {
    throw new Error(`compactQuantile 非法：${quantile}（必须是 0~1 的有限数值；配置留空/解析成 null 都会走到这里）`)
  }
  const usable = (verdicts ?? []).filter(
    (v) => typeof v?.prob === 'number' && typeof v?.effectProb === 'number',
  )
  // 相对分位需要一个总体；样本太小则排序没有意义 → 宁可不做
  if (usable.length < Math.max(2, minCandidates ?? 4)) return new Set()

  // quantile=0 的语义是字面意义"一条不取"（issue #6：此前 Math.max(1,…) 会反而取 1 条）
  const take = quantile === 0 ? 0 : Math.max(1, Math.floor(usable.length * quantile))
  if (take === 0) return new Set()
  const tailOf = (key) => new Set(
    [...usable]
      .sort((a, b) => (a[key] - b[key]) || (a.seq - b.seq))
      .slice(0, take)
      .map((v) => v.seq),
  )
  const byResult = tailOf('prob')
  const byEffect = tailOf('effectProb')
  return new Set([...byResult].filter((seq) => byEffect.has(seq)))
}

// ---------------------------------------------------------------- 范围选择

/** 一个"步骤"= assistant 消息（含 ≥1 个 tool-call）+ 紧随其后的 1:1 tool/result。 */
function readStep(surface, eventAt, headIdx) {
  const headSeq = surface[headIdx]
  const head = eventAt(headSeq)
  const calls = toolCallsOf(head)
  if (calls.length === 0) return null

  const resultIdx = []
  for (let offset = 1; offset <= calls.length; offset += 1) {
    const idx = headIdx + offset
    if (idx >= surface.length) return { headIdx, headSeq, head, calls, resultIdx, complete: false }
    if (eventAt(surface[idx])?.type !== 'tool/result') {
      return { headIdx, headSeq, head, calls, resultIdx, complete: false }
    }
    resultIdx.push(idx)
  }
  return { headIdx, headSeq, head, calls, resultIdx, complete: true }
}

/**
 * 挑出可以整对移出的范围（连续步骤合并成一段）。
 *
 * 依赖全部注入，所以能脱离 DSH 单测。
 *
 * @param {object} input
 * @param {number[]} input.surface surface 上的 seq 列表
 * @param {(seq:number)=>object} input.eventAt seq → 事件
 * @param {Map<number,object>} input.cache 判定缓存：**按工具结果 seq** 索引
 * @param {(seq:number, verdict:object)=>boolean} input.dropVerdict 判定"这条可以整对移出"
 * @param {(event:object)=>string} input.toolNameOf
 * @param {object} input.cfg 见下面用到的字段
 * @returns {{ranges:Array, stats:object}}
 */
export function selectReceiptRanges({ surface, eventAt, cache, dropVerdict, cfg }) {
  const stats = {
    scanned: 0,
    steps: 0,
    eligibleSteps: 0,
    skippedTail: 0,
    skippedTool: 0,
    /**
     * 被工具规则排除的**调用名统计**。
     *
     * 为什么必须记这个：第二层用的是**白名单**，一旦真实工具名与默认白名单对不上
     * （各宿主的命名风格差很多：Read / read / fs_read / Get-Content…），
     * 整个功能会**静默地永不触发**——第一层用黑名单所以一直没暴露这个问题。
     * 把名字如实统计出来并上报，才能一眼看出"是白名单没配上"而不是"模型判断不对"。
     */
    blockedToolNames: {},
    allowedToolNames: {},
    skippedToolUnknown: 0,
    skippedVerdict: 0,
    skippedGuard: 0,
    skippedText: 0,
    skippedIncomplete: 0,
    skippedShort: 0,
    guardHits: [],
  }
  const cuts = computeCuts(surface, eventAt)
  const lastAllowed = surface.length - 1 - cfg.preserveRecent

  const steps = []
  let index = 0
  while (index < surface.length) {
    stats.scanned += 1
    const step = readStep(surface, eventAt, index)
    if (step == null) {
      index += 1
      continue // 不是步骤头（user 消息 / 纯文本 assistant / checkpoint）
    }
    stats.steps += 1
    steps.push(step)
    // 无论是否合格都跳到这一步的末尾，避免把同一个调用数两遍。
    // ⚠️ 这里必须用**位置**推进，不能用 seq 值 —— 一旦发生过 surface 替换
    // （我们的第一层裁剪就会替换），seq 就不再等于「位置+1」了。
    index = step.resultIdx.length > 0 ? step.resultIdx[step.resultIdx.length - 1] + 1 : index + 1
  }

  const eligible = []
  for (const step of steps) {
    const lastResultIdx = step.resultIdx[step.resultIdx.length - 1] ?? step.headIdx
    const resultSeqs = step.resultIdx.map((idx) => surface[idx])
    let reason = null

    if (!step.complete) reason = 'incomplete'
    else if (!balancedBefore(cuts, step.headIdx) || !balancedAfter(cuts, lastResultIdx)) reason = 'incomplete'
    else if (lastResultIdx > lastAllowed || step.headIdx > lastAllowed) reason = 'tail'
    else if (cfg.compactTools.length > 0
      && step.calls.some((call) => !isToolIn(cfg.compactTools, call.name))) reason = 'tool'
    else if (step.calls.some((call) => isToolIn(cfg.neverCompactTools, call.name))) reason = 'tool'
    else if (assistantTextChars(step.head) > cfg.maxStepTextChars) reason = 'text'
    if (reason == null) {
      for (const seq of resultSeqs) {
        const verdict = cache?.get(seq)
        if (verdict == null || !dropVerdict(seq, verdict)) {
          reason = 'verdict'
          break
        }
      }
    }
    let hits = []
    if (reason == null && cfg.evidenceGuard) {
      for (const seq of resultSeqs) {
        const scan = scanEvidence(resultText(eventAt(seq)), cfg.evidencePatterns)
        if (scan.hit) {
          hits = scan.matches
          reason = 'guard'
          break
        }
      }
    }

    if (reason != null) {
      if (reason === 'tail') stats.skippedTail += 1
      else if (reason === 'tool') {
        stats.skippedTool += 1
        // 只记**真正没通过工具门**的那个名字（issue #7）：此前把整步的所有调用名
        // 都记进 blockedToolNames，通过白名单的名字也被列为"被拦下"，用户按
        // jev_probe_shapes 的提示去"补配"一个本来就在白名单里的名字，而真正的
        // 元凶淹没在同一份名单里——这个诊断字段就完成不了它的设计任务。
        const offending = cfg.compactTools.length > 0
          ? step.calls.filter((call) => !isToolIn(cfg.compactTools, call.name))
          : step.calls.filter((call) => isToolIn(cfg.neverCompactTools, call.name))
        for (const call of offending) {
          const name = call.name ?? 'unknown'
          if (name === 'unknown' || name === '') stats.skippedToolUnknown += 1
          stats.blockedToolNames[name] = (stats.blockedToolNames[name] ?? 0) + 1
        }
      } else if (reason === 'verdict') stats.skippedVerdict += 1
      else if (reason === 'guard') {
        stats.skippedGuard += 1
        stats.guardHits.push({ headSeq: step.headSeq, matches: hits })
      } else if (reason === 'text') stats.skippedText += 1
      else stats.skippedIncomplete += 1
      continue
    }

    stats.eligibleSteps += 1
    for (const call of step.calls) {
      const name = call.name ?? 'unknown'
      stats.allowedToolNames[name] = (stats.allowedToolNames[name] ?? 0) + 1
    }
    eligible.push({
      ...step,
      resultSeqs,
      lastResultIdx,
      resultChars: resultSeqs.reduce((sum, seq) => sum + resultCharsOf(eventAt(seq)), 0),
      tools: step.calls.map((call) => call.name ?? 'unknown'),
    })
  }

  // 相邻的合格步骤合并成一段（合并后两端仍然平衡：步骤之间没有别的东西）
  const merged = []
  for (const step of eligible) {
    const previous = merged[merged.length - 1]
    if (previous != null && previous.endIdx + 1 === step.headIdx) {
      previous.steps.push(step)
      previous.endIdx = step.lastResultIdx
      previous.end = surface[step.lastResultIdx]
      previous.chars += step.resultChars
      continue
    }
    merged.push({
      startIdx: step.headIdx,
      endIdx: step.lastResultIdx,
      start: surface[step.headIdx],
      end: surface[step.lastResultIdx],
      steps: [step],
      chars: step.resultChars,
    })
  }

  // 省得不够多的范围不值得开一次压缩事务
  const ranges = []
  for (const range of merged) {
    if (range.chars < cfg.compactMinChars) {
      stats.skippedShort += 1
      continue
    }
    ranges.push(range)
  }
  return { ranges, stats }
}

function resultText(event) {
  const content = event?.data?.message?.content
  if (!Array.isArray(content)) return ''
  const block = content.find((item) => item?.type === 'tool-result')
  const inner = block?.content
  if (!Array.isArray(inner)) return ''
  return inner
    .filter((item) => item?.type === 'text' && typeof item.text === 'string')
    .map((item) => item.text)
    .join('\n')
}

function resultCharsOf(event) {
  const content = event?.data?.message?.content
  if (!Array.isArray(content)) return 0
  const block = content.find((item) => item?.type === 'tool-result')
  return countChars(block?.content)
}

// ---------------------------------------------------------------- 回执渲染

/**
 * 渲染确定性回执。
 *
 * 每一行都是可以核对的**事实**：工具名、命令/路径（逐字截断）、输出字符数、seq。
 * 刻意**不**写任何"我们发现了…""因此…"式的推断句——那正是摘要会幻觉的地方。
 */
export function renderReceipt(range, { eventAt, argChars = 120 } = {}) {
  const lines = []
  const count = range.steps.reduce((sum, step) => sum + step.calls.length, 0)
  lines.push(
    `${RECEIPT_MARKER} 原历史 s${range.start}–s${range.end} 是 ${count} 次工具调用`
    + `（共约 ${range.chars} 字符输出），为释放上下文已移出。以下为事实清单（代码生成，无模型推断）：`,
  )
  for (const step of range.steps) {
    step.calls.forEach((call, offset) => {
      const seq = step.resultSeqs[offset] ?? step.headSeq
      const args = renderCallArgs(call, argChars)
      const chars = resultCharsOf(eventAt(step.resultSeqs[offset]))
      lines.push(`· s${seq} ${call.name ?? 'unknown'}${args ? `：${args}` : ''} → ${chars} 字符输出`)
    })
  }
  lines.push(
    `原始事件仍完整保存在会话日志中（seqs ${range.start}–${range.end}）。`
    + '需要内容时重跑相同命令/读取相同文件即可；本回执不含对内容的解释。',
  )
  return lines.join('\n')
}
