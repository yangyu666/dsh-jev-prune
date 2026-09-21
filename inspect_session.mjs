/**
 * inspect_session.mjs —— 直接读 DSH 的持久化会话日志做取证（零 LLM 成本）。
 *
 * 为什么需要它：
 *   · `jev_probe_shapes` 打的是**事件级**形状（type / 块类型 / 键名），看不到**块内部**字段；
 *     而工具名解析要靠 `tool-call` 块的 id/name 与 `tool-result` 的 toolCallId/source.callId 配对。
 *   · 想验证"回执有没有真的落进会话"，一条命令就能查，不必再跑一轮 LLM 会话去让模型转述。
 *
 * ⚠️ DSH 的 `session.v3.jsonl.zstd` 是**多帧拼接**的 zstd（每追加一批就新起一帧），
 *   而 Node 的 `zstdDecompressSync` / 流式解压**只认第一帧**（实测第二帧报
 *   "Unknown frame descriptor"）。所以这里自己按 zstd 帧格式切帧后逐帧解压。
 *
 * 用法：
 *   node inspect_session.mjs <会话目录 | session.v3.jsonl.zstd>
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

// ---------------------------------------------------------------- zstd 多帧切分

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/**
 * 把多帧 zstd 缓冲切成单帧数组。
 * 帧格式：magic(4) + FHD(1) + [Window_Descriptor(1)] + [Dictionary_ID(0/1/2/4)] + [FCS(0/1/2/4/8)] + blocks
 * 每个 block 头 3 字节小端：bit0=last, bits1-2=type, bits3-23=size；
 * raw/compressed block 后跟 size 字节，RLE block 后跟 1 字节。
 * 尾随的 Content_Checksum(4) 在 FHD 的 bit2 置位时存在。
 */
export function splitZstdFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset + 4 <= buffer.length) {
    const start = buffer.indexOf(MAGIC, offset)
    if (start < 0) break
    let p = start + 4
    if (p >= buffer.length) break
    const fhd = buffer[p]
    p += 1
    const fcsFlag = (fhd >> 6) & 0b11
    const singleSegment = (fhd >> 5) & 1
    const hasChecksum = (fhd >> 2) & 1
    const dictIdFlag = fhd & 0b11

    if (singleSegment === 0) p += 1 // Window_Descriptor
    p += dictIdFlag === 0 ? 0 : dictIdFlag === 1 ? 1 : dictIdFlag === 2 ? 2 : 4
    p += fcsFlag === 0 ? (singleSegment === 1 ? 1 : 0)
      : fcsFlag === 1 ? 2
        : fcsFlag === 2 ? 4 : 8

    if (p > buffer.length) break
    for (;;) {
      if (p + 3 > buffer.length) {
        p = buffer.length
        break
      }
      const header = buffer.readUIntLE(p, 3)
      p += 3
      const last = header & 1
      const blockType = (header >> 1) & 0b11
      const blockSize = header >> 3
      if (blockType === 0 || blockType === 2) p += blockSize
      else if (blockType === 1) p += 1
      else throw new Error(`未知的 zstd block 类型 ${blockType}`)
      if (last === 1) break
      if (p > buffer.length) {
        p = buffer.length
        break
      }
    }
    if (hasChecksum) p += 4
    frames.push(buffer.subarray(start, Math.min(p, buffer.length)))
    offset = Math.min(p, buffer.length)
    if (offset <= start) break
  }
  return frames
}

/** 逐帧解压并拼起来。 */
export function decompressZstdJsonl(buffer) {
  const frames = splitZstdFrames(buffer)
  const parts = []
  for (const frame of frames) {
    try {
      parts.push(zstdDecompressSync(frame).toString('utf8'))
    } catch {
      // 单帧坏了就跳过，不让取证停摆
    }
  }
  return parts.join('')
}

// ---------------------------------------------------------------- 会话读解

export function readSessionEvents(pathOrDir) {
  let file = pathOrDir
  if (statSync(pathOrDir).isDirectory()) {
    const entry = readdirSync(pathOrDir).find((f) => f.endsWith('.jsonl.zstd'))
    if (entry == null) throw new Error(`目录里没有 .jsonl.zstd：${pathOrDir}`)
    file = join(pathOrDir, entry)
  }
  const text = decompressZstdJsonl(readFileSync(file))
  const events = []
  let header = null
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue
    let parsed
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    if (parsed?.type === 'session') header = parsed
    else if (parsed?.type != null && typeof parsed.seq === 'number') events.push(parsed)
    else if (parsed?.type != null) events.push(parsed)
  }
  return { file, header, events }
}

/** 取事件的内容块（与 state.js 的 contentOf 同口径）。 */
function blocksOf(event) {
  const data = event?.data ?? {}
  if (event?.type === 'user/message') return data.content ?? null
  if (event?.type === 'assistant/message' || event?.type === 'tool/result') return data.message?.content ?? null
  return null
}

// ---------------------------------------------------------------- CLI

const isMain = process.argv[1] != null && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())
// issue #10：CLI 触发条件此前是 `isMain || process.argv[2] != null`——任何 importer
// 只要命令行带了第二个参数（例如 verify_real_shapes.mjs 的正常用法），import 求值时
// 就会替它跑 CLI、把进程带崩。CLI 入口只留给直接执行本文件的场景。
if (isMain) {
  const target = process.argv[2]
  if (target == null) {
    console.error('用法: node inspect_session.mjs <会话目录 | session.v3.jsonl.zstd>')
    process.exit(1)
  }
  const { file, header, events } = readSessionEvents(target)
  console.log(`文件: ${file}`)
  // issue #11：createdAt 缺失/非法时此前直接 RangeError 整个工具退出——
  // 而取证工具存在的意义恰恰是查"日志为什么不对"，头部字段缺失是常见病因
  const createdAt = header?.createdAt != null && Number.isFinite(new Date(header.createdAt).getTime())
    ? new Date(header.createdAt).toISOString()
    : 'unknown'
  if (header != null) console.log(`会话: ${header.id}  cwd=${header.cwd}  ${createdAt}`)
  console.log(`事件数: ${events.length}\n`)

  const byType = {}
  for (const e of events) byType[e.type] = (byType[e.type] ?? 0) + 1
  console.log('事件类型分布:', JSON.stringify(byType))
  const onSurface = events.filter((e) => e.surfaceOp == null && e.shadowedRange == null)
  console.log(`（其中 ${onSurface.length} 条不带 surfaceOp/shadowedRange）\n`)

  console.log('=== tool-call 块（原样字段名）===')
  let n = 0
  for (const e of events) {
    const blocks = blocksOf(e)
    if (!Array.isArray(blocks)) continue
    for (const b of blocks) {
      if (b?.type !== 'tool-call') continue
      console.log(`  seq=${e.seq}  块键=${JSON.stringify(Object.keys(b))}`)
      console.log(`    id=${JSON.stringify(b.id)}  name=${JSON.stringify(b.name)}  arguments 类型=${typeof b.arguments}`)
      if (++n >= 2) break
    }
    if (n >= 2) break
  }

  console.log('\n=== tool-result 块 ===')
  n = 0
  for (const e of events) {
    const blocks = blocksOf(e)
    if (!Array.isArray(blocks)) continue
    for (const b of blocks) {
      if (b?.type !== 'tool-result') continue
      console.log(`  seq=${e.seq}  

source=${JSON.stringify(e.data?.message?.source)}  块键=${JSON.stringify(Object.keys(b))}`)
      console.log(`    toolCallId=${JSON.stringify(b.toolCallId)}  isError=${JSON.stringify(b.isError)}  正文块数=${Array.isArray(b.content) ? b.content.length : '-'}`)
      if (++n >= 2) break
    }
    if (n >= 2) break
  }

  // 工具名解析真值：id ↔ source.callId 能不能配上
  console.log('\n=== 工具名解析（真值）===')
  const nameById = new Map()
  for (const e of events) {
    const blocks = blocksOf(e)
    if (!Array.isArray(blocks)) continue
    for (const b of blocks) {
      if (b?.type !== 'tool-call') continue
      const id = b.id ?? b.callId ?? b.toolCallId
      if (id != null && typeof b.name === 'string') nameById.set(id, b.name)
    }
  }
  const names = new Set(nameById.values())
  console.log(`  索引大小=${nameById.size}  索引到的工具名=${JSON.stringify([...names])}`)
  let resolved = 0
  let unresolved = 0
  for (const e of events) {
    if (e.type !== 'tool/result') continue
    const callId = e.data?.message?.source?.callId
    if (nameById.has(callId)) resolved += 1
    else unresolved += 1
  }
  console.log(`  tool/result 里 source.callId 能配对上的: ${resolved} 条；配对不上的: ${unresolved} 条`)
  if (unresolved > 0) {
    const sample = events.find((e) => e.type === 'tool/result' && !nameById.has(e.data?.message?.source?.callId))
    console.log(`  反例: seq=${sample?.seq} source.callId=${JSON.stringify(sample?.data?.message?.source?.callId)}`)
    console.log(`  索引里的 id 样例: ${JSON.stringify([...nameById.keys()].slice(0, 5))}`)
  }

  // checkpoint 与回执
  const summaries = events.filter((e) => e.type === 'compaction/summary')
  const checkpoints = events.filter((e) => e.type === 'user/message'
    && e.data?.source?.kind === 'plugin' && e.data.source.plugin === 'compact')
  console.log(`\n=== 压缩产物 ===\n  compaction/summary: ${summaries.length} 条；checkpoint user/message: ${checkpoints.length} 条`)
  for (const s of summaries) {
    const text = (s.data?.summary ?? []).map((b) => (typeof b === 'string' ? b : b?.text ?? '')).join('')
    console.log(`  summary seq=${s.seq}  provider=${JSON.stringify(s.data?.provider)}  model=${JSON.stringify(s.data?.model)}`)
    console.log(`    shadowedRange=${JSON.stringify(s.data?.shadowedRange)}  shadowedSeqs=${JSON.stringify(s.data?.shadowedSeqs)}`)
    console.log(`    摘要前 160 字: ${text.slice(0, 160).replace(/\n/g, ' ⏎ ')}`)
  }
  for (const c of checkpoints) {
    const text = (c.data?.content ?? []).map((b) => b?.text ?? '').join('')
    console.log(`  checkpoint seq=${c.seq}  compactionId=${JSON.stringify(c.data?.source?.compactionId)}`)
    console.log(`    正文前 200 字: ${text.slice(0, 200).replace(/\n/g, ' ⏎ ')}`)
  }
  const prunes = events.filter((e) => e.type === 'compaction/prune')
  console.log(`  compaction/prune（第一层裁剪的影子定价）: ${prunes.length} 条`)
}
