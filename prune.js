/**
 * prune.js —— 裁剪机制（纯函数）。从 index.js 抽出来是为了能单测：
 * index.js 要 import DSH 的包，导致里面的逻辑在 DSH 环境外根本跑不起来，
 * 而"按码点切、标记只插一次、非文本块保序"这些恰恰最容易写错。
 *
 * 与 DSH 自带裁剪器（@deepseek-ai/dsh-compaction-tool-result-pruner）同口径：
 *   · 按 **Unicode 码点** 切，不按 UTF-16 code unit —— 否则会把代理对劈成半个字符
 *   · 标记插在被移除区间的**第一个相交文本块**里，且只插一次
 *   · 非文本块原样保留、保持顺序
 */

/** 我们插入的裁剪标记。用来识别"已经裁过"，避免重复判定。 */
export const JEV_PRUNE_MARKER =
  '\n[… Jev 判定该工具结果已过期，中间内容已裁剪；原始事件仍在会话日志中，可重跑工具 …]\n'

/** 文本块的总码点数。非文本块计 0（与 DSH 的 measureContent 一致）。 */
export function countChars(blocks) {
  if (!Array.isArray(blocks)) return 0
  let chars = 0
  for (const block of blocks) {
    if (block?.type === 'text' && typeof block.text === 'string') chars += Array.from(block.text).length
  }
  return chars
}

/**
 * 工具名归一化：小写 + 去掉下划线与连字符。
 *
 * 为什么放在 prune.js（依赖链的最底层）：**两层的安全黑名单都必须用它**。
 * 外部审查抓到的真 bug：第一层 `neverPruneTools.includes(tool)` 是字面比较，
 * 默认值是 PascalCase（'Edit'），而真实 DSH 的工具名是全小写（edit/write）——
 * 结果"改写类永不裁剪"这条承诺在第一层静默失效（第二层修了，第一层漏了）。
 * 归一化后 'Edit'/'edit'、'MultiEdit'/'multi_edit'、'ApplyPatch'/'apply_patch' 都等价。
 */
export function normalizeToolName(name) {
  return String(name ?? '').trim().toLowerCase().replace(/[_-]/g, '')
}

/** 名字是否在列表里（归一化比较；空名单/空名字一律 false）。 */
export function isToolIn(list, name) {
  const needle = normalizeToolName(name)
  if (needle.length === 0) return false
  return (list ?? []).some((item) => normalizeToolName(item) === needle)
}

/**
 * 把 blocks 的中间挖掉，保留头 headChars 与尾 tailChars，中间插入 marker。
 *
 * @param {Array} blocks 内容块数组
 * @param {number} headChars 保留的头部码点数
 * @param {number} tailChars 保留的尾部码点数
 * @param {string} marker 插入的标记文本
 * @param {number} minGain 至少省下这么多码点才值得动手（不足则返回 null）
 * @returns {Array|null} 裁剪后的块数组；不值得裁时返回 null
 */
export function sliceWithBudget(blocks, headChars, tailChars, marker, minGain = 40) {
  if (!Array.isArray(blocks) || blocks.length === 0) return null
  const totalChars = countChars(blocks)
  const overhead = Array.from(marker).length
  // 省下来的还不够标记本身占的地方 → 不动手
  if (totalChars - (headChars + tailChars) < Math.max(minGain, overhead)) return null

  const removedStart = headChars
  const removedEnd = totalChars - tailChars
  const out = []
  let consumed = 0
  let markerInserted = false

  for (const block of blocks) {
    if (block?.type !== 'text' || typeof block.text !== 'string') {
      out.push(block) // 非文本块保序原样保留
      continue
    }
    const points = Array.from(block.text) // 码点数组，不是 UTF-16 单元
    const blockStart = consumed
    const blockEnd = blockStart + points.length
    const headEnd = Math.min(points.length, Math.max(0, removedStart - blockStart))
    const tailStart = Math.min(points.length, Math.max(0, removedEnd - blockStart))
    const intersects = blockStart < removedEnd && blockEnd > removedStart
    const useMarker = intersects && !markerInserted ? marker : ''
    if (useMarker.length > 0) markerInserted = true
    const text = points.slice(0, headEnd).join('') + useMarker + points.slice(tailStart).join('')
    if (text.length > 0) out.push({ ...block, text })
    consumed = blockEnd
  }

  if (!markerInserted) return null // 没有真正挖掉任何东西
  const after = countChars(out)
  if (after >= totalChars) return null // 显式不变量：裁剪后必须更短
  return out
}

/** 触发条件解析："55%" → 窗口比例；"154000" → 绝对 token 数。 */
export function parseLimit(raw) {
  const text = String(raw).trim()
  if (text.endsWith('%')) {
    const value = Number(text.slice(0, -1))
    if (!Number.isFinite(value) || value <= 0 || value > 100) throw new Error(`invalid limit ${raw}`)
    return { kind: 'ratio', value: value / 100 }
  }
  const value = Number(text)
  if (!Number.isFinite(value) || value <= 0) throw new Error(`invalid limit ${raw}`)
  return { kind: 'tokens', value }
}

/**
 * 单个节点的裁决。抽成纯函数是为了能穷举测试——这是全插件最容易写错的地方，
 * 四个分支的优先级错了就会误删承重内容。
 *
 * 优先级（从上到下，先命中先返回）：
 *   1. 落在最近区（含正在进行的调用）  → keep（永不触碰）
 *   2. 工具在 neverPruneTools 里        → keep
 *   3. Jev 说还要                       → keep（哪怕它很大 —— DSH 会误删这类）
 *   4. Jev 说过期                       → prune（哪怕它不大 —— DSH 完全不碰这类）
 *      · 但短于 minCharsToPrune 时不裁（省不到东西、还丢信息）
 *   5. 没有判定                         → fallback（退回 DSH 原来的按体积裁决）
 */
export function decideAction({ inTail, tool, neverPruneTools, verdict, charsBefore, minCharsToPrune }) {
  if (inTail) return 'keep'
  // 归一化比较（外部审查回归）：真实 DSH 的工具名是小写 edit/write，
  // 字面 includes 对 PascalCase 黑名单永远不命中 → "改写类永不裁剪"静默失效
  if (isToolIn(neverPruneTools, tool)) return 'keep'
  if (verdict == null) return 'fallback'
  if (verdict.keep) return 'keep'
  if (charsBefore < minCharsToPrune) return 'keep'
  return 'prune'
}

/**
 * 逐节点扫描 surface 并落地裁剪。
 *
 * 依赖全部注入（pruner / freeze / toolNameOf / callIdOf），所以可以脱离 DSH 单测。
 *
 * ⚠️ shadow-price 协议与 DSH 自带实现**逐字一致**：先把 `compaction/prune` 事件
 * 与替换事件**紧邻 append**，纯消费者才能按同一套账本扣减 token。
 *
 * @returns {{pruned: Array, charsRemoved: number}}
 */
export function pruneSessionWithJev({ pruner, session, cache, cfg, stats, freeze, toolNameOf, callIdOf }) {
  const surface = [...session.surface.nodes]
  const lastAllowed = surface.length - 1 - cfg.preserveRecent
  const pruned = []
  let charsRemoved = 0

  for (let index = 0; index < surface.length; index += 1) {
    const seq = surface[index]
    const event = session.eventAt(seq)
    if (event?.type !== 'tool/result') continue

    const original = session.deriveEventMessage(event)
    const result = original?.content?.[0]
    if (result == null || result.type !== 'tool-result') continue

    const blocks = result.content
    const charsBefore = countChars(blocks)
    const tool = toolNameOf(event)
    const verdict = cache?.get(seq) ?? null

    const action = decideAction({
      inTail: index > lastAllowed,
      tool,
      neverPruneTools: cfg.neverPruneTools,
      verdict,
      charsBefore,
      minCharsToPrune: cfg.minCharsToPrune,
    })

    // keep 的三个来源分开计数（issue #8）：此前落在最近区/黑名单保护的节点
    // 都被记进 keptByJev——"Jev 保留"虚高，而真正的硬规则保护在统计里完全不可见，
    // 用户拿这行数字判断"Jev 的判断在起作用吗"会得出错误结论。
    if (action === 'keep') {
      if (index > lastAllowed) stats.keptByTail += 1
      else if (isToolIn(cfg.neverPruneTools, tool)) stats.keptByBlacklist += 1
      else if (verdict?.keep) stats.keptByJev += 1
    }

    let content = null
    if (action === 'prune') {
      content = sliceWithBudget(blocks, cfg.headChars, cfg.tailChars, cfg.marker ?? JEV_PRUNE_MARKER)
      if (content != null) stats.prunedByJev += 1
    } else if (action === 'fallback') {
      content = pruner.pruneContent(blocks)
      if (content != null) stats.prunedByVolume += 1
    }

    if (content == null) continue
    const charsAfter = countChars(content)
    if (charsAfter >= charsBefore) continue

    if (cfg.dryRun) {
      charsRemoved += charsBefore - charsAfter
      continue
    }

    const message = freeze({ ...original, content: [{ ...result, content }] })
    appendShadowPrice({ pruner, session, seq, original })
    const replacement = session.append(
      'tool/result',
      { ...event.data, message },
      { surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq] },
    )
    pruned.push({
      originalSeq: seq,
      replacementSeq: replacement?.seq ?? null,
      callId: callIdOf(event),
      charsBefore,
      charsAfter,
    })
    charsRemoved += charsBefore - charsAfter
  }

  stats.savedChars += charsRemoved
  return { pruned, charsRemoved }
}

function appendShadowPrice({ pruner, session, seq, original }) {
  let tokens = 0
  try {
    tokens = pruner.ctx?.tokenMeter?.estimateMessage?.(original) ?? 0
  } catch {
    tokens = 0
  }
  session.append('compaction/prune', {
    shadowedRange: { start: seq, end: seq },
    shadowedSeqs: [seq],
    shadowedTokenCount: tokens,
  })
}
