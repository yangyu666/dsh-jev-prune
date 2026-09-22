/**
 * smoke_apply.mjs —— 冒烟测试：用假 ctx 真的跑一次 apply()，**两层都覆盖**。
 *
 * 比"能否 import"深一层：只证明模块能加载是不够的，这里证明 **apply() 的用法是对的**——
 * ctx.on / ctx.effect / ctx.tools.register 的调用形状、Config schema 能否被 schemastery 接受、
 * 接管的 pruneSession 在真实调用链上是否按预期裁决、以及
 * **summarize 猴补丁有没有真的把回执注进 compactRegion**。
 *
 * 怎么跑：这个文件要放在**能解析到 @deepseek-ai/schemastery 与 dsh-tools** 的目录里，
 * 并且同目录的 node_modules 下要有插件副本（包名 `dsh-jev-prune`）。例如：
 *   cp <plugin>/{index,jev,state,prune,receipt}.js package.json  <ws>/_probe/node_modules/dsh-jev-prune/
 *   cp <plugin>/smoke_apply.mjs <ws>/_probe/ && cd <ws>/_probe && node smoke_apply.mjs
 * 不塞进 DSH 完整依赖树也能跑（那棵树要装 3~25 分钟，而这个只要 4 秒）。
 *
 * 假对象的事件/服务形状全部取自 DSH 源码，不是猜的：
 *   · pruner: measureContent / pruneContent / pruneSession / ctx.tokenMeter.estimateMessage
 *   · compaction: summarize(input, agent, signal) / compactRegion(start, end, agent, signal)
 *   · session: surface.nodes / eventAt / deriveEventMessage / append（返回 {seq}）
 *   · tool/result 事件: data.message.content[0] 是 tool-result 块，正文在它的 .content
 *   · assistant 消息: data.message.content[] 里 { type:'tool-call', name, arguments, id }
 */

const results = []
const ok = (name, detail = '') => results.push({ name, ok: true, detail })
const bad = (name, detail) => results.push({ name, ok: false, detail })
const check = (name, cond, detail = '') => (cond ? ok(name, detail) : bad(name, detail))

// ---------------------------------------------------------------- 假 DSH 对象

/**
 * 会话：user 提问 + 若干组只读探查（每组的工具结果大小不同）+ 1 条收尾文本。
 * 这样才有「连续的只读步骤」可供第二层合并成一段。
 *
 * @param {Array<{tool:string,args:object,chars:number,interleave?:string}>} [plan]
 *   自定义步骤表。默认三步连成**一段**；H 块要测多段配额，所以会传入
 *   带 interleave（中间插一条 assistant 文本把段切开）的表。
 */
function makeSession(plan) {
  const events = new Map()
  let nextSeq = 1
  const add = (type, data) => {
    const seq = nextSeq++
    events.set(seq, { seq, type, data })
    return seq
  }
  const addStep = (tool, args, text) => {
    const callId = `c${nextSeq + 1}`
    const head = add('assistant/message', {
      message: { content: [{ type: 'text', text: '看一下。' }, { type: 'tool-call', id: callId, name: tool, arguments: args }] },
    })
    const result = add('tool/result', {
      message: { source: { callId }, content: [{ type: 'tool-result', content: [{ type: 'text', text }] }] },
    })
    return { head, result, tool }
  }

  add('user/message', { content: [{ type: 'text', text: '排查河牌底池计算，先摸结构。' }], source: { kind: 'user' } })
  // 三步都必须在默认只读白名单内（read/grep/glob）——默认配置下 shell 工具进不了候选
  const effectivePlan = plan ?? [
    { tool: 'Read', args: { file_path: 'server/src/game/river.ts' }, chars: 6000 },
    { tool: 'Grep', args: { pattern: 'basePot', path: 'server/src' }, chars: 4000 },
    { tool: 'Glob', args: { pattern: '*.ts', path: 'server/src' }, chars: 6000 },
  ]
  const steps = []
  for (const item of effectivePlan) {
    if (item.interleave) {
      // 插一条不含 tool-call 的 assistant 文本，把前后两组只读步骤**切成两段**，
      // 这样 maxCompactionsPerPass > 1 才有第二个可压区间
      add('assistant/message', { message: { content: [{ type: 'text', text: item.interleave }] } })
    }
    const fill = item.fill ?? 'a'
    steps.push(addStep(item.tool, item.args, fill.repeat(item.chars)))
  }
  const step1 = steps[0]
  const step2 = steps[1]
  const step3 = steps[2]

  const tail = add('assistant/message', { message: { content: [{ type: 'text', text: '继续。' }] } })

  const appended = []
  const session = {
    seqs: { s1: step1.result, s2: step2.result, s3: step3.result },
    steps: [step1, step2, step3],
    tail,
    appended,
    // ⚠️ 刻意**不**提供 `.events`：实测活的 DSH 会话对象上 `session.events` 是 undefined，
    // 只有 `eventAt(seq)` 与 `surface.nodes` 可用。假对象要复刻这个现实，
    // 否则会掩盖"依赖 .events 的 bug"（那个 bug 让工具名索引在活宿主里建出 0 条）。
    surface: { nodes: [...events.keys()] },
    eventAt: (seq) => events.get(seq) ?? null,
    deriveEventMessage: (event) => event.data.message,
    append(type, data, options) {
      const seq = nextSeq++
      events.set(seq, { seq, type, data })
      appended.push({ seq, type, data, options })
      return { seq }
    },
  }
  return session
}

function makePruner() {
  let pruneContentCalls = 0
  return {
    get pruneContentCalls() { return pruneContentCalls },
    ctx: { tokenMeter: { estimateMessage: () => 123 } },
    measureContent: (blocks) => blocks.reduce((n, b) => n + (b?.text ? Array.from(b.text).length : 0), 0),
    // 与 DSH 同口径：超过阈值才裁；这里设成极高，模拟"体积启发式不动作"
    pruneContent(blocks) {
      pruneContentCalls += 1
      const chars = blocks.reduce((n, b) => n + (b?.text ? Array.from(b.text).length : 0), 0)
      if (chars <= 100000) return null
      return blocks
    },
    /**
     * 基线 pruneSession —— 忠实复刻 DSH 自带实现的循环与 append 协议。
     * 插件会**接管**这个方法；这里的实现用来验证"接管前它是可用的"
     * （插件的 guard 要求 pruner.pruneSession 是函数，否则拒绝接管）。
     */
    pruneSession(session) {
      const pruned = []
      let charsRemoved = 0
      for (const seq of [...session.surface.nodes]) {
        const event = session.eventAt(seq)
        if (event?.type !== 'tool/result') continue
        const original = session.deriveEventMessage(event)
        const result = original?.content?.[0]
        if (result == null) continue
        const content = this.pruneContent(result.content)
        if (content == null) continue
        const before = this.measureContent(result.content)
        const after = this.measureContent(content)
        session.append('compaction/prune', {
          shadowedRange: { start: seq, end: seq },
          shadowedSeqs: [seq],
          shadowedTokenCount: this.ctx.tokenMeter.estimateMessage(original),
        })
        session.append('tool/result',
          { ...event.data, message: { ...original, content: [{ ...result, content }] } },
          { surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq] })
        pruned.push({ originalSeq: seq, charsBefore: before, charsAfter: after })
        charsRemoved += before - after
      }
      return { pruned, charsRemoved }
    },
  }
}

/**
 * 假 compaction 服务。行为对齐 DSH `BasicCompactionEngine` 的关键契约：
 *   · `compactRegion` 内部通过 `this.summarize(...)` **动态派发**（所以我们猴补丁实例方法才有效）
 *   · `summarize` 返回 `{ summary, provider, model }`，summary 是内容块数组
 *   · 回执必须比被压缩的区间更小，否则后端会抛错（这里也照做）
 */
function makeCompaction(session) {
  const calls = []
  const summaries = []
  return {
    calls,
    summaries,
    async summarize(input, agent, signal) {
      summaries.push({ input, injected: false })
      return { summary: [{ type: 'text', text: '（基线模型摘要）' }], provider: 'fake', model: 'fake-model' }
    },
    async compactRegion(start, end, agent, signal) {
      const nodes = session.surface.nodes
      const startIdx = nodes.indexOf(start)
      const endIdx = nodes.indexOf(end)
      if (startIdx < 0 || endIdx < 0 || startIdx > endIdx) throw new Error(`compactRegion: 非法区间 ${start}-${end}`)
      // 关键：模拟后端内部这一次动态派发 —— 猴补丁必须在这里被调用到
      const summarized = await this.summarize({ messages: [] }, agent, signal)
      const text = summarized.summary.map((b) => b.text ?? '').join('')
      calls.push({ start, end, nodes: nodes.slice(startIdx, endIdx + 1), summary: text, provider: summarized.provider })
      return {
        compactionId: 'fake-compaction',
        shadowedRange: { start, end },
        shadowedSeqs: nodes.slice(startIdx, endIdx + 1),
        shadowedTokenCount: 1234,
        summary: summarized.summary,
      }
    },
  }
}

function makeCtx({ pruner, session, compaction }) {
  const handlers = new Map()
  const registeredTools = []
  const registeredCommands = []
  const tokenMeter = {
    measure: (s) => {
      const nodes = (s?.surface?.nodes ?? []).map((seq) => {
        const event = s.eventAt(seq)
        const blocks = event?.data?.message?.content?.[0]?.content
        const text = Array.isArray(blocks) ? blocks.map((b) => b.text ?? '').join('') : ''
        return { seq, tokens: Math.ceil(text.length / 4), heuristicTokens: Math.ceil(text.length / 4) }
      })
      return { totalTokens: nodes.reduce((sum, n) => sum + n.tokens, 0), nodes }
    },
  }
  const services = new Map([
    ['toolResultPruner', pruner],
    ['tokenMeter', tokenMeter],
    ['compaction', compaction],
    ['commands', { register: (c) => { registeredCommands.push(c); return c } }],
  ])
  const toolsService = { register: (t) => { registeredTools.push(t); return t } }
  services.set('tools', toolsService)

  return {
    registeredTools,
    registeredCommands,
    handlers,
    // Cordis 两种取法都要支持：ctx.get('x') 与 ctx.x
    get: (n) => services.get(n) ?? null,
    tools: toolsService,
    commands: services.get('commands'),
    tokenMeter,
    compaction,
    on: (evt, fn) => { handlers.set(evt, fn) },
    effect: (fn) => fn(),
    logger: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} },
  }
}

// ---------------------------------------------------------------- 假 Jev
/**
 * 只读概率、不看文本 —— 与真实现同语义。
 * @param {Record<number, number>} resultPreset 结果可丢性 P(保留)
 * @param {Record<number, number>} effectPreset 副作用 P(有副作用)
 */
function fakeJudge(resultPreset, effectPreset = {}) {
  return {
    ready: true,
    requests: 0,
    usage: { input_tokens: 0, output_tokens: 0 },
    batch: (_state, questions) => [questions],
    async ask(_state, questions) {
      this.requests += 1
      const out = {}
      for (const id of Object.keys(questions)) {
        const match = /^(result|effect)_s(\d+)$/.exec(id)
        if (match == null) continue
        const seq = Number(match[2])
        const preset = match[1] === 'result' ? resultPreset : effectPreset
        if (preset[seq] != null) out[id] = preset[seq]
      }
      return out
    },
  }
}

// ---------------------------------------------------------------- 跑
let mod
try {
  mod = await import('dsh-jev-prune')
  ok('import dsh-jev-prune')
} catch (error) {
  bad('import dsh-jev-prune', error?.message ?? String(error))
  // issue #18：README 的冒烟配方在干净目录里必失败（缺 peer 依赖）——报错要说清缺什么、怎么装
  if (/Cannot find package/.test(error?.message ?? '')) {
    console.error('\n提示：缺少 peer 依赖。在本目录执行：')
    console.error('  npm install @deepseek-ai/schemastery @deepseek-ai/dsh-tools')
    console.error('（或直接用 npm pack 产出的 tarball 安装本包）\n')
  }
  for (const r of results) console.log(`${r.ok ? '  ✅' : '  ❌'} ${r.name}${r.detail ? `  — ${r.detail}` : ''}`)
  process.exit(1)
}

check('导出 name', typeof mod.name === 'string' && mod.name.length > 0, mod.name)
check('导出 inject 含 tools', Array.isArray(mod.inject) && mod.inject.includes('tools'), JSON.stringify(mod.inject))
check('导出 apply', typeof mod.apply === 'function')

const PLUGIN_CFG = {
  enabled: true,
  apiKey: 'dummy', // 有注入的假 judge，这个不会被用到
  // 本文件全部用例都走"决策路径"，不走压力门：假 ctx 里解析不出上下文窗口，
  // 而并行门（issue #32）在两个方向上都要求**解析不出来就别做**——若沿用默认
  // `judgeOn='pressure'`，第一层会诚实地什么都不做，测的就不是决策逻辑了。
  // 压力门本身由下方 G 块专门覆盖。
  judgeOn: 'always',
  compactOn: 'always',
  preserveRecent: 0, // 让三条都进候选
  minCharsToPrune: 400,
  headChars: 600,
  tailChars: 200,
  wording: 'goal',
  logLevel: 'silent',
  heartbeatFile: '',
}

// ---------- A. apply() 不抛错、装配齐全、两个接入点都被接管 ----------
{
  const pruner = makePruner()
  const session = makeSession()
  const compaction = makeCompaction(session)
  const baseSummarize = compaction.summarize
  const ctx = makeCtx({ pruner, session, compaction })
  try {
    mod.apply(ctx, PLUGIN_CFG, { judge: fakeJudge({}) })
    ok('apply(ctx, config, {judge}) 未抛错')
  } catch (error) {
    bad('apply(ctx, config, {judge}) 未抛错', error?.message ?? String(error))
  }
  check('注册了 agent/pre-step 钩子', ctx.handlers.has('agent/pre-step'))
  const toolNames = ctx.registeredTools.map((t) => t?.name).filter(Boolean)
  for (const name of ['jev_prune_status', 'jev_prune_now', 'jev_compact_now', 'jev_restore', 'jev_probe_shapes']) {
    check(`注册了 ${name} 工具`, toolNames.includes(name), toolNames.join(', '))
  }
  check('注册了 /jev 命令', ctx.registeredCommands.some((c) => c?.name === 'jev'),
    ctx.registeredCommands.map((c) => c?.name).join(', '))
  check('已接管 pruner.pruneSession', typeof pruner.pruneSession === 'function')
  check('已接管 compaction.summarize（回执的注入点）', compaction.summarize !== baseSummarize)

  // 无判定 → 退回按体积；假 pruner 阈值极高，故什么都不裁
  const r = pruner.pruneSession(session)
  check('无判定时退回按体积且不裁', r.pruned.length === 0 && session.appended.length === 0,
    `pruned=${r.pruned.length} appended=${session.appended.length}`)
  check('三条候选都走到了 pruneContent', pruner.pruneContentCalls === 3, `实际 ${pruner.pruneContentCalls}`)

  // summarize 被接管后，没有 pending 回执时**必须**退回原实现（不能吞掉别人的摘要）
  const passthrough = await compaction.summarize({ messages: [] }, { session, options: {} })
  check('无 pending 回执时 summarize 退回原实现',
    passthrough?.provider === 'fake', JSON.stringify(passthrough))
}

// ---------- B. 预置判定 → 跑完整第一层决策路径 ----------
{
  const pruner = makePruner()
  const session = makeSession()
  const compaction = makeCompaction(session)
  const { s1, s2, s3 } = session.seqs
  const ctx = makeCtx({ pruner, session, compaction })
  const judge = fakeJudge({ [s1]: 0.08, [s2]: 0.15, [s3]: 0.93 }, { [s1]: 0.05, [s2]: 0.05, [s3]: 0.30 })
  mod.apply(ctx, {
    ...PLUGIN_CFG,
    // 第二层这一步不参与（窗口解析不出来时会保守跳过），避免干扰第一层的断言
    compactReceipts: false,
  }, { judge })

  const handler = ctx.handlers.get('agent/pre-step')
  check('agent/pre-step 处理器存在', typeof handler === 'function')
  if (typeof handler === 'function') {
    try {
      await handler({ agent: { session, options: {} } }, () => {})
      ok('判定 pass 已执行')
    } catch (error) {
      bad('判定 pass 已执行', error?.message ?? String(error))
    }
  }
  check('判定 pass 发出了请求', judge.requests === 1, `实际 ${judge.requests}`)

  const r = pruner.pruneSession(session)
  const prunedSeqs = r.pruned.map((p) => p.originalSeq)
  check('Jev 说过期的 s1 被裁', prunedSeqs.includes(s1), `pruned=${JSON.stringify(prunedSeqs)}`)
  check('Jev 说过期且不太小的 s2 被裁', prunedSeqs.includes(s2))
  check('Jev 说保留的 s3 没被碰（哪怕 6000 字符）', !prunedSeqs.includes(s3))

  const prices = session.appended.filter((a) => a.type === 'compaction/prune')
  const replaces = session.appended.filter((a) => a.type === 'tool/result')
  check('每次替换前都有 compaction/prune', prices.length === prunedSeqs.length && replaces.length === prunedSeqs.length,
    `prune 事件=${prices.length} 替换=${replaces.length}`)
  check('compaction/prune 带齐 shadowedRange/Seqs/tokenCount',
    prices.every((p) => p.data.shadowedRange?.start === p.data.shadowedSeqs?.[0]
      && typeof p.data.shadowedTokenCount === 'number'),
    JSON.stringify(prices[0]?.data ?? null))
  check('替换事件带 surfaceOp:replace + sourceEventSeqs',
    replaces.every((x) => x.options?.surfaceOp?.op === 'replace'
      && Array.isArray(x.options?.sourceEventSeqs)),
    JSON.stringify(replaces[0]?.options ?? null))

  const first = session.appended.find((a) => a.type === 'tool/result')
  const text = first?.data?.message?.content?.[0]?.content?.[0]?.text ?? ''
  check('裁后仍保留头部 600 字符', text.slice(0, 20) === 'a'.repeat(20))
  check('裁后长度显著变短', text.length < 2000, `实际 ${text.length}`)
  check('stats 记录了省下的字符', r.charsRemoved > 0, `charsRemoved=${r.charsRemoved}`)
}

/** 从报告里读出"两轴尾部交集"的 seq 列表（报告格式变了这里会立刻失败，这是有意的）。 */
function eligibleSeqsFrom(report) {
  const line = report.split('\n').find((l) => l.includes('两轴尾部交集'))
  const match = /\[([^\]]*)\]/.exec(line ?? '')
  if (match == null) return []
  return match[1].split(',').map((s) => Number(s.trim().replace('s', ''))).filter(Number.isFinite)
}

// ---------- C. 第二层 · 自动路径：pre-step 里就完成回执压缩 ----------
{
  const pruner = makePruner()
  const session = makeSession()
  const compaction = makeCompaction(session)
  const ctx = makeCtx({ pruner, session, compaction })
  // 三条都"结果可丢 + 无副作用"→ 两轴尾部交集覆盖三条 → 应合并成一段
  const judge = fakeJudge({ [session.seqs.s1]: 0.10, [session.seqs.s2]: 0.11, [session.seqs.s3]: 0.12 },
    { [session.seqs.s1]: 0.05, [session.seqs.s2]: 0.06, [session.seqs.s3]: 0.07 })
  mod.apply(ctx, {
    ...PLUGIN_CFG,
    compactOn: 'always', // 跳过压力门（本测试不接真 LLM，解析不出上下文窗口）
    compactQuantile: 1, // 测试专用：三条全取，才验得到"合并成一段"
    minCandidatesForRelative: 3,
    compactMinChars: 1000,
  }, { judge })

  const agentRef = { agent: { session, options: {} } }
  await ctx.handlers.get('agent/pre-step')(agentRef, () => {})
  check('判定 pass 拿到了两轴概率', judge.requests >= 1, `requests=${judge.requests}`)

  // 关键：**不需要手动触发** —— pre-step 的自动路径已经压缩了
  check('自动路径（pre-step）就完成了压缩', compaction.calls.length === 1, `实际 ${compaction.calls.length}`)
  const call = compaction.calls[0]
  if (call != null) {
    check('压缩范围覆盖三个步骤的头到尾',
      call.start === session.steps[0].head && call.end === session.steps[2].result,
      `${call.start}-${call.end} vs ${session.steps[0].head}-${session.steps[2].result}`)
    check('区间含 6 个节点（3 调用 + 3 结果）', call.nodes.length === 6, `实际 ${call.nodes.length}`)
    check('注进去的是我们的回执，不是模型摘要',
      call.summary.includes('[已压缩 · 确定性回执]') && !call.summary.includes('基线模型摘要'),
      call.summary.slice(0, 80))
    check('回执 provider 标记为 jev-receipt', call.provider === 'jev-receipt', String(call.provider))
    // 回执必须逐字记录命令与路径 —— 这是"整对删除后事实仍不丢"的依据
    check('回执记录了 Read 的路径', call.summary.includes('server/src/game/river.ts'))
    check('回执记录了 Grep 的 pattern', call.summary.includes('basePot'))
    check('回执记录了 Glob 的 pattern 与 path', call.summary.includes('*.ts server/src'))
    check('回执写明了被移出的 seq 范围与字符数', /s\d+–s\d+/.test(call.summary) && /字符输出/.test(call.summary))
  }
}

// ---------- C2. 第二层 · 手动路径：dry-run 先看，再真跑 ----------
// compactOn='pressure' 且解析不出上下文窗口 → pre-step 保守跳过（这是一条刻意的设计决策：
// 不知道压力就不做破坏性动作）。于是可以用手动工具把决策过程摊开看。
{
  const pruner = makePruner()
  const session = makeSession()
  const compaction = makeCompaction(session)
  const ctx = makeCtx({ pruner, session, compaction })
  const judge = fakeJudge({ [session.seqs.s1]: 0.10, [session.seqs.s2]: 0.11, [session.seqs.s3]: 0.12 },
    { [session.seqs.s1]: 0.05, [session.seqs.s2]: 0.06, [session.seqs.s3]: 0.07 })
  mod.apply(ctx, {
    ...PLUGIN_CFG,
    compactOn: 'pressure', // 默认值：解析不出窗口 → 保守不动作
    compactQuantile: 1,
    minCandidatesForRelative: 3,
    compactMinChars: 1000,
  }, { judge })
  const agentRef = { agent: { session, options: {} } }
  await ctx.handlers.get('agent/pre-step')(agentRef, () => {})
  check('压力未知时自动路径保守跳过（不做破坏性动作）', compaction.calls.length === 0, `实际 ${compaction.calls.length}`)

  const compactTool = ctx.registeredTools.find((t) => t?.name === 'jev_compact_now')
  check('jev_compact_now 可用', compactTool != null)

  let dryReport = ''
  try {
    dryReport = await compactTool.execute({ dryRun: true }, agentRef)
    ok('jev_compact_now --dryRun 执行未抛错')
  } catch (error) {
    bad('jev_compact_now --dryRun 执行未抛错', error?.message ?? String(error))
  }
  check('dry-run 下没有任何 compactRegion 调用', compaction.calls.length === 0, `实际 ${compaction.calls.length}`)
  check('dry-run 报告里带上回执全文', dryReport.includes('[已压缩 · 确定性回执]'), dryReport.slice(0, 60))
  check('dry-run 报告声明未执行', /dry-run/.test(dryReport))
  check('dry-run 已选中三条', eligibleSeqsFrom(dryReport).length === 3, eligibleSeqsFrom(dryReport).join(','))
  check('dry-run 逐条说明省了多少', /tokens → 回执/.test(dryReport), dryReport.split('\n').slice(3, 5).join(' | '))

  let report = ''
  try {
    report = await compactTool.execute({}, agentRef)
    ok('jev_compact_now 执行未抛错')
  } catch (error) {
    bad('jev_compact_now 执行未抛错', error?.message ?? String(error))
  }
  check('手动路径压缩了一次', compaction.calls.length === 1, `实际 ${compaction.calls.length}`)
  check('工具输出报告了已压缩', /已压缩/.test(report), report.split('\n').slice(0, 4).join(' | '))
  check('手动路径注入的也是回执',
    (compaction.calls[0]?.summary ?? '').includes('[已压缩 · 确定性回执]'))
}

// ---------- D. 第二层的门控：有副作用的调用绝不能被整对移出（含反事实对照） ----------
/**
 * 构造条件让 s2 **只可能**因为"副作用"这一轴被排除：
 *   result 轴尾部 = {s2, s3}   （s2 的 result 概率故意给最低）
 *   effect 轴尾部 = {s1, s3}   （只有 s2 的 effect 高）
 * 于是 s2 被排除的原因唯一 —— 副作用轴。再用"把 s2 的副作用设低"做对照，证明因果。
 */
async function layer2Run(effectOfS2) {
  const pruner = makePruner()
  const session = makeSession()
  const compaction = makeCompaction(session)
  const { s1, s2, s3 } = session.seqs
  const ctx = makeCtx({ pruner, session, compaction })
  const judge = fakeJudge({ [s1]: 0.14, [s2]: 0.10, [s3]: 0.12 },
    { [s1]: 0.05, [s2]: effectOfS2, [s3]: 0.07 })
  mod.apply(ctx, {
    ...PLUGIN_CFG,
    compactOn: 'pressure', // 让 pre-step 只判定、不动作，方便逐步观察
    compactQuantile: 0.7, // take = 2/3，必须有取舍才测得出门控
    minCandidatesForRelative: 3,
    compactMinChars: 100,
  }, { judge })
  const agentRef = { agent: { session, options: {} } }
  await ctx.handlers.get('agent/pre-step')(agentRef, () => {})
  const tool = ctx.registeredTools.find((t) => t?.name === 'jev_compact_now')
  const dry = await tool.execute({ dryRun: true }, agentRef)
  const dryEligible = eligibleSeqsFrom(dry)
  const exec = await tool.execute({}, agentRef)
  return { session, compaction, dryEligible, dry, exec }
}

{
  const blocked = await layer2Run(0.40)
  check('副作用高的 s2 不在两轴交集里', !blocked.dryEligible.includes(blocked.session.seqs.s2),
    `eligible=[${blocked.dryEligible.join(',')}]`)
  check('报告列出了被排除的原因', /排除计数/.test(blocked.dry), blocked.dry.split('\n')[2] ?? '')
  const call = blocked.compaction.calls[0]
  check('实际压缩的段落不含 s2', call != null && !call.nodes.includes(blocked.session.seqs.s2),
    `nodes=[${(call?.nodes ?? []).join(',')}]`)

  // 反事实：把同一个调用的副作用改成低 → 它就该被选中。这证明上面的排除确实来自副作用轴
  const allowed = await layer2Run(0.06)
  check('反事实对照：副作用低时同一条被选中', allowed.dryEligible.includes(allowed.session.seqs.s2),
    `eligible=[${allowed.dryEligible.join(',')}]`)
  check('反事实对照：确实压缩了包含它的段落',
    (allowed.compaction.calls[0]?.nodes ?? []).includes(allowed.session.seqs.s2),
    `nodes=[${(allowed.compaction.calls[0]?.nodes ?? []).join(',')}]`)
}

// ---------- C3. 第二层 · 竞态：await 期间别处的并发压缩抢走回执 ----------
//
// issue #29。原实现按 session 存一个待用回执、并在 finally 里无条件 delete(session)：
// compactRegion 是异步的，而 summarize 的入参里**没有区间身份**，所以 await 窗口内任何
// 别处发起的压缩都可能把回执抢走 —— 别人那段被换成我们的确定性回执，我们要压的那段
// 反而用了模型摘要。
//
// 真实的触发形态是**并发的顶层压缩**（DSH 自己的自动压缩），不是我们调用栈里的嵌套调用。
// 所以这里的 mock 让 `compactRegion` 在真正派发 summarize 之前先 `await` 一次
// 微任务边界，并在这期间启动一条独立的 summarize 调用 —— 复刻"两条压缩同时在飞"。
{
  const pruner = makePruner()
  const session = makeSession()
  const compaction = makeCompaction(session)

  // 模拟另一个"压缩发起方"：在 await 窗口里独立跑一次 summarize（不是我们嵌套调的）
  let intruderResult = null
  const innerCompact = compaction.compactRegion.bind(compaction)
  compaction.compactRegion = async (start, end, agent, signal) => {
    const first = await innerCompact(start, end, agent, signal)
    // 第一次完成后，让"别处"再发起一次压缩并观察它拿到什么 provider
    if (intruderResult == null) {
      intruderResult = await compaction.summarize({ messages: ['elsewhere'] }, agent, signal)
      compaction.intruderProvider = intruderResult?.provider ?? null
    }
    return first
  }

  const ctx = makeCtx({ pruner, session, compaction })
  const judge = fakeJudge({ [session.seqs.s1]: 0.10, [session.seqs.s2]: 0.11, [session.seqs.s3]: 0.12 },
    { [session.seqs.s1]: 0.05, [session.seqs.s2]: 0.06, [session.seqs.s3]: 0.07 })
  mod.apply(ctx, {
    ...PLUGIN_CFG,
    compactOn: 'always',
    compactQuantile: 1,
    minCandidatesForRelative: 3,
    compactMinChars: 1000,
  }, { judge })

  const agentRef = { agent: { session, options: {} } }
  await ctx.handlers.get('agent/pre-step')(agentRef, () => {})

  // 以插件自己的账本为准（外面包一层会漏记我们注入的那次：我们的钩子会直接 return，
  // 不走 original，所以包装 `baseSummarize` 观察不到注入）
  const statusTool = ctx.registeredTools.find((t) => t?.name === 'jev_prune_status')
  const statusText = statusTool ? await statusTool.execute({}, agentRef) : ''
  check('我们自己的那次压缩拿到了回执',
    compaction.calls[0]?.provider === 'jev-receipt',
    `provider=${compaction.calls[0]?.provider}`)
  check('回执是一次性的：后续别处的压缩拿不到它（否则会把别人的区间写成我们的回执）',
    compaction.intruderProvider !== 'jev-receipt',
    `intruder provider=${compaction.intruderProvider}`)
  check('插件账本记到「回执摘要被消费 1 次」',
    /回执摘要被消费 1 次/.test(String(statusText)),
    String(statusText).split('\n').find((l) => /回执摘要被消费/.test(l)) ?? String(statusText).slice(0, 120))
}

// ---------- G. 两层压力门必须同向关闭（issue #32 回归） ----------
// 旧实现是不对称的：第二层解析不出阈值 → 不做；第一层解析不出阈值 → **穿透照做**。
// 更隐蔽的是 meter 缺失/抛错时 `used` 恒为 0，于是 `0 < threshold` 永远成立，
// 判定每一轮都跑，压力门等于不存在。对一个"省 Jev 调用钱"的门来说，
// "解析不出来就别花钱"才是安全方向。这里把两个方向都钉住。
{
  // G1：解析不出窗口 + 默认 judgeOn='pressure' → 第一层**不发请求**
  const pruner = makePruner()
  const session = makeSession()
  const compaction = makeCompaction(session)
  const ctx = makeCtx({ pruner, session, compaction })
  const judge = fakeJudge({ [session.seqs.s1]: 0.05, [session.seqs.s2]: 0.05, [session.seqs.s3]: 0.05 },
    { [session.seqs.s1]: 0.05, [session.seqs.s2]: 0.05, [session.seqs.s3]: 0.05 })
  mod.apply(ctx, { ...PLUGIN_CFG, judgeOn: 'pressure' }, { judge })
  await ctx.handlers.get('agent/pre-step')({ agent: { session, options: {} } }, () => {})
  check('压力未知时第一层不发 Jev 请求（与第二层同向关闭）',
    judge.requests === 0,
    `实际发出 ${judge.requests} 次`)

  // G2：meter 存在但 measure 抛错 → 同样不发请求（旧实现会把它当成 used=0 放行）
  const pruner2 = makePruner()
  const session2 = makeSession()
  const compaction2 = makeCompaction(session2)
  const ctx2 = makeCtx({ pruner: pruner2, session: session2, compaction: compaction2 })
  ctx2.tokenMeter.measure = () => { throw new Error('meter 坏了') }
  const judge2 = fakeJudge({ [session2.seqs.s1]: 0.05, [session2.seqs.s2]: 0.05, [session2.seqs.s3]: 0.05 },
    { [session2.seqs.s1]: 0.05, [session2.seqs.s2]: 0.05, [session2.seqs.s3]: 0.05 })
  mod.apply(ctx2, { ...PLUGIN_CFG, judgeOn: 'pressure' }, { judge: judge2 })
  await ctx2.handlers.get('agent/pre-step')({ agent: { session: session2, options: {} } }, () => {})
  check('meter 抛错时第一层也不发 Jev 请求（旧实现会放行）',
    judge2.requests === 0,
    `实际发出 ${judge2.requests} 次`)

  // G3：meter 正常且用量低于阈值 → 不发请求；高于阈值 → 发
  const pruner3 = makePruner()
  const session3 = makeSession()
  const compaction3 = makeCompaction(session3)
  const ctx3 = makeCtx({ pruner: pruner3, session: session3, compaction: compaction3 })
  // 用一个绝对阈值（非 ratio）绕开窗口解析：低于它必定不判，高于它必定判
  const judge3 = fakeJudge({ [session3.seqs.s1]: 0.05, [session3.seqs.s2]: 0.05, [session3.seqs.s3]: 0.05 },
    { [session3.seqs.s1]: 0.05, [session3.seqs.s2]: 0.05, [session3.seqs.s3]: 0.05 })
  mod.apply(ctx3, { ...PLUGIN_CFG, judgeOn: 'pressure', softLimit: 999999 }, { judge: judge3 })
  await ctx3.handlers.get('agent/pre-step')({ agent: { session: session3, options: {} } }, () => {})
  check('用量低于绝对阈值时第一层不发请求', judge3.requests === 0, `实际发出 ${judge3.requests} 次`)

  // G4（PR #28 review 回归）：绝对阈值 + meter 缺失 → **必须照常判定**。
  // 绝对阈值不需要 meter，早期实现却在 `!measured` 处直接 return，
  // 于是宿主没注册 tokenMeter 时第一层永久静默失效（比旧行为更糟）。
  //
  // 注意：必须从 ctx.get 里摘掉 tokenMeter。只设 `ctx.tokenMeter = undefined`
  // 是**无效的**——插件走的是 `ctx.get('tokenMeter')`，仍会读到那个对象，
  // 于是这条断言在回退修复后依然变绿（我在反向验证时踩到过这个坑）。
  {
    const p = makePruner()
    const s = makeSession()
    const c = makeCompaction(s)
    const cx = makeCtx({ pruner: p, session: s, compaction: c })
    const realGet = cx.get
    cx.get = (n) => (n === 'tokenMeter' ? null : realGet(n)) // 真正让 meter 消失
    const j = fakeJudge(
      { [s.seqs.s1]: 0.05, [s.seqs.s2]: 0.05, [s.seqs.s3]: 0.05 },
      { [s.seqs.s1]: 0.05, [s.seqs.s2]: 0.05, [s.seqs.s3]: 0.05 },
    )
    mod.apply(cx, { ...PLUGIN_CFG, judgeOn: 'pressure', softLimit: 1 }, { judge: j })
    await cx.handlers.get('agent/pre-step')({ agent: { session: s, options: {} } }, () => {})
    check('绝对阈值下 meter 缺失时第一层仍照常判定（不因拿不到用量而关闭功能）',
      j.requests > 0,
      `实际发出 ${j.requests} 次（0 表示功能被静默关掉了）`)
  }

  const pruner4 = makePruner()
  const session4 = makeSession()
  const compaction4 = makeCompaction(session4)
  const ctx4 = makeCtx({ pruner: pruner4, session: session4, compaction: compaction4 })
  const judge4 = fakeJudge({ [session4.seqs.s1]: 0.05, [session4.seqs.s2]: 0.05, [session4.seqs.s3]: 0.05 },
    { [session4.seqs.s1]: 0.05, [session4.seqs.s2]: 0.05, [session4.seqs.s3]: 0.05 })
  mod.apply(ctx4, { ...PLUGIN_CFG, judgeOn: 'pressure', softLimit: 1 }, { judge: judge4 })
  await ctx4.handlers.get('agent/pre-step')({ agent: { session: session4, options: {} } }, () => {})
  check('用量高于绝对阈值时第一层正常发请求', judge4.requests > 0, `实际发出 ${judge4.requests} 次`)
}

// ---------- H. 单次 pass 的压缩配额（issue #35 回归） ----------
// 旧默认 maxCompactionsPerPass=1：一次 pass 只回收一段，大上下文要靠多轮 pre-step
// 慢慢挤，每轮都要重走压力门 + 重判定。默认提到 3 之后，一段 pass 内应能压掉多段。
// 这里用 interleave 把只读步骤切成**两段**，验证配额真的被放行了。
{
  const twoRangePlan = [
    { tool: 'Read', args: { file_path: 'server/src/game/river.ts' }, chars: 6000, fill: 'a' },
    { tool: 'Grep', args: { pattern: 'basePot', path: 'server/src' }, chars: 5000, fill: 'b' },
    // 这条不带 tool-call 的 assistant 文本把前后只读步骤切成两段
    { tool: 'Read', args: { file_path: 'server/src/game/turn.ts' }, chars: 6000, fill: 'c', interleave: '中间结论：再看下一段。' },
    { tool: 'Glob', args: { pattern: '*.ts', path: 'server/src' }, chars: 5000, fill: 'd' },
  ]
  const pruner = makePruner()
  const session = makeSession(twoRangePlan)
  const compaction = makeCompaction(session)
  const ctx = makeCtx({ pruner, session, compaction })
  const seqs = session.steps.map((s) => s.result)
  const judge = fakeJudge(
    Object.fromEntries(seqs.map((s) => [s, 0.10])),
    Object.fromEntries(seqs.map((s) => [s, 0.05])),
  )
  mod.apply(ctx, {
    ...PLUGIN_CFG,
    compactQuantile: 1,
    minCandidatesForRelative: 3,
    compactMinChars: 1000,
    maxCompactionsPerPass: 2, // 显式给 2，确保两段都能压
  }, { judge })

  const agentRef = { agent: { session, options: {} } }
  await ctx.handlers.get('agent/pre-step')(agentRef, () => {})
  check('配额 ≥2 时一次 pass 压掉多段（旧默认 1 只能压一段）',
    compaction.calls.length >= 2,
    `实际压了 ${compaction.calls.length} 段`)

  // 配额=1 必须严格只压一段（回归保护：配额不能被无视）
  const pruner2 = makePruner()
  const session2 = makeSession(twoRangePlan)
  const compaction2 = makeCompaction(session2)
  const ctx2 = makeCtx({ pruner: pruner2, session: session2, compaction: compaction2 })
  const seqs2 = session2.steps.map((s) => s.result)
  const judge2 = fakeJudge(
    Object.fromEntries(seqs2.map((s) => [s, 0.10])),
    Object.fromEntries(seqs2.map((s) => [s, 0.05])),
  )
  mod.apply(ctx2, {
    ...PLUGIN_CFG,
    compactQuantile: 1,
    minCandidatesForRelative: 3,
    compactMinChars: 1000,
    maxCompactionsPerPass: 1,
  }, { judge: judge2 })
  await ctx2.handlers.get('agent/pre-step')({ agent: { session: session2, options: {} } }, () => {})
  check('配额=1 时严格只压一段（配额不得被无视）',
    compaction2.calls.length === 1,
    `实际压了 ${compaction2.calls.length} 段`)

  // 默认值必须是 3（issue #35 把默认从 1 上调）；通过 resolveConfig 读，避免硬编码漂移
  const defaults = mod.resolveConfig({})
  check('默认配额已从 1 提到 3', defaults.maxCompactionsPerPass === 3,
    `实际默认 ${defaults.maxCompactionsPerPass}`)
}

// ---------- I. 批次循环只处理本批的题（issue #30 回归） ----------
// 旧实现每批都遍历完整的 `fresh`：对不在本批里的候选，若缓存里已有旧值，
// `previous` 分支会把它原样写回并**再累加一次** stats.judged——
// 于是"判定了 N 条"按批数虚报（3 条切成 3 批 → 报 9 条）。
// 这里造 3 条候选 + 只装得下 1 题的请求预算 = 3 批，
// 然后直接读状态报告里的 `判定 N 次` 计数器。
{
  const pruner = makePruner()
  const session = makeSession()
  const compaction = makeCompaction(session)
  const ctx = makeCtx({ pruner, session, compaction })
  // 每条候选都给出真实的预置概率（这样 answers 里确实有值，不会被 `continue` 跳过）
  const judge = fakeJudge({ [session.seqs.s1]: 0.10, [session.seqs.s2]: 0.11, [session.seqs.s3]: 0.12 },
    { [session.seqs.s1]: 0.05, [session.seqs.s2]: 0.06, [session.seqs.s3]: 0.07 })
  // 记录 fakeJudge 实际收到的问题个数，用来证明"确实切成了多批"
  const batchSizes = []
  const baseBatch = judge.batch
  // 让假 judge 也尊重请求预算：每条陈述都**单独成批**（模拟 maxRequestTokens 极小）。
  // 真 client 的 batch() 会按 token 预算切；这里直接按题切，等价于预算只装得下 1 题。
  judge.batch = (state, questions, limits) => {
    if (limits?.maxRequestTokens > 1) return baseBatch(state, questions, limits)
    const out = Object.keys(questions).map((id) => ({ [id]: questions[id] }))
    for (const b of out) batchSizes.push(Object.keys(b).length)
    return out
  }
  // 强制每题一批（把预算压到 0，batch() 里每题都会单独成批）
  mod.apply(ctx, {
    ...PLUGIN_CFG,
    dryRun: true,
    maxRequestTokens: 1,
  }, { judge })

  const agentRef = { agent: { session, options: {} } }
  await ctx.handlers.get('agent/pre-step')(agentRef, () => {})

  const statusTool = ctx.registeredTools.find((t) => t?.name === 'jev_prune_status')
  const statusText = String(await statusTool.execute({}, agentRef))
  const judgedMatch = /判定 (\d+) 次/.exec(statusText)
  const judgedCount = judgedMatch ? Number(judgedMatch[1]) : -1

  // 前提成立性检查：必须真的切成了多批，否则这条测试说明不了问题
  check('前提：请求预算被压到每题一批（否则本测试无意义）',
    batchSizes.length >= 2,
    `批数=${batchSizes.length} 各批题数=${JSON.stringify(batchSizes)}`)
  check('批次循环不重复计数：3 条候选跨多批时判定数不得 >3（旧实现按批数虚报）',
    judgedCount === 3,
    `实际判定数=${judgedCount}（批数 ${batchSizes.length}）`)
}

// ---------------------------------------------------------------- 汇总
console.log()
for (const r of results) console.log(`${r.ok ? '  ✅' : '  ❌'} ${r.name}${r.detail ? `  — ${r.detail}` : ''}`)
const failures = results.filter((r) => !r.ok)
console.log()
console.log(failures.length === 0
  ? `结论：apply() 装配 + 两个接入点接管 + 判定 pass + 两层裁决路径 + append/回执协议，在真实 DSH 接口形状下全部通过（${results.length} 项）`
  : `结论：${failures.length} / ${results.length} 项失败`)
process.exitCode = failures.length === 0 ? 0 : 1
