/**
 * verify_real_shapes.mjs —— 用**真实会话日志**离线验工具名解析（零 LLM 成本）。
 *
 * 起因：真实 DSH 里的工具名是 `pwsh` / `read`（小写，shell 叫 pwsh），
 * 而我猜的白名单是 Claude Code 风格的 PascalCase —— 白名单一个都匹配不上，
 * 第二层因此静默永不触发。字段名这类东西**必须拿真值，不能猜**。
 *
 * 这个脚本把会话日志喂给插件自己的 state.js，验证：
 *   ① buildToolNameIndex 能否从真实事件里建出索引
 *   ② toolNameOf 能否解析出工具名（而不是 'unknown'）
 *   ③ selectCandidates 会挑出哪些节点、解析出的名字是什么
 *
 * 用法: node verify_real_shapes.mjs <会话目录 | .jsonl.zstd> [...更多会话]
 */

import { readSessionEvents } from './inspect_session.mjs'
import { buildToolNameIndex, selectCandidates, toolNameOf, resultChars } from './state.js'

const targets = process.argv.slice(2)
if (targets.length === 0) {
  console.error('用法: node verify_real_shapes.mjs <会话目录 | .jsonl.zstd> [...]')
  process.exit(1)
}

const MARKER = '[' + '… Jev 判定该工具结果已过期' // 只要前缀就够（避免和实现里的常量耦合）

// 真实 DSH 的工具名（从会话日志取证得到，不是猜的）
const REAL_DSH_TOOLS = ['pwsh', 'read', 'write', 'edit', 'glob', 'grep', 'list', 'fetch', 'web_search']
// 我原来猜的（Claude Code 风格 PascalCase）——留着做对照，证明这个 bug 有多隐蔽
const DEFAULT_COMPACT_TOOLS_GUESS = ['Read', 'Grep', 'Glob', 'Bash', 'List', 'Ls', 'Search',
  'WebFetch', 'WebSearch', 'Fetch', 'Tree', 'Stat']

// 日志里 `surfaceOp` 是**字符串**（"append" / "replace"），不是对象 —— 别按对象判空。
const SURFACE_TYPES = new Set(['system/message', 'user/message', 'assistant/message', 'tool/result', 'compaction/summary'])

/** 从会话日志重建 surface（replace 事件把它声明的 sourceEventSeqs 移出）。 */
function reconstructSurface(events) {
  const present = new Set()
  for (const e of events) {
    if (typeof e.seq !== 'number' || !SURFACE_TYPES.has(e.type)) continue
    if (e.surfaceOp === 'replace') {
      for (const src of e.sourceEventSeqs ?? []) present.delete(src)
    } else {
      present.add(e.seq)
    }
  }
  return [...present].sort((a, b) => a - b)
}

for (const target of targets) {
  let loaded
  try {
    loaded = readSessionEvents(target)
  } catch (error) {
    console.log(`跳过 ${target}：${error.message}`)
    continue
  }
  const { file, events } = loaded
  const bySeq = new Map(events.filter((e) => typeof e.seq === 'number').map((e) => [e.seq, e]))
  const surface = reconstructSurface(events)

  console.log(`\n════════ ${file.split(/[\\/]/).pop()} ════════`)
  console.log(`事件 ${events.length} 条，surface 候选 ${surface.length} 个节点`)

  const nameByCallId = buildToolNameIndex(events)
  console.log(`buildToolNameIndex → ${nameByCallId.size} 条，名字集合 = ${JSON.stringify([...new Set(nameByCallId.values())])}`)

  const eventAt = (seq) => bySeq.get(seq) ?? null
  let resolved = 0
  let unknown = 0
  for (const seq of surface) {
    const event = eventAt(seq)
    if (event?.type !== 'tool/result') continue
    const name = toolNameOf(event, nameByCallId)
    if (name === 'unknown') unknown += 1
    else resolved += 1
  }
  console.log(`toolNameOf 解析：成功 ${resolved} 条 / 未解析 ${unknown} 条`)

  const candidates = selectCandidates({
    surface,
    eventAt,
    events,
    preserveRecent: 2,
    neverPruneTools: ['edit', 'write', 'multiedit', 'applypatch'],
    marker: MARKER,
    nameByCallId,
  })
  console.log(`selectCandidates → ${candidates.length} 个：`)
  for (const c of candidates.slice(0, 12)) {
    console.log(`  s${String(c.seq).padStart(4)}  ${c.tool.padEnd(18)} ${String(resultChars(eventAt(c.seq))).padStart(7)} 字符`)
  }

  // 白名单命中检查（这才是第二层能不能触发的实际判据）
  for (const allowlist of [REAL_DSH_TOOLS, DEFAULT_COMPACT_TOOLS_GUESS]) {
    const hit = candidates.filter((c) => allowlist.includes(c.tool)).length
    console.log(`  白名单[${allowlist === REAL_DSH_TOOLS ? '真实 DSH 名' : '我原来猜的 PascalCase'}] 命中 ${hit}/${candidates.length}`)
  }
}