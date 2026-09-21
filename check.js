/**
 * check.js —— 纯函数自检（不碰 DSH 运行时，node check.js 直接跑）。
 *
 * 覆盖三件最容易写错的事：
 *   1. token 估算（上游校正算法的移植是否正确）
 *   2. state 组装是否带【任务目标】（缺它会让判断整体悬在阈值附近）
 *   3. 候选筛选的三条排除规则（最近区 / 永不裁剪工具 / 已裁过）
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { estimateTokens } from './jev.js'
import { countChars, decideAction, parseLimit, pressureLevel, pruneSessionWithJev, sliceWithBudget } from './prune.js'
import {
  DEFAULT_COMPACT_TOOLS,
  DEFAULT_EVIDENCE_PATTERNS,
  DEFAULT_NEVER_COMPACT_TOOLS,
  DSH_READONLY_TOOLS,
  RECEIPT_MARKER,
  balancedAfter,
  balancedBefore,
  computeCuts,
  computeEligibleSeqs,
  isToolIn,
  normalizeToolName,
  renderCallArgs,
  renderReceipt,
  scanEvidence,
  selectReceiptRanges,
} from './receipt.js'
import {
  buildJevState,
  buildToolNameIndex,
  callIdOf,
  looksPruned,
  probeToolNames,
  questionsFor,
  recentGoal,
  resultChars,
  selectCandidates,
  sessionEvents,
  toolNameOf,
} from './state.js'

const here = dirname(fileURLToPath(import.meta.url))

// ---------------------------------------------------------------- token 估算
// 词 = 1 + ⌊(len-1)/6⌋：6 个字母 → 1；12 个字母 → 2
assert.equal(estimateTokens('abcdef'), 1)
assert.equal(estimateTokens('abcdefghijkl'), 2)
// 数字串 = len/2：4 位数字 → 2
assert.equal(estimateTokens('1234'), 2)
// 其他字符各 0.9：4 个符号 → ceil(3.6) = 4
assert.equal(estimateTokens('....'), 4)
// 混排的实际量级：JSON 密集文本不能被明显低估
const jsonish = '{"file_path": "/server/src/game/betting.ts", "limit": 1000}'
const got = estimateTokens(jsonish)
assert.ok(got >= 20 && got <= 60, `JSON 估算应在合理区间，实际 ${got}`)
assert.equal(estimateTokens(''), 0)

// ---------------------------------------------------------------- 事件构造
function userEvent(seq, text) {
  return { seq, type: 'user/message', data: { content: [{ type: 'text', text }], source: { kind: 'user' } } }
}
function assistantWithCall(seq, callId, tool, args) {
  return {
    seq,
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: '继续' }, { type: 'tool-call', id: callId, name: tool, arguments: args }] } },
  }
}
function toolResult(seq, callId, text) {
  return {
    seq,
    type: 'tool/result',
    data: { message: { source: { callId }, content: [{ type: 'tool-result', content: [{ type: 'text', text }] }] } },
  }
}

const BIG = 'x'.repeat(5000)
const SMALL = 'y'.repeat(50)

const events = [
  userEvent(1, '联机德州扑克：河牌阶段加注校验对不上，不要动 handEvaluator。'),
  assistantWithCall(2, 'c1', 'Read', { file_path: 'server/src/game/betting.ts' }),
  toolResult(3, 'c1', BIG),
  assistantWithCall(4, 'c2', 'Grep', { pattern: 'pots.flop' }),
  toolResult(5, 'c2', SMALL),
  assistantWithCall(6, 'c3', 'Edit', { file_path: 'a.ts' }),
  toolResult(7, 'c3', 'Edit applied: a.ts (+1 -1)'),
  assistantWithCall(8, 'c4', 'Bash', { command: 'find . -type f' }),
  toolResult(9, 'c4', BIG),
  toolResult(10, 'c5', `已裁剪${'z'.repeat(10)}`),
]
const eventAt = (seq) => events.find((event) => event.seq === seq)
const surface = events.map((event) => event.seq)

// ---------------------------------------------------------------- callId / 工具名
assert.equal(callIdOf(eventAt(3)), 'c1')
const nameIndex = buildToolNameIndex(events)
assert.equal(nameIndex.get('c1'), 'Read')
assert.equal(nameIndex.get('c4'), 'Bash')

// ---------------------------------------------------------------- resultChars
assert.equal(resultChars(eventAt(3)), 5000)
assert.equal(resultChars(eventAt(5)), 50)

// ---------------------------------------------------------------- 候选筛选
const candidates = selectCandidates({
  surface,
  eventAt,
  events,
  preserveRecent: 2, // 排除 s9 / s10
  neverPruneTools: ['Edit', 'Write'],
  marker: '已裁剪',
  nameByCallId: nameIndex,
})
const seqs = candidates.map((c) => c.seq)
assert.deepEqual(seqs, [3, 5], `候选应为 [3,5]，实际 ${JSON.stringify(seqs)}`)
assert.equal(candidates[0].tool, 'Read')
assert.equal(candidates[0].chars, 5000)
// s7 是 Edit 结果 → 被 neverPruneTools 排除
assert.equal(seqs.includes(7), false, 'Edit 结果不应进候选')
// s9 是 Bash 且落在最近 2 个节点里 → 排除
assert.equal(seqs.includes(9), false, '最近区不应进候选')

// 已经裁过的节点要能识别
assert.equal(looksPruned(eventAt(10), '已裁剪'), true)
assert.equal(looksPruned(eventAt(3), '已裁剪'), false)

// ---------------------------------------------------------------- 问题措辞
const questions = questionsFor(candidates)
assert.deepEqual(Object.keys(questions), ['result_s3', 'effect_s3', 'result_s5', 'effect_s5'])
// 默认（goal 版）必须锚定任务目标，且**不得出现字符数/体积词**——否则模型会按体积作答
assert.match(questions.result_s3, /s3 号工具结果/)
assert.match(questions.result_s3, /【任务目标】/)
assert.equal(/字符/.test(questions.result_s3), false, 'goal 版措辞不应暴露字符数（会诱导按体积判断）')
assert.equal(/体积/.test(questions.result_s3), false, 'goal 版措辞不应出现体积词（会被字面匹配）')
// 副作用问句：方向必须显式写成"高 = 有副作用 = 承重"
assert.match(questions.effect_s3, /s3 号工具调用/)
assert.match(questions.effect_s3, /改变了会话之外的状态/)
// legacy 版保留上游原味，供对照
const legacy = questionsFor(candidates, 'legacy')
assert.match(legacy.result_s3, /5000 字符/)
assert.match(legacy.result_s3, /重跑一次该工具无法替代/)
// 四种措辞都要能生成（每题两个轴）
for (const w of ['goal', 'legacy', 'contrast', 'consequence']) {
  const q = questionsFor(candidates, w)
  assert.equal(Object.keys(q).length, candidates.length * 2, `措辞 ${w} 应生成两倍于候选数的问题`)
  assert.equal(typeof q.result_s3, 'string')
  assert.equal(typeof q.effect_s3, 'string')
}

// ---------------------------------------------------------------- 任务目标
const goal = recentGoal(events)
assert.match(goal, /河牌阶段加注校验/)
assert.match(goal, /handEvaluator/)

// ---------------------------------------------------------------- state 组装
const built = buildJevState({
  surface,
  eventAt,
  goal,
  options: { textHead: 400, textTail: 150, maxStateTokens: 25000, inputChars: 300 },
})
assert.match(built.state, /【上下文】/)
assert.match(built.state, /【任务目标】/, 'state 必须带任务目标 —— 缺它会让概率悬在阈值附近')
assert.match(built.state, /【history】/)
assert.match(built.state, /\[s1\]\[user\]/)
// tool/result 只给注记与体积，不给全文
assert.match(built.state, /\[s3\]\[tool_result\] ok, 5000 chars/)
assert.equal(/x{100}/.test(built.state), false, '工具结果正文不应进 state')

// 预算压制：预算很紧时应从最老开始丢行，但保留行数地板，并如实报告是否装下
const squeezed = buildJevState({
  surface,
  eventAt,
  goal,
  options: { textHead: 10, textTail: 5, maxStateTokens: 200, inputChars: 20, minHistoryLines: 8 },
})
assert.ok(squeezed.omitted > 0, '预算不足时应从最老开始丢行')
assert.ok(squeezed.lines >= 8, `行数不应低于地板 8，实际 ${squeezed.lines}`)
assert.ok(squeezed.lines < surface.length, '确实丢了行')
assert.equal(typeof squeezed.fitted, 'boolean')
assert.equal(squeezed.stateTokens > 0, true)

// ---------------------------------------------------------------- 裁剪机制（prune.js）
// 这段逻辑以前困在 index.js 里（要 import DSH 的包 → 在 DSH 外跑不起来），
// 而它恰恰最容易写错：按码点切、标记只插一次、非文本块保序、必须真的更短。

const marker = ' MARK '
const big = 'a'.repeat(2000)

// 正常裁剪：留头 + 标记 + 留尾，且必须真的更短
{
  const out = sliceWithBudget([{ type: 'text', text: big }], 600, 200, marker)
  assert.ok(out != null, '2000 字符配 600/200 的预算应当动手')
  const text = out[0].text
  assert.ok(text.startsWith('a'.repeat(600)), '应保留完整的头 600')
  assert.ok(text.endsWith('a'.repeat(200)), '应保留完整的尾 200')
  assert.equal(text.includes(marker.trim()), true, '应插入标记')
  assert.ok(countChars(out) < countChars([{ type: 'text', text: big }]), '结果必须更短')
}

// 不值得裁：省下的还不够标记占的地方 → 返回 null
{
  const out = sliceWithBudget([{ type: 'text', text: 'a'.repeat(650) }], 600, 200, marker)
  assert.equal(out, null, '头+尾就超过原文长度时不该动手')
}
assert.equal(sliceWithBudget([], 600, 200, marker), null, '空数组返回 null')
assert.equal(sliceWithBudget(null, 600, 200, marker), null, '非数组返回 null')

// 标记只插一次（多文本块时最易出错的点）
{
  const blocks = [
    { type: 'text', text: 'a'.repeat(1000) },
    { type: 'text', text: 'b'.repeat(1000) },
    { type: 'text', text: 'c'.repeat(1000) },
  ]
  const out = sliceWithBudget(blocks, 500, 300, marker)
  assert.ok(out != null)
  const joined = out.map((b) => b.text).join('')
  assert.equal(joined.split(marker.trim()).length - 1, 1, '标记应恰好出现一次')
}

// 非文本块保序原样保留
{
  const blocks = [
    { type: 'text', text: 'x'.repeat(30) },
    { type: 'image', data: 'zzz' },
    { type: 'text', text: 'y'.repeat(3000) },
  ]
  const out = sliceWithBudget(blocks, 20, 20, marker)
  assert.ok(out != null)
  const imageAt = out.findIndex((b) => b.type === 'image')
  assert.ok(imageAt >= 0, '非文本块不该消失')
  assert.deepEqual(out[imageAt], { type: 'image', data: 'zzz' }, '非文本块应原样保留')
}

// 按码点切：不能劈开代理对（emoji / 增补平面字符）
{
  const emoji = '🎲'.repeat(500) // 每个是 2 个 UTF-16 单元、1 个码点
  const out = sliceWithBudget([{ type: 'text', text: emoji }], 100, 50, marker)
  assert.ok(out != null)
  for (const block of out) {
    if (block.type !== 'text') continue
    // 不含"半个"代理对：孤立的代理项会被 JSON 序列化成 \udXXX
    const lonely = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(block.text)
    assert.equal(lonely, false, '不应出现孤立代理项（说明切在了码点边界上）')
  }
}

// parseLimit / pressureLevel
assert.deepEqual(parseLimit('55%'), { kind: 'ratio', value: 0.55 })
assert.deepEqual(parseLimit('154000'), { kind: 'tokens', value: 154000 })
assert.equal(pressureLevel(100, 600, 700), 'none')
assert.equal(pressureLevel(650, 600, 700), 'soft')
assert.equal(pressureLevel(700, 600, 700), 'hard')
assert.equal(pressureLevel(700, null, null), 'none', '算不出窗口时不应误判压力')

// ---------------------------------------------------------------- 逐节点裁决（含 append 协议）
// 用假的 pruner / session 复刻 DSH 的接口形状（形状取自 DSH 源码，不是猜的）：
//   pruner.measureContent / pruneContent / ctx.tokenMeter.estimateMessage
//   session.surface.nodes / eventAt / deriveEventMessage / append

function fakeSession(eventsArr, tailSeqs = []) {
  const appended = []
  const events = new Map(eventsArr.map((e) => [e.seq, e]))
  return {
    appended,
    get events() { return [...events.values()] },
    surface: { nodes: eventsArr.map((e) => e.seq) },
    eventAt: (seq) => events.get(seq) ?? null,
    deriveEventMessage: (event) => event.data.message,
    append(type, data, options) {
      const seq = Math.max(...[...events.keys()]) + 1 + appended.length
      appended.push({ seq, type, data, options })
      events.set(seq, { seq, type, data })
      return { seq }
    },
  }
}

function fakePruner(thresholdChars) {
  return {
    ctx: { tokenMeter: { estimateMessage: () => 42 } },
    measureContent: (blocks) => countChars(blocks),
    // 与 DSH 同口径：只有超过 thresholdChars 才裁
    pruneContent(blocks) {
      if (countChars(blocks) <= thresholdChars) return null
      return sliceWithBudget(blocks, 40, 20, ' VOLUME ')
    },
  }
}

const resultEvent = (seq, callId, text) => ({
  seq,
  type: 'tool/result',
  data: { message: { source: { callId }, content: [{ type: 'tool-result', content: [{ type: 'text', text }] }] } },
})

const baseCfg = {
  preserveRecent: 0,
  neverPruneTools: ['Edit'],
  keepThreshold: 0.5,
  minCharsToPrune: 400,
  headChars: 50,
  tailChars: 30,
  marker: marker,
  dryRun: false,
}
const freshStats = () => ({
  judged: 0, requests: 0, prunedByJev: 0, prunedByVolume: 0,
  savedChars: 0, keptByJev: 0, skipped: 0, errors: 0, lastNote: '',
})
const run = ({ events, cache, cfg, threshold }) => {
  const session = fakeSession(events)
  const pruner = fakePruner(threshold ?? 999999)
  const stats = freshStats()
  const out = pruneSessionWithJev({
    pruner, session, cache, cfg: { ...baseCfg, ...cfg }, stats,
    freeze: (m) => m,
    toolNameOf: () => 'Bash',
    callIdOf: (e) => e.data.message.source.callId,
  })
  return { out, session, stats }
}

// ① Jev 说「还要」→ 不裁，哪怕它巨大（这是修 DSH 的误伤）
{
  const events = [resultEvent(10, 'c1', 'a'.repeat(5000))]
  const { out, session, stats } = run({ events, cache: new Map([[10, { keep: true, prob: 0.9 }]]) })
  assert.equal(out.pruned.length, 0, 'Jev 说还要就不该裁')
  assert.equal(session.appended.length, 0, '不该有任何 append')
  assert.equal(stats.keptByJev, 1)
}

// ② Jev 说「过期」→ 裁，哪怕它远低于体积阈值（这是纯增量）
{
  const events = [resultEvent(11, 'c2', 'b'.repeat(800))]
  const { out, session, stats } = run({
    events, cache: new Map([[11, { keep: false, prob: 0.1 }]]), threshold: 999999,
  })
  assert.equal(out.pruned.length, 1, 'Jev 说过期就该裁，与体积无关')
  assert.equal(stats.prunedByJev, 1)
  assert.equal(stats.prunedByVolume, 0)
  // append 协议：先 compaction/prune（带 shadowedRange/Seqs/tokenCount），再 tool/result replace
  const [price, replace] = session.appended
  assert.equal(price.type, 'compaction/prune')
  assert.deepEqual(price.data.shadowedRange, { start: 11, end: 11 })
  assert.deepEqual(price.data.shadowedSeqs, [11])
  assert.equal(price.data.shadowedTokenCount, 42, '应调用 pruner.ctx.tokenMeter.estimateMessage')
  assert.equal(replace.type, 'tool/result')
  assert.deepEqual(replace.options.surfaceOp, { op: 'replace', startSeq: 11, endSeq: 11 })
  assert.deepEqual(replace.options.sourceEventSeqs, [11])
}

// ③ 没有判定 → 退回按体积（且体积不够大时什么都不做）
{
  const events = [resultEvent(12, 'c3', 'c'.repeat(5000))]
  const { out, session, stats } = run({ events, cache: new Map(), threshold: 1000 })
  assert.equal(out.pruned.length, 1, '无判定时应退回按体积，且大块会被裁')
  assert.equal(stats.prunedByVolume, 1)
  assert.equal(stats.prunedByJev, 0)
  assert.equal(session.appended.length, 2)
}
{
  const events = [resultEvent(13, 'c4', 'd'.repeat(100))]
  const { out } = run({ events, cache: new Map(), threshold: 1000 })
  assert.equal(out.pruned.length, 0, '无判定 + 体积未超 → 不动手')
}

// ④ 落在最近区 → 一律不碰（哪怕 Jev 说过期）
{
  const events = [resultEvent(14, 'c5', 'e'.repeat(5000))]
  const { out, session } = run({
    events, cache: new Map([[14, { keep: false, prob: 0.05 }]]), cfg: { preserveRecent: 1 },
  })
  assert.equal(out.pruned.length, 0, '最近区不该被裁')
  assert.equal(session.appended.length, 0)
}

// ⑤ 永不裁剪工具 → 不碰
{
  const events = [resultEvent(15, 'c6', 'f'.repeat(5000))]
  const { out } = run({
    events, cache: new Map([[15, { keep: false, prob: 0.05 }]]),
    cfg: { neverPruneTools: ['Bash'] }, // toolNameOf 固定返回 Bash
  })
  assert.equal(out.pruned.length, 0, 'neverPruneTools 里的工具不该被裁')
}

// ⑤b 外部审查回归：第一层黑名单必须**归一化**比较。
// 真实 DSH 的改写类工具名是小写 edit/write，而默认黑名单历史上是 PascalCase ——
// 字面 includes 永远不命中，"改写类永不裁剪"的承诺在第一层静默失效。
{
  const base = { inTail: false, verdict: { keep: false, prob: 0.05 }, charsBefore: 5000, minCharsToPrune: 400 }
  const pascal = ['Edit', 'Write', 'MultiEdit', 'ApplyPatch']
  assert.equal(decideAction({ ...base, tool: 'edit', neverPruneTools: pascal }), 'keep', '小写 edit 要命中 Edit')
  assert.equal(decideAction({ ...base, tool: 'write', neverPruneTools: pascal }), 'keep', '小写 write 要命中 Write')
  assert.equal(decideAction({ ...base, tool: 'multi_edit', neverPruneTools: pascal }), 'keep', 'multi_edit 要命中 MultiEdit')
  assert.equal(decideAction({ ...base, tool: 'apply_patch', neverPruneTools: pascal }), 'keep', 'apply_patch 要命中 ApplyPatch')
  assert.equal(decideAction({ ...base, tool: 'str_replace_editor', neverPruneTools: DEFAULT_NEVER_COMPACT_TOOLS }), 'keep')
  // 反事实：只读工具不受黑名单保护，正常进入后续裁决分支
  assert.equal(decideAction({ ...base, tool: 'read', neverPruneTools: pascal }), 'prune', 'read 不在黑名单里，Jev 说过期就裁')

  // 整链验证：toolNameOf 解析出小写 edit + PascalCase 黑名单 → 整条管线不碰它
  const events = [resultEvent(15, 'c6', 'f'.repeat(5000))]
  const session = fakeSession(events)
  const pruner = fakePruner(999999)
  const stats = freshStats()
  const out = pruneSessionWithJev({
    pruner, session, cache: new Map([[15, { keep: false, prob: 0.05 }]]),
    cfg: { ...baseCfg, neverPruneTools: pascal },
    stats, freeze: (m) => m,
    toolNameOf: () => 'edit',
    callIdOf: (e) => e.data.message.source.callId,
  })
  assert.equal(out.pruned.length, 0, '整条管线：小写 edit 不被裁')
  assert.equal(session.appended.length, 0)
}

// ⑥ Jev 说过期但太短 → 不裁（省不到东西还丢信息）
{
  const events = [resultEvent(16, 'c7', 'g'.repeat(200))]
  const { out, stats } = run({ events, cache: new Map([[16, { keep: false, prob: 0.02 }]]) })
  assert.equal(out.pruned.length, 0, `短于 minCharsToPrune(${baseCfg.minCharsToPrune}) 不该裁`)
  assert.equal(stats.prunedByJev, 0)
}

// ⑦ dryRun：只记账、不 append、不改内容
{
  const events = [resultEvent(17, 'c8', 'h'.repeat(5000))]
  const { out, session, stats } = run({
    events, cache: new Map([[17, { keep: false, prob: 0.05 }]]), cfg: { dryRun: true },
  })
  assert.equal(session.appended.length, 0, 'dryRun 不该写任何事件')
  assert.equal(out.pruned.length, 0)
  assert.ok(out.charsRemoved > 0, 'dryRun 仍应如实记账省下多少')
  assert.equal(stats.savedChars, out.charsRemoved)
}

// ⑧ 非 tool/result 节点与结构异常节点要被安全跳过
{
  const events = [
    { seq: 20, type: 'user/message', data: { content: [{ type: 'text', text: 'x' }] } },
    { seq: 21, type: 'tool/result', data: { message: { source: {}, content: [{ type: 'text', text: 'no tool-result block' }] } } },
    resultEvent(22, 'c9', 'i'.repeat(5000)),
  ]
  const { out } = run({ events, cache: new Map([[22, { keep: false, prob: 0.05 }]]) })
  assert.equal(out.pruned.length, 1, '只有结构完整的那条被处理')
  assert.equal(out.pruned[0].originalSeq, 22)
}

// ================================================================ 第二层：回执压缩
// 这一层做的是**破坏性**动作（整对移出 surface），所以每条门控都要单独测。
// 全部用纯函数，不需要 DSH 运行时。

// ---------------------------------------------------------------- 工具配对平衡
{
  const evs = [
    { seq: 1, type: 'user/message', data: { content: [{ type: 'text', text: 'go' }] } },
    { seq: 2, type: 'assistant/message', data: { message: { content: [{ type: 'tool-call', id: 'a', name: 'Read', arguments: {} }] } } },
    { seq: 3, type: 'tool/result', data: { message: { content: [{ type: 'tool-result', content: [] }] } } },
    { seq: 4, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'done' }] } } },
  ]
  const at = (s) => evs.find((e) => e.seq === s)
  const cuts = computeCuts(evs.map((e) => e.seq), at)
  assert.equal(cuts.length, evs.length + 1, 'N 个节点应有 N+1 个切点')
  assert.equal(balancedBefore(cuts, 0), true)
  assert.equal(balancedBefore(cuts, 1), true, '调用之前是平衡的')
  assert.equal(balancedAfter(cuts, 1), false, '调用之后（结果未到）不平衡 —— 这正是不能切的地方')
  assert.equal(balancedAfter(cuts, 2), true, '结果之后重新平衡')
  assert.equal(balancedAfter(cuts, 3), true)

  // 多个 tool-call 在一条 assistant 消息里
  const many = [
    { seq: 1, type: 'assistant/message', data: { message: { content: [{ type: 'tool-call' }, { type: 'tool-call' }] } } },
    { seq: 2, type: 'tool/result', data: { message: { content: [] } } },
    { seq: 3, type: 'tool/result', data: { message: { content: [] } } },
  ]
  const mcuts = computeCuts(many.map((e) => e.seq), (s) => many.find((e) => e.seq === s))
  assert.equal(balancedAfter(mcuts, 0), false)
  assert.equal(balancedAfter(mcuts, 1), false, '两个调用只回来一个结果时仍不平衡')
  assert.equal(balancedAfter(mcuts, 2), true)

  // surface 损坏要抛错，而不是静默算错
  assert.throws(() => computeCuts([1, 99], at), /没有对应的会话事件/)
  assert.throws(
    () => computeCuts([3], at),
    /没有对应的 tool-call/,
    '无主的 tool/result 必须抛错',
  )
}

// ---------------------------------------------------------------- 相对分位门控
{
  // 只读 3 条（两轴都低）+ 有副作用 3 条（effect 高）→ 交集应只含只读那 3 条
  const verdicts = [
    { seq: 10, prob: 0.10, effectProb: 0.05 },
    { seq: 12, prob: 0.12, effectProb: 0.06 },
    { seq: 14, prob: 0.11, effectProb: 0.07 },
    { seq: 20, prob: 0.13, effectProb: 0.30 },
    { seq: 22, prob: 0.14, effectProb: 0.33 },
    { seq: 24, prob: 0.15, effectProb: 0.28 },
  ]
  const half = computeEligibleSeqs(verdicts, { quantile: 0.5, minCandidates: 4 })
  assert.deepEqual([...half].sort((a, b) => a - b), [10, 12, 14], 'q=0.5 时两轴各取 3 条，交集为 3 条只读')
  assert.equal([...half].some((seq) => seq >= 20), false, '有副作用的调用**绝不能**被选中')

  // 交集语义：只落在**单轴**尾部的必须被排除（若是并集，12 和 14 都会被选中）
  const strict = computeEligibleSeqs(verdicts, { quantile: 0.34, minCandidates: 4 })
  assert.deepEqual([...strict], [10], '必须取交集：只在 result 尾部(14)或只在 effect 尾部(12)的都不算')

  // 样本量不足时宁可不做（小样本上排序没有意义）
  assert.equal(computeEligibleSeqs(verdicts.slice(0, 2), { quantile: 0.5, minCandidates: 4 }).size, 0)

  // 缺任何一轴的概率都不参与
  assert.equal(computeEligibleSeqs(
    Array.from({ length: 6 }, (_, i) => ({ seq: i + 1, prob: 0.1 })),
    { quantile: 0.5, minCandidates: 4 },
  ).size, 0, '缺 effectProb 的判定不能用于第二层')
}

// ---------------------------------------------------------------- 范围选择
{
  // 会话：user → 3 组只读探查 → 1 组 Edit（承重）→ 1 条带 error 的探查 → 收尾文本
  const evs = []
  const push = (e) => evs.push(e)
  let seq = 0
  push(userEvent((seq += 1), '排查河牌底池 bug'))
  const addStep = (tool, args, output) => {
    const callId = `c${seq + 1}`
    push(assistantWithCall((seq += 1), callId, tool, args))
    push(toolResult((seq += 1), callId, output))
    return seq
  }
  addStep('Read', { file_path: 'server/src/game/river.ts' }, 'x'.repeat(3000))
  addStep('Grep', { pattern: 'basePot', path: 'server/src' }, 'y'.repeat(2500))
  addStep('Bash', { command: 'wc -l server/src/*.ts' }, 'z'.repeat(2000))
  addStep('Edit', { file_path: 'server/src/game/river.ts' }, 'Edit applied (+2 -1)')
  addStep('Read', { file_path: 'server/src/game/pot.ts' }, `failed to load${'w'.repeat(2000)}`)
  push({ seq: (seq += 1), type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '继续' }] } } })

  const at = (s) => evs.find((e) => e.seq === s)
  const surf = evs.map((e) => e.seq)
  const cache = new Map()
  for (const e of evs) {
    if (e.type !== 'tool/result') continue
    cache.set(e.seq, { keep: false, prob: 0.1, effectProb: 0.05, chars: 3000, tool: 'Read' })
  }
  const baseCfg = {
    preserveRecent: 0,
    compactTools: DEFAULT_COMPACT_TOOLS,
    neverCompactTools: DEFAULT_NEVER_COMPACT_TOOLS,
    evidenceGuard: true,
    evidencePatterns: DEFAULT_EVIDENCE_PATTERNS,
    maxStepTextChars: 240,
    compactMinChars: 1000,
  }
  const run = (overrides = {}, cacheOverride) => selectReceiptRanges({
    surface: surf,
    eventAt: at,
    cache: cacheOverride ?? cache,
    dropVerdict: (s) => (cacheOverride ?? cache).get(s)?.droppable !== false,
    cfg: { ...baseCfg, ...overrides },
  })

  // 1) 两条连续只读（Read/Grep）应合并成一段；Bash 不在默认只读白名单里，
  //    Edit 被黑名单拦、带 error 的那条被证据守卫拦 —— 各自把区间断开
  const { ranges, stats } = run()
  assert.equal(ranges.length, 1, '只应有一段合法范围')
  const range = ranges[0]
  assert.equal(range.steps.length, 2, '两条连续只读应被合并进同一段')
  assert.equal(range.chars, 5500)
  assert.equal(range.start, at(range.start).seq)
  assert.equal(at(range.start).type, 'assistant/message')
  assert.equal(at(range.end).type, 'tool/result')
  assert.equal(stats.skippedTool, 2, 'Bash（不在只读白名单）与 Edit（黑名单）都应被工具规则排除')
  assert.equal(stats.skippedGuard, 1, '含 error 的探查应被证据守卫排除')
  assert.ok(stats.eligibleSteps >= 2)

  // 2) 白名单只留 Read/Grep → 与默认等价（Bash 与 Edit 都被排除）
  const narrowed = run({ compactTools: ['Read', 'Grep'] })
  assert.equal(narrowed.ranges.length, 1)
  assert.equal(narrowed.ranges[0].steps.length, 2)
  assert.equal(narrowed.stats.skippedTool, 2, 'Bash 与 Edit 都应被工具规则排除')

  // 3) 白名单显式设为 [] = 放宽到只受黑名单约束（不安全模式，须显式 opt-in）；
  //    此时 Bash 也可进候选，仍只有 Edit 被拦
  const noAllowlist = run({ compactTools: [] })
  assert.equal(noAllowlist.stats.skippedTool, 1, '只有 Edit 会被拦')

  // 4) 关掉证据守卫后，带 error 的那条也能进（但它是孤立步骤，另成一段）
  const noGuard = run({ evidenceGuard: false })
  assert.equal(noGuard.stats.skippedGuard, 0)
  assert.equal(noGuard.ranges.length, 2, 'Bash/Edit 断开只读区，error-Read 孤立成第二段')

  // 5) 最近区保护
  const tailSafe = run({ preserveRecent: 20 })
  assert.equal(tailSafe.ranges.length, 0)
  assert.ok(tailSafe.stats.skippedTail > 0)

  // 6) 推理文本过长 → 整步排除
  const chatty = at(range.start)
  chatty.data.message.content[0].text = '先想一下'.repeat(100)
  const chattyRun = run()
  assert.equal(chattyRun.stats.skippedText, 1, '长推理文本的步骤不应被整对移出')
  chatty.data.message.content[0].text = '继续'

  // 7) 判定说"不可丢" → 排除
  const guardedCache = new Map(cache)
  guardedCache.set(3, { keep: true, prob: 0.9, effectProb: 0.9, chars: 3000, tool: 'Read', droppable: false })
  const guardedRun = run({}, guardedCache)
  assert.equal(guardedRun.stats.skippedVerdict, 1)
  assert.equal(guardedRun.ranges[0].steps.length, 1, '被否掉的那步之后仍可继续成段（只剩 Grep；Bash 已被只读白名单拦下）')

  // 8) 省得不够多 → 整个范围丢弃
  const tiny = run({ compactMinChars: 100000 })
  assert.equal(tiny.ranges.length, 0)
  assert.equal(tiny.stats.skippedShort, 1)
}

// ---------------------------------------------------------------- 回执渲染
{
  const evs = [
    assistantWithCall(1, 'c1', 'Glob', { pattern: '*.ts', path: 'server/src' }),
    toolResult(2, 'c1', 'z'.repeat(2000)),
    assistantWithCall(3, 'c2', 'Read', { file_path: 'server/src/game/pot.ts' }),
    toolResult(4, 'c2', 'y'.repeat(500)),
  ]
  const at = (s) => evs.find((e) => e.seq === s)
  const surf = evs.map((e) => e.seq)
  const cache = new Map([
    [2, { keep: false, prob: 0.1, effectProb: 0.05, chars: 2000, tool: 'Glob' }],
    [4, { keep: false, prob: 0.1, effectProb: 0.05, chars: 500, tool: 'Read' }],
  ])
  const { ranges } = selectReceiptRanges({
    surface: surf,
    eventAt: at,
    cache,
    dropVerdict: () => true,
    cfg: {
      preserveRecent: 0,
      compactTools: DEFAULT_COMPACT_TOOLS,
      neverCompactTools: DEFAULT_NEVER_COMPACT_TOOLS,
      evidenceGuard: true,
      evidencePatterns: DEFAULT_EVIDENCE_PATTERNS,
      maxStepTextChars: 240,
      compactMinChars: 100,
    },
  })
  assert.equal(ranges.length, 1)
  const text = renderReceipt(ranges[0], { eventAt: at })
  assert.ok(text.startsWith(RECEIPT_MARKER), '回执必须以识别前缀开头')
  assert.match(text, /s1–s4/, '必须写明被移出的 seq 范围')
  assert.match(text, /2 次工具调用/)
  // 事实必须逐字记录：模式/路径与文件路径都不能丢
  assert.match(text, /Glob：\*\.ts server\/src/, 'glob 的 pattern 与 path 都要逐字在回执里')
  assert.match(text, /server\/src\/game\/pot\.ts/)
  assert.match(text, /2000 字符输出/)
  assert.match(text, /原始事件仍完整保存在会话日志中/)
  // 确定性：同一输入两次渲染必须完全相同（这是"无幻觉"的可测形式）
  assert.equal(text, renderReceipt(ranges[0], { eventAt: at }))
  // 不得出现任何推断性表述
  for (const word of ['我们发现', '因此', '根因是', '结论', '我认为']) {
    assert.equal(text.includes(word), false, `回执不得包含推断性表述「${word}」`)
  }
}

// ---------------------------------------------------------------- 证据守卫与入参渲染
{
  assert.equal(scanEvidence('TypeError: x is undefined', ['error']).hit, true)
  assert.equal(scanEvidence('TypeError: x is undefined', ['ERROR']).hit, true, '大小写不敏感')
  assert.equal(scanEvidence('all good', ['error', 'fail']).hit, false)
  assert.deepEqual(scanEvidence('failed and error', ['error', 'fail']).matches, ['error', 'fail'])
  assert.equal(scanEvidence('', []).hit, false)

  // 入参渲染只接 tool-call **块**（不是裸 args）—— 契约写在测试里
  assert.equal(renderCallArgs({ arguments: { file_path: 'a/b.ts' } }), 'a/b.ts')
  assert.equal(renderCallArgs({ arguments: { command: 'ls -la', cwd: '/x' } }), 'ls -la cwd=/x',
    '次要字段要带 key 前缀，否则光看值不知道是哪个参数')
  assert.equal(renderCallArgs({ arguments: { pattern: 'p', path: 'src' } }), 'p src',
    'Grep 的 pattern 应排在 path 前面')
  assert.equal(renderCallArgs({ arguments: '{"file_path":"a.ts"}' }), 'a.ts', '字符串形式的 JSON 入参也要能解析')
  assert.equal(renderCallArgs({ arguments: 'not json' }), 'not json')
  assert.equal(renderCallArgs({ arguments: { unknown_key: 'v' } }), 'unknown_key=v')
  const payloadOnly = renderCallArgs({ arguments: { content: 'x'.repeat(500) } })
  assert.ok(payloadOnly.startsWith('{"content"'), '全是载荷型字段时整体序列化')
  assert.ok(payloadOnly.endsWith('…'), '并被截断')
  assert.equal(payloadOnly.length, 121)
  assert.equal(renderCallArgs({ arguments: null }), '')
  assert.equal(renderCallArgs({ arguments: { command: 'x'.repeat(300) } }, 20).length, 21, '超长入参要截断并带省略号')
}

// ---------------------------------------------------------------- 工具名归一化与白名单陷阱
// 这一组测试的由来（真实事故）：真实 DSH 的工具名是 `pwsh` / `read` / `glob`（全小写、
// shell 叫 pwsh），而我最初猜的白名单是 Claude Code 风格的 PascalCase —— 在真实会话里
// **命中 0/11**，第二层因此静默地永不触发。所以默认不用白名单，且比较必须归一化。
{
  assert.equal(normalizeToolName('Read'), 'read')
  assert.equal(normalizeToolName('  Pwsh '), 'pwsh')
  assert.equal(normalizeToolName('multi_edit'), 'multiedit')
  assert.equal(normalizeToolName('Get-ChildItem'), 'getchilditem')
  assert.equal(normalizeToolName(null), '')

  assert.equal(isToolIn(['Edit'], 'edit'), true, '黑名单必须能拦住小写变体（否则保护静默失效）')
  assert.equal(isToolIn(['edit'], 'Edit'), true)
  assert.equal(isToolIn(['MultiEdit'], 'multi_edit'), true)
  assert.equal(isToolIn(['ApplyPatch'], 'apply_patch'), true)
  assert.equal(isToolIn(['read'], 'read'), true)
  assert.equal(isToolIn(['read'], 'write'), false)
  assert.equal(isToolIn([], 'read'), false)
  assert.equal(isToolIn(['read'], ''), false)

  // 默认值就是设计决策本身：默认 = **只读白名单**（外部审查的结论：
  // "空白名单 = 允许一切 shell 调用"不是只读安全默认；而白名单失效的风险
  // 由 normalizeToolName + blockedToolNames 上报兜住，可观测）
  assert.ok(DEFAULT_COMPACT_TOOLS.length > 0, 'compactTools 默认必须是只读白名单，不能为空')
  assert.deepEqual(DEFAULT_COMPACT_TOOLS, DSH_READONLY_TOOLS)
  for (const shell of ['pwsh', 'bash', 'sh', 'shell', 'command']) {
    assert.equal(isToolIn(DEFAULT_COMPACT_TOOLS, shell), false,
      `shell 类工具「${shell}」绝不能进默认白名单（pwsh Remove-Item 复现过）`)
  }
  assert.ok(DSH_READONLY_TOOLS.includes('read'))
  assert.ok(DSH_READONLY_TOOLS.includes('glob'))
  assert.ok(DSH_READONLY_TOOLS.includes('grep'))
  assert.equal(DSH_READONLY_TOOLS.includes('Bash'), false, '预设里不该有猜出来的 PascalCase 名字')
  assert.ok(DEFAULT_NEVER_COMPACT_TOOLS.some((n) => normalizeToolName(n) === 'edit'))
  assert.ok(DEFAULT_NEVER_COMPACT_TOOLS.some((n) => normalizeToolName(n) === 'multiedit'))
}

// ---------------------------------------------------------------- 工具名索引（含真实事件类型）
{
  // 真实 DSH 同时存在两种来源：扁平的 tool/call 事件，以及 assistant 消息里的 tool-call 块
  const evs = [
    { seq: 1, type: 'tool/call', data: { callId: 'c1', name: 'pwsh', arguments: '{}' } },
    { seq: 2, type: 'tool/result', data: { message: { source: { kind: 'tool', callId: 'c1' }, content: [{ type: 'tool-result', content: [{ type: 'text', text: 'ok' }] }] } } },
    { seq: 3, type: 'assistant/message', data: { message: { content: [{ type: 'tool-call', id: 'c2', name: 'read', arguments: '{"file_path":"a.ts"}' }] } } },
    { seq: 4, type: 'tool/result', data: { message: { source: { kind: 'tool', callId: 'c2' }, content: [{ type: 'tool-result', content: [{ type: 'text', text: 'ok' }] }] } } },
  ]
  const at = (s) => evs.find((e) => e.seq === s)
  const index = buildToolNameIndex(evs)
  assert.equal(index.get('c1'), 'pwsh', 'tool/call 事件必须被索引（最直接的来源）')
  assert.equal(index.get('c2'), 'read', 'assistant 消息里的 tool-call 块也要索引')
  assert.equal(toolNameOf(at(2), index), 'pwsh')
  assert.equal(toolNameOf(at(4), index), 'read')
  assert.equal(toolNameOf({ seq: 9, type: 'tool/result', data: { message: { source: { callId: 'nope' } } } }, index), 'unknown')

  // probeToolNames 是"白名单为什么不命中"的取证块
  const probe = probeToolNames({ surface: [1, 2, 3, 4], eventAt: at, events: evs, limit: 10 })
  assert.equal(probe.indexSize, 2)
  assert.deepEqual(probe.names, ['pwsh', 'read'])
  assert.equal(probe.resolved, 2)
  assert.equal(probe.unresolved, 0)
}

// ---------------------------------------------------------------- 工具名统计与推理文本门控
{
  const evs = []
  let seq = 0
  const push = (e) => evs.push(e)
  const addStep = (tool, text, reasoning) => {
    const callId = `c${seq + 1}`
    const content = [{ type: 'tool-call', id: callId, name: tool, arguments: {} }]
    if (text != null) content.unshift({ type: 'text', text })
    if (reasoning != null) content.unshift({ type: 'reasoning', text: reasoning })
    push({ seq: (seq += 1), type: 'assistant/message', data: { message: { content } } })
    push({
      seq: (seq += 1),
      type: 'tool/result',
      data: { message: { source: { callId }, content: [{ type: 'tool-result', content: [{ type: 'text', text: 'z'.repeat(3000) }] }] } },
    })
    return seq
  }
  push({ seq: (seq += 1), type: 'user/message', data: { content: [{ type: 'text', text: 'go' }] } })
  addStep('pwsh', '看一下。', null)
  addStep('read', '看一下。', null)
  addStep('edit', '看一下。', null) // 黑名单
  addStep('read', '看一下。', '想'.repeat(400)) // 长 reasoning —— 必须被看见
  const at = (s) => evs.find((e) => e.seq === s)
  const surf = evs.map((e) => e.seq)
  const cache = new Map()
  for (const e of evs) {
    if (e.type !== 'tool/result') continue
    cache.set(e.seq, { keep: false, prob: 0.1, effectProb: 0.05, chars: 3000 })
  }
  const { ranges, stats } = selectReceiptRanges({
    surface: surf,
    eventAt: at,
    cache,
    dropVerdict: () => true,
    cfg: {
      preserveRecent: 0,
      compactTools: [], // 默认：只用黑名单
      neverCompactTools: DEFAULT_NEVER_COMPACT_TOOLS,
      evidenceGuard: true,
      evidencePatterns: DEFAULT_EVIDENCE_PATTERNS,
      maxStepTextChars: 240,
      compactMinChars: 100,
    },
  })
  // 前两步合格（pwsh 不在黑名单里、read 合格）→ 合成一段
  assert.equal(ranges.length, 1)
  assert.equal(ranges[0].steps.length, 2)
  assert.equal(stats.skippedTool, 1, 'edit 应被黑名单拦下（归一化后比较）')
  assert.deepEqual(stats.blockedToolNames, { edit: 1 }, '必须如实记下被拦下的名字')
  assert.deepEqual(stats.allowedToolNames, { pwsh: 1, read: 1 }, '通过的名字也要记，便于自查')
  assert.equal(stats.skippedText, 1, 'reasoning 块的长文本必须计入推理门控（只数 text 会让门控形同虚设）')

  // 同一份数据，配上白名单 → 只允许 read（pwsh 被拦）
  const allow = selectReceiptRanges({
    surface: surf,
    eventAt: at,
    cache,
    dropVerdict: () => true,
    cfg: {
      preserveRecent: 0,
      compactTools: ['read'],
      neverCompactTools: DEFAULT_NEVER_COMPACT_TOOLS,
      evidenceGuard: true,
      evidencePatterns: DEFAULT_EVIDENCE_PATTERNS,
      maxStepTextChars: 240,
      compactMinChars: 100,
    },
  })
  assert.equal(allow.ranges.length, 1, '只允许 read → 剩短文本那一读'
    + '（另一条 read 带长 reasoning，被推理门控拦下）')
  assert.equal(allow.ranges[0].steps.length, 1)
  assert.equal(allow.ranges[0].steps[0].calls[0].name, 'read')
  assert.equal(allow.stats.skippedText, 1, '长 reasoning 的那条 read 必须被拦下')
  assert.equal(allow.stats.skippedTool, 2, 'pwsh 与 edit 都被工具门拦下')
  assert.deepEqual(allow.stats.blockedToolNames, { pwsh: 1, edit: 1 })
}

// ---------------------------------------------------------------- 外部审查回归：shell 破坏性命令
// 审查案例：`pwsh: Remove-Item important.txt` 在默认配置下会被选中整对压缩。
// 修复后（默认 = 只读白名单）必须被工具门拦下，且名字要出现在 blockedToolNames 里。
{
  const evs = []
  let seq = 0
  const push = (e) => evs.push(e)
  const addStep = (tool, args, output) => {
    const callId = `c${seq + 1}`
    push({ seq: (seq += 1), type: 'assistant/message', data: { message: { content: [{ type: 'tool-call', id: callId, name: tool, arguments: args }] } } })
    push({ seq: (seq += 1), type: 'tool/result', data: { message: { source: { callId }, content: [{ type: 'tool-result', content: [{ type: 'text', text: output }] }] } } })
    return seq
  }
  push({ seq: (seq += 1), type: 'user/message', data: { content: [{ type: 'text', text: 'clean up' }] } })
  addStep('pwsh', { command: 'Remove-Item important.txt' }, 'done')
  addStep('read', { file_path: 'notes.md' }, 'n'.repeat(3000))
  const at = (s) => evs.find((e) => e.seq === s)
  const surf = evs.map((e) => e.seq)
  // cache 按工具**结果**的 seq 索引：user(1) pwsh头(2) pwsh结果(3) read头(4) read结果(5)
  const cache = new Map([[3, { keep: false, prob: 0.05, effectProb: 0.02, chars: 10 }]])
  cache.set(5, { keep: false, prob: 0.05, effectProb: 0.02, chars: 3000 })

  const buildCfg = (compactTools) => ({
    preserveRecent: 0,
    compactTools,
    neverCompactTools: DEFAULT_NEVER_COMPACT_TOOLS,
    evidenceGuard: true,
    evidencePatterns: DEFAULT_EVIDENCE_PATTERNS,
    maxStepTextChars: 240,
    compactMinChars: 100,
  })
  const runCase = (compactTools) => selectReceiptRanges({
    surface: surf,
    eventAt: at,
    cache,
    dropVerdict: () => true,
    cfg: buildCfg(compactTools),
  })

  // 默认配置：pwsh 被拦，即使其结果"可丢 + 无副作用"（两轴全过也没用 —— 工具门在前）
  const safe = runCase(DEFAULT_COMPACT_TOOLS)
  assert.equal(safe.ranges.length, 1)
  assert.deepEqual(safe.ranges[0].steps.map((s) => s.calls[0].name), ['read'],
    '默认配置下 pwsh 步绝不能进压缩范围')
  assert.equal(safe.stats.blockedToolNames.pwsh, 1, '被拦的名字必须可观测')

  // 反事实：显式放宽到 [] 才会让 pwsh 进候选 —— 证明拦截来自白名单这一道门
  const relaxed = runCase([])
  assert.equal(relaxed.ranges[0].steps.length, 2, '放宽模式下 pwsh 可进候选（显式 opt-in）')
}

// ---------------------------------------------------------------- sessionEvents 回退链
// 实测活的 DSH 会话对象上 session.events 是 undefined —— 只有 eventAt 与 surface 可用。
// 之前所有 `session.events ?? []` 都拿到空数组，导致工具名索引 0 条、任务目标丢失。
{
  const evs = [
    { seq: 1, type: 'tool/call', data: { callId: 'c1', name: 'read', arguments: '{}' } },
    { seq: 2, type: 'assistant/message', data: { message: { content: [{ type: 'tool-call', id: 'c2', name: 'pwsh', arguments: '{}' }] } } },
    { seq: 3, type: 'tool/result', data: { message: { source: { callId: 'c1' }, content: [{ type: 'tool-result', content: [{ type: 'text', text: 'ok' }] }] } } },
  ]
  const bySeq = new Map(evs.map((e) => [e.seq, e]))
  const mkSession = (overrides) => ({
    surface: { nodes: [1, 2, 3] },
    eventAt: (seq) => bySeq.get(seq) ?? null,
    ...overrides,
  })

  // ① 有 .events 数组 → 直接用
  assert.deepEqual(sessionEvents(mkSession({ events: evs })), evs)
  // ② .events 缺失/undefined（真实 DSH 的情况）→ 回退到遍历 surface + eventAt
  const fallback = sessionEvents(mkSession({ events: undefined }))
  assert.equal(fallback.length, 3, 'session.events 缺失时必须回退到 surface+eventAt')
  assert.deepEqual(fallback.map((e) => e.seq), [1, 2, 3])
  // ③ snapshotEvents 也可用
  const snap = sessionEvents(mkSession({ snapshotEvents: () => evs }))
  assert.equal(snap.length, 3)
  // ④ 什么都没有 → 空数组，不抛错
  assert.deepEqual(sessionEvents({ surface: { nodes: [] } }), [])
  assert.deepEqual(sessionEvents(null), [])
}

// ---------------------------------------------------------------- 打包完整性
// 这一类错误只有"装进宿主后启动"才会暴露：源码里加了一个模块、忘了同步
// package.json 的 files 或复制清单 → 宿主里 ERR_MODULE_NOT_FOUND → 整个 profile 起不来。
// 在这里提前守住。
{
  const pkg = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8'))
  const declared = new Set([...(pkg.files ?? []), 'package.json'])
  const srcFiles = [...declared].filter((f) => f.endsWith('.js'))
  assert.ok(srcFiles.length >= 4, `package.json.files 应声明至少 4 个 js 文件，实际 ${srcFiles.length}`)
  for (const file of srcFiles) {
    assert.ok(existsSync(join(here, file)), `package.json.files 声明了 ${file} 但它不存在`)
  }
  // 每个相对 import 都必须落到实际文件上
  for (const file of srcFiles) {
    const text = readFileSync(join(here, file), 'utf8')
    for (const m of text.matchAll(/from\s+'\.\/([^']+)'/g)) {
      assert.ok(existsSync(join(here, m[1])), `${file} 里 ./${m[1]} 指向不存在的文件`)
    }
  }
  // 入口本身必须在 files 里
  assert.ok(declared.has('index.js'), 'package.json.files 必须包含入口 index.js')

  // 不在 files 里（不随包分发）但必须存在于仓库的脚本，也要检查其相对 import 能落地。
  // 这类文件是"忘了同步"的高发区：改了源码文件名却忘了改脚本的 import。
  for (const file of ['smoke_apply.mjs', 'check.js', 'wire_profile.mjs', 'probe_effect.js', 'e2e_jev.js']) {
    if (!existsSync(join(here, file))) continue
    const text = readFileSync(join(here, file), 'utf8')
    for (const m of text.matchAll(/from\s+'\.\/([^']+)'/g)) {
      assert.ok(existsSync(join(here, m[1])), `${file} 里 ./${m[1]} 指向不存在的文件`)
    }
  }
}

console.log('ok —— 纯函数自检全部通过')
