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

import { JevClient, JevError, estimateTokens } from './jev.js'
import { JEV_PRUNE_MARKER, countChars, decideAction, parseLimit, planTrims, pruneSessionWithJev, sliceWithBudget } from './prune.js'
import {
  DEFAULT_COMPACT_TOOLS,
  DEFAULT_EVIDENCE_PATTERNS,
  DEFAULT_FLOOR_THRESHOLD,
  DEFAULT_MIN_CANDIDATES_FOR_RELATIVE,
  DEFAULT_NEVER_COMPACT_TOOLS,
  DSH_READONLY_TOOLS,
  RECEIPT_MARKER,
  balancedAfter,
  balancedBefore,
  cachedVerdictForEvent,
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
  resultExcerpt,
  selectCandidates,
  sessionEvents,
  toolNameOf,
} from './state.js'
import {
  CONFIG_WARNINGS,
  Config,
  clampConfigNumber,
  isCompactableTool,
  resolveConfig,
} from './index.js'

const here = dirname(fileURLToPath(import.meta.url))

// ---------------------------------------------------------------- token 估算
// 常数由真实 BPE 标定（见 jev.js 的 TOKEN_ESTIMATE_CONSTANTS 注释）。
// 英文词 ≤ 6 字母 → 0.9 片，向上取整后是 1
assert.equal(estimateTokens('abcdef'), 1)
// 12 字母 → 0.9 + 6×0.16 = 1.86 → ceil = 2
assert.equal(estimateTokens('abcdefghijkl'), 2)
// 数字串按 1.8 片/位分组：4 位 → 4/1.8 = 2.22 → ceil = 3
assert.equal(estimateTokens('1234'), 3)
// 符号成串按 0.65/字符：4 个 → 2.6 → ceil = 3
assert.equal(estimateTokens('....'), 3)
// 混排的实际量级：JSON 密集文本不能被明显低估
const jsonish = '{"file_path": "/server/src/game/betting.ts", "limit": 1000}'
const got = estimateTokens(jsonish)
assert.ok(got >= 20 && got <= 60, `JSON 估算应在合理区间，实际 ${got}`)
assert.equal(estimateTokens(''), 0)

// 空串与纯空白都要落到 0/1 的边界，不能变成 0 除或 NaN
assert.ok(estimateTokens(' ') >= 1, '纯空白至少要算 1（下游会拿它当除数）')

// 标定效果（issue #33 回归）：对真实 BPE 的平均绝对偏差必须压住。
//
// ⚠️ 留出集原则（PR #28 review）：这些样本**不得**参与常数拟合。
// 早期版本直接复用了标定数据本身，于是断言退化成同义反复——它必然通过，
// 只能防"手改常数"，完全防不了"过拟合到拟合集"。
// 下面这组是标定时**留出**的样本（gpt-tokenizer 实测值），常数没见过它们，
// 所以 MAE 超过阈值真的说明泛化坏了。
const HOLDOUT_CASES = [
  // [文本, 真实 token 数（gpt-tokenizer 实测，未参与拟合）]
  ['There is a substantial difference between a plausible-sounding explanation and a verified one; the former is cheap, the latter is not. '.repeat(3), 79],
  ['DEFAULT_NEVER_PRUNE_TOOLS DEFAULT_NEVER_COMPACT_TOOLS resolveConfig clampConfigNumber CONFIG_RANGES CONFIG_WARNINGS '.repeat(3), 76],
  ['这个插件的第一层只做截断（可逆），第二层会把调用与结果整对移出（破坏性），所以两层的黑名单必须分开维护。'.repeat(3), 120],
  ['await client.ask(state, questions, { signal }) 之后要检查 lastRetries lastError 与 requests，不能用累计量判断"这一次"是否重试过。'.repeat(3), 105],
  ['2026-09-22T02:58:00.579Z WARN meter=missing threshold=3000 measured=false action=proceed\n'.repeat(5), 150],
]
let tokenAbsDrift = 0
for (const [text, real] of HOLDOUT_CASES) {
  tokenAbsDrift += Math.abs(estimateTokens(text) - real) / real
}
const tokenMae = tokenAbsDrift / HOLDOUT_CASES.length
if (!(tokenMae <= 0.15)) {
  throw new Error(`token 估算在留出集上的平均绝对偏差 ${(tokenMae * 100).toFixed(1)}% 超过 15%`
    + `（标定过拟合或常数被手改？）`)
}

// 方向性：估算不能系统性偏大（把两层的门都收紧）。
// 旧实现在英文与路径上 +37%/+44%，正是这条要防的。
const englishProse = HOLDOUT_CASES[0][0]
assert.ok(estimateTokens(englishProse) / 79 - 1 <= 0.15,
  `纯英文必须不显著高估（实际 ${estimateTokens(englishProse)} vs 真实 79）`)

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
  // 故意用小写（issue #1/#2）：默认黑名单是 PascalCase，真实 DSH 工具名是全小写——
  // 字面 includes 会让这条排除静默失效。比较必须走 isToolIn 的归一化。
  neverPruneTools: ['edit', 'write'],
  marker: '已裁剪',
  nameByCallId: nameIndex,
})
const seqs = candidates.map((c) => c.seq)
assert.deepEqual(seqs, [3, 5], `候选应为 [3,5]，实际 ${JSON.stringify(seqs)}`)
assert.equal(candidates[0].tool, 'Read')
assert.equal(candidates[0].chars, 5000)
// s7 是 Edit 结果 → 被 neverPruneTools 排除（'Edit' 必须能匹配小写黑名单 'edit'）
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
// tool/result 只给注记、体积与**有界摘录**——不给全文。
// P0-2 起不变量变了：从"正文一律不进 state"改为"正文只能以 ≤ resultExcerptChars 的摘录出现"。
// 判盲的代价是实测过的（Claude 版 256 条无一过阈值、我们 42/42 判过期），所以摘录默认开启。
assert.match(built.state, /\[s3\]\[tool_result\] ok, 5000 chars/)
assert.match(built.state, /摘录: /, 'P0-2：结果应带关键摘录（判盲缓解）')
assert.equal(/x{1000}/.test(built.state), false, '工具结果正文不得整段进 state（只允许有界摘录）')
assert.equal(/x{200}/.test(built.state), false, '单行超长正文只允许取头部一小段（摘录受预算截断）')

// P0-2：摘录要带**对的线索**——头几行 + 命中证据词的行（报错/失败**往往在结果中段**，
// 正是"掐中间"策略会丢掉的位置）
{
  const body = [
    'Step 2/7 : RUN apt-get update && apt-get install -y curl',
    ...Array.from({ length: 40 }, (_, i) => `filler line ${i} lorem ipsum dolor sit amet`),
    'ERROR E2001_BASE_IMAGE: base image node:18-broken does not exist; use node:20-alpine instead',
    ...Array.from({ length: 40 }, (_, i) => `tail filler ${i}`),
  ].join('\n')
  const ev = {
    type: 'tool/result',
    data: { message: { source: { callId: 'cX' }, content: [{ type: 'tool-result', content: [{ type: 'text', text: body }] }] } },
  }
  const excerpt = resultExcerpt(ev, 240)
  assert.match(excerpt, /Step 2\/7/, '头行应进摘录（"这是什么文件/命令"）')
  assert.match(excerpt, /E2001_BASE_IMAGE/, '中段的证据行应进摘录（这是掐中间会丢的那一段）')
  assert.equal(excerpt.includes('tail filler 39'), false, '尾部无证据的填充不该占摘录预算')
  assert.ok(Array.from(excerpt).length <= 240, `摘录必须受预算约束，实际 ${Array.from(excerpt).length}`)
  assert.equal(resultExcerpt(ev, 0), '', '预算 0 = 关闭摘录')
  // 关闭时必须回到旧行为（可配置回退，别把判盲当成不可逆）
  const off = buildJevState({
    surface,
    eventAt,
    goal,
    options: { textHead: 400, textTail: 150, maxStateTokens: 25000, inputChars: 300, resultExcerptChars: 0 },
  })
  assert.equal(/x{100}/.test(off.state), false, 'resultExcerptChars=0 时必须回到"只给体积"的旧行为')
}

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

// abridge 的两个回归（issue #4/#5）：
// ① head/tail undefined（config 未经 schemastery 归一化）→ 不得产生 NaN 或重复原文
// ② 按 Unicode 码点切片，不得劈开代理对（README 的承诺在 state 侧同样成立）
{
  const evs2 = [userEvent(1, 'a'.repeat(600))] // 600 码点 > 400+150+40 → 必须触发截断
  const built2 = buildJevState({
    surface: [1],
    eventAt: (s) => evs2.find((e) => e.seq === s),
    goal: '',
    options: {},
  })
  assert.equal(built2.state.includes('NaN'), false, '缺 textHead/textTail 时不得产生 NaN')
  // NaN 路径下 slice(0,undefined) 会返回整段原文 → 600 个 a 出现两遍；
  // 正常路径只有头部 400 个 a + 尾部 150 个 a，"400 连 a"恰好出现 1 次
  assert.equal(built2.state.split('a'.repeat(400)).length - 1, 1, '同一段文本不得被输出两遍')

  const emojiText = 'a'.repeat(399) + '😀' + 'b'.repeat(400)
  const evs3 = [userEvent(1, emojiText)]
  const built3 = buildJevState({
    surface: [1],
    eventAt: (s) => evs3.find((e) => e.seq === s),
    goal: '',
    options: { textHead: 400, textTail: 150 },
  })
  const lonely = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(built3.state)
  assert.equal(lonely, false, 'state 不得包含孤立代理项（abridge 必须按码点切）')
}

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

// parseLimit（pressureLevel 已删除：有测试无调用的死代码，issue #14）
assert.deepEqual(parseLimit('55%'), { kind: 'ratio', value: 0.55 })
assert.deepEqual(parseLimit('154000'), { kind: 'tokens', value: 154000 })

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
  savedChars: 0, keptByJev: 0, keptByTail: 0, keptByBlacklist: 0,
  skipped: 0, errors: 0, lastNote: '',
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
  const { out, session, stats } = run({
    events, cache: new Map([[14, { keep: false, prob: 0.05 }]]), cfg: { preserveRecent: 1 },
  })
  assert.equal(out.pruned.length, 0, '最近区不该被裁')
  assert.equal(session.appended.length, 0)
  // issue #8：最近区保护此前被记成"Jev 保留"——三个 keep 来源必须分开计数
  assert.equal(stats.keptByTail, 1, '最近区保护应记入 keptByTail')
  assert.equal(stats.keptByJev, 0, '最近区保护不应记入 keptByJev')
}

// ⑤ 永不裁剪工具 → 不碰
{
  const events = [resultEvent(15, 'c6', 'f'.repeat(5000))]
  const { out, stats } = run({
    events, cache: new Map([[15, { keep: false, prob: 0.05 }]]),
    cfg: { neverPruneTools: ['Bash'] }, // toolNameOf 固定返回 Bash
  })
  assert.equal(out.pruned.length, 0, 'neverPruneTools 里的工具不该被裁')
  // issue #8：黑名单保护此前在统计里完全不可见（三个计数器全 0）
  assert.equal(stats.keptByBlacklist, 1, '黑名单保护应记入 keptByBlacklist')
  assert.equal(stats.keptByJev, 0)
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

// ================================================================ P0-1：压力自适应分位的裁剪选择
// 为什么需要这一层：Jev 概率是**窄带**的（真实会话实测 42/42 条低于 0.5、P50=0.13），
// 固定 0.5 阈值会把每一轮判定都读成"可裁"；而纯相对分位又会"每轮必裁固定比例"。
// 所以拆成正交的两件事：**裁多少**由压力缺口比例定（ratio × 池子总增益）、**裁哪些**由概率排序定。
{
  const node = (seq, chars, prob, extra = {}) => ({
    seq, index: seq, tool: 'read', chars,
    gain: chars - 50 - 30 - 6, // 与 baseCfg 的 head/tail 一致（marker=' MARK ' 6 字符）
    prob, effectProb: prob, verdict: { keep: prob >= 0.5, prob }, inTail: false, blacklisted: false,
    ...extra,
  })

  // ① 压力缺口为 0（ratio=0）→ **一条都不裁**
  const small = [node(1, 800, 0.05), node(2, 900, 0.06), node(3, 1000, 0.07), node(4, 1100, 0.08)]
  const zeroPlan = planTrims(small, { keepMode: 'budget', pressureRatio: 0 })
  assert.equal(zeroPlan.mode, 'budget')
  assert.equal(zeroPlan.budget, 0, '无压力缺口时预算应为 0')
  assert.equal(zeroPlan.selected.length, 0, '预算为 0 时一条都不裁')

  // ② ratio=0.5 → 预算 = 池子总增益的一半；按概率升序裁，裁够就停
  const mixed = [
    node(10, 12000, 0.09),
    node(11, 900, 0.03),   // 概率最低
    node(12, 900, 0.04),
    node(13, 900, 0.20),
  ]
  const plan = planTrims(mixed, { keepMode: 'budget', pressureRatio: 0.5 })
  assert.equal(plan.mode, 'budget')
  const totalGain = mixed.reduce((s, n) => s + n.gain, 0)
  assert.equal(plan.budget, totalGain * 0.5, '预算应为池子总增益 × 压力比例')
  // 顺序即设计：按概率升序裁，先裁低概率的小结果，省不够预算时必须动到那条大的（10）
  assert.deepEqual(plan.selected, [11, 12, 10], '按概率升序裁，裁到省够预算为止')
  assert.ok(plan.spent >= plan.budget, '裁完必须至少省到预算量')

  // ③ 保护上限：prob ≥ keepThreshold 的一律不进候选池
  const protectedSet = [node(20, 12000, 0.9), node(21, 900, 0.05), node(22, 900, 0.06), node(23, 900, 0.07)]
  const guarded = planTrims(protectedSet, { keepMode: 'budget', pressureRatio: 0.5 })
  assert.equal(guarded.keptByCeiling, 1, 'prob 0.9 的应计入保护上限')
  assert.equal(guarded.selected.includes(20), false, '保护上限之上的结果绝不能被选中')

  // ④ 小样本（< minCandidatesForBudget）→ 降级绝对下限，只裁 prob < floorThreshold 的
  const tiny = [node(30, 12000, 0.05), node(31, 12000, 0.30)]
  const floored = planTrims(tiny, { keepMode: 'budget', pressureRatio: 0.5 })
  assert.equal(floored.mode, 'floor', '候选太少应降级为绝对下限')
  assert.deepEqual(floored.selected, [30], '降级模式只裁 prob < 0.2 的')

  // ⑤ keepMode 不是 budget 时返回 null（调用方退回逐节点 absolute 裁决，旧行为不变）
  assert.equal(planTrims(mixed, { keepMode: 'absolute' }), null)
  assert.equal(planTrims(mixed, undefined), null, '缺省时不得改变旧行为')

  // ⑤b 修 null 排序 bug：prob=null 的节点（result 轴批次失败）不得进 selected，更不该被当成 0 优先裁
  {
    const withNull = [node(60, 12000, null), node(61, 900, 0.05), node(62, 900, 0.06), node(63, 900, 0.07)]
    const p = planTrims(withNull, { keepMode: 'budget', pressureRatio: 0.5 })
    assert.equal(p.selected.includes(60), false, 'prob=null 的节点不得进 selected（失败方向：未知不裁）')
  }

  // ⑥ 整链：budget 模式下按 ratio 只裁"预算内"的那条，其余如实记为"预算用尽"
  {
    const events = [
      resultEvent(40, 'c1', 'x'.repeat(12000)),
      resultEvent(41, 'c2', 'y'.repeat(5000)),
      resultEvent(42, 'c3', 'z'.repeat(900)),
      resultEvent(43, 'c4', 'w'.repeat(900)),
    ]
    const { out, stats } = run({
      events,
      cache: new Map([
        [40, { keep: false, prob: 0.05 }], [41, { keep: false, prob: 0.06 }],
        [42, { keep: false, prob: 0.07 }], [43, { keep: false, prob: 0.08 }],
      ]),
      cfg: { keepMode: 'budget', pressureRatio: 0.25 },
    })
    assert.equal(out.pruned.length, 1, '只裁预算内的那一条')
    assert.equal(out.pruned[0].originalSeq, 40)
    assert.equal(stats.prunedByJev, 1)
    assert.equal(stats.keptByBudget, 3, '概率同样低但预算已用尽的那三条应记入 keptByBudget')
    assert.equal(out.plan.mode, 'budget')
    assert.equal(out.decisions[0].reason, 'selected(budget)')
    assert.equal(out.decisions[1].reason, 'budget-exhausted')
  }

  // ⑦ 对照：`absolute` 模式（旧行为）下四条都会被裁 —— 证明省下来的是"分位"在起作用
  {
    const events = [
      resultEvent(50, 'c1', 'x'.repeat(12000)),
      resultEvent(51, 'c2', 'y'.repeat(5000)),
      resultEvent(52, 'c3', 'z'.repeat(900)),
      resultEvent(53, 'c4', 'w'.repeat(900)),
    ]
    const { out } = run({
      events,
      cache: new Map([
        [50, { keep: false, prob: 0.05 }], [51, { keep: false, prob: 0.06 }],
        [52, { keep: false, prob: 0.07 }], [53, { keep: false, prob: 0.08 }],
      ]),
      cfg: { keepMode: 'absolute' },
    })
    assert.equal(out.pruned.length, 4, 'absolute 模式会四条都裁（这是被替换掉的旧行为）')
  }
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

  // 小总体分支（issue #27 修复）：此前样本不足**直接返回空集** → 第二层在只读占比低的
  // 会话里静默不工作。现在改为降级到绝对下限模式，但下限阈值明显更严（0.2）。
  //
  // ⚠️ 这里必须分成**两个口径**测。原断言只用默认配置测 k=2 → 期望 0，而
  // `computeEligibleSeqs` 的默认参数曾是硬编码字面量 `3` / `0.2`，与导出的
  // `DEFAULT_MIN_CANDIDATES_FOR_FLOOR` / `DEFAULT_FLOOR_THRESHOLD` **分叉**：
  // 常量改成 2 之后插件实体（走 resolveConfig，读常量）行为已变，而这行断言吃的是旧字面量、
  // 依然全绿 —— 它测的是一个真实配置路径上不存在的数。现在默认值引用常量，
  // 于是两个口径都必须显式写出来。
  assert.equal(computeEligibleSeqs(verdicts.slice(0, 2), { quantile: 0.5, minCandidates: 4, minCandidatesForAbsolute: 3 }).size, 0,
    '显式把地板设成 3 时，2 条样本仍不得做整对移出')
  assert.equal(computeEligibleSeqs(verdicts.slice(0, 2), { quantile: 0.5, minCandidates: 4 }).size, 2,
    '默认地板=2 时，2 条样本进绝对下限模式并全选（与 DEFAULT_MIN_CANDIDATES_FOR_FLOOR 一致）')
  assert.equal(computeEligibleSeqs(verdicts.slice(0, 1), { quantile: 0.5, minCandidates: 4 }).size, 0,
    '1 条样本在任何配置下都不得动作（分布的下限）')

  // 缺任何一轴的概率都不参与
  assert.equal(computeEligibleSeqs(
    Array.from({ length: 6 }, (_, i) => ({ seq: i + 1, prob: 0.1 })),
    { quantile: 0.5, minCandidates: 4 },
  ).size, 0, '缺 effectProb 的判定不能用于第二层')

  // quantile 非法必须 fail loud（issue #6）：此前 NaN/undefined 静默返回空集，
  // 第二层"功能静默死亡"且报错文案被误读成"样本不够"
  for (const bad of [undefined, NaN, -0.1, 1.5, '0.34']) {
    assert.throws(
      () => computeEligibleSeqs(verdicts, { quantile: bad, minCandidates: 4 }),
      (e) => /compactQuantile 非法/.test(e.message),
      `quantile=${String(bad)} 应抛错`,
    )
  }
  // quantile=0 的语义是字面意义"一条不取"（此前 Math.max(1,…) 反而取 1 条）
  let disabledNote = ''
  assert.equal(computeEligibleSeqs(verdicts, {
    quantile: 0,
    minCandidates: 4,
    onNote: (note) => { disabledNote = note },
  }).size, 0)
  assert.match(disabledNote, /compactQuantile=0.*关闭/, '显式关闭不能误报成“分位交集为空”')
  assert.equal(computeEligibleSeqs(verdicts.slice(0, 2), { quantile: 0, minCandidates: 4 }).size, 0,
    'quantile=0 必须在小样本降级之前生效，2 条低分候选也不得被重新选中')

  // 两轴各取 1 条但不是同一节点时，交集为空；严格绝对下限仍可救回两轴都很低的节点。
  let fallbackNote = ''
  const disjoint = computeEligibleSeqs([
    { seq: 1, prob: 0.01, effectProb: 0.90 },
    { seq: 2, prob: 0.90, effectProb: 0.01 },
    { seq: 3, prob: 0.10, effectProb: 0.10 },
    { seq: 4, prob: 0.80, effectProb: 0.80 },
  ], { quantile: 0.25, minCandidates: 4, onNote: (note) => { fallbackNote = note } })
  assert.deepEqual([...disjoint], [3], '相对尾部交集为空时应降级到两轴绝对下限')
  assert.match(fallbackNote, /交集为空.*绝对下限/, '降级必须通过 onNote 对外可见')

  const cached = { keep: false, prob: 0.1, effectProb: 0.1 }
  const cache = new Map([[7, cached]])
  assert.equal(cachedVerdictForEvent(cache, { seq: 7 }), cached, '当前 seq 直接命中优先')
  assert.equal(cachedVerdictForEvent(cache, { seq: 70, sourceEventSeqs: [7] }), cached,
    '第一层 replacement 必须沿 sourceEventSeqs 找回旧 seq 的判定')
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
    maxStepReasoningChars: 240,
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

  // 6) assistant 可见文本过长 → 整步排除（text 轴）
  const chatty = at(range.start)
  chatty.data.message.content[0].text = '先想一下'.repeat(100)
  const chattyRun = run()
  assert.equal(chattyRun.stats.skippedText, 1, '过长的可见文本不应被整对移出')
  assert.equal(chattyRun.stats.skippedReasoning, 0, 'text 轴拦截不得计入 reasoning 轴计数')
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

// ---------------------------------------------------------------- replacement 来源链上的证据也必须守住
// 第一层可能把位于正文中间的 error 截掉；第二层若只扫描 surface 上的 replacement，
// 会误以为没有证据并把整个调用/结果对移出。
{
  const original = toolResult(2, 'c1', `${'a'.repeat(1200)}fatal error: hidden in middle${'b'.repeat(1200)}`)
  const replacement = {
    ...toolResult(3, 'c1', `${'a'.repeat(100)}${JEV_PRUNE_MARKER}${'b'.repeat(100)}`),
    sourceEventSeqs: [2],
  }
  const evs = [
    assistantWithCall(1, 'c1', 'Read', { file_path: 'hidden-error.txt' }),
    original,
    replacement,
  ]
  const at = (seq) => evs.find((event) => event.seq === seq)
  const cache = new Map([[2, { keep: false, prob: 0.05, effectProb: 0.05, chars: 2500, tool: 'Read' }]])
  const { ranges, stats } = selectReceiptRanges({
    surface: [1, 3],
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
      maxStepReasoningChars: 240,
      compactMinChars: 10,
    },
  })
  assert.equal(ranges.length, 0, '原始结果中被第一层截掉的 error 仍应阻止第二层整对移出')
  assert.equal(stats.skippedGuard, 1, '来源链证据应计入 guard 排除，而不是 verdict/short')
  assert.deepEqual(stats.guardHits[0]?.matches, ['error'])
}

// ---------------------------------------------------------------- blockedToolNames 诊断口径
// issue #7：多调用步骤此前把**所有**调用名都记进 blockedToolNames，通过白名单的也中招——
// 用户会按 jev_probe_shapes 的提示去"补配"一个本来就在白名单里的名字。
{
  const evs = []
  let seq = 0
  // 一个 assistant 消息同时带两个 tool-call：read（在白名单）+ pwsh（不在）
  evs.push({
    seq: (seq += 1),
    type: 'assistant/message',
    data: { message: { content: [
      { type: 'tool-call', id: 'ca', name: 'read', arguments: '{}' },
      { type: 'tool-call', id: 'cb', name: 'pwsh', arguments: '{}' },
    ] } },
  })
  evs.push({ seq: (seq += 1), type: 'tool/result', data: { message: { source: { callId: 'ca' }, content: [{ type: 'tool-result', content: [{ type: 'text', text: 'x'.repeat(2000) }] }] } } })
  evs.push({ seq: (seq += 1), type: 'tool/result', data: { message: { source: { callId: 'cb' }, content: [{ type: 'tool-result', content: [{ type: 'text', text: 'y'.repeat(2000) }] }] } } })

  const at = (s) => evs.find((e) => e.seq === s)
  const cache = new Map()
  for (const e of evs) {
    if (e.type !== 'tool/result') continue
    cache.set(e.seq, { keep: false, prob: 0.1, effectProb: 0.05, chars: 2000, tool: 'read' })
  }
  const { stats } = selectReceiptRanges({
    surface: evs.map((e) => e.seq),
    eventAt: at,
    cache,
    dropVerdict: () => true,
    cfg: {
      preserveRecent: 0,
      compactTools: ['read', 'glob'],
      neverCompactTools: DEFAULT_NEVER_COMPACT_TOOLS,
      evidenceGuard: false,
      evidencePatterns: DEFAULT_EVIDENCE_PATTERNS,
      maxStepTextChars: 240,
      maxStepReasoningChars: 240,
      compactMinChars: 100,
    },
  })
  assert.equal(stats.skippedTool, 1)
  assert.deepEqual(Object.keys(stats.blockedToolNames).sort(), ['pwsh'],
    `blockedToolNames 只应含真正违规的名字，实际 ${JSON.stringify(stats.blockedToolNames)}`)
  assert.equal(stats.blockedToolNames.read, undefined, '通过白名单的名字不应被记为 blocked')
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
      maxStepReasoningChars: 240,
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

  // 段首匹配（issue #1）：命中必须落在标识符段开头 —— 压掉子串误报、保住真证据
  assert.equal(scanEvidence('debugging the parser', ['bug']).hit, false, 'bug 不应被 debug 触发')
  assert.equal(scanEvidence('__debug__', ['bug']).hit, false, '下划线包裹的复合标识符也不该触发')
  assert.equal(scanEvidence('this.debug = 1', ['bug']).hit, false)
  assert.equal(scanEvidence('bugs found', ['bug']).hit, true, '复数形式仍是证据')
  assert.equal(scanEvidence('bugfix applied', ['bug']).hit, true)
  assert.equal(scanEvidence('errors: 3', ['error']).hit, true, '复数形式仍是证据')
  assert.equal(scanEvidence('getError()', ['error']).hit, true, '驼峰分界算段首')
  assert.equal(scanEvidence('myerror', ['error']).hit, false, '无分隔符的复合标识符不算段首')
  assert.equal(scanEvidence('TODOs left', ['todo']).hit, true)
  assert.equal(scanEvidence('pseudotodo', ['todo']).hit, false)
  assert.equal(scanEvidence('default: x', ['fail:']).hit, false, 'fail: 不应被 default: 触发')
  assert.equal(scanEvidence('stack trace follows', ['stack trace']).hit, true)
  assert.equal(scanEvidence('mystack trace', ['stack trace']).hit, false)

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
      maxStepReasoningChars: 240,
      compactMinChars: 100,
    },
  })
  // 前两步合格（pwsh 不在黑名单里、read 合格）→ 合成一段
  assert.equal(ranges.length, 1)
  assert.equal(ranges[0].steps.length, 2)
  assert.equal(stats.skippedTool, 1, 'edit 应被黑名单拦下（归一化后比较）')
  assert.deepEqual(stats.blockedToolNames, { edit: 1 }, '必须如实记下被拦下的名字')
  assert.deepEqual(stats.allowedToolNames, { pwsh: 1, read: 1 }, '通过的名字也要记，便于自查')
  assert.equal(stats.skippedReasoning, 1, '长 reasoning 必须计入 reasoning 轴门控（只数 text 会让门控形同虚设）')
  assert.equal(stats.skippedText, 0, 'reasoning 轴拦截不得计入 text 轴计数')

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
      maxStepReasoningChars: 240,
      compactMinChars: 100,
    },
  })
  assert.equal(allow.ranges.length, 1, '只允许 read → 剩短文本那一读'
    + '（另一条 read 带长 reasoning，被 reasoning 轴门控拦下）')
  assert.equal(allow.ranges[0].steps.length, 1)
  assert.equal(allow.ranges[0].steps[0].calls[0].name, 'read')
  assert.equal(allow.stats.skippedReasoning, 1, '长 reasoning 的那条 read 必须被拦下')
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
    maxStepReasoningChars: 240,
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
  // issue #13：此前只对 .js 做存在性与 import 检查，package.json.files 里的
  // 4 个 .mjs 全部漏检（verify_real_shapes.mjs 恰好有真实的相对 import）
  const srcFiles = [...declared].filter((f) => f.endsWith('.js') || f.endsWith('.mjs'))
  assert.ok(srcFiles.length >= 8, `package.json.files 应声明至少 8 个源文件，实际 ${srcFiles.length}`)
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
  // issue #13：名单里曾有 probe_effect.js / e2e_jev.js —— 从未存在过，静默 continue
  // 让这道存在性检查永远空转；现改为缺失即断言失败，并补上真正存在的两个工具。
  for (const file of ['smoke_apply.mjs', 'check.js', 'wire_profile.mjs', 'inspect_session.mjs', 'verify_real_shapes.mjs']) {
    assert.ok(existsSync(join(here, file)), `辅助脚本 ${file} 必须存在于仓库（若已改名请同步这份名单）`)
    const text = readFileSync(join(here, file), 'utf8')
    for (const m of text.matchAll(/from\s+'\.\/([^']+)'/g)) {
      assert.ok(existsSync(join(here, m[1])), `${file} 里 ./${m[1]} 指向不存在的文件`)
    }
  }
}

// ---------------------------------------------------------------- 分位总体的可压缩性（外部审查）

{
  // 背景：第一层的判定缓存复用 selectCandidates 的候选，那份候选只排除黑名单
  // （第一层没有白名单），所以 shell 之类不可整对移出的调用也会进缓存。
  // 第二层若直接拿整份缓存当分位总体，尾部名额会被这些节点占掉、随后又被工具门
  // 全部拒绝 → 静默少压缩。下面三组断言把口径钉住。

  const cfg = { compactTools: ['read', 'glob'], neverCompactTools: DEFAULT_NEVER_COMPACT_TOOLS }

  assert.equal(isCompactableTool('read', cfg), true, '白名单内的只读工具可移出')
  assert.equal(isCompactableTool('pwsh', cfg), false, '白名单外的 shell 不可移出')
  assert.equal(isCompactableTool('edit', cfg), false, '黑名单优先于白名单')
  assert.equal(isCompactableTool('Edit', cfg), false, '黑名单比较要归一化（Edit ≡ edit）')

  // compactTools=[] 是显式的不安全模式：只受黑名单约束
  const relaxed = { compactTools: [], neverCompactTools: DEFAULT_NEVER_COMPACT_TOOLS }
  assert.equal(isCompactableTool('pwsh', relaxed), true, '放宽模式下 shell 变成可移出')
  assert.equal(isCompactableTool('edit', relaxed), false, '放宽模式下黑名单仍然生效')

  // 尾部名额不应被不可移出的节点占满：6 条 shell（更“过期”）+ 4 条 read
  const mk = (seq, tool, p, e) => ({ seq, tool, prob: p, effectProb: e })
  const verdicts = [
    mk(1, 'pwsh', 0.10, 0.05), mk(2, 'pwsh', 0.11, 0.06), mk(3, 'pwsh', 0.12, 0.07),
    mk(4, 'pwsh', 0.13, 0.08), mk(5, 'pwsh', 0.14, 0.09), mk(6, 'pwsh', 0.15, 0.10),
    mk(7, 'read', 0.40, 0.30), mk(8, 'read', 0.45, 0.35), mk(9, 'read', 0.50, 0.40), mk(10, 'read', 0.55, 0.45),
  ]
  const filtered = verdicts.filter((v) => isCompactableTool(v.tool, cfg))
  const eligible = computeEligibleSeqs(filtered, { quantile: 0.34, minCandidates: 4 })
  assert.deepEqual([...eligible], [7], '过滤后尾部应落在可移出的 read 上，而不是被 shell 占满')
  assert.equal(computeEligibleSeqs(verdicts, { quantile: 0.34, minCandidates: 4 }).size > 0, true,
    '不过滤时仍会给出（无用的）尾部——这正是需要过滤的原因')
}

// ---------------------------------------------------------------- 小总体降级（issue #27 回归）

{
  // 修复前：`usable.length < minCandidates` 一律返回空集。后果是**只读工具在写/执行
  // 密集会话里占少数时，第二层在绝大多数真实会话中静默不工作**，而报错只说
  // "需要 ≥4 个"，读起来像"样本确实不够"而不像 bug。这个块把降级行为钉成断言。
  const near = [
    { seq: 1, prob: 0.10, effectProb: 0.05 }, // 两轴都远低于 0.2 → 该选中
    { seq: 2, prob: 0.30, effectProb: 0.10 }, // effect 低但 prob 不够低 → 单轴尾部，不该选
    { seq: 3, prob: 0.50, effectProb: 0.45 }, // 两轴都高 → 不该选
  ]
  const notes = []
  const small = computeEligibleSeqs(near, {
    quantile: 0.34, minCandidates: 4, minCandidatesForAbsolute: 3, floorThreshold: 0.2,
    onNote: (n) => notes.push(n),
  })
  assert.deepEqual([...small], [1],
    '总体=3 (<4) 时不得直接放弃，应降级为绝对下限：仅两轴同时 <0.2 的入选')
  assert.equal(notes.length, 1, '降级必须发出说明（否则用户又分不清"样本不够"和"功能坏了"）')
  assert.ok(/降级为绝对下限/.test(notes[0]), `说明文案应点明降级：${notes[0]}`)

  // 绝对下限比 compactThreshold(0.5) 严：0.3/0.3 在 absolute 模式下会被选中，
  // 但在小总体的降级模式下必须被拒（没有相对信息时只能用"更保守"来补偿）
  const mid = [
    { seq: 4, prob: 0.30, effectProb: 0.30 },
    { seq: 5, prob: 0.31, effectProb: 0.32 },
    { seq: 6, prob: 0.33, effectProb: 0.33 },
  ]
  assert.equal(computeEligibleSeqs(mid, {
    quantile: 0.34, minCandidates: 4, minCandidatesForAbsolute: 3, floorThreshold: 0.2,
  }).size, 0, '降级模式的阈值必须明显严于 compactThreshold，两轴 0.3 不该被放行')

  // 样本连最低线都不到 → 仍然不做，且说明里点出原因
  const tinyNotes = []
  assert.equal(computeEligibleSeqs(near.slice(0, 2), {
    quantile: 0.34, minCandidates: 4, minCandidatesForAbsolute: 3,
    onNote: (n) => tinyNotes.push(n),
  }).size, 0)
  assert.ok(/低于绝对下限模式的最低样本/.test(tinyNotes[0] ?? ''), `应说明样本过少：${tinyNotes[0]}`)

  // 总体达标时**不得**触发降级分支（口径不能被悄悄改掉）
  const bigNotes = []
  const big = computeEligibleSeqs(verdicts6(), {
    quantile: 0.5, minCandidates: 4, minCandidatesForAbsolute: 3,
    onNote: (n) => bigNotes.push(n),
  })
  assert.equal(bigNotes.length, 0, '总体达标时必须走正常的相对分位路径，不得降级')
  assert.ok(big.size > 0, '正常路径仍应给出结果')

  function verdicts6() {
    return [
      { seq: 10, prob: 0.10, effectProb: 0.05 }, { seq: 12, prob: 0.12, effectProb: 0.06 },
      { seq: 14, prob: 0.11, effectProb: 0.07 }, { seq: 20, prob: 0.13, effectProb: 0.30 },
      { seq: 22, prob: 0.14, effectProb: 0.33 }, { seq: 24, prob: 0.15, effectProb: 0.28 },
    ]
  }
}

// ---------------------------------------------------------------- 判定值的有效性（外部审查）

{
  // typeof NaN === 'number'，所以用 typeof 过滤会让 NaN 混进总体；而排序比较
  // (a-b) 返回 NaN 被 V8 当作“相等”不换位，NaN 项便按数组位置混进尾部。
  const v = [
    { seq: 1, prob: NaN, effectProb: 0.10 },
    { seq: 2, prob: 0.40, effectProb: 0.20 },
    { seq: 3, prob: 0.50, effectProb: 0.30 },
    { seq: 4, prob: 0.60, effectProb: 0.40 },
    { seq: 5, prob: 0.70, effectProb: 0.50 },
  ]
  const r = computeEligibleSeqs(v, { quantile: 0.34, minCandidates: 4 })
  assert.equal(r.has(1), false, 'NaN 判定值不得被选为可整对移出')

  const withUndefined = v.map((x) => (x.seq === 1 ? { seq: 1, prob: undefined, effectProb: null } : x))
  assert.equal(computeEligibleSeqs(withUndefined, { quantile: 0.34, minCandidates: 4 }).has(1), false,
    'undefined/null 判定值同样不得入选')
}

// ---------------------------------------------------------------- 文本门控两轴分离（issue #26 回归）

{
  // 修复前：assistantTextChars = text + reasoning 累加，与单一阈值 maxStepTextChars 比较。
  // 后果：reasoning 的分布（实测 0~1207，且会溢出到数千）完全主导阈值，只要模型多写几句
  // 草稿，第二层就在没有任何日志的情况下整层失效。这个块把"两轴独立"钉成断言。
  const evs = []
  let seq = 0
  const addStep = (tool, text, reasoning) => {
    const callId = `t${seq + 1}`
    const content = [{ type: 'tool-call', id: callId, name: tool, arguments: {} }]
    if (text != null) content.unshift({ type: 'text', text })
    if (reasoning != null) content.unshift({ type: 'reasoning', text: reasoning })
    evs.push({ seq: (seq += 1), type: 'assistant/message', data: { message: { content } } })
    evs.push({
      seq: (seq += 1),
      type: 'tool/result',
      data: { message: { source: { callId }, content: [{ type: 'tool-result', content: [{ type: 'text', text: 'z'.repeat(3000) }] }] } },
    })
  }
  evs.push({ seq: (seq += 1), type: 'user/message', data: { content: [{ type: 'text', text: 'go' }] } })
  addStep('read', '看一下。', '想'.repeat(1300)) // 长 reasoning、短 text ← 修复前的"整层关闭"元凶
  const at2 = (s) => evs.find((e) => e.seq === s)
  const cache2 = new Map()
  for (const e of evs) if (e.type === 'tool/result') cache2.set(e.seq, { keep: false, prob: 0.1, effectProb: 0.05, chars: 3000 })
  const run2 = (over) => selectReceiptRanges({
    surface: evs.map((e) => e.seq),
    eventAt: at2,
    cache: cache2,
    dropVerdict: () => true,
    cfg: {
      preserveRecent: 0,
      compactTools: [],
      neverCompactTools: DEFAULT_NEVER_COMPACT_TOOLS,
      evidenceGuard: false,
      evidencePatterns: DEFAULT_EVIDENCE_PATTERNS,
      maxStepTextChars: 1200,
      maxStepReasoningChars: 4000,
      compactMinChars: 100,
      ...over,
    },
  })

  // ① 生产默认下，reasoning=1300 的步骤**必须合格**（修复前这里会是 0 段）
  const defaults = run2()
  assert.equal(defaults.ranges.length, 1,
    'reasoning=1300 在默认 maxStepReasoningChars=4000 下必须仍可整对移出'
    + '（修复前与 1200 的 text 阈值累加 → 0 段，第二层静默失效）')
  assert.equal(defaults.stats.skippedReasoning, 0)
  assert.equal(defaults.stats.skippedText, 0)

  // ② reasoning 真的超限时才拦，且只记到 reasoning 轴
  const tight = run2({ maxStepReasoningChars: 500 })
  assert.equal(tight.ranges.length, 0, 'reasoning 超过自己的阈值时必须拦下')
  assert.equal(tight.stats.skippedReasoning, 1)
  assert.equal(tight.stats.skippedText, 0, 'reasoning 轴拦截不得污染 text 轴计数')

  // ③ 反过来：reasoning 很长、但 text 超限 → 必须记到 text 轴
  //    （这条在修复前是"分不出来的"——两个原因共用一个计数器）
  const textOver = run2({ maxStepTextChars: 2 })
  assert.equal(textOver.stats.skippedText, 1, 'text 超限必须记到 text 轴')
  assert.equal(textOver.stats.skippedReasoning, 0, 'text 轴拦截不得污染 reasoning 轴计数')

  // ④ 两轴阈值互不影响：只调 text 阈值不得改变 reasoning 的判定结果
  const textLoose = run2({ maxStepTextChars: 100000 })
  assert.equal(textLoose.ranges.length, 1, '放宽 text 阈值不应影响 reasoning 轴的通过性')
}

// ---------------------------------------------------------------- 配置兜底完整性（外部审查）

{
  // 维护约定（见 index.js resolveConfig 注释）：Config schema 的每个 default 都必须
  // 在 resolveConfig 里有对应兜底。这条约定此前只写在注释里、没有测试固化，
  // 结果 baseUrl 悄悄漏掉。这里把它变成断言。
  const schemaKeys = Object.keys(Config?.dict ?? {})
  assert.ok(schemaKeys.length > 0, '应能枚举出 Config schema 的键')

  const resolved = resolveConfig({})
  const missing = schemaKeys.filter((key) => !(key in resolved))
  assert.deepEqual(missing, [], `resolveConfig 缺少这些键的兜底：${missing.join(', ')}`)

  // 未经 schemastery 归一化时，所有布尔/数组/数值键都必须有确定值（不能是 undefined）
  const empty = resolveConfig({})
  for (const key of schemaKeys) {
    assert.notEqual(empty[key], undefined, `${key} 在未归一化配置下不得为 undefined`)
  }
}

// ---------------------------------------------------------------- 越界配置钳制（issue #28 回归）

{
  // 修复前：schema 只有 .default()、resolveConfig 只有 `?? 兜底`（只挡 undefined/null），
  // 所以任何越界值原样穿透到运行时，且后果是**静默失效**而非报错。这个块把每条后果钉死。
  //
  // ⚠️ 这里有**两层独立防线**，测试必须分别打，否则会误判"修好了"：
  //   ① `Config(raw)`（schemastery）→ 越界**抛 ValidationError**，是"响亮的拒绝"
  //   ② `resolveConfig(raw)`（我们自己的钳制）→ 越界**回落到默认值 + 告警**，是"静默的修正"
  // 真实的"未归一化"路径（cordis.patch.yml 直接注入配置对象、冒烟测试的 PLUGIN_CFG）
  // 只经过 ②，所以 ② 必须自己站得住，不能依赖 ①。

  // ① schemastery 层必须响亮地拒绝（不是静默 clamp）
  assert.throws(() => Config({ preserveRecent: -5 }), /expected number >= 0/,
    'Config 应对越界值抛错，而不是悄悄改掉')
  assert.throws(() => Config({ compactPreserveRecent: -1 }), /expected number >= 0/)
  assert.throws(() => Config({ receiptMaxRatio: 5 }), /expected number <= 1/)

  // ② 我们的钳制层：越界 → 回落到默认值（而不是钳到边界）
  const neg = resolveConfig({ preserveRecent: -5 })
  assert.equal(neg.preserveRecent, 4, 'preserveRecent=-5 必须回落到默认 4（负数会让最近区保护反向放大）')
  assert.ok(neg[CONFIG_WARNINGS].some((w) => /preserveRecent/.test(w)), '钳制必须留下告警')
  assert.ok(/低于下限/.test(neg[CONFIG_WARNINGS][0]), `告警应说明原因：${neg[CONFIG_WARNINGS][0]}`)
  assert.ok(/已改为 4/.test(neg[CONFIG_WARNINGS][0]), '告警应同时给出改后的值')
  assert.equal(resolveConfig({ compactPreserveRecent: -1 }).compactPreserveRecent, 1,
    '第二层独立最近区的非法值应回落默认 1')

  // ②b 第二层永久静默失效：maxStepTextChars=-1 会让每一步都 text > -1
  assert.equal(resolveConfig({ maxStepTextChars: -1 }).maxStepTextChars, 1200)

  // ②c 经济性门失效
  assert.equal(resolveConfig({ compactMinChars: -100 }).compactMinChars, 2000)

  // ②d receiptMaxRatio 同时是"回执不得比原文大"的安全门 → 上界收在 1
  const high = resolveConfig({ receiptMaxRatio: 5 })
  assert.equal(high.receiptMaxRatio, 0.5, 'receiptMaxRatio > 1 等于允许"压缩后更占地方"')
  assert.ok(high[CONFIG_WARNINGS].some((w) => /高于上限/.test(w)), '超上限也要告警')

  // ②e 概率类越界
  assert.equal(resolveConfig({ keepThreshold: 2 }).keepThreshold, 0.5)
  assert.equal(resolveConfig({ floorThreshold: 7 }).floorThreshold, DEFAULT_FLOOR_THRESHOLD)

  // ②f 计数类下界不能是 0（配 0 等于把功能关掉，那是布尔开关的职责）
  assert.equal(resolveConfig({ minHistoryLines: 0 }).minHistoryLines, 8)
  assert.equal(resolveConfig({ maxCompactionsPerPass: 0 }).maxCompactionsPerPass, 3,
    '越界的配额回落默认值 3（issue #35 把默认从 1 提到 3）')
  assert.equal(resolveConfig({ minCandidatesForRelative: 1 }).minCandidatesForRelative,
    DEFAULT_MIN_CANDIDATES_FOR_RELATIVE, '相对分位至少要 2 条才谈得上"排序"')

  // ① 非数值一律回落到默认值（"改了多少"不可解释，"打到默认"才可解释）
  for (const bad of [NaN, Infinity, -Infinity, '600', {}, []]) {
    const got = clampConfigNumber('headChars', bad, 600, null)[0]
    assert.equal(got, 600, `headChars=${String(bad)} 应回落到默认值 600`)
  }

  // ① 未配置（undefined/null/''）**不是**非法，必须静默用默认值、不产生告警
  for (const unset of [undefined, null, '']) {
    const [v, clamped] = clampConfigNumber('headChars', unset, 600, null)
    assert.equal(v, 600)
    assert.equal(clamped, false, `${String(unset)} 是"没配"而不是"配错"，不该告警`)
  }
  assert.equal(resolveConfig({})[CONFIG_WARNINGS].length, 0, '全部合法的配置不得产生告警')

  // keepMode 白名单（review 修复）：拼错的模式必须回落 budget 并留痕，不得静默穿过
  {
    const bad = resolveConfig({ keepMode: 'budgt' })
    assert.equal(bad.keepMode, 'budget', '拼错的 keepMode 应回落 budget')
    assert.ok(bad[CONFIG_WARNINGS].some((w) => w.includes('keepMode')), 'keepMode 回落必须留下 configWarnings')
    const good = resolveConfig({ keepMode: 'absolute' })
    assert.equal(good.keepMode, 'absolute')
    assert.equal(good[CONFIG_WARNINGS].length, 0, '合法 keepMode 不告警')
  }

  // 废弃键的运行时信号（review 反馈）：显式配置 volumeBudgetThresholdChars / budgetMinChars
  // 必须推 configWarnings，否则用户配了却静默空转（与 keepMode 的留痕约定一致）。
  //
  // ⚠️ 必须走**宿主的真实取配置路径**：cordis 会先用 Config schema 校验用户配置、把默认值
  // 填进去，再把结果交给 apply()（`resolveConfig(runtime, config).value`）。直接调
  // `resolveConfig({...})` 传的是**没有默认值**的裸对象，测不到那个差异 ——
  // 第一版断言就是这么写的，于是"空配置也被报废弃"这个回归它完全看不见。
  const viaHost = (userCfg) => {
    const r = Config['~standard'].validate(userCfg)
    assert.ok(!r.issues, `schema 不应拒绝 ${JSON.stringify(userCfg)}`)
    return resolveConfig(r.value)
  }
  {
    // ① 关键回归：用户什么都没配 → 不得告警（schema 填的默认值不是"用户配置"）
    const none = viaHost({})
    assert.equal(none[CONFIG_WARNINGS].length, 0,
      `空配置不得报废弃键（宿主已填默认值，实测会误报）：${JSON.stringify(none[CONFIG_WARNINGS])}`)
    // ② 配了无关的键 → 同样不得告警
    const unrelated = viaHost({ dryRun: true })
    assert.equal(unrelated[CONFIG_WARNINGS].length, 0, '只配无关键不得报废弃键')
    // ③ 真的改了废弃键的值 → 必须留痕
    const changed1 = viaHost({ volumeBudgetThresholdChars: 5000 })
    assert.ok(changed1[CONFIG_WARNINGS].some((w) => w.includes('volumeBudgetThresholdChars')),
      '改了 volumeBudgetThresholdChars 必须留痕')
    const changed2 = viaHost({ budgetMinChars: 100 })
    assert.ok(changed2[CONFIG_WARNINGS].some((w) => w.includes('budgetMinChars')),
      '改了 budgetMinChars 必须留痕')
    // ④ 显式写成默认值 = 空操作，不告警（代价可接受，注释里写明）
    const asDefault = viaHost({ volumeBudgetThresholdChars: 8192, budgetMinChars: 0 })
    assert.equal(asDefault[CONFIG_WARNINGS].length, 0, '显式写成默认值属空操作，不告警')
  }


  // 合法值必须原样保留（钳制不能顺手改掉正常配置）
  const ok = resolveConfig({ preserveRecent: 0, compactPreserveRecent: 0, headChars: 0, maxStepTextChars: 5000, receiptMaxRatio: 1 })
  assert.equal(ok.preserveRecent, 0, '0 是合法值（不保护最近区），不得被当成缺省')
  assert.equal(ok.compactPreserveRecent, 0, '第二层最近区也允许显式设为 0')
  assert.equal(ok.headChars, 0)
  assert.equal(ok.maxStepTextChars, 5000)
  assert.equal(ok.receiptMaxRatio, 1, '1 是上界本身，闭区间内')
  assert.equal(ok[CONFIG_WARNINGS].length, 0)

  // 区间表必须覆盖**每一个**数值型 schema 键，否则新加的键会悄悄不受保护
  const numericKeys = Object.keys(Config?.dict ?? {}).filter((k) => Config.dict[k]?.type === 'number')
  assert.ok(numericKeys.length >= 20, `应能枚举出数值键（实际 ${numericKeys.length} 个）`)
  const uncovered = numericKeys.filter((k) => clampConfigNumber(k, 1e12, 1, null)[0] === 1e12)
  assert.deepEqual(uncovered, [], `这些数值键尚未纳入钳制区间表：${uncovered.join(', ')}`)

  // schema 的 .min() 与钳制表必须同向（防止两处各写一个数字后漂移）：
  // 比 schema 下界更小的值，在钳制层也必须被判为越界
  for (const key of numericKeys) {
    const min = Config.dict[key]?.meta?.min
    if (typeof min !== 'number') continue
    assert.equal(clampConfigNumber(key, min - 1, 0, null)[1], true,
      `${key}：低于 schema 下界 ${min} 的值在钳制层也必须被判为越界`)
  }
}

// ------------------------------------------- Jev 客户端：可重试失败与退避（issue #34）
// 旧实现单次失败就丢掉整轮判定：一次网络抖动 → 本次 pass 全部候选没有概率 →
// 两层静默不动。这里把"该重试的重试、不该重试的立刻放弃"两件事都钉住。
{
  const okBody = { answers: { q1: { noul: 0.12 } }, usage: { input_tokens: 10, output_tokens: 2 } }
  const okResponse = () => ({ ok: true, status: 200, text: async () => JSON.stringify(okBody) })

  // 1) 网络层异常（fetch 抛错）→ 重试；第二次成功
  {
    let calls = 0
    const client = new JevClient({
      apiKey: 'k',
      maxRetries: 2,
      retryBaseMs: 0,
      fetchImpl: async () => {
        calls += 1
        if (calls === 1) throw new Error('ECONNRESET')
        return okResponse()
      },
    })
    const out = await client.ask('state', { q1: 'x' })
    assert.equal(out.q1, 0.12, '重试后应拿到概率')
    assert.equal(calls, 2, '网络异常应重试一次')
    assert.equal(client.retries, 1)
    assert.equal(client.lastRetries, 1, '本次 ask 重试了 1 次')
    assert.equal(client.requests, 2, 'requests 计入失败尝试：2 次尝试都真的发出去了')
    // 口径一致性（PR #28 review）：requests = 成功 ask 数 + 重试数
    assert.equal(client.requests, 1 + client.retries, 'requests 必须等于成功次数 + 重试次数')

    // 关键回归（PR #28 review）：累计量不得被当成"本次"用。
    // 上一次 ask 重试过，这一次完全顺利 → lastRetries 必须归零，
    // 否则状态报告会从此永久显示"重试 N 次"。
    client.fetchImpl = okResponse
    await client.ask('state', { q1: 'x' })
    assert.equal(client.lastRetries, 0, '新的 ask 顺利时应报 lastRetries=0')
    assert.equal(client.retries, 1, '累计量保留历史（供"这个 client 重试过没有"判断）')
  }

  // 2) 5xx → 重试；429 → 重试
  for (const status of [500, 503, 429]) {
    let calls = 0
    const client = new JevClient({
      apiKey: 'k',
      maxRetries: 2,
      retryBaseMs: 0,
      fetchImpl: async () => {
        calls += 1
        if (calls === 1) return { ok: false, status, text: async () => 'boom' }
        return okResponse()
      },
    })
    const out = await client.ask('state', { q1: 'x' })
    assert.equal(out.q1, 0.12, `${status} 之后应重试成功`)
    assert.equal(calls, 2)
  }

  // 3) 4xx（密钥错 / 请求本身有问题）→ **不重试**，立刻抛
  for (const status of [400, 401, 403, 404]) {
    let calls = 0
    const client = new JevClient({
      apiKey: 'k',
      maxRetries: 3,
      retryBaseMs: 0,
      fetchImpl: async () => {
        calls += 1
        return { ok: false, status, text: async () => 'nope' }
      },
    })
    await assert.rejects(() => client.ask('state', { q1: 'x' }), JevError)
    assert.equal(calls, 1, `${status} 不该重试（实际发了 ${calls} 次）`)
    assert.equal(client.retries, 0)
    assert.equal(client.lastRetries, 0)
    assert.equal(client.requests, 1, '不可重试的失败也真的发过一次请求')
  }

  // 4) 响应缺 answers → 不重试（换一次大概率还是坏响应）
  {
    let calls = 0
    const client = new JevClient({
      apiKey: 'k',
      maxRetries: 3,
      retryBaseMs: 0,
      fetchImpl: async () => {
        calls += 1
        return { ok: true, status: 200, text: async () => JSON.stringify({ usage: {} }) }
      },
    })
    await assert.rejects(() => client.ask('state', { q1: 'x' }), /缺少 answers/)
    assert.equal(calls, 1, '形状错误不该重试')
  }

  // 5) 一直失败 → 尝试次数 = maxRetries + 1（不多不少），并记录 lastError
  {
    let calls = 0
    const client = new JevClient({
      apiKey: 'k',
      maxRetries: 2,
      retryBaseMs: 0,
      fetchImpl: async () => {
        calls += 1
        return { ok: false, status: 503, text: async () => 'down' }
      },
    })
    await assert.rejects(() => client.ask('state', { q1: 'x' }), JevError)
    assert.equal(calls, 3, 'maxRetries=2 表示最多 3 次尝试')
    assert.equal(client.retries, 2)
    assert.equal(client.lastRetries, 2)
    assert.equal(client.requests, 3, '全部失败的 3 次尝试都要计入 requests')
    assert.equal(client.requests, client.retries + 1, '口径：尝试数 = 重试数 + 1')
    assert.ok(client.lastError.length > 0, 'lastError 要留下原因')
  }

  // 6) 外部 signal 已 abort → 一次都不发（用户中断不该触发重试）
  {
    let calls = 0
    const client = new JevClient({
      apiKey: 'k',
      maxRetries: 3,
      retryBaseMs: 0,
      fetchImpl: async () => {
        calls += 1
        throw new Error('should not be called')
      },
    })
    const ac = new AbortController()
    ac.abort()
    await assert.rejects(() => client.ask('state', { q1: 'x' }, { signal: ac.signal }), /中断/)
    assert.equal(calls, 0, 'abort 后不应发起请求')
  }

  // 7) 请求中途被中断 → 不重试
  {
    let calls = 0
    const client = new JevClient({
      apiKey: 'k',
      maxRetries: 3,
      retryBaseMs: 0,
      fetchImpl: async () => {
        calls += 1
        throw new Error('aborted by signal')
      },
    })
    const ac = new AbortController()
    const promise = client.ask('state', { q1: 'x' }, { signal: ac.signal })
    ac.abort()
    await assert.rejects(() => promise, /中断/)
    assert.equal(calls, 1, '被中断时只发一次，不继续重试')
  }

  // 8) maxRetries=0 时退化为旧行为（不重试），确保配置可关
  {
    let calls = 0
    const client = new JevClient({
      apiKey: 'k',
      maxRetries: 0,
      retryBaseMs: 0,
      fetchImpl: async () => {
        calls += 1
        throw new Error('boom')
      },
    })
    await assert.rejects(() => client.ask('state', { q1: 'x' }), JevError)
    assert.equal(calls, 1, 'maxRetries=0 应退化为单次尝试')
  }
}

console.log('ok —— 纯函数自检全部通过')
