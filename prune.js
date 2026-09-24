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
 *
 * 注意：`keepMode: 'budget'` 时不走这个函数逐节点判——见 `planTrims`。
 * 保留它是为了 `absolute` 模式（旧行为）与既有测试的兼容。
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
 * **预算匹配的裁剪选择**（P0-1）。为什么不是纯相对分位：
 *
 * 纯分位（"每轮裁掉概率最低的 34%"）把两件事耦合成了一个拍脑袋的比例——
 *   · 会话里**所有结果都还有用**时它照样裁（不需要压缩时的动作是纯损失）；
 *   · 比例与"宿主需要腾多少空间"无关（需要省 5% 时裁 34% 是过度，需要 60% 时是不够）。
 *
 * 而 Jev 概率是**窄带**的（实测真实会话 42/42 低于 0.5，中位数 0.13），
 * 绝对阈值同样不可用（"0.5 一刀切"会把所有判定过的结果都判成可裁）。
 *
 * 所以这里换一个正交的分解：
 *   · **裁多少** ← 由既有体积规则决定：`budget = 对 chars > volumeBudgetThresholdChars
 *     的结果，若按我们的 head/tail 规则裁剪本可省下的字符总量`（默认阈值 8192 = DSH 自带
 *     tool-result-pruner 的真实默认值）。体积规则是"该腾多少"的既成事实，不改它；
 *   · **裁哪些** ← 由 Jev 的概率**排序**决定：从最低开始裁，裁到省出的量 ≥ budget 就停；
 *   · 绝对阈值退居**保护上限**：prob ≥ keepThreshold 的一律不进候选池（明显该留的不参与排序）；
 *   · 候选太少（< minCandidatesForBudget）时降级为绝对下限模式（只裁 prob < floorThreshold），
 *     口径与第二层的 floor 分支一致。
 *
 * 于是 `budget = 0`（没有结果超过体积阈值）→ 一条都不裁，这正是"不做无谓动作"的保证。
 *
 * @param {Array<{seq:number,index:number,tool:string,chars:number,gain:number,prob:number|null,
 *   effectProb:number|null,verdict:object|null,inTail:boolean,blacklisted:boolean}>} nodes
 * @param {object} cfg
 * @returns {{mode:string,selected:Set<number>,budget:number,spent:number,poolSize:number,
 *   keptByCeiling:number,note:string}|null} null = 不用预算模式（调用方退回逐节点裁决）
 */
export function planTrims(nodes, cfg = {}) {
  if ((cfg.keepMode ?? 'absolute') !== 'budget') return null
  const keepCeiling = cfg.keepThreshold ?? 0.5
  const floor = cfg.keepFloorThreshold ?? 0.2
  const minCandidates = cfg.minCandidatesForBudget ?? 4
  const minGain = cfg.minGainChars ?? 40
  // 压力缺口比例（judgePass 传入，0~1）：0 = 无缺口不裁，1 = 裁掉池子全部增益。
  // 缺失/非法一律钳到 0（失败方向：解析不出压力就不动手，与两层的门控口径一致）。
  const ratio = Math.min(1, Math.max(0, Number(cfg.pressureRatio) || 0))

  const eligible = nodes.filter((n) => !n.inTail && !n.blacklisted && n.verdict != null
    && n.gain >= minGain && n.chars >= (cfg.minCharsToPrune ?? 400))
  const ceilingProtected = eligible.filter((n) => typeof n.prob === 'number' && n.prob >= keepCeiling)
  // 修 null 排序 bug：prob 缺失（result 轴批次失败）时**不进池子**，更不能被当成 0 优先裁。
  const pool = eligible.filter((n) => typeof n.prob === 'number' && n.prob < keepCeiling)

  if (pool.length === 0) {
    return { mode: 'budget', selected: [], budget: 0, spent: 0, poolSize: 0, keptByCeiling: ceilingProtected.length, ratio, note: '无可裁候选（全部落在保护上限之上或不可裁）' }
  }

  // 小样本：排序没有意义 → 降级为绝对下限（与第二层 floor 分支同口径）
  if (pool.length < minCandidates) {
    const selected = pool.filter((n) => n.prob < floor).map((n) => n.seq)
    const spent = pool.filter((n) => n.prob < floor).reduce((s, n) => s + n.gain, 0)
    return {
      mode: 'floor', selected, budget: 0, spent, poolSize: pool.length, keptByCeiling: ceilingProtected.length, ratio,
      note: `候选仅 ${pool.length} 条（< ${minCandidates}）→ 降级绝对下限：只裁 prob < ${floor} 的 ${selected.length} 条`,
    }
  }

  // 预算 = 压力缺口比例 × 池子总增益。「裁多少」与「能裁的是谁」落在同一个总体（pool），
  // 不再锚定体积规则（那是 #30 自查里"方向反了"的根源）。
  const totalGain = pool.reduce((s, n) => s + n.gain, 0)
  const budget = ratio * totalGain
  if (!(budget > 0)) {
    return { mode: 'budget', selected: [], budget: 0, spent: 0, poolSize: pool.length, keptByCeiling: ceilingProtected.length, ratio, note: `压力缺口为 0（ratio=${ratio}）→ 不裁` }
  }
  const sorted = [...pool].sort((a, b) => (a.prob - b.prob) || (a.seq - b.seq))
  const selected = []
  let spent = 0
  for (const node of sorted) {
    if (spent >= budget) break
    selected.push(node.seq)
    spent += node.gain
  }
  return {
    mode: 'budget', selected, budget, spent, poolSize: pool.length, keptByCeiling: ceilingProtected.length, ratio,
    note: `压力分位 ${(ratio * 100).toFixed(1)}%（预算 ${Math.round(budget)} 字符）→ 从 ${pool.length} 条候选中按概率升序裁 ${selected.length} 条，省 ${spent}`,
  }
}

/**
 * 逐节点扫描 surface 并落地裁剪。
 *
 * 依赖全部注入（pruner / freeze / toolNameOf / callIdOf），所以可以脱离 DSH 单测。
 *
 * ⚠️ shadow-price 协议与 DSH 自带实现**逐字一致**：先把 `compaction/prune` 事件
 * 与替换事件**紧邻 append**，纯消费者才能按同一套账本扣减 token。
 *
 * 两个阶段（P0-1）：先**收集**全部工具结果节点的元数据 → `planTrims` 在全局视野下
 * 决定"裁哪些"（预算模式）→ 再**应用**。绝对模式（keepMode !== 'budget'）保持原有的
 * 逐节点 `decideAction` 行为不变。
 *
 * @returns {{pruned: Array, charsRemoved: number, plan: object|null, decisions: Array}}
 */
export function pruneSessionWithJev({ pruner, session, cache, cfg, stats, freeze, toolNameOf, callIdOf }) {
  const surface = [...session.surface.nodes]
  const lastAllowed = surface.length - 1 - cfg.preserveRecent
  const pruned = []
  let charsRemoved = 0

  // ---- 阶段一：收集（不做任何裁决） ----
  const nodes = []
  for (let index = 0; index < surface.length; index += 1) {
    const seq = surface[index]
    const event = session.eventAt(seq)
    if (event?.type !== 'tool/result') continue
    const original = session.deriveEventMessage(event)
    const result = original?.content?.[0]
    if (result == null || result.type !== 'tool-result') continue
    const blocks = result.content
    const chars = countChars(blocks)
    const marker = Array.from(cfg.marker ?? JEV_PRUNE_MARKER).length
    const gain = chars - (cfg.headChars + cfg.tailChars) - marker
    const tool = toolNameOf(event)
    const verdict = cache?.get(seq) ?? null
    nodes.push({
      seq, index, event, original, result, blocks, chars, gain, tool, verdict,
      inTail: index > lastAllowed,
      blacklisted: isToolIn(cfg.neverPruneTools, tool),
      prob: typeof verdict?.prob === 'number' ? verdict.prob : null,
      effectProb: typeof verdict?.effectProb === 'number' ? verdict.effectProb : null,
    })
  }

  // ---- 阶段二：全局计划（仅 budget 模式返回非 null） ----
  const plan = planTrims(nodes, cfg)
  // selected 现在是数组（可 JSON 序列化，修落盘丢失），这里转 Set 供 has() 用。
  // 注意：plan 非 null 时即使 selected 为空数组也必须得到非 null 的 planned（空 Set = 不裁任何节点），
  // 不能退回 absolute 分支——那会窄带下 verdict.keep 全 false 导致全裁。
  const planned = plan != null ? new Set(plan.selected) : null
  const decisions = []

  for (const node of nodes) {
    const { seq, index, event, original, result, blocks, chars, tool, verdict } = node
    const charsBefore = chars

    let action
    let reason
    if (planned != null) {
      // 预算模式：由全局计划裁决。
      // ⚠️ 无判定的节点**仍走 fallback**（退回 DSH 原生按体积裁决）——预算模式只改
      // "Jev 驱动的决策"，不改兜底契约。这条由 smoke 的"三条候选都走到 pruneContent"钉住。
      if (node.inTail) { action = 'keep'; reason = 'tail' }
      else if (node.blacklisted) { action = 'keep'; reason = 'blacklist' }
      else if (verdict == null) { action = 'fallback'; reason = 'no-verdict-fallback' }
      else if (charsBefore < (cfg.minCharsToPrune ?? 400)) { action = 'keep'; reason = 'too-short' }
      else if (node.gain < (cfg.minGainChars ?? 40)) { action = 'keep'; reason = 'no-gain' }
      else if (planned.has(seq)) { action = 'prune'; reason = `selected(${plan.mode})` }
      else if (typeof node.prob === 'number' && node.prob >= (cfg.keepThreshold ?? 0.5)) { action = 'keep'; reason = 'keep-ceiling' }
      else { action = 'keep'; reason = 'budget-exhausted' }
    } else {
      action = decideAction({
        inTail: index > lastAllowed,
        tool,
        neverPruneTools: cfg.neverPruneTools,
        verdict,
        charsBefore,
        minCharsToPrune: cfg.minCharsToPrune,
      })
      reason = action === 'keep'
        ? (index > lastAllowed ? 'tail' : isToolIn(cfg.neverPruneTools, tool) ? 'blacklist' : verdict?.keep ? 'verdict-keep' : 'short-or-unknown')
        : action === 'fallback' ? 'no-verdict-fallback' : 'verdict-prune'
    }

    // keep 的三个来源分开计数（issue #8）：此前落在最近区/黑名单保护的节点
    // 都被记进 keptByJev——"Jev 保留"虚高，而真正的硬规则保护在统计里完全不可见，
    // 用户拿这行数字判断"Jev 的判断在起作用吗"会得出错误结论。
    // P0-1 追加第四类：被**预算**（而非判定）留下来的。
    if (action === 'keep') {
      if (index > lastAllowed) stats.keptByTail += 1
      else if (isToolIn(cfg.neverPruneTools, tool)) stats.keptByBlacklist += 1
      else if (verdict?.keep) stats.keptByJev += 1
      else if (planned != null) stats.keptByBudget = (stats.keptByBudget ?? 0) + 1
    }

    let content = null
    if (action === 'prune') {
      content = sliceWithBudget(blocks, cfg.headChars, cfg.tailChars, cfg.marker ?? JEV_PRUNE_MARKER)
      if (content != null) stats.prunedByJev += 1
    } else if (action === 'fallback') {
      content = pruner.pruneContent(blocks)
      if (content != null) stats.prunedByVolume += 1
    }

    if (content == null) {
      // 观察记录：即使不动手也留下"为什么"
      decisions.push({ seq, tool, chars: charsBefore, gain: node.gain, prob: node.prob, effectProb: node.effectProb, action, reason, applied: false })
      continue
    }
    const charsAfter = countChars(content)
    if (charsAfter >= charsBefore) {
      decisions.push({ seq, tool, chars: charsBefore, gain: node.gain, prob: node.prob, effectProb: node.effectProb, action, reason: `${reason}/no-shrink`, applied: false })
      continue
    }

    decisions.push({ seq, tool, chars: charsBefore, charsAfter, gain: charsBefore - charsAfter, prob: node.prob, effectProb: node.effectProb, action, reason, applied: true })

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
  if (plan != null) stats.lastBudget = plan
  return { pruned, charsRemoved, plan, decisions }
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
