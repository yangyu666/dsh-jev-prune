/**
 * DSH 会话 → Jev state 的组装。纯函数，无 DSH 运行时依赖。
 *
 * 事件结构依据 DSH 源码与参考插件（aerince/dsh-active-context-pruning）的读法：
 *   user/message      → data.content[]            （blocks）
 *   assistant/message → data.message.content[]    （blocks）
 *   tool/result       → data.message.content[]    ；callId 在 data.message.source.callId
 *   compaction/summary→ data.summary / shadowedRange / shadowedSeqs
 *   compaction/prune  → data.shadowedRange / shadowedSeqs / shadowedTokenCount
 * block：{ type:'text', text } 或 { type:'tool-call', name, arguments }
 *
 * state 头部必须含【任务目标】—— 实测缺它会让判断概率整体悬在阈值附近、
 * 阈值摆动 41.4%（见 dsh-compact README 的 A/B 实验）。
 */

import { estimateTokens } from './jev.js'
// 工具名黑名单必须与两层裁决用同一套归一化比较（prune.js 是依赖链最底层）。
// 外部审查（issue #2）：selectCandidates 此前用字面 includes，默认 PascalCase 黑名单
// 对真实小写工具名（edit/write）静默失效——改写类节点照进候选、照花判定钱。
import { isToolIn } from './prune.js'

export const STATE_CONTEXT =
  '一个编码助手的对话正被压缩以释放上下文。history 是当前模型可见的全部历史（surface），' +
  '最老在前；工具输出已被替换为简短的 result 注记。每个问题问的是：某一次工具调用的输出，' +
  '是否仍需逐字留在历史里。没被保留的内容会被裁剪，但助手总是可以重新运行工具或重新读取文件。'

export function blockText(block) {
  if (block == null || typeof block !== 'object') return ''
  if (typeof block.text === 'string') return block.text
  if (block.type === 'tool-call') {
    const args = typeof block.arguments === 'string' ? block.arguments : JSON.stringify(block.arguments ?? {})
    return `[工具调用] ${block.name ?? block.tool ?? '?'} ${args}`
  }
  return ''
}

export function contentOf(event) {
  if (event == null || typeof event !== 'object') return null
  if (event.type === 'user/message') return event.data?.content ?? null
  if (event.type === 'assistant/message' || event.type === 'tool/result') return event.data?.message?.content ?? null
  return null
}

export function eventText(event) {
  if (event?.type === 'compaction/summary') {
    const summary = event.data?.summary
    if (typeof summary === 'string') return summary
    if (Array.isArray(summary)) return summary.map(blockText).join('\n')
  }
  if (event?.type === 'tool/result') {
    const blocks = resultContent(event)
    if (!Array.isArray(blocks)) return ''
    return blocks.map(blockText).join('\n')
  }
  const content = contentOf(event)
  if (!Array.isArray(content)) return ''
  return content.map(blockText).join('\n')
}

export function isCheckpointEvent(event) {
  return event?.type === 'user/message'
    && event.data?.source?.kind === 'plugin'
    && event.data.source.plugin === 'compact'
}

export function callIdOf(event) {
  return event?.data?.message?.source?.callId ?? event?.data?.callId ?? null
}

/** 工具名解析：不同 DSH 版本字段名可能不同，逐个容忍探测。 */
export function toolNameOf(event, nameByCallId) {
  const source = event?.data?.message?.source
  const direct = source?.name ?? source?.tool ?? source?.toolName ?? event?.data?.name ?? event?.data?.tool
  if (typeof direct === 'string' && direct.length > 0) return direct
  const callId = callIdOf(event)
  if (callId != null && nameByCallId?.has(callId)) return nameByCallId.get(callId)
  return 'unknown'
}

/**
 * 取会话的"全部事件"数组，带回退链。
 *
 * ⚠️ 实测活的 DSH 会话对象上 **`session.events` 是 undefined**（`isArray:false, ctor:"null"`），
 * 只有 `session.eventAt(seq)` 是确认存在的。之前所有 `session.events ?? []` 的地方
 * 都拿到空数组 → 工具名索引建出 0 条、任务目标也丢了。这里按可靠度依次回退：
 *   ① session.events（数组）
 *   ② session.snapshotEvents()
 *   ③ session.ownEvents()
 *   ④ 遍历 session.surface.nodes 逐个 eventAt()（surface 是确认存在的访问器）
 */
export function sessionEvents(session) {
  if (Array.isArray(session?.events)) return session.events
  for (const method of ['snapshotEvents', 'ownEvents']) {
    if (typeof session?.[method] === 'function') {
      try {
        const result = session[method]()
        if (Array.isArray(result)) return result
      } catch {
        // 继续尝试下一种
      }
    }
  }
  const surface = session?.surface?.nodes
  if (Array.isArray(surface) && typeof session?.eventAt === 'function') {
    const out = []
    for (const seq of surface) {
      const event = session.eventAt(seq)
      if (event != null) out.push(event)
    }
    return out
  }
  return []
}

/**
 * 从会话事件里建立 callId → 工具名 索引。
 *
 * 两条来源都要吃（实测真实 DSH 会话里两者同时存在）：
 *   ① `tool/call` 事件：`data.callId` + `data.name` —— **最直接、最权威**（扁平字段，不用挖块）
 *   ② `assistant/message` 里的 `tool-call` 块：`block.id` + `block.name`
 * 先扫 ① 再扫 ②（② 不覆盖 ①）。
 */
export function buildToolNameIndex(events) {
  const index = new Map()
  for (const event of events) {
    if (event?.type !== 'tool/call') continue
    const id = event.data?.callId ?? event.data?.id
    const name = event.data?.name ?? event.data?.tool
    if (id != null && typeof name === 'string' && name.length > 0) index.set(id, name)
  }
  for (const event of events) {
    const content = contentOf(event)
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (block?.type !== 'tool-call') continue
      const id = block.id ?? block.callId ?? block.toolCallId
      const name = block.name ?? block.tool ?? block.toolName
      if (id == null || typeof name !== 'string' || name.length === 0) continue
      if (!index.has(id)) index.set(id, name)
    }
  }
  return index
}

/** 工具结果的正文块数组。
 * DSH 的层次是 message.content[0] = { type:'tool-result', content:[区块…] }，
 * 正文在**内层** content —— 与裁剪器源码 `original.content[0].content` 一致。 */
export function resultContent(event) {
  const block = firstResultBlock(event)
  return block?.content ?? null
}

function firstResultBlock(event) {
  const content = contentOf(event)
  if (!Array.isArray(content)) return null
  return content.find((block) => block?.type === 'tool-result') ?? null
}

/** 工具结果的正文长度（Unicode 码点数），与 DSH 裁剪器口径一致。 */
export function resultChars(event) {
  const blocks = resultContent(event)
  if (!Array.isArray(blocks)) return 0
  let chars = 0
  for (const block of blocks) {
    if (block?.type === 'text' && typeof block.text === 'string') chars += Array.from(block.text).length
  }
  return chars
}

/** 是否已经被裁过（正文里带裁剪标记）→ 不再重复判定。 */
export function looksPruned(event, marker) {
  const blocks = resultContent(event)
  if (!Array.isArray(blocks)) return false
  return blocks.some((block) => typeof block?.text === 'string' && block.text.includes(marker))
}

/** 最近若干条「纯文本用户消息」作为任务目标（对齐上游 goalFromMessages）。 */
export function recentGoal(events, limit = 3, maxChars = 500) {
  const picked = []
  for (const event of events) {
    if (event?.type !== 'user/message') continue
    if (isCheckpointEvent(event)) continue
    if (event.data?.source?.kind !== 'user' && event.data?.source?.kind != null) continue
    const content = contentOf(event)
    if (!Array.isArray(content)) continue
    const text = content.filter((b) => b?.type === 'text').map((b) => b.text).join(' ').trim()
    if (text.length > 0) picked.push(text.slice(0, maxChars))
  }
  if (picked.length === 0) return ''
  return picked.slice(-limit).join('\n')
}

/**
 * 挑出候选工具结果节点。
 *
 * 排除：最近 preserveRecent 个 surface 节点（含正在进行的调用）、
 *       永不裁剪工具、已裁过的、以及索引解析不出的。
 * @returns {Array<{seq:number, index:number, chars:number, callId:string|null, tool:string}>}
 */
export function selectCandidates({ surface, eventAt, events, preserveRecent, neverPruneTools, marker, nameByCallId }) {
  const lastAllowed = surface.length - 1 - preserveRecent
  const out = []
  for (let index = 0; index <= lastAllowed; index += 1) {
    const seq = surface[index]
    const event = eventAt(seq)
    if (event?.type !== 'tool/result') continue
    if (looksPruned(event, marker)) continue
    const tool = toolNameOf(event, nameByCallId)
    // 归一化比较（issue #1/#2）：字面 includes 对小写工具名永远不命中
    if (isToolIn(neverPruneTools, tool)) continue
    out.push({ seq, index, chars: resultChars(event), callId: callIdOf(event), tool })
  }
  return out
}

/**
 * 候选 → **两道** noul 陈述（陈述为"应当保留/是承重的"，noul 即该概率）。
 *
 *   result_sN  结果本身是否还需逐字留在历史里   → 第一层（裁正文）用它
 *   effect_sN  这次调用是否**改变了会话之外的状态**（有副作用）→ 第二层（移出整对）用它
 *
 * 为什么要第二道：整对删除连"调用发生过"这个事实一起删掉。有些调用的**输出很短**
 * （`Successfully installed` / 12 字符），按结果判分必然"可丢"，但它做过的事是承重的。
 * 这道问句专门抓这类：**高 = 有副作用 = 不许整对删除**（仍可由第一层截断正文）。
 *
 * ⚠️ 措辞是这套方案里**最敏感的一环**，实测（probe_phrasing.js，5 个候选同一份 state）：
 *
 *   变体                    极差     标准差
 *   上游原味（陈述式）        0.070    0.023   ← 几乎无区分度，等于对每条都说"裁"
 *   带后果（丢弃后缺什么）     0.080    0.028
 *   带相对对比              0.380    0.136   ← 区分度 6 倍，但措辞里出现"体积大"时
 *   带目标引用              0.340    0.116      大结果会被字面匹配抬分（污染）
 *
 * 所以默认用 goal 版，并且：
 *   · **不在问题里写字符数** —— 写"约 15599 字符"会诱导模型按体积作答
 *   · **不出现"大/小/体积"这类词** —— 会被字面匹配，而不是语义理解
 *   · 显式锚定【任务目标】—— 判断"还有用吗"本质是"相对于目标还有用吗"
 *
 * 传 'legacy' 可切回上游原味（做对照用）。
 * 注意：区分度已验证，**排序正确性尚未验证**（没有标注数据）。
 */
export function questionsFor(candidates, wording = 'goal') {
  const out = {}
  for (const candidate of candidates) {
    out[`result_s${candidate.seq}`] = phrase(candidate, wording)
    out[`effect_s${candidate.seq}`] = effectPhrase(candidate, wording)
  }
  return out
}

function phrase(c, wording) {
  if (wording === 'legacy') {
    return `第 s${c.seq} 号工具结果（${c.tool}，约 ${c.chars} 字符）应当逐字留在历史里：` +
      `助手接下来的动作仍然需要它的内容，且重跑一次该工具无法替代。`
  }
  if (wording === 'contrast') {
    return `在本次会话的所有工具结果中，第 s${c.seq} 号（${c.tool}）属于` +
      `"结论已经被别处记录下来、可以安全丢弃"的那一类。`
  }
  if (wording === 'consequence') {
    return `第 s${c.seq} 号工具结果（${c.tool}）被裁掉后，助手在完成当前任务时会缺少必要的信息，` +
      `且无法通过重跑该工具廉价地拿回来。`
  }
  // 默认：目标锚定版
  return `第 s${c.seq} 号工具结果（${c.tool}）：在【任务目标】接下来还要进行的步骤里，` +
    `助手仍需要直接引用它的内容，重跑该工具不能替代。`
}

/**
 * 副作用问句。**方向必须显式写清楚**（高 = 有副作用 = 承重），
 * 因为实测里我第一版把方向读反过一次。
 *
 * 刻意**不写字符数、不写工具类别** —— 那些会诱导模型按表面的体量/类型作答，
 * 而这道题的答案是"这次动作有没有改变外部世界"。
 */
function effectPhrase(c, wording) {
  if (wording === 'legacy' || wording === 'contrast' || wording === 'consequence') {
    // 对照臂统一用同一句，避免把措辞变量混进方向验证
    return `第 s${c.seq} 号工具调用（${c.tool}）：它改变了会话之外的持久状态` +
      `（写文件、改配置、安装、提交、删除、对外发起操作等），后续步骤需要知道它发生过。`
  }
  return `第 s${c.seq} 号工具调用（${c.tool}）：在【任务目标】接下来的步骤里，` +
    `助手仍需要知道这次调用**发生过、并改变了会话之外的状态**（而不是仅仅读过/看过）。`
}

/**
 * 组装 Jev state：头部（上下文 + 任务目标）+ history 行。
 *
 * 预算压制保留一个**行数地板**（minHistoryLines）：把历史丢光虽然能塞进预算，
 * 但判断者看不到上下文就没法判断了。地板之下仍超预算时如实返回 `fitted: false`，
 * 由调用方决定（宁可少判几个节点，也不要发一个会 400 的请求）。
 *
 * @returns {{state:string, lines:number, omitted:number, fitted:boolean, stateTokens:number}}
 */
export function buildJevState({ surface, eventAt, goal, context = STATE_CONTEXT, options }) {
  const { textHead, textTail, maxStateTokens, inputChars } = options
  const minLines = Math.max(1, options.minHistoryLines ?? 8)
  const entries = []
  for (const seq of surface) {
    const event = eventAt(seq)
    if (event == null) continue
    const type = event.type
    if (type === 'tool/result') {
      entries.push([`[s${seq}][tool_result] ok, ${resultChars(event)} chars (内容省略)`])
      continue
    }
    if (type === 'compaction/summary') {
      entries.push([`[s${seq}][checkpoint] ${abridge(eventText(event), textHead, textTail)}`])
      continue
    }
    const content = contentOf(event)
    if (!Array.isArray(content)) continue
    const lines = []
    for (const block of content) {
      if (block?.type === 'text' && typeof block.text === 'string') {
        lines.push(`[s${seq}][${type === 'user/message' ? 'user' : 'assistant'}] ${abridge(block.text, textHead, textTail)}`)
      } else if (block?.type === 'reasoning' && typeof block.text === 'string') {
        // 实测 DSH 的 assistant 消息块是 [reasoning, tool-call]：模型的思考在 reasoning 里。
        // 不把正文塞进 state（太贵），但要让判断者知道"这一步思考了多少"——它和纯只读探查不是一回事。
        lines.push(`[s${seq}][reasoning] ~${Array.from(block.text).length} 字符的思考过程（未展开）`)
      } else if (block?.type === 'tool-call') {
        const args = typeof block.arguments === 'string' ? block.arguments : JSON.stringify(block.arguments ?? {})
        lines.push(`[s${seq}][tool_call] ${block.name ?? '?'} ${args.slice(0, inputChars)}${args.length > inputChars ? '…' : ''}`)
      }
    }
    if (lines.length > 0) entries.push(lines)
  }

  let header = `【上下文】\n${context}\n`
  if (goal && goal.length > 0) header += `\n【任务目标】\n${goal}\n`
  header += '\n【history】\n'

  const budget = maxStateTokens - estimateTokens(header)
  const all = entries.flatMap((lines) => lines)
  let omitted = 0
  while (all.length > minLines && estimateTokens(all.join('\n')) > budget) {
    all.shift() // 从最老开始丢
    omitted += 1
  }
  const state = header + all.join('\n')
  const stateTokens = estimateTokens(state)
  return { state, lines: all.length, omitted, fitted: stateTokens <= maxStateTokens, stateTokens }
}

/**
 * 按 **Unicode 码点**切片截断（issue #4/#5）。
 *
 * 两个此前都真实存在的坑：
 *   · head/tail 为 undefined（config 未经 schemastery 归一化时）→ `head + tail + 40` 是
 *     NaN、比较恒假、slice 返回整段原文 —— 同一段文本输出两遍、state 里带 "NaN" 字面量。
 *     这里做数值兜底，但根因是 resolveConfig 漏键（见 index.js）。
 *   · 用 UTF-16 的 .length/.slice 会把代理对劈成半个字符 —— 与 README「按码点切片」的
 *     承诺相反，也与 prune.js 的口径不一致。统一改为码点数组。
 */
function abridge(text, head, tail) {
  const headChars = Number.isFinite(head) ? head : 400
  const tailChars = Number.isFinite(tail) ? tail : 150
  const points = Array.from(String(text ?? ''))
  if (points.length <= headChars + tailChars + 40) return points.join('')
  const omitted = points.length - headChars - tailChars
  return `${points.slice(0, headChars).join('')}\n… ${omitted} 字符省略 …\n${points.slice(-tailChars).join('')}`
}

/**
 * 首次运行探针：把实际事件形状打出来，用来校正字段假设。
 *
 * 只打"事件级"形状（type / 块类型 / 键名）是不够的 —— 实测真正会错的是**块内部**的
 * 字段名与取值（`tool-call.id` / `tool-call.name` / `tool-result.toolCallId` /
 * `source.callId`）。所以这里额外打：
 *   · 每个 tool-call 块的实际 `name` 与 `id` 前缀
 *   · 每个 tool-result 块的 `toolCallId` 与 `source.callId`
 *   · **id → name 的配对结果**（能不能解析出工具名）
 * 有它就不必再猜"为什么白名单不命中"。
 */
export function probeShapes(surface, eventAt, limit = 40) {
  const seen = new Map()
  const rows = []
  for (const seq of surface.slice(0, limit)) {
    const event = eventAt(seq)
    if (event == null) continue
    const content = contentOf(event)
    const blocks = Array.isArray(content) ? content.map((b) => b?.type ?? typeof b) : []
    const sourceKeys = event.data?.message?.source != null ? Object.keys(event.data.message.source) : []
    const dataKeys = event.data != null ? Object.keys(event.data) : []
    rows.push({ seq, type: event.type, blocks, dataKeys, sourceKeys })
    const key = `${event.type}|${blocks.join(',')}|${dataKeys.join(',')}|${sourceKeys.join(',')}`
    seen.set(key, (seen.get(key) ?? 0) + 1)
  }
  return { rows, summary: [...seen.entries()].map(([key, count]) => ({ key, count })) }
}

/**
 * 工具名解析的取证块：把真实的 callId↔name 配对、以及**解析结果**打出来。
 * `jev_probe_shapes` 与 `jev_prune_status` 共用它。
 */
export function probeToolNames({ surface, eventAt, events, limit = 12 }) {
  const nameByCallId = buildToolNameIndex(events ?? [])
  const rows = []
  let unresolved = 0
  for (const seq of surface.slice(0, limit)) {
    const event = eventAt(seq)
    if (event?.type !== 'tool/result') continue
    const callId = callIdOf(event)
    const name = toolNameOf(event, nameByCallId)
    if (name === 'unknown') unresolved += 1
    rows.push({ seq, callId, tool: name })
  }
  return {
    indexSize: nameByCallId.size,
    // 名字集合取自索引（同时含 tool/call 事件与 assistant 消息块两种来源）——
    // 这是用户配 compactTools 时真正需要的那份清单
    names: [...new Set(nameByCallId.values())].sort(),
    rows,
    unresolved,
    resolved: rows.length - unresolved,
  }
}
