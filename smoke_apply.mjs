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
      events.set(seq, { seq, type, data, ...options })
      appended.push({ seq, type, data, options })
      const op = options?.surfaceOp
      if (op === 'append') {
        session.surface.nodes.push(seq)
      } else if (op?.op === 'replace') {
        const start = session.surface.nodes.indexOf(op.startSeq)
        const end = session.surface.nodes.indexOf(op.endSeq)
        if (start < 0 || end < start) throw new Error(`fake surface replace: 非法区间 ${op.startSeq}-${op.endSeq}`)
        session.surface.nodes.splice(start, end - start + 1, seq)
      }
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
    // 与 cordis 同构：同一事件可以有**多个**监听器，第三个参数（或 options.prepend）
    // 决定插入队首还是队尾。此前这里只是 Map<event, fn> —— 第二个监听会**覆盖**第一个，
    // 而且 prepend 被完全忽略。于是"判定钩子 prepend 到 compaction-basic 之前"这条
    // 真实语义在测试里根本不存在（拆成两个监听后 30/72 项直接失败）。
    // 假对象必须复刻宿主这个形状，否则测的是一套不存在的语义。
    on: (evt, fn, options) => {
      const prepend = typeof options === 'object' && options !== null
        ? options.prepend === true
        : options === true
      const list = handlers.get(evt) ?? []
      if (prepend) list.unshift(fn)
      else list.push(fn)
      handlers.set(evt, list)
    },
    /**
     * 忠实复刻 cordis 的 waterfall（`agent/pre-step` 正是这类事件）：
     * 最外层先跑，最后一个参数是内层 next；监听器**不调用 next() 即否决**后续链路
     * （含宿主内建行为）。所以测试里不能"取一个 handler 直接调"——链上有几个监听、
     * 谁先谁后，恰恰是这次要验证的东西。
     */
    waterfall: (name, ...args) => {
      const cbs = [...(handlers.get(name) ?? [])]
      const inner = args.pop()
      const next = () => (cbs.shift() ?? inner)(...args)
      args.push(next)
      return next()
    },
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

// 可选的 dsh-llm 不存在时必须走可测的浅拷贝降级；恒等函数会让后续代码意外复用入参。
{
  const fallbackFreeze = await mod.resolveFreezeMessage(async () => {
    throw new Error('模拟可选依赖缺失')
  })
  const input = { role: 'tool', content: [{ type: 'text', text: 'x' }] }
  const output = fallbackFreeze(input)
  check('freezeMessage 加载失败时返回浅拷贝而不是原对象',
    output !== input && output.role === input.role && output.content === input.content)
}

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
  // 拆成两个监听是有意的：判定必须 **prepend**（抢在 compaction-basic 调 pruneSession
  // 之前），压缩保持 append。数量与顺序都要钉住，否则"拆开"这个动作本身没有测试保护。
  const preStepHooks = ctx.handlers.get('agent/pre-step') ?? []
  check('pre-step 注册了判定 + 压缩两个监听', preStepHooks.length === 2, `实际 ${preStepHooks.length}`)
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

  const preStepHooks = ctx.handlers.get('agent/pre-step') ?? []
  check('agent/pre-step 处理器存在', preStepHooks.length > 0, `实际 ${preStepHooks.length} 个`)
  if (preStepHooks.length > 0) {
    try {
      // 走 waterfall 而不是取单个 handler 直接调：链上有判定 + 压缩两个监听，
      // 真实宿主链上还有 compaction-basic，只调一个测不出顺序问题
      await ctx.waterfall('agent/pre-step', { agent: { session, options: {} } }, () => {})
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
  await ctx.waterfall('agent/pre-step', agentRef, () => {})
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
  await ctx.waterfall('agent/pre-step', agentRef, () => {})
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
  await ctx.waterfall('agent/pre-step', agentRef, () => {})
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
  await ctx.waterfall('agent/pre-step', agentRef, () => {})

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
  await ctx.waterfall('agent/pre-step', { agent: { session, options: {} } }, () => {})
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
  await ctx2.waterfall('agent/pre-step', { agent: { session: session2, options: {} } }, () => {})
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
  await ctx3.waterfall('agent/pre-step', { agent: { session: session3, options: {} } }, () => {})
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
    await cx.waterfall('agent/pre-step', { agent: { session: s, options: {} } }, () => {})
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
  await ctx4.waterfall('agent/pre-step', { agent: { session: session4, options: {} } }, () => {})
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
  await ctx.waterfall('agent/pre-step', agentRef, () => {})
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
  await ctx2.waterfall('agent/pre-step', { agent: { session: session2, options: {} } }, () => {})
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
  await ctx.waterfall('agent/pre-step', agentRef, () => {})

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

// ---------- J. 判定 pass 不得静默抛错（回归：startRequests 未声明） ----------
// judgePass 的结算行读过未声明的 `startRequests`（全仓 0 次声明、1 次引用），
// 在严格模式下抛 ReferenceError，被 pre-step 的 catch 吞成
// stats.errors + lastNote="判定失败：startRequests is not defined"。
//
// 危害恰恰在于它**不显眼**：判定结果已经写进 decisions，第一层裁剪照常执行，
// 所以从会话行为上看功能完全正常——只有 errors 计数与心跳在说谎。
// 这个 bug 能一路活到 PR #28 之后，就是因为此前没有任何断言检查过 errors 计数。
{
  const pruner = makePruner()
  const session = makeSession()
  const compaction = makeCompaction(session)
  const ctx = makeCtx({ pruner, session, compaction })
  const judge = fakeJudge(
    { [session.seqs.s1]: 0.05, [session.seqs.s2]: 0.05, [session.seqs.s3]: 0.05 },
    { [session.seqs.s1]: 0.05, [session.seqs.s2]: 0.05, [session.seqs.s3]: 0.05 },
  )
  mod.apply(ctx, { ...PLUGIN_CFG, dryRun: true }, { judge })
  const agentRef = { agent: { session, options: {} } }
  await ctx.waterfall('agent/pre-step', agentRef, () => {})

  const statusTool = ctx.registeredTools.find((t) => t?.name === 'jev_prune_status')
  const statusText = String(await statusTool.execute({}, agentRef))
  const lines = statusText.split(String.fromCharCode(10))

  // 前提：判定真的跑过了，否则"没有错误"毫无意义
  check('前提：判定确实执行了（否则 J 块无意义）',
    judge.requests > 0,
    `实际发出 ${judge.requests} 次`)
  // 关键断言：成功路径上不允许留下任何被吞掉的错误
  check('判定成功后不得留下被吞掉的错误（startRequests 未声明回归）',
    !/错误 [1-9]/.test(statusText),
    lines.filter((l) => /错误|判定失败/.test(l)).join(' | ') || '未发现错误行')
  check('判定成功后不得被记成"判定失败"',
    !/判定失败/.test(statusText),
    lines.find((l) => /判定失败/.test(l)) ?? '无')
}


// ---------- K. session 缺失时必须优雅退出，不得留下被吞掉的错误 ----------
// judgePass 的第一道早退条件写的是 `session?.surface?.nodes == null`——**显式容忍**
// session 不存在（宿主在会话挂上之前也会发 pre-step），compactPass 对同一情况的处置是
// `report.blocked = '没有活动会话'`，所以这是项目自己声明的受支持路径。
//
// 但早退分支里那句 `pressureRatios.set(session, 0)` 是**无条件**的，而 WeakMap 的键必须
// 是对象：`set(undefined)` 抛 `TypeError: Invalid value used as weak map key`。抛出点
// 落在 pre-step 的 try 里 → 被吞成 `stats.errors += 1` 与
// `最近（第一层）: 判定失败：…`。第一层行为其实没坏，只有账本在说谎——与 #29 同一个模式，
// 也正是这个 PR 想消灭的那类"静默失效"。
//
// 断言方式刻意走**真实路径**：不是直接调 judgePass，而是发一次不带 session 的 pre-step，
// 再读插件自己的状态报告。否则测的又是"我以为的东西"。
{
  const pruner = makePruner()
  const session = makeSession()
  const compaction = makeCompaction(session)
  const ctx = makeCtx({ pruner, session, compaction })
  const judge = fakeJudge({}, {})
  mod.apply(ctx, { ...PLUGIN_CFG }, { judge })

  // agent 没有 session —— 第一道早退条件为真
  await ctx.waterfall('agent/pre-step', { agent: {}, options: {} }, () => {})

  const statusTool = ctx.registeredTools.find((t) => t?.name === 'jev_prune_status')
  const text = String(await statusTool.execute({}, { agent: { session, options: {} } }))
  check('session 缺失时判定 pass 不得抛错（WeakMap.set(undefined) 回归）',
    !/Invalid value used as weak map key/.test(text),
    text.split('\n').filter((l) => /判定失败|Invalid/.test(l)).join(' | ') || '未发现')
  check('session 缺失时不得被计入错误（错误 1 次）',
    !/错误 [1-9]/.test(text),
    text.split('\n').filter((l) => /错误/.test(l)).join(' | ') || '未发现错误行')
  check('session 缺失应被如实记成"跳过"，而不是静默',
    /没有活动会话/.test(text),
    text.split('\n').filter((l) => /跳过|活动会话/.test(l)).join(' | ') || '未记录跳过原因')
}


// ---------- L. alwaysTrimRatio 必须真的生效（新增配置项的行为断言） ----------
// 这个键是 `judgeOn: 'always'` 时替代硬编码 0.5 的固定裁剪比例。配置项最危险的失败模式
// 是"进了 schema 但没人读"（静默空转）——schema / CONFIG_RANGES / resolveConfig 三处
// 一致（已有元断言）**排不掉**这种失败，只有行为断言能：改这个值，裁剪量必须跟着变。
//
// 构造上有两个坑，都是实测踩出来的，写在这里免得下次重踩：
//   ① 候选数必须 ≥ minCandidatesForBudget（默认 4）——只有 3 条时 P0-2 的小总体降级会
//      接管，直接走"绝对下限"、完全不看比例，于是三个比例给出同一个结果，
//      看起来像"这个配置项没生效"，其实是走了另一条路径。故用 6 步会话 + 前提断言。
//   ② compactOn 必须是 pressure——若是 always，第二层会在 pre-step 里把节点整对移出，
//      第一层就没东西可裁，探针会看到恒为 0 的假结果。
{
  const plan6 = [
    { tool: 'Read', args: { file_path: 'server/src/game/river.ts' }, chars: 6000 },
    { tool: 'Grep', args: { pattern: 'basePot' }, chars: 4000 },
    { tool: 'Glob', args: { pattern: '*.ts', path: 'server/src' }, chars: 6000 },
    { tool: 'Read', args: { file_path: 'server/src/game/turn.ts' }, chars: 5000 },
    { tool: 'Grep', args: { pattern: 'potOdds' }, chars: 4500 },
    { tool: 'Glob', args: { pattern: '*.json', path: 'server/config' }, chars: 3000 },
  ]
  const pruneWithRatio = async (ratio) => {
    const pruner = makePruner()
    const session = makeSession(plan6)
    const compaction = makeCompaction(session)
    const ctx = makeCtx({ pruner, session, compaction })
    // ⚠️ 不能用 session.steps —— 假会话只暴露前 3 步（见 makeSession），
    // 6 步计划里后 3 步拿不到概率就会被排除出候选，于是又只剩 3 条、撞上小总体降级。
    // 从 surface 推全部 tool/result 节点才是完整候选集。
    const resultSeqs = session.surface.nodes.filter((seq) => session.eventAt(seq)?.type === 'tool/result')
    const probs = Object.fromEntries(resultSeqs.map((seq) => [seq, 0.05]))
    const judge = fakeJudge(probs, probs)
    mod.apply(ctx, { ...PLUGIN_CFG, judgeOn: 'always', compactOn: 'pressure', alwaysTrimRatio: ratio }, { judge })
    const agentRef = { agent: { session, options: {} } }
    await ctx.waterfall('agent/pre-step', agentRef, () => {})
    // 直接走 DSH 每步真正调用、且已被插件接管的那个接缝
    const out = pruner.pruneSession(session)
    const statusTool = ctx.registeredTools.find((t) => t?.name === 'jev_prune_status')
    const statusText = String(await statusTool.execute({}, agentRef))
    return { out, statusText }
  }

  const r0 = await pruneWithRatio(0)
  const rHalf = await pruneWithRatio(0.5)
  const r1 = await pruneWithRatio(1)

  // 前提：确实走了"预算（压力分位）"路径，而不是小总体降级或体积兜底
  check('前提：走的是预算路径而非小总体降级（否则本测试无意义）',
    /压力分位/.test(r1.statusText) && !/降级绝对下限/.test(r1.statusText),
    r1.statusText.split('\n').find((l) => /第一层预算/.test(l)) ?? '（无预算行）')

  check('alwaysTrimRatio=0 → 一条都不裁（缺口为 0 就不动手）',
    r0.out.pruned.length === 0,
    `实际裁了 ${r0.out.pruned.length} 条 / ${r0.out.charsRemoved} 字符`)
  check('alwaysTrimRatio 单调生效：0.5 与 1 都真的裁了东西',
    rHalf.out.charsRemoved > 0 && r1.out.charsRemoved > 0,
    `0.5 → ${rHalf.out.charsRemoved} 字符 / 1 → ${r1.out.charsRemoved} 字符`)
  check('alwaysTrimRatio=1 裁得比 0.5 多（比例真的进了预算）',
    r1.out.charsRemoved > rHalf.out.charsRemoved,
    `0.5 → ${rHalf.out.charsRemoved} 字符 / 1 → ${r1.out.charsRemoved} 字符`)
  check('alwaysTrimRatio=1 裁满全池（6 条）',
    r1.out.pruned.length === plan6.length,
    `实际 ${r1.out.pruned.length} / 期望 ${plan6.length}`)
}

// ---------- M. 判定钩子必须 prepend 到 compaction-basic 之前（顺序回归） ----------
// 为什么这条必须存在：真正调用 `pruner.pruneSession` 的**只有** DSH 的
// `dsh-compaction-basic`（全依赖树仅两处，都在该文件里：:888 context-overflow、
// :902 pressure），而它是在**自己的** `agent/pre-step` 里调的。我们的第一层判定结果
// 正是在那次调用里被消费。所以：
//   · 判定钩子若排在 compaction-basic **之后** → pruneSession 读到的 cache 还是上一轮的
//     → 本轮新结果全部 fallback 到体积规则 → **第一层静默失效**（不是报错，是悄悄不生效）。
//   · 这就是为什么判定钩子要用 `ctx.on(..., true)` **prepend**：抢在基线束之前。
//
// 复刻真实装载顺序：基线束先加载（监听先注册），插件后加载但 prepend。
// 断言点选在"compaction-basic 调 pruneSession 的那一刻"——那一刻 judge 是否已经跑完，
// 就是这条修复的全部内容。
{
  const pruner = makePruner()
  const session = makeSession()
  const compaction = makeCompaction(session)
  const ctx = makeCtx({ pruner, session, compaction })

  // 假 compaction-basic：位置等价于基线束的 pre-step，内部调用 pruneSession
  let cbcObserved = null
  let judgeRequestsAtCbc = null
  ctx.on('agent/pre-step', async ({ agent }, next) => {
    judgeRequestsAtCbc = judge.requests
    cbcObserved = pruner.pruneSession(agent.session)
    return next()
  })

  const resultSeqs = session.surface.nodes.filter((q) => session.eventAt(q)?.type === 'tool/result')
  const probs = Object.fromEntries(resultSeqs.map((q) => [q, 0.05]))
  const judge = fakeJudge(probs, probs)
  mod.apply(ctx, {
    ...PLUGIN_CFG,
    compactOn: 'always',
    compactQuantile: 1,
    compactPreserveRecent: 0,
  }, { judge })

  const chain = ctx.handlers.get('agent/pre-step') ?? []
  // 前提：链上有 3 个监听（基线 + 判定 + 压缩）。若只有 2 个，说明判定与压缩仍是
  // 同一个监听、或基线监听没挂上——两种情况下这条测试都测不到顺序问题。
  check('前提：pre-step 链上有基线 + 判定 + 压缩三个监听（否则本测试无意义）',
    chain.length === 3, `实际 ${chain.length}`)

  await ctx.waterfall('agent/pre-step', { agent: { session, options: {} } }, () => {})

  check('前提：compaction-basic 的位置确实调用了 pruneSession',
    cbcObserved != null,
    cbcObserved == null ? '未观察到 pruneSession 调用' : `观察到了，裁了 ${cbcObserved.pruned.length} 条`)
  check('compaction-basic 调 pruneSession 时本轮判定已完成（判定钩子确实 prepend 了）',
    judgeRequestsAtCbc === 1,
    `那一刻 judge.requests=${judgeRequestsAtCbc}（应为 1；为 0 说明判定跑在基线之后）`)
  check('因此那一刻第一层确实按 Jev 裁了，而不是 fallback 到体积规则',
    (cbcObserved?.pruned?.length ?? 0) > 0,
    `pruneSession 裁了 ${cbcObserved?.pruned?.length ?? 0} 条（0 = 判定 cache 为空、已退化为体积规则）`)
  check('第一层替换 seq 后，第二层仍能沿 sourceEventSeqs 找回判定并压缩',
    compaction.calls.length > 0,
    `第二层压缩 ${compaction.calls.length} 段（0 = replacement seq 使缓存失效）`)
}

// ---------- N. 第二层被 skip 时必须落盘原因（可观测缺口） ----------
// 此前只有**成功**路径与 catch 会写 stats.lastCompactNote，被 skip 的 pass 一律不写
// → 心跳与状态报告里留着上一轮的旧值，"第二层为什么没动"恰好是唯一看不见的东西。
// 跑批端实测踩到：只能看到 compactSkipped=4，不知道原因。两条路径都要钉住：
//   ① 有 selection 的 blocked（带逐条排除计数）
//   ② 无 selection 的 blocked（极早退）
{
  // ① compactMinChars 设成不可能达到的值 → 所有范围都被 skippedShort 掉 → ranges 为空
  const pruner = makePruner()
  const session = makeSession()
  const compaction = makeCompaction(session)
  const ctx = makeCtx({ pruner, session, compaction })
  const resultSeqs = session.surface.nodes.filter((q) => session.eventAt(q)?.type === 'tool/result')
  const probs = Object.fromEntries(resultSeqs.map((q) => [q, 0.05]))
  const judge = fakeJudge(probs, probs)
  mod.apply(ctx, {
    ...PLUGIN_CFG,
    compactOn: 'always',
    compactQuantile: 1,
    minCandidatesForRelative: 3,
    compactMinChars: 999999, // 任何范围都达不到 → 全被 skippedShort
  }, { judge })
  const agentRef = { agent: { session, options: {} } }
  await ctx.waterfall('agent/pre-step', agentRef, () => {})
  const statusTool = ctx.registeredTools.find((t) => t?.name === 'jev_prune_status')
  const txt = String(await statusTool.execute({}, agentRef))
  const layer2 = txt.split('\n').find((l) => /最近（第二层）/.test(l)) ?? ''

  check('第二层被 skip 时原因必须落盘（此前只在成功路径写）',
    /没有合格的连续只读步骤段/.test(layer2), layer2.trim() || '（没有第二层记录 = 又回到静默）')
  check('blocked 时还要带上 selection 的逐条排除计数与合格步数',
    /short:1/.test(layer2) && /eligible:3/.test(layer2),
    layer2.trim() || '（缺排除计数）')

  // ② 极早退（compactReceipts=false，selection 为 null）同样要留痕
  const pruner2 = makePruner()
  const session2 = makeSession()
  const compaction2 = makeCompaction(session2)
  const ctx2 = makeCtx({ pruner: pruner2, session: session2, compaction: compaction2 })
  const judge2 = fakeJudge({}, {})
  mod.apply(ctx2, { ...PLUGIN_CFG, compactReceipts: false }, { judge: judge2 })
  const agentRef2 = { agent: { session: session2, options: {} } }
  await ctx2.waterfall('agent/pre-step', agentRef2, () => {})
  const txt2 = String(await ctx2.registeredTools.find((t) => t?.name === 'jev_prune_status').execute({}, agentRef2))
  const layer2b = txt2.split('\n').find((l) => /最近（第二层）/.test(l)) ?? ''
  check('极早退的 blocked 也要落盘（compactReceipts=false）',
    /compactReceipts=false/.test(layer2b), layer2b.trim() || '（没有第二层记录）')
}

// ---------- O. 两层最近区必须真正独立（compactPreserveRecent 接线回归） ----------
// 只把配置写进 schema / 状态页还不够：判定缓存若仍按第一层 preserveRecent 截断，
// 第二层即使配置 compactPreserveRecent=0，也永远拿不到最近节点的两轴概率。
// 这里保持第一层最近 4 个 surface 节点（恰好挡住最后一个 tool/result），再让第二层
// 保留 0 个；判定范围应扩到两层里更小的窗口，因此 3 条结果都要被判定。
{
  const judgedWith = async (compactReceipts, plan, overrides = {}) => {
    const pruner = makePruner()
    const session = makeSession(plan)
    const compaction = makeCompaction(session)
    const ctx = makeCtx({ pruner, session, compaction })
    const resultSeqs = session.surface.nodes.filter((q) => session.eventAt(q)?.type === 'tool/result')
    const probs = Object.fromEntries(resultSeqs.map((q) => [q, 0.05]))
    const judge = fakeJudge(probs, probs)
    mod.apply(ctx, {
      ...PLUGIN_CFG,
      dryRun: true,
      preserveRecent: 4,
      compactReceipts,
      compactOn: 'always',
      compactPreserveRecent: 0,
      ...overrides,
    }, { judge })
    const agentRef = { agent: { session, options: {} } }
    await ctx.waterfall('agent/pre-step', agentRef, () => {})
    const statusTool = ctx.registeredTools.find((t) => t?.name === 'jev_prune_status')
    const statusText = String(await statusTool.execute({}, agentRef))
    return Number(/第一层：判定 (\d+) 次/.exec(statusText)?.[1] ?? -1)
  }

  const firstLayerOnly = await judgedWith(false)
  const bothLayers = await judgedWith(true)
  check('前提：第一层 preserveRecent=4 时只判定最早的 1 条结果',
    firstLayerOnly === 1, `实际 ${firstLayerOnly}`)
  check('compactPreserveRecent=0 会把判定范围扩到全部 3 条结果',
    bothLayers === 3, `实际 ${bothLayers}（若仍为 2，说明配置只展示了但没有接线）`)

  const relativeDisabled = await judgedWith(true, undefined, { compactQuantile: 0 })
  check('compactQuantile=0 显式关闭选择时不为第二层扩候选付费',
    relativeDisabled === firstLayerOnly,
    `实际判定 ${relativeDisabled} 条（第一层自身只需 ${firstLayerOnly} 条）`)

  const absoluteDisabled = await judgedWith(true, undefined, {
    compactMode: 'absolute',
    compactThreshold: 0,
  })
  check('absolute 阈值=0 时不为不可能命中的第二层扩候选付费',
    absoluteDisabled === firstLayerOnly,
    `实际判定 ${absoluteDisabled} 条（第一层自身只需 ${firstLayerOnly} 条）`)

  const manualOnly = await judgedWith(true, undefined, { compactOn: 'off' })
  check("compactOn='off' 仍预取第二层两轴，保证 jev_compact_now(force) 可用",
    manualOnly === bothLayers,
    `实际判定 ${manualOnly} 条（手动压缩需要 ${bothLayers} 条）`)

  const mixedTools = await judgedWith(true, [
    { tool: 'Read', args: { file_path: 'a.ts' }, chars: 3000 },
    { tool: 'pwsh', args: { command: 'Get-Content b.ts' }, chars: 3000 },
    { tool: 'Read', args: { file_path: 'c.ts' }, chars: 3000 },
  ])
  check('第二层扩展判定窗口时不为白名单外工具付费',
    mixedTools === 2,
    `实际判定 ${mixedTools} 条（期望仅两条 Read；若为 3，pwsh 仍在空转）`)

  const layerSpecificBlacklist = await judgedWith(true, undefined, { neverPruneTools: ['Read'] })
  check('第一层 neverPruneTools 不得误关第二层允许的 Read 判定',
    layerSpecificBlacklist === 3,
    `实际判定 ${layerSpecificBlacklist} 条（期望 3；为 0 说明两层黑名单仍耦合）`)
}

// ---------- P. 会话恢复后，已裁 replacement 仍可重新进入第二层 ----------
// decisions 是 WeakMap 内存缓存；插件/宿主重启后缓存为空，但 session 日志和 surface 会恢复。
// 若第二层沿用第一层的“带裁剪标记就不再判定”，这些旧 replacement 将永久失去 verdict。
{
  const session = makeSession()

  // 第一实例先完成判定与第一层裁剪，制造带 sourceEventSeqs 的 replacement。
  const pruner1 = makePruner()
  const compaction1 = makeCompaction(session)
  const ctx1 = makeCtx({ pruner: pruner1, session, compaction: compaction1 })
  const originalResults = session.surface.nodes.filter((seq) => session.eventAt(seq)?.type === 'tool/result')
  const firstProbs = Object.fromEntries(originalResults.map((seq) => [seq, 0.05]))
  mod.apply(ctx1, { ...PLUGIN_CFG, compactReceipts: false }, { judge: fakeJudge(firstProbs, firstProbs) })
  const agentRef1 = { agent: { session, options: {} } }
  await ctx1.waterfall('agent/pre-step', agentRef1, () => {})
  pruner1.pruneSession(session)
  const replacements = session.surface.nodes.filter((seq) =>
    (session.eventAt(seq)?.sourceEventSeqs?.length ?? 0) > 0
    && session.eventAt(seq)?.type === 'tool/result')
  check('前提：第一实例已产生带 sourceEventSeqs 的裁剪 replacement',
    replacements.length > 0, `实际 ${replacements.length}`)

  // 第二实例模拟重启：新的 apply() 拥有全新的 decisions WeakMap。
  const pruner2 = makePruner()
  const compaction2 = makeCompaction(session)
  const ctx2 = makeCtx({ pruner: pruner2, session, compaction: compaction2 })
  const currentResults = session.surface.nodes.filter((seq) => session.eventAt(seq)?.type === 'tool/result')
  const secondProbs = Object.fromEntries(currentResults.map((seq) => [seq, 0.05]))
  const judge2 = fakeJudge(secondProbs, secondProbs)
  mod.apply(ctx2, {
    ...PLUGIN_CFG,
    compactOn: 'always',
    compactQuantile: 1,
    compactPreserveRecent: 0,
  }, { judge: judge2 })
  await ctx2.waterfall('agent/pre-step', { agent: { session, options: {} } }, () => {})

  check('重启后会重新判定已裁 replacement（缓存为空也不会永久跳过）',
    judge2.requests > 0, `实际请求 ${judge2.requests} 次`)
  check('重启后已裁 replacement 能继续进入第二层回执压缩',
    compaction2.calls.length > 0, `实际压缩 ${compaction2.calls.length} 段`)
}

// ---------- Q. 部分判定缓存不得让缺失轴永久饿死 ----------
// 第一次只返回 result 轴，cache 已有 entry 但 effectProb=null；第二次必须继续问。
// 旧逻辑只看 cache.has(seq)，会从此把它当成 fresh=false，第二层永远拿不到两轴交集。
{
  const pruner = makePruner()
  const session = makeSession()
  const compaction = makeCompaction(session)
  const ctx = makeCtx({ pruner, session, compaction })
  // 复刻 compaction-basic：判定后立刻调用第一层，使两轮之间发生 old seq → replacement seq。
  ctx.on('agent/pre-step', async ({ agent }, next) => {
    pruner.pruneSession(agent.session)
    return next()
  })
  const judge = {
    ready: true,
    requests: 0,
    asked: [],
    retries: 0,
    lastRetries: 0,
    lastError: '',
    usage: { input_tokens: 0, output_tokens: 0 },
    batch: (_state, questions) => [questions],
    async ask(_state, questions) {
      this.requests += 1
      this.asked.push(Object.keys(questions))
      const out = {}
      for (const id of Object.keys(questions)) {
        if (this.requests === 1 && id.startsWith('result_s')) out[id] = 0.05
        if (this.requests >= 2 && id.startsWith('effect_s')) out[id] = 0.05
      }
      return out
    },
  }
  mod.apply(ctx, {
    ...PLUGIN_CFG,
    compactOn: 'always',
    compactQuantile: 1,
    compactPreserveRecent: 0,
  }, { judge })
  const agentRef = { agent: { session, options: {} } }
  await ctx.waterfall('agent/pre-step', agentRef, () => {})
  check('前提：第一轮只有单轴时第二层不能压缩',
    compaction.calls.length === 0, `实际压缩 ${compaction.calls.length} 段`)
  check('前提：两轮之间第一层确实把结果替换成了新 seq',
    session.surface.nodes.some((seq) => (session.eventAt(seq)?.sourceEventSeqs?.length ?? 0) > 0),
    'surface 上没有 replacement，测不到跨 seq 补轴')
  await ctx.waterfall('agent/pre-step', agentRef, () => {})
  check('缺失 effect 轴的缓存项会在下一轮继续请求',
    judge.requests === 2, `实际请求 ${judge.requests} 次`)
  check('补轴请求只问缺失的 effect，不重复询问已有 result',
    judge.asked[1]?.length > 0
      && judge.asked[1].every((id) => id.startsWith('effect_s')),
    `第二轮题号 ${JSON.stringify(judge.asked[1] ?? [])}`)
  check('补齐第二轴后第二层可以继续压缩',
    compaction.calls.length > 0, `实际压缩 ${compaction.calls.length} 段`)
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
