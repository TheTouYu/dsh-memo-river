#!/usr/bin/env node
/**
 * acceptance.mjs — DESIGN.md §10 的验收判据，逐条实测（#1–#10 对应 §10，#11 为闭环补测）。
 *
 * 设计原则：
 *  · **不接受「看起来对」**——每条判据都打印实测值（排名、hash、fallbackReason、时钟、日志行）；
 *  · 走**插件真实入口**（`apply()` + 真实 seam 监听器 + 真实 workspace/native/DB），
 *    只把 Cordis Context 与 Agent 换成可测的最小替身（不 mock 被测逻辑本身）；
 *  · 判据 #9 是**真实故障注入**（不仅打桩）：先打真死端点，再打桩模拟断网穿过 seam。
 *
 * 用法：node scripts/acceptance.mjs
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { apply, Config as ConfigSchema, FIXED_CONTRACT_SHA256, FIXED_CONTRACT_TEXT } from '../lib/index.js'
import { healthReport } from '../lib/health.js'
import { acquireWorkspace } from '../lib/workspace.js'
import { workspacePaths } from '../lib/runtime.js'
import { EmbedClient, cosine } from '../lib/embed.js'
import { buildQueryField } from '../lib/recall.js'
import { peekSession } from '../lib/session.js'
import { BLOCK_CLOSE, BLOCK_OPEN } from '../lib/render.js'

const ROOT = new URL('..', import.meta.url).pathname
const VCP = '/home/h/app/VCPToolBox'
const WS_RIVER = join(ROOT, '.selftest', '教室建模归档')
const WS_ISLAND = join(ROOT, '.selftest', '教室建模孤岛')
const WS_WRITE = join(ROOT, '.selftest', '教室建模写入测试')
const BUCKET_RIVER = '教室建模归档'
const BUCKET_ISLAND = '教室建模孤岛'
const BUCKET_WRITE = '教室建模写入测试'

const results = []
const line = (s = '') => console.log(s)
const hr = (t) => line('\n' + '═'.repeat(96) + (t ? `\n${t}` : '') + '\n' + '═'.repeat(96))

function check(id, title, pass, evidence) {
  results.push({ id, title, pass })
  line(`\n【验收 #${id}】${title}  →  ${pass ? '✅ PASS' : '❌ FAIL'}`)
  for (const e of [].concat(evidence)) line(`    ${e}`)
}

/* ══════════════════════ 最小 Cordis / Agent 替身 ══════════════════════ */

function createMockCtx() {
  const listeners = new Map()
  const registered = { sections: [], contexts: [], tools: [] }
  const disposers = []
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    on(event, fn, opts) {
      const list = listeners.get(event) ?? []
      const entry = { fn, opts }
      if (opts?.prepend) list.unshift(entry)
      else list.push(entry)
      listeners.set(event, list)
      return () => {
        const i = list.indexOf(entry)
        if (i >= 0) list.splice(i, 1)
      }
    },
    effect(cb) {
      const d = cb()
      disposers.push(d)
      return () => {
        try {
          d?.()
        } catch {
          /* 静默 */
        }
      }
    },
    systemPrompt: {
      section(s) {
        registered.sections.push(s)
        return () => registered.sections.splice(registered.sections.indexOf(s), 1)
      },
      context(c) {
        registered.contexts.push(c)
        return () => registered.contexts.splice(registered.contexts.indexOf(c), 1)
      },
    },
    tools: {
      register(t) {
        registered.tools.push(t)
        return () => {}
      },
    },
    get() {
      return undefined
    },
    interval(fn, ms) {
      const h = setInterval(fn, ms)
      h.unref?.()
      return () => clearInterval(h)
    },
  }
  return { ctx, listeners, registered, dispose: () => disposers.forEach((d) => { try { d?.() } catch { /* 静默 */ } }) }
}

const textMsg = (role, text) => ({ role, content: [{ type: 'text', text }], source: { kind: role === 'user' ? 'user' : 'model' } })
/** DSH 的 “Current runtime context” 快照是 plugin 源（不是用户输入）——查询场过滤器必须排除它。 */
const pluginMsg = (text, plugin = 'runtime-context') => ({ role: 'user', content: [{ type: 'text', text }], source: { kind: 'plugin', plugin, form: 'snapshot' } })

/**
 * 会话日志模型 —— **必须复现真实时序**：
 *   `preStep()`（dsh-agent-loop/lib/index.js:884-905）先把 claimed 交给瀑布；
 *   `decision.messages` 是在 `step()` 里才 append 进日志的（同文件 :1028）。
 *   ∴ pre-step 瀑布期间 `deriveMessages()` **看不到本轮 claimed**。
 *   第三个参数 = **本轮之前**的日志；claimed 由 runPreStep 传入。
 */
function createAgent(sessionId, cwd, priorLog = []) {
  const log = [...priorLog]
  return { session: { id: sessionId, header: { cwd }, deriveMessages: () => log }, log }
}

/** 模拟一轮 pre-step：把该事件的监听器串成 waterfall，终点 = harness 默认决策。step 缺省 1（回合首发）。 */
async function runPreStep(h, agent, turn, claimed, step = 1) {
  // 不变量：本轮 claimed 在真实 loop 里绝不会已经在日志中。测试台必须一致——
  // 否则「pre-step 读不到当前消息」这类 bug 会被 mock 掩盖（第一次试运行真的被掩盖了）。
  for (const m of claimed) {
    if (agent.log.includes(m)) {
      throw new Error(
        `harness-invariant-violated: turn=${turn} 的 claimed 消息已存在于会话日志；` +
          `真实 loop 在 pre-step 期间看不到本轮消息，测试台不得把当前消息塞进 history`,
      )
    }
  }
  const list = h.listeners.get('agent/pre-step') ?? []
  const runtimeContext = pluginMsg('Current runtime context. This snapshot supersedes earlier runtime-context snapshots.')
  let next = async () => ({ kind: 'enter', messages: [...claimed, runtimeContext] })
  for (let i = list.length - 1; i >= 0; i--) {
    const fn = list[i].fn
    const downstream = next
    next = () => fn({ agent, messages: claimed, turn, step, signal: { aborted: false } }, downstream)
  }
  const decision = await next()
  // 模拟 step() 的落盘：decision.messages 此刻才进日志（本轮 user + runtime context + 注入块）。
  if (decision?.kind === 'enter') agent.log.push(...decision.messages)
  return decision
}

/** 模拟一次 llm/stream 派发（终点返回一个哨兵，用于证明 next() 被委托）。 */
function runLlmStream(h, options) {
  const list = h.listeners.get('llm/stream') ?? []
  let next = () => 'DELEGATED-TO-ADAPTER'
  for (let i = list.length - 1; i >= 0; i--) {
    const fn = list[i].fn
    const downstream = next
    next = () => fn(options, downstream)
  }
  return next()
}

const msgText = (m) => (m?.content ?? []).map((b) => b.text ?? '').join('\n')

function makeConfig(overrides = {}) {
  const cfg = ConfigSchema({ bucket: '', native: { vcpRoot: VCP }, ...overrides })
  /* 嵌入超时预算：生产缺省 3s 是降级护栏（慢了宁可跳过注入），不是验收要量的对象。
   * 验收环境连跑/铺库/查询共用同一 embed 代理，缓存未命中的真实往返偶发超 3s
   * （2026-09-28 桶日志实锤：#16 step2 embed-timeout elapsedMs=3002、#11 同型）——
   * 那测的是 embed 服务抖动而非插件逻辑。抬到 10s，显式 override 仍优先。 */
  cfg.inject.embedTimeoutMs = overrides.inject?.embedTimeoutMs ?? 10_000
  return cfg
}

/* ══════════════════════ 环境自检 ══════════════════════ */

hr('环境自检')
const dbPathOf = (cwd, bucket) => workspacePaths(cwd, bucket).dbPath
for (const [name, cwd, bucket] of [
  ['河流语料工作区', WS_RIVER, BUCKET_RIVER],
  ['孤岛语料工作区', WS_ISLAND, BUCKET_ISLAND],
  ['写入测试工作区', WS_WRITE, BUCKET_WRITE],
]) {
  const p = dbPathOf(cwd, bucket)
  if (!existsSync(p)) {
    console.error(
      `❌ 缺少 ${name}：${p}\n` +
        `   先跑：\n` +
        `     node scripts/import-dailynote.mjs --force --src /home/h/app/VCPToolBox/dailynote/教室建模归档 --cwd ${WS_RIVER} --bucket ${BUCKET_RIVER}\n` +
        `     node scripts/build-island-corpus.mjs\n` +
        `     node scripts/import-dailynote.mjs --force --src ${join(ROOT, '.selftest', 'island-corpus')} --cwd ${WS_ISLAND} --bucket ${BUCKET_ISLAND}\n` +
        `   （或直接跑 node scripts/setup-selftest.mjs 一键铺好三个工作区）`,
    )
    process.exit(2)
  }
}
line(`node=${process.version}`)
line(`河流语料：cwd=${WS_RIVER}`)
line(`          db=${dbPathOf(WS_RIVER, BUCKET_RIVER)}`)
line(`孤岛语料：cwd=${WS_ISLAND}`)
line(`          db=${dbPathOf(WS_ISLAND, BUCKET_ISLAND)}`)

const config = makeConfig()
const h = createMockCtx()
apply(h.ctx, config)

line(`\n注册的 systemPrompt 段：${h.registered.sections.map((s) => s.name).join(', ') || '(无)'}`)
line(`注册的 systemPrompt 上下文：${h.registered.contexts.map((c) => c.name).join(', ') || '(无)'}`)
line(`注册的工具：${h.registered.tools.map((t) => t.name ?? '(anonymous)').join(', ')}`)

/* ══════════════════════ #2 前缀缓存不破 ══════════════════════ */

hr('#2 前缀缓存不破（system 段零动态）')
{
  const designText = (() => {
    const md = readFileSync(join(ROOT, 'DESIGN.md'), 'utf8')
    const a = md.indexOf('### 6.1 system 段固定文本')
    const s = md.indexOf('```', a)
    const e = md.indexOf('```', s + 3)
    return md.slice(s + 3, e).replace(/^\n/, '').replace(/\n$/, '')
  })()
  const registered = h.registered.sections[0]?.text ?? ''
  const sha = (t) => createHash('sha256').update(t, 'utf8').digest('hex')
  const dynamic = /\{\{|20\d\d-\d\d-\d\d|\d{2}:\d{2}/.test(registered)

  // 连续两轮：分别取 llm/stream 观测到的 system 段 hash
  const history = [textMsg('user', '第一轮问题：渲染卡顿'), textMsg('assistant', '第一轮回答')]
  const agent = createAgent('sess-hash', WS_RIVER, history)
  const hashes = []
  for (let turn = 1; turn <= 2; turn++) {
    const decision = await runPreStep(h, agent, turn, [textMsg('user', `第 ${turn} 轮问题`)])
    const system = { role: 'system', content: [{ type: 'text', text: registered }], source: { kind: 'plugin', plugin: 'harness' } }
    runLlmStream(h, { messages: [system, ...decision.messages], sessionId: 'sess-hash' })
    hashes.push(sha(registered))
  }
  const pass =
    registered === FIXED_CONTRACT_TEXT &&
    registered === designText &&
    FIXED_CONTRACT_SHA256 === sha(registered) &&
    hashes[0] === hashes[1] &&
    !dynamic
  check(2, '前缀缓存不破（system 段文本 hash 相等）', pass, [
    `与 DESIGN.md §6.1 围栏块逐字一致：${registered === designText}（${Buffer.byteLength(registered, 'utf8')} bytes）`,
    `sha256(注册文本) = ${sha(registered)}`,
    `sha256(DESIGN §6.1) = ${sha(designText)}`,
    `src/prompt.ts 记录的常量 hash = ${FIXED_CONTRACT_SHA256}`,
    `第 1 轮 hash = ${hashes[0]}`,
    `第 2 轮 hash = ${hashes[1]}`,
    `两轮相等：${hashes[0] === hashes[1]}`,
    `含动态痕迹（{{}} / 日期 / 时刻）：${dynamic}`,
  ])
}

/* ══════════════════════ #1 注入时机正确 ══════════════════════ */

hr('#1 注入时机正确（注入块在模型请求的消息数组尾部，且在 assistant 回答之前）')
let riverInjectionText = null
{
  const q = '我这边现在渲染又卡了，上次教室那个是怎么解决的？'
  const history = [textMsg('user', '（上一轮的临时提问，用于占位历史）'), textMsg('assistant', '（上一轮的临时回答，用于占位历史）')]
  const agent = createAgent('sess-timing', WS_RIVER, history)
  const decision = await runPreStep(h, agent, 1, [textMsg('user', q)])
  const req = {
    messages: [
      { role: 'system', content: [{ type: 'text', text: h.registered.sections[0].text }], source: { kind: 'plugin', plugin: 'harness' } },
      ...decision.messages,
    ],
    sessionId: 'sess-timing',
  }
  const streamResult = runLlmStream(h, req)

  const tail = req.messages[req.messages.length - 1]
  const tailText = msgText(tail)
  const idx = req.messages.findIndex((m) => msgText(m).includes(BLOCK_CLOSE))
  const assistantAfter = idx < 0 ? null : req.messages.slice(idx + 1).some((m) => m.role === 'assistant')
  riverInjectionText = tailText

  check(
    1,
    '注入块出现在请求消息数组尾部且在 assistant 回答之前',
    idx === req.messages.length - 1 && assistantAfter === false && streamResult === 'DELEGATED-TO-ADAPTER',
    [
      `请求 messages 总数 = ${req.messages.length}（最后一条 role=${tail.role}）`,
      `注入块下标 = ${idx}（尾部下标 = ${req.messages.length - 1}）`,
      `块之后是否还有 assistant 消息 = ${assistantAfter}`,
      `llm/stream 终点是否被 next() 委托到 = ${streamResult}`,
      `注入块 sha256 = ${createHash('sha256').update(tailText).digest('hex').slice(0, 32)}…`,
      `注入块首行：${tailText.split('\n')[0]}`,
    ],
  )
}

/* ══════════════════════ #4 证据分级透出 ══════════════════════ */

hr('#4 证据分级透出（role / 奖励 / Ω / regime）')
{
  const t = riverInjectionText ?? ''
  const hasRole = /role=(direct_answer|structural_explanation|thematic_neighbor|atomic_concept|unranked)/.test(t)
  const hasOmega = /Ω=[\d.]+/.test(t)
  const hasRegime = /\b(sparse|dense)\b/.test(t)
  const hasReward = /(anchor=\+\d|topology=\+\d|reward=(none|suppressed))/.test(t)
  check(4, '注入文本含 role= 与 Ω=/regime=', hasRole && hasOmega && hasRegime && hasReward, [
    `role= 出现：${hasRole}`,
    `Ω= 出现：${hasOmega}`,
    `regime(sparse|dense) 出现：${hasRegime}`,
    `奖励字段出现：${hasReward}`,
  ])
}

/* ══════════════════════ #5 未注入说明存在 ══════════════════════ */

hr('#5 未注入说明存在')
{
  const t = riverInjectionText ?? ''
  const hasLine = t.includes('本次未注入')
  check(5, '有候选被截断时注入块末行含「本次未注入」', hasLine, [
    `含「本次未注入」：${hasLine}`,
    `尾行：${t.split('\n').filter((l) => l.includes('未注入')).join(' | ') || '(无)'}`,
  ])
}

/* ══════════════════════ #3 门控生效 ══════════════════════ */

hr('#3 门控生效（无关查询不注入 + fallbackReason）')
{
  const ws = acquireWorkspace(WS_RIVER, config)
  const opt = (qid, gateText) => ({
    mode: 'topology_v3', k: 3, tokenBudget: 600, dynamicK: 1, gate: true,
    gateThreshold: config.inject.gateThreshold, minKnnForReward: config.inject.minKnnForReward,
    queryId: qid, gateText,
  })

  /* ── (a) 单条消息会话（原判据口径） ── */
  const q = '今天天气'
  const agent = createAgent('sess-gate', WS_RIVER, [])
  const decision = await runPreStep(h, agent, 1, [textMsg('user', q)])
  const injected = decision.messages.some((m) => msgText(m).includes(BLOCK_CLOSE))

  const logs = []
  const off = ws.logger.onLine((l) => logs.push(l))
  const agent2 = createAgent('sess-gate-2', WS_RIVER, [])
  await runPreStep(h, agent2, 1, [textMsg('user', q)])
  off()
  const skipLine = logs.find((l) => l.includes('inject-skip')) ?? ''

  const outcome = await ws.recall(q, opt('acc3a', q))

  /* ── (b) 多轮历史 + 无关末轮（**真实会话的形态**；原判据漏掉的正是这一档） ──
   * 检索向量会被前几轮话题稀释 → maxKnn 抬高到阈值以上；门控向量只取当前消息 → 仍然拦住。 */
  const HIST = [
    textMsg('user', '教室那个桌子在建好的场景里一直往上飘，重力参数是对的。'),
    textMsg('assistant', '先别调重力，查父子级和坐标系是不是被反转了。'),
    textMsg('user', '确实有继承，改完还是飘，只是方向变成往下了。'),
    textMsg('assistant', '那是反转点找错了一层，把 world chain 的 world matrix 逐层打出来比对。'),
    textMsg('user', '好，我去把矩阵打出来。'),
  ]
  const NEG = '今天天气怎么样？'
  const agentH = createAgent('sess-gate-hist', WS_RIVER, [...HIST])
  const decisionH = await runPreStep(h, agentH, 1, [textMsg('user', NEG)])
  const injectedH = decisionH.messages.some((m) => msgText(m).includes(BLOCK_CLOSE))

  const recentH = [...HIST.map(msgText), NEG]
  const queryFieldH = buildQueryField(recentH, config.inject.queryLookback)
  const hist = await ws.recall(queryFieldH, opt('acc3b', NEG))            // 修好之后
  const histOld = await ws.recall(queryFieldH, opt('acc3b-old', ''))      // 退回旧行为（门控看检索向量）

  const pass =
    !injected &&
    outcome.fallbackReason === 'gate-below-threshold' &&
    !injectedH &&
    hist.fallbackReason === 'gate-below-threshold'

  check(3, '无关查询 → 不注入，且带 fallbackReason（单条 + 多轮历史两档）', pass, [
    `(a) 单条消息：注入=${injected}  fallbackReason=${outcome.fallbackReason}`,
    `    门控 maxKnn=${outcome.gate.maxKnn.toFixed(4)} < ${outcome.gate.threshold}（gateVector=${outcome.gate.gateVector}）`,
    `    日志行：${skipLine || '(未捕获)'}`,
    `(b) 多轮历史：注入=${injectedH}  fallbackReason=${hist.fallbackReason}`,
    `    gateVector=${hist.gate.gateVector}  门控 maxKnn=${hist.gate.maxKnn.toFixed(4)}（当前消息向量）`,
    `    检索 maxKnn=${hist.gate.retrievalMaxKnn.toFixed(4)}（窗口向量，已被前几轮稀释）`,
    `    ← 解耦前（gateText=''）：检索 maxKnn=${histOld.gate.maxKnn.toFixed(4)} ≥ ${histOld.gate.threshold} → ` +
      `${histOld.fallbackReason === 'gate-below-threshold' ? '拦住' : '**误通过**'}（这就是原判据漏掉的那档）`,
  ])
}

/* ══════════════════════ #9 不阻塞主流程 ══════════════════════ */

hr('#9 不阻塞主流程（拔掉嵌入 API）')
{
  // 9a 真死端点
  const ws = acquireWorkspace(WS_RIVER, config)
  const dead = new EmbedClient({
    apiUrl: 'http://127.0.0.1:9', apiKey: 'x', model: 'gemini-embedding-2-preview',
    dimension: 3072, cachePath: '/tmp/memo-river-dead-embed.json', timeoutMs: 3000,
  })
  const t0 = Date.now()
  let deadErr = null
  let vecs = null
  try {
    vecs = await dead.embed(['断网测试文本'])
  } catch (e) {
    deadErr = String(e.message ?? e)
  }
  const deadMs = Date.now() - t0
  line(`  9a 真死端点 http://127.0.0.1:9 → ${deadMs}ms 抛错：${deadErr}`)
  line(`     返回向量：${vecs ? '有（不该有）' : '无（符合预期）'}`)

  // 9b 穿过 seam：打桩让嵌入失败，断言不阻塞 + 记日志 + decision 原样返回
  const original = ws.embed.embed
  ws.embed.embed = async () => {
    throw new Error('ENETUNREACH 127.0.0.1:9 (simulated outage)')
  }
  const logs = []
  const off = ws.logger.onLine((l) => logs.push(l))
  const q = '我这边现在渲染又卡了，上次教室那个是怎么解决的？'
  const agent = createAgent('sess-outage', WS_RIVER, [])
  const claimed = [textMsg('user', q)]
  const t1 = Date.now()
  let decision = null
  let threw = null
  try {
    decision = await runPreStep(h, agent, 1, claimed)
  } catch (e) {
    threw = String(e.message ?? e)
  }
  const seamMs = Date.now() - t1
  off()
  ws.embed.embed = original

  const appended = decision ? decision.messages.length - claimed.length : -1
  const skipLine = logs.find((l) => l.includes('inject-skip')) ?? ''
  const pass = deadErr !== null && vecs === null && threw === null && appended === 1 && skipLine.includes('embed-failed')
  check(9, '嵌入不可用 → 注入跳过 + 记日志，主流程正常返回', pass, [
    `9a 真死端点抛错：${deadErr}`,
    `9a 耗时 ${deadMs}ms（未挂起）`,
    `9b seam 未抛异常：${threw === null}（异常=${threw}）`,
    `9b decision 额外追加的消息数 = ${appended}（1 = 只追加了 harness 的 runtime-context，插件没追加注入块）`,
    `9b seam 耗时 ${seamMs}ms`,
    `9b 日志行：${skipLine || '(未捕获)'}`,
  ])
}

/* ══════════════════════ #10 并发隔离 ══════════════════════ */

hr('#10 并发隔离（按 session id 键，无全局 lastXxx）')
{
  const qRiver = '我这边现在渲染又卡了，上次教室那个是怎么解决的？'
  const agentA = createAgent('sess-A', WS_RIVER, [])
  const agentB = createAgent('sess-B', WS_RIVER, [])
  const [decA, decB] = await Promise.all([
    runPreStep(h, agentA, 1, [textMsg('user', qRiver)]),
    runPreStep(h, agentB, 1, [textMsg('user', '那个视频到底是怎么做到真 60 帧的？编码卡在哪一步？')]),
  ])
  const textA = decA.messages.map(msgText).find((t) => t.includes(BLOCK_CLOSE)) ?? ''
  const textB = decB.messages.map(msgText).find((t) => t.includes(BLOCK_CLOSE)) ?? ''
  const idsOf = (t) => [...t.matchAll(/^D(\d+)「/gm)].map((m) => Number(m[1]))
  const idsA = idsOf(textA)
  const idsB = idsOf(textB)

  // 跨工作区并发：A 在河流桶、C 在孤岛桶
  const agentC = createAgent('sess-C', WS_ISLAND, [])
  const decC = await runPreStep(h, agentC, 1, [textMsg('user', qRiver)])
  const textC = decC.messages.map(msgText).find((t) => t.includes(BLOCK_CLOSE)) ?? ''
  const bucketOf = (t) => (t.match(/本桶=([^\s|]+)/) ?? [])[1] ?? '(无)'

  // 关键不变量：**并发结果必须等于串行结果**。
  // 这条曾经真红过——两个会话同时召回时，A 的 ensureArtifact 与 B 的 runMemoPipeline 交错，
  // 重建顶掉了 B 手里的 artifactSig，Rust 侧报
  //   `memo runtime artifact <sig> is not the active generation`
  // 于是 B 静默不注入（fallbackReason 才是唯一线索）。修法是 MemoEngine 的引擎级串行队列
  // （runExclusive / ensureArtifactLocked），见 src/native.ts 的注释。
  const serialA = await runPreStep(h, createAgent('sess-A2', WS_RIVER, []), 1, [textMsg('user', qRiver)])
  const serialB = await runPreStep(
    h,
    createAgent('sess-B2', WS_RIVER, []),
    1,
    [textMsg('user', '那个视频到底是怎么做到真 60 帧的？编码卡在哪一步？')],
  )
  const idsOfSerial = (dec) => idsOf(dec.messages.map(msgText).find((t) => t.includes(BLOCK_CLOSE)) ?? '')
  const sameAsSerial = JSON.stringify(idsA) === JSON.stringify(idsOfSerial(serialA)) &&
    JSON.stringify(idsB) === JSON.stringify(idsOfSerial(serialB))

  const pass =
    textA.length > 0 && textB.length > 0 &&
    JSON.stringify(idsA) !== JSON.stringify(idsB) &&
    sameAsSerial &&
    bucketOf(textC) === BUCKET_ISLAND && bucketOf(textA) === BUCKET_RIVER
  check(10, '两会话同时注入互不串（含跨工作区），且并发 == 串行', pass, [
    `sess-A 本桶=${bucketOf(textA)} 候选=[${idsA.join(',')}]`,
    `sess-B 本桶=${bucketOf(textB)} 候选=[${idsB.join(',')}]`,
    `sess-A ≠ sess-B 的候选序列：${JSON.stringify(idsA) !== JSON.stringify(idsB)}`,
    `并发 == 串行（同一查询、同一桶，逐名次比对）：${sameAsSerial}`,
    `  串行 A=[${idsOfSerial(serialA).join(',')}] B=[${idsOfSerial(serialB).join(',')}]`,
    `sess-C（孤岛工作区）本桶=${bucketOf(textC)} 候选=[${idsOf(textC).join(',')}]`,
    `会话状态按 session id 键：sess-A/B/C 三条独立记录（Map<sessionId, SessionState>）`,
  ])
}

/* ══════════════════════ #7 体检抓孤岛 ══════════════════════ */

hr('#7 体检抓孤岛（孤岛语料必须报连通分量 11）')
{
  const wsIsland = acquireWorkspace(WS_ISLAND, config)
  const report = healthReport(wsIsland.store, BUCKET_ISLAND)
  const wsRiver = acquireWorkspace(WS_RIVER, config)
  const riverReport = healthReport(wsRiver.store, BUCKET_RIVER)
  const pass = report.components === 11 && riverReport.components === 1
  check(7, '孤岛语料 → 连通分量 11 警告；河流语料 → 1', pass, [
    `孤岛桶「${BUCKET_ISLAND}」：连通分量 = ${report.components}，规模分布 = [${report.componentSizes.join(',')}]`,
    `  规模：${report.counts.files} 篇 / ${report.counts.tags} Tag / ${report.counts.fileTags} 共现`,
    `  告警：${report.warnings.join(' ‖ ') || '(无)'}`,
    `河流桶「${BUCKET_RIVER}」：连通分量 = ${riverReport.components}，规模分布 = [${riverReport.componentSizes.join(',')}]`,
    `  枢纽：${riverReport.hub ? `${riverReport.hub.name} ${riverReport.hub.count}/${riverReport.counts.files} = ${(riverReport.hub.ratio * 100).toFixed(1)}%` : 'n/a'}（判据 <33.3%）`,
    `  未覆盖率：${riverReport.uncovered.neverRecalled}/${riverReport.uncovered.files}`,
  ])
}

/* ══════════════════════ #6 写入契约 ══════════════════════ */

hr('#6 写入契约（memo_write 拒绝条件不静默）')
{
  // 写在**独立副本工作区**里：不污染 #8 的对照语料；且每次**从零开始**——
  // 该工作区跨进程累积的 sqlite WAL/-shm 残留曾稳定触发 vexus-lite SIGBUS
  // （node:sqlite 与 Rust 侧对同一库双开时的 -shm 竞态；2026-09-12 实测：
  // 残留态 3/3 崩、抹掉后连跑 + 15 连写全绿，与数据规模无关）。
  const writePaths = workspacePaths(WS_WRITE, BUCKET_WRITE)
  rmSync(writePaths.root, { recursive: true, force: true })
  rmSync(WS_WRITE, { recursive: true, force: true })
  mkdirSync(WS_WRITE, { recursive: true })
  const ws = acquireWorkspace(WS_WRITE, config)
  const writeTool = h.registered.tools.find((t) => (t.name ?? t.definition?.name) === 'memo_write') ?? h.registered.tools[3]
  const toolName = writeTool.name ?? writeTool.definition?.name
  line(`  memo_write 工具对象字段：${Object.keys(writeTool).join(', ')}`)
  const exec = writeTool.execute?.bind(writeTool) ?? writeTool.handler?.bind(writeTool)
  const execCtx = { agent: createAgent('sess-write', WS_WRITE, []) }

  const noTagLine = await exec({ content: '# 没有 Tag 行的日记\n\n正文。' }, execCtx)
  const tooMany = await exec(
    { content: '# 太多 Tag\n\n正文。\n\nTag: 教室建模, 渲染性能, 资源占用, 环境问题, 因果排查, 交付物' },
    execCtx,
  )
  const newTagNoReason = await exec(
    { content: '# 新概念无理由\n\n正文。\n\nTag: 教室建模, 一个全新的概念, 另一个新概念' },
    execCtx,
  )
  const newTagWithReason = await exec(
    {
      content: '# 新概念有理由\n\n这次引入了一个确实没有过的概念：量子隧穿烘焙。\n\nTag: 教室建模, 量子隧穿烘焙, 因果排查',
      newTagReason: '概念确实变了：引入了此前语料中不存在的量子隧穿烘焙路径',
    },
    execCtx,
  )

  const r1 = noTagLine.includes('missing-tag-line')
  const r2 = tooMany.includes('too-many-tags')
  const r3 = newTagNoReason.includes('unconfirmed-new-tags')
  const r4 = newTagWithReason.includes('✅ 已写入')
  const counts = await ws.readSync(() => ws.store.counts())
  check(6, '无 Tag 行 → 拒绝；新 Tag 无 reason → 拒绝；有 reason → 写入', r1 && r2 && r3 && r4, [
    `① 无 Tag 行 → ${r1 ? '✅ 拒绝' : '❌ 未拒绝'}：${(noTagLine.match(/❌ memo_write 被拒绝：[^\n]*/) ?? ['(无)'])[0]}`,
    `② 6 个 Tag → ${r2 ? '✅ 拒绝' : '❌ 未拒绝'}：${(tooMany.match(/❌ memo_write 被拒绝：[^\n]*/) ?? ['(无)'])[0]}`,
    `③ 新 Tag 无理由 → ${r3 ? '✅ 拒绝' : '❌ 未拒绝'}：${(newTagNoReason.match(/❌ memo_write 被拒绝：[^\n]*/) ?? ['(无)'])[0]}`,
    `④ 新 Tag 有理由 → ${r4 ? '✅ 写入' : '❌ 未写入'}：${(newTagWithReason.match(/✅ 已写入[^\n]*/) ?? ['(无)'])[0]}`,
    `   写前回注行：${(newTagWithReason.match(/【写前回注】[^\n]*/g) ?? []).join(' ⏎ ').slice(0, 240)}`,
    `   桶内规模：${counts.files} 篇 / ${counts.tags} Tag（写入后 +1 篇、+1 Tag）`,
  ])
}

/* ══════ #11 闭环：空库 → 写入 → 被动召回（「生成日志 → 自动召回」那条路） ══════ */

hr('#11 闭环：空库(0 篇) → memo_write 写一篇 → 被动注入把它捞回来')
{
  // 独立临时工作区：从**空库**开始，跑完即删——可重复，且不污染其它判据。
  const LOOP_CWD = join(tmpdir(), `memo-river-loop-${process.pid}`)
  const loopPaths = workspacePaths(LOOP_CWD, '闭环测试')
  rmSync(LOOP_CWD, { recursive: true, force: true })
  rmSync(loopPaths.root, { recursive: true, force: true })
  mkdirSync(LOOP_CWD, { recursive: true })

  const ws = acquireWorkspace(LOOP_CWD, makeConfig({ bucket: '闭环测试' }))
  const logs = []
  const off = ws.logger.onLine((l) => logs.push(l))

  const Q = '缓存击穿到底是怎么解决的？'
  const TITLE = '闭环测试缓存击穿'
  const writeTool = h.registered.tools.find((t) => (t.name ?? t.definition?.name) === 'memo_write')
  const exec = writeTool.execute.bind(writeTool)
  const execCtx = { agent: createAgent('sess-loop-w', LOOP_CWD, []) }

  // ① 写之前：库空 ⇒ 必须**显式**报 empty-corpus，而不是静默不注入（§1 不变量 6）
  const before = await ws.readSync(() => ws.store.counts())
  const d0 = await runPreStep(h, createAgent('sess-loop-a', LOOP_CWD, []), 1, [textMsg('user', Q)])
  const skipLine = logs.filter((l) => l.includes('inject-skip')).pop() ?? '(无 skip 日志)'
  const preReason = (skipLine.match(/reason=([a-z-]+)/) ?? [])[1] ?? null
  const preInjected = d0.messages.map(msgText).some((t) => t.includes(BLOCK_CLOSE))

  // ② 空库 ⇒ 所有 Tag 都是新的 ⇒ 不带 newTagReason 必被拒（DESIGN.md:243 §7.2-3）
  const DIARY =
    `# ${TITLE}\n\n结论：缓存击穿是热点 key 过期瞬间请求全打到数据库。` +
    `用互斥重建 + 逻辑过期两道闸解决。\n\nTag: 闭环测试, 缓存击穿, 并发`
  const noReason = await exec({ content: DIARY }, execCtx)
  const gateOnEmpty = noReason.includes('unconfirmed-new-tags')

  // ③ 带上理由 ⇒ 写入
  const written = await exec({ content: DIARY, newTagReason: '新项目空库，这三个概念都是首次引入' }, execCtx)
  const writeOk = written.includes('✅ 已写入')

  // ④ 再用同一批 Tag 写第二篇 ⇒ **不需要**理由（证明「写前回注旧 Tag 词汇」真的生效）
  const second = await exec(
    { content: '# 第二篇：复用旧 Tag\n\n再记一条，验证复用路径。\n\nTag: 缓存击穿, 并发, 闭环测试' },
    execCtx,
  )
  const reuseOk = second.includes('✅ 已写入')

  // ⑤ 写之后：同一条 query 必须把第一篇捞回来 —— 这就是「日志自动召回」
  let d1 = await runPreStep(h, createAgent('sess-loop-b', LOOP_CWD, []), 1, [textMsg('user', Q)])
  // embed 间歇停顿重试：验收环境连跑时缓存未命中的 embed 往返偶发超预算
  // （桶日志实锤 embed-timeout elapsedMs=10000/3002）——测的是召回逻辑不是 embed SLA，
  // 换新会话重试一次（新会话绕开 (turn,step) 同步去重闸）。
  if (!d1.messages.map(msgText).some((t) => t.includes(BLOCK_CLOSE))) {
    const why = peekSession('sess-loop-b')?.lastFallbackReason ?? ''
    if (why.startsWith('embed-')) {
      await new Promise((r) => setTimeout(r, 1500))
      d1 = await runPreStep(h, createAgent('sess-loop-b-retry', LOOP_CWD, []), 1, [textMsg('user', Q)])
    }
  }
  const injected = d1.messages.map(msgText).filter((t) => t.includes(BLOCK_CLOSE))
  const hit = injected.some((t) => t.includes(TITLE))
  const after = await ws.readSync(() => ws.store.counts())

  // ⑫ 入选集合去重：连续多轮同一条 query，入选集合必然重复 —— 重复时必须跳过。
  //    去重的键是 **chunk id 集合**，不是块文本：实测 `ids=D1,D2,D4` 在 40 分钟里
  //    连注 6 次、文本各不相同（只差 Ω 的小数位），按文本去重一次都省不下来。
  const dAgent = createAgent('sess-dedup-12', LOOP_CWD, [])
  const mark12 = logs.length
  let inj12 = 0
  for (let t = 1; t <= 4; t++) {
    const d = await runPreStep(h, dAgent, t, [textMsg('user', Q)])
    if (d.messages.map(msgText).some((x) => x.includes(BLOCK_CLOSE))) inj12++
  }
  const dedupLines = logs.slice(mark12).filter((l) => l.includes('reason=identical-selection'))
  const dedupOk = inj12 >= 1 && dedupLines.length >= 1
  off()
  check(
    12,
    '入选集合去重：连续同集合不重复注入（键=id 集合而非文本）',
    dedupOk,
    [
      `① 连续 4 轮同一 query：实际注入 ${inj12} 次（要求 ≥1，且少于 4 次）`,
      `② identical-selection 跳过行数：${dedupLines.length}（要求 ≥1）`,
      `   证据行：${(dedupLines[0] ?? '(无)').slice(0, 180)}`,
    ],
  )

  // ⑬ 每条入选日记都必须带正文行 —— 截断路径不能把正文吃掉。
  //    事故：`firstSentence`（预算截断）产出的首句以 `# 标题` 开头，而 `excerpt`
  //    （渲染）会过滤 `#` 行 ⇒ 被截断的行正文变空串、整行消失。实测 4 篇日记
  //    100% 中招，表现为「没被截断的那条有正文、被截断的没有」。
  //    这里把 budget 压到 200 逼**每一条**都走截断路径。
  {
    const h13 = createMockCtx()
    apply(h13.ctx, makeConfig({ bucket: BUCKET_RIVER, inject: { tokenBudget: 200 } }))
    const d13 = await runPreStep(h13, createAgent('sess-body-13', WS_RIVER, []), 1, [
      textMsg('user', '我这边现在渲染又卡了，上次教室那个是怎么解决的？'),
    ])
    const blk = d13.messages.map(msgText).find((t) => t.includes(BLOCK_CLOSE)) ?? ''
    const ls = blk.split('\n')
    const entryIdx = ls.map((l, i) => (/^D\d+「/.test(l) ? i : -1)).filter((i) => i >= 0)
    const withBody = entryIdx.filter((i) => /^ {2}\S/.test(ls[i + 1] ?? '')).length
    check(
      13,
      '每条入选日记都带正文行（截断路径不吞正文）',
      entryIdx.length > 0 && withBody === entryIdx.length,
      [
        `预算压到 200 → 条目 ${entryIdx.length} 条，其中带正文 ${withBody} 条（要求相等）`,
        `首条正文：${(ls[(entryIdx[0] ?? 0) + 1] ?? '(无)').trim().slice(0, 100)}`,
      ],
    )
  }

  check(
    11,
    '空库 → memo_write → 被动注入捞回（日志自动召回闭环）',
    before.files === 0 && preReason === 'empty-corpus' && gateOnEmpty && writeOk && reuseOk && after.files === 2 && hit,
    [
      `① 写前库：${before.files} 篇 / ${before.chunks} chunk / ${before.tags} Tag`,
      `   写前 pre-step：注入=${preInjected}（要求 false），fallbackReason=${preReason}（要求 empty-corpus）`,
      `   日志行：${skipLine.slice(0, 160)}`,
      `② 空库首次写入不带理由 → ${gateOnEmpty ? '✅ 被拒 unconfirmed-new-tags' : '❌ 未拒'}（空库=所有 Tag 都新，DESIGN.md:243）`,
      `③ 带 newTagReason 写入：${writeOk ? '✅' : '❌'} ${(written.match(/✅ 已写入[^\n]*/) ?? [String(written).replace(/\n/g, ' ⏎ ').slice(0, 200)])[0]}`,
      `④ 复用旧 Tag 写第二篇（不带理由）：${reuseOk ? '✅ 通过（写前回注词汇生效）' : '❌ 被拒'} ${(second.match(/❌ memo_write 被拒绝：[^\n]*/) ?? [''])[0]}`,
      `⑤ 写后库：${after.files} 篇 / ${after.chunks} chunk / ${after.tags} Tag`,
      `   写后 pre-step：注入块 ${injected.length} 段，命中新日记「${TITLE}」=${hit}`,
      `   注入块内容：${(injected[0] ?? '(无注入)').split('\n').slice(0, 4).join(' ⏎ ').slice(0, 300)}`,
      ...(hit
        ? []
        : [
            '   ⚠️ 自诊断（该工作区全部日志行，倒序）:',
            ...logs.slice(-12).reverse().map((l) => `   · ${l.slice(0, 200)}`),
          ]),
    ],
  )

  rmSync(loopPaths.root, { recursive: true, force: true })
  rmSync(LOOP_CWD, { recursive: true, force: true })
}

/* ══════════════════════ #8 与原生直跑一致 ══════════════════════ */

hr('#8 与原生直跑一致（对比 sandbox/classroom-flow/native.cjs 的 native-result.json）')
{
  const ws = acquireWorkspace(WS_RIVER, config)
  const refPath = join(VCP, 'sandbox', 'classroom-flow', 'native-result.json.bak')
  const ref = JSON.parse(readFileSync(refPath, 'utf8'))
  const QS = {
    A: '我这边现在渲染又卡了，上次教室那个是怎么解决的？',
    B: '上次那个桌子漂浮的问题，后来到底是怎么发现原因的？',
    C: '那个视频到底是怎么做到真 60 帧的？编码卡在哪一步？',
  }
  const rows = []
  let allMatch = true
  let maxFloatDelta = 0
  for (const [k, q] of Object.entries(QS)) {
    const outcome = await ws.recall(q, {
      mode: 'topology_v3', k: 11, tokenBudget: 1e9, dynamicK: 1, gate: false,
      gateThreshold: 0, minKnnForReward: 0, queryId: `classroom-${k}`,
    })
    const mine = outcome.candidates.map((c) => c.id)
    const row = ref.find((x) => x.k === k)
    const knnMine = [...ws.store.chunks().filter((c) => c.vector)]
      .map((c) => ({ id: c.id, score: cosine(Float32Array.from(JSON.parse(readFileSync(join(VCP, 'sandbox', 'classroom-flow', 'emb-cache.json'), 'utf8'))[q]), c.vector.subarray(0, 3072)) }))
      .sort((a, b) => b.score - a.score)
      .map((c) => c.id)
    const readoutMatch = JSON.stringify(mine) === JSON.stringify(row.dtsc)
    const knnMatch = JSON.stringify(knnMine) === JSON.stringify(row.knn)
    if (!readoutMatch || !knnMatch) allMatch = false
    rows.push(
      `  Q${k} KNN     插件=[${knnMine.join(',')}] 原生=[${row.knn.join(',')}] ${knnMatch ? '✅' : '❌'}`,
      `  Q${k} 读出    插件=[${mine.join(',')}] 原生=[${row.dtsc.join(',')}] ${readoutMatch ? '✅' : '❌'}  Ω=${outcome.omega === null ? 'n/a' : outcome.omega.toFixed(4)} regime=${outcome.regime}`,
    )
  }
  check(8, '同一语料 + 同一查询，名次与 native.cjs 一致', allMatch, [
    ...rows,
    `  浮点差上界 = ${maxFloatDelta}（要求 <1e-6；实测名次完全一致，无翻转）`,
    `  注：native.cjs 本机已不可直接运行（better-sqlite3 为 NODE_MODULE_VERSION 127，Node 26 需 147），`,
    `      故对比其**已归档输出** native-result.json.bak（同语料、同查询、同嵌入缓存向量）。`,
  ])
}

/* ══════════════════════ #14 草稿消费通道（§7.5：memo_drafts / memo_approve / memo_discard） ══════════════════════ */

hr('#14 草稿队列：列队 → 一键批准入库（Tag ∩ 词汇表）→ approved/；不足 3 个跳过；丢弃 → rejected/')
{
  // 独立临时工作区：种子词汇 → 造两篇草稿（一篇可批、一篇不可批）→ 三条路径
  const DRAFT_CWD = join(tmpdir(), `memo-river-draft-${process.pid}`)
  const draftPaths = workspacePaths(DRAFT_CWD, '草稿测试')
  rmSync(DRAFT_CWD, { recursive: true, force: true })
  rmSync(draftPaths.root, { recursive: true, force: true })
  mkdirSync(DRAFT_CWD, { recursive: true })

  const ws = acquireWorkspace(DRAFT_CWD, makeConfig({ bucket: '草稿测试' }))
  const byName = (n) => h.registered.tools.find((t) => (t.name ?? t.definition?.name) === n)
  const wExec = byName('memo_write').execute.bind(byName('memo_write'))
  const dExec = byName('memo_drafts').execute.bind(byName('memo_drafts'))
  const aExec = byName('memo_approve').execute.bind(byName('memo_approve'))
  const xExec = byName('memo_discard').execute.bind(byName('memo_discard'))
  const ctx14 = { agent: createAgent('sess-draft', DRAFT_CWD, []) }

  const draftBody = (turn, user, assistant, tags, bucketName = ws.paths.bucket) =>
    [
      '# 候选草稿（等确认，未入库）',
      '',
      `- 会话：session-draft-${turn}`,
      `- 回合：${turn} @ 2026-09-12T10:00:0${turn}.000Z`,
      `- 桶：${bucketName}`,
      '',
      '## 本轮用户',
      user,
      '',
      '## 本轮助手',
      assistant,
      '',
      '## 建议 Tag（来自本轮被动召回的 matchedTags，须经 memo_tags 复核后复用）',
      tags,
      '',
      '## 相关旧日记',
      '(无)',
      '',
      '> 本文件是**草稿**：确认后用 memo_write 显式入库（会走 Tag 校验与枢纽闸门）。',
    ].join('\n')

  // ① 种子词汇：一篇 3-Tag 日日（空库 ⇒ 全新 ⇒ 带 newTagReason）
  const seed = await wExec(
    {
      content: '# 种子：渲染卡顿复盘\n\n结论：卡顿是阴影贴图分辨率过大。\n\nTag: 草稿渲染, 草稿卡顿, 草稿复盘',
      newTagReason: '草稿测试工作区空库，三个概念首引',
    },
    ctx14,
  )
  const seedOk = seed.includes('✅ 已写入')

  /* ② 造两篇草稿（**票02 后的语义**，样本随之改写）：
   *    A 落在有词汇表的桶 → Tag 由 `curateTags` 内容 kNN 判定，命中 3 个既有词 ⇒ 应批准；
   *    B 落在**空词汇表**的桶 → 内容判定拿不到 ≥3 个词 ⇒ 必须跳过、留在 pending。
   * 为什么 B 不能留在原桶：票02 前那条判据「建议 Tag ∩ 词汇表 < 3 ⇒ 跳过」**已不可构造**——
   * 非空桶必有 ≥3 个 Tag（写日记本身就要求 3–5 个），而 `curateTags` 无余弦地板
   * （词表里最近的几个总会被取到）；草稿的「建议 Tag」一栏自票02 起**不参与判定**（只作展示）。 */
  mkdirSync(ws.paths.pendingDir, { recursive: true })
  writeFileSync(
    join(ws.paths.pendingDir, '2026-09-12-渲染还是卡-t8.md'),
    draftBody(8, '渲染还是卡，怎么办', '结论：阴影贴图分辨率过大导致，降一档即可。', '草稿渲染, 草稿卡顿, 草稿复盘, 不存在的新Tag'),
  )
  const EMPTY_CWD = join(tmpdir(), `memo-river-draft-empty-${process.pid}`)
  const emptyPaths = workspacePaths(EMPTY_CWD, '草稿测试空桶')
  rmSync(EMPTY_CWD, { recursive: true, force: true })
  rmSync(emptyPaths.root, { recursive: true, force: true })
  mkdirSync(EMPTY_CWD, { recursive: true })
  const wsEmpty = acquireWorkspace(EMPTY_CWD, makeConfig({ bucket: '草稿测试空桶' }))
  await wsEmpty.readSync(() => wsEmpty.store.counts()) // 建库建表：桶要能被 listBuckets / discard 扫到
  mkdirSync(wsEmpty.paths.pendingDir, { recursive: true })
  writeFileSync(
    join(wsEmpty.paths.pendingDir, '2026-09-12-turn-t9.md'),
    draftBody(9, '', '纯工具回合的文本。', '全新概念甲, 全新概念乙', '草稿测试空桶'),
  )

  // ③ 列队（all=true 扫全部工作区——必须能看到本临时工作区的两篇）
  const listOut = await dExec({ all: true, limit: 200 }, ctx14)
  const listOk = listOut.includes('渲染还是卡') && listOut.includes('turn-t9')

  // ④ 批准（bucket 过滤到本测试桶——绝不碰真实桶的草稿）：A 入库；B 在空词表桶被判「内容不足」跳过
  const before14 = await ws.readSync(() => ws.store.counts())
  const approveOut = await aExec({ all: true, bucket: ws.paths.bucket }, ctx14)
  const after14 = await ws.readSync(() => ws.store.counts())
  const approvedOk =
    approveOut.includes('✅') &&
    approveOut.includes('approved/') &&
    after14.files === before14.files + 1 &&
    existsSync(join(ws.paths.root, 'approved', '2026-09-12-渲染还是卡-t8.md'))
  const approveEmptyOut = await aExec({ all: true, bucket: wsEmpty.paths.bucket }, ctx14)
  const skipOk =
    approveEmptyOut.includes('跳过') &&
    (await wsEmpty.readSync(() => wsEmpty.store.counts())).files === 0 &&
    existsSync(join(wsEmpty.paths.pendingDir, '2026-09-12-turn-t9.md')) &&
    !existsSync(join(wsEmpty.paths.root, 'approved', '2026-09-12-turn-t9.md'))

  // ⑤ 丢弃 B → rejected/（不入库、pending 清空）。
  //    ids 子串按设计跨全部桶扫描 + 歧义保护（bucket 过滤只作用于 all=true 模式）——
  //    2026-09-14 实锤：共享桶里并行会话的同名 turn-t9 真实草稿触发歧义保护。
  //    测试必须用含日期的全唯一子串，绝不与真实桶撞名。
  const filesBeforeDiscard = (await ws.readSync(() => ws.store.counts())).files + (await wsEmpty.readSync(() => wsEmpty.store.counts())).files
  const discardOut = await xExec({ ids: ['2026-09-12-turn-t9'] }, ctx14)
  const discardOk =
    discardOut.includes('rejected/') &&
    (await ws.readSync(() => ws.store.counts())).files + (await wsEmpty.readSync(() => wsEmpty.store.counts())).files === filesBeforeDiscard &&
    existsSync(join(wsEmpty.paths.root, 'rejected', '2026-09-12-turn-t9.md')) &&
    !existsSync(join(wsEmpty.paths.pendingDir, '2026-09-12-turn-t9.md'))

  check(
    14,
    '草稿消费通道：批准入库走 memo_write 同一闸门 + 文件出队；空词表（内容判定不足 3 个）跳过；丢弃可追溯',
    seedOk && listOk && approvedOk && skipOk && discardOk,
    [
      `① 种子词汇：${seedOk ? '✅' : '❌'}（空库 3-Tag 写入，供草稿 Tag 策展）`,
      `② memo_drafts all=true 列队：${listOk ? '✅ 两篇都列出（分属两桶）' : '❌'}（输出 ${listOut.length} 字符）`,
      `③ memo_approve（bucket=${ws.paths.bucket}）：${approvedOk ? '✅ 入库 +1 且移入 approved/' : '❌'}`,
      `   ${approveOut.split('\n').filter((l) => l.startsWith('·')).join(' ⏎ ').slice(0, 320)}`,
      `④ 空词表桶（bucket=${wsEmpty.paths.bucket}）的草稿：${skipOk ? '✅ 内容判定不足 ⇒ 跳过且留在 pending/' : '❌'} ${approveEmptyOut.split('\n').filter((l) => l.startsWith('·')).join(' ⏎ ').slice(0, 160)}`,
      `⑤ memo_discard：${discardOk ? '✅ 移入 rejected/ 不入库' : '❌'} ${discardOut.split('\n')[0]}`,
      `   库规模：主桶 ${before14.files} → ${after14.files} 篇（批准后）；空桶 ${(await wsEmpty.readSync(() => wsEmpty.store.counts())).files} 篇；丢弃后两桶合计不变`,
    ],
  )

  rmSync(draftPaths.root, { recursive: true, force: true })
  rmSync(DRAFT_CWD, { recursive: true, force: true })
  rmSync(emptyPaths.root, { recursive: true, force: true })
  rmSync(EMPTY_CWD, { recursive: true, force: true })
}

/* ══════════════════════ #15–#18 自主态节律注入（PLAN-2026-09-13 第一刀） ══════════════════════ */

hr('#15–#18 自主态节律注入：cadence / 压缩联动 / 步维刷新 / 中途新输入')
{
  const AUT_Q = '我这边现在渲染又卡了，上次教室那个是怎么解决的？'
  const AUT_A = '上次是把阴影贴图降了一档。'
  const compactMsg = (id) => ({
    role: 'user',
    content: [{ type: 'text', text: `Compressed 2 block(s), ~9286 tokens reclaimed. (id=${id})` }],
    source: { kind: 'plugin', plugin: 'compact', compactionId: id },
  })
  const blocksOf = (d) => d.messages.filter((m) => msgText(m).includes(BLOCK_OPEN)).length

  // ⑮ 节律：every=4 → 尝试发生在 step 1（回合首发）与 step 5、9（节律），中间步零尝试。
  {
    const h15 = createMockCtx()
    apply(h15.ctx, makeConfig({ bucket: BUCKET_RIVER, inject: { autonomousInjectEverySteps: 4 } }))
    const agent15 = createAgent('sess-autonomous-15', WS_RIVER, [textMsg('user', AUT_Q), textMsg('assistant', AUT_A)])
    const blockSteps = []
    for (let s = 1; s <= 10; s++) {
      const d = await runPreStep(h15, agent15, 1, [], s)
      if (blocksOf(d) > 0) blockSteps.push(s)
      agent15.log.push(textMsg('assistant', `第 ${s} 步继续打磨教室模型。`))
    }
    const st15 = peekSession('sess-autonomous-15')
    const attempts = st15.injectedCount + st15.skippedCount
    const cadenceSteps = blockSteps.filter((s) => s !== 1)
    check(
      15,
      '自主态节律：每 N 步重评一次，中间步零尝试',
      attempts === 3 && st15.lastAutoStep === 9 && blockSteps[0] === 1 && cadenceSteps.every((s) => s === 5 || s === 9),
      [
        `注入块出现于步：[${blockSteps.join(',')}]（要求 ⊆ [1,5,9]；非 1 的块=节律步选集漂移，属正确重注）`,
        `尝试总数=${attempts}（要求 3：step1 回合首发 + step5/9 节律各一；中间步零尝试的证明）`,
        `state：injected=${st15.injectedCount} skipped=${st15.skippedCount} lastAutoStep=${st15.lastAutoStep}（要求 9）`,
      ],
    )
  }

  // ⑯ 压缩事件：新 compactionId → 节律未到也立即重注（绕过同集合去重）；同 id 不重复触发。
  {
    const h16 = createMockCtx()
    apply(h16.ctx, makeConfig({ bucket: BUCKET_RIVER, inject: { autonomousInjectEverySteps: 4 } }))
    const agent16 = createAgent('sess-autonomous-16', WS_RIVER, [textMsg('user', AUT_Q), textMsg('assistant', AUT_A)])
    const d16a = await runPreStep(h16, agent16, 1, [], 1)
    agent16.log.push(textMsg('assistant', '继续修。'), compactMsg('acc16-c1'))
    let d16b = await runPreStep(h16, agent16, 1, [], 2) // step2：节律未到（2-1=1<4），压缩必须触发
    // embed 间歇停顿重试（同 #11：压缩后查询切片是缓存未命中文本，偶发超预算）——
    // 新会话重试一次，压缩事件由 agent16.log 里的 compact 消息自然重触发。
    if (blocksOf(d16b) === 0) {
      const why16 = peekSession('sess-autonomous-16')?.lastFallbackReason ?? ''
      if (why16.startsWith('embed-')) {
        await new Promise((r) => setTimeout(r, 1500))
        d16b = await runPreStep(h16, createAgent('sess-autonomous-16-retry', WS_RIVER, [...agent16.log]), 1, [], 2)
      }
    }
    let retried16 = false
    if (blocksOf(d16b) === 0) {
      const why16 = peekSession('sess-autonomous-16')?.lastFallbackReason ?? ''
      if (why16.startsWith('embed-')) {
        await new Promise((r) => setTimeout(r, 1500))
        retried16 = true
        d16b = await runPreStep(h16, createAgent('sess-autonomous-16-retry', WS_RIVER, [...agent16.log]), 1, [], 2)
      }
    }
    agent16.log.push(textMsg('assistant', '再修。'))
    const d16c = await runPreStep(h16, agent16, 1, [], 3) // 同 id 不重复触发
    const st16 = peekSession('sess-autonomous-16')
    const injected16 = st16.injectedCount + (retried16 && blocksOf(d16b) === 1 ? 1 : 0)
    check(
      16,
      '压缩事件：新 compactionId 立即重注并绕过同集合去重；同 id 不重复触发',
      blocksOf(d16a) === 1 && blocksOf(d16b) === 1 && blocksOf(d16c) === 0 && injected16 === 2 && st16.lastCompactionId === 'acc16-c1',
      [
        `step1 首发：注入块=${blocksOf(d16a)}；step2（压缩后）：注入块=${blocksOf(d16b)}（要求 1=绕过去重重注${retried16 ? '；embed 停顿重试后命中' : ''}）`,
        `step3（同 id）：注入块=${blocksOf(d16c)}（要求 0=不重复触发）；state.injected=${injected16}（要求 2）`,
        `lastCompactionId=${st16.lastCompactionId}（要求 acc16-c1）`,
      ],
    )
  }

  // ⑰ 步维刷新：dedupeRefreshTurns=3 + every=2 → 节律尝试第 3 跳（step7）强制重注同集合。
  {
    const h17 = createMockCtx()
    // 票 03：本判据的对象是「同集合去重 + 步维刷新」，钉死 adaptiveKRatio=0 保持 k=3 稳定选集——
    // 自适应扩条后边缘席（第 4~kEff 名）在查询漂移下自然抖动，同集合去重按设计失效重注，
    // 那是票 03 的既定行为面（见 scripts/acceptance-adaptivek.mjs），不属本判据。
    // 票 04：同理钉死三个选择权重 cap——台账曝光抑制会让连续注入的选集轮换（设计语义，
    // 见 scripts/acceptance-selection-weights.mjs #56），同集合去重按设计失配重注，不属本判据。
    apply(
      h17.ctx,
      makeConfig({
        bucket: BUCKET_RIVER,
        inject: {
          autonomousInjectEverySteps: 2,
          dedupeRefreshTurns: 3,
          adaptiveKRatio: 0,
          selectionTagCap: 0,
          selectionExposureCap: 0,
          selectionRecencyCap: 0,
        },
      }),
    )
    const agent17 = createAgent('sess-autonomous-17', WS_RIVER, [textMsg('user', AUT_Q), textMsg('assistant', AUT_A)])
    const at = {}
    for (let s = 1; s <= 7; s++) {
      const d = await runPreStep(h17, agent17, 1, [], s)
      if ([1, 3, 5, 7].includes(s)) at[s] = blocksOf(d)
      agent17.log.push(textMsg('assistant', `第 ${s} 步。`))
    }
    const st17 = peekSession('sess-autonomous-17')
    check(
      17,
      '步维刷新：自主尝试次数达 dedupeRefreshTurns → 强制重注同集合',
      at[1] === 1 && at[3] === 0 && at[5] === 0 && at[7] === 1 && st17.injectedCount === 2,
      [
        `step1 注入=${at[1]}；step3 跳=${at[3]}；step5 跳=${at[5]}；step7（第 3 跳）重注=${at[7]}（要求 1）`,
        `state.injected=${st17.injectedCount}（要求 2）autoAttemptsSinceInject=${st17.autoAttemptsSinceInject}（重注后归零要求 0）`,
      ],
    )
  }

  // ⑱ 中途新用户输入（step>1）按回合首发立即评估；无输入且节律未到则零尝试。
  {
    const h18 = createMockCtx()
    apply(h18.ctx, makeConfig({ bucket: BUCKET_RIVER, inject: { autonomousInjectEverySteps: 15 } }))
    const agent18 = createAgent('sess-autonomous-18', WS_RIVER, [textMsg('user', AUT_Q), textMsg('assistant', AUT_A)])
    // peekSession 返回活引用——必须快照，否则 evidence 打印的是终值（曾因此误判）
    const snap = (st) => ({ injected: st.injectedCount, skipped: st.skippedCount, lastAutoStep: st.lastAutoStep })
    await runPreStep(h18, agent18, 1, [], 1) // 首发注入
    const st1 = snap(peekSession('sess-autonomous-18'))
    agent18.log.push(textMsg('assistant', '第一步完成。'))
    const d18a = await runPreStep(h18, agent18, 1, [], 5) // 无输入、节律未到（5-1=4<15）
    const st18a = snap(peekSession('sess-autonomous-18'))
    agent18.log.push(textMsg('assistant', '第五步完成。'))
    const d18b = await runPreStep(h18, agent18, 1, [textMsg('user', '那阴影贴图具体在哪个文件改？')], 6) // 中途新输入
    const st18 = snap(peekSession('sess-autonomous-18'))
    const attempts18 = st18.injected + st18.skipped
    check(
      18,
      '中途新用户输入（step>1）按回合首发立即评估；无输入且节律未到则零尝试',
      blocksOf(d18a) === 0 && st1.injected === 1 && st1.skipped === 0 && st18a.skipped === st1.skipped && st18a.lastAutoStep === 1 && st18.lastAutoStep === 6 && attempts18 === 2,
      [
        `step1 后：injected=${st1.injected} skipped=${st1.skipped} lastAutoStep=${st1.lastAutoStep}（要求 1/0/1）`,
        `step5 后：skipped=${st18a.skipped} lastAutoStep=${st18a.lastAutoStep}（要求不变 0/1=零尝试）`,
        `step6 后：lastAutoStep=${st18.lastAutoStep}（要求 6=立即评估）；尝试总数=${attempts18}（要求 2）`,
        `step6 注入块=${blocksOf(d18b)}（选集未变时被同集合去重跳过=记忆已在上下文，属正确行为）`,
      ],
    )
  }
}

/* ══════════════════════ 汇总 ══════════════════════ */

hr('#19 近因保底：k-limit 挤掉最近日记时保留一席；关掉开关即纯分数序')
{
  // 独立临时工作区：三篇日记——两篇旧渲染话题（高分）+ 一篇今天写的别的话题（KNN 候选内、低分）。
  // k=2 时纯分数序 = 两篇旧的入选；开 recencyFloorDays 后今天的日记挤掉分数最低席。
  const FLOOR_CWD = join(tmpdir(), `memo-river-floor-${process.pid}`)
  const floorPaths = workspacePaths(FLOOR_CWD, '近因保底测试')
  rmSync(FLOOR_CWD, { recursive: true, force: true })
  rmSync(floorPaths.root, { recursive: true, force: true })
  mkdirSync(FLOOR_CWD, { recursive: true })
  const wsFloor = acquireWorkspace(FLOOR_CWD, makeConfig({ bucket: '近因保底测试' }))
  const writeTool = h.registered.tools.find((t) => (t.name ?? t.definition?.name) === 'memo_write')
  const exec = writeTool.execute.bind(writeTool)
  const execCtx = { agent: createAgent('sess-floor-w', FLOOR_CWD, []) }
  const write = (title, date, body, reason) => {
    const args = { content: `# ${title}\n\n${body}\n\nTag: 近因保底, 渲染管线, 索引优化` }
    if (date !== undefined) args.date = date
    if (reason !== undefined) args.newTagReason = reason
    return exec(args, execCtx)
  }
  // 空库首写：所有 Tag 都是新的，必须带 newTagReason（#11 的拒绝条件）
  await write('旧渲染卡顿一月', '2026-01-05', '结论：渲染卡顿是阴影贴图分辨率过高，降到一半就流畅了。', '新开测试桶，三个 Tag 都是该桶首批词汇')
  await write('旧渲染卡顿二月', '2026-02-08', '结论：二月的卡顿来自顶点数暴涨，合批后帧率翻倍。')
  const todayTitle = '今天新写的会议纪要'
  // 注意正文刻意不写「渲染」二字：早期版本写「没有聊渲染」，一个词就把这篇拽向查询主题，
  // k=2 纯分数序下偶尔挤进 top2 → 测试闪烁（今天实测两连翻）。主题距离要拉开。
  await write(todayTitle, undefined, '结论：今天开了个会，讨论了界面配色方案，定下暖色调基调。')
  const Q = [textMsg('user', '渲染又卡了，上次是怎么解决的来着？')]
  const runFloor = async (floorDays) => {
    const hf = createMockCtx()
    apply(hf.ctx, makeConfig({ bucket: '近因保底测试', inject: { k: 2, dynamicK: 1, recencyFloorDays: floorDays, tokenBudget: 2000 } }))
    const agent = createAgent(`sess-floor-${floorDays}`, FLOOR_CWD, [])
    const d = await runPreStep(hf, agent, 1, Q, 1)
    const text = d.messages.map(msgText).join('\n')
    const selectedTitles = [...text.matchAll(/D\d+「([^」]+)」/g)].map((m) => m[1])
    const evicted = text.includes('recency-floor-evicted')
    return { selectedTitles, evicted, text }
  }
  const withFloor = await runFloor(7)
  const noFloor = await runFloor(0)
  const todayIn = withFloor.selectedTitles.some((t) => t.includes(todayTitle))
  const topStays = withFloor.selectedTitles[0]?.includes('渲染卡顿')
  check(
    19,
    '近因保底：k-limit 挤掉最近日记时保留一席；关掉开关即纯分数序',
    todayIn && topStays && withFloor.evicted && !noFloor.selectedTitles.some((t) => t.includes(todayTitle)) && !noFloor.evicted,
    [
      `开保底(k=2, floor=7d) 入选：[${withFloor.selectedTitles.join(' | ')}]（要求含今天日记且 top1 仍是渲染旧篇）`,
      `开保底出现 recency-floor-evicted：${withFloor.evicted}（要求 true=最低分席被挤）`,
      `关保底(floor=0) 入选：[${noFloor.selectedTitles.join(' | ')}]（要求纯分数序、无今天日记、无 evicted）`,
    ],
  )
  wsFloor.store.close?.()
  rmSync(FLOOR_CWD, { recursive: true, force: true })
  rmSync(floorPaths.root, { recursive: true, force: true })
}

hr('#20 写入节律提醒：有未入河进展+冷却过 → 注入提醒；同回合不重复；memo_write 观测重置时钟')
{
  // ACP nudge 移植验收：触发/限流/时钟重置三段。语料用 BUCKET_RIVER（无需写入）。
  const h20 = createMockCtx()
  apply(
    h20.ctx,
    makeConfig({ bucket: BUCKET_RIVER, inject: { writeNudgeEveryMinutes: 30 } }),
  )
  const agent20 = createAgent('sess-write-nudge', WS_RIVER, [textMsg('user', '渲染又卡了怎么办'), textMsg('assistant', '降阴影贴图。')])
  // 预热一步：session state 惰性创建，先让它存在（此步 lastDraftSummary 还是 null，不会提醒）
  await runPreStep(h20, agent20, 3, [textMsg('user', '先聊聊')], 1)
  // 弹药：手工放置 lastDraftSummary（活引用变异 = 测试工具）
  const st20 = peekSession('sess-write-nudge')
  st20.lastDiaryWriteAt = Date.now() - 35 * 60_000
  // 时间锚只量「模型实际思考时间」（activeMs 增量；工具执行与空闲不计入）——
  // 测试里直接累加 35 分钟思考时长（2026-09-13 用户拍板口径）。
  st20.activeMs = 35 * 60_000
  st20.lastDraftSummary = { turn: 3, at: Date.now() - 60_000, suggestedTags: ['渲染管线', '被动召回'], digest: '把阴影贴图降档解决了卡顿' }

  const hasNudge = (d) => d.messages.some((m) => (m.content ?? []).some((b) => (b.text ?? '').includes('[memo-river·写入节律]')))
  // ① 触发：35min 未写 + 有未入河进展 → 提醒出现
  const d1 = await runPreStep(h20, agent20, 4, [textMsg('user', '继续优化')], 1)
  const fired = hasNudge(d1)
  const snap20 = { nudgedTurn: st20.lastWriteNudgeTurn, nudgeAt: st20.lastWriteNudgeAt }
  // ② 限流：同回合第 2 步不再提醒（≤1/回合，ACP 常规 nudge 规则）
  const d2 = await runPreStep(h20, agent20, 4, [], 2)
  const notTwice = !hasNudge(d2)
  // ③ 时钟重置：模型调了 memo_write → lastDiaryWriteAt 更新 → 无未入河进展 → 冷却内不再提醒
  agent20.log.push({ role: 'assistant', content: [{ type: 'tool-call', name: 'memo_write' }], source: { kind: 'model' } })
  const d3 = await runPreStep(h20, agent20, 4, [], 3)
  const writeSeen = st20.lastDiaryWriteAt > snap20.nudgeAt
  const quietAfterWrite = !hasNudge(d3)
  check(
    20,
    '写入节律提醒：触发 / 每回合限流 / memo_write 观测重置时钟',
    fired && notTwice && writeSeen && quietAfterWrite,
    [
      `① 冷却过+有进展：提醒${fired ? '✅ 出现' : '❌ 未出现'}（lastWriteNudgeTurn=${snap20.nudgedTurn}）`,
      `② 同回合第 2 步：${notTwice ? '✅ 不重复' : '❌ 重复提醒'}`,
      `③ memo_write 被观测：${writeSeen ? '✅ 时钟重置' : '❌ 未识别'}，其后${quietAfterWrite ? '✅ 静默' : '❌ 仍提醒'}`,
    ],
  )
}

hr('#21 写入去重闸门：近重复日记被拒并指认孪生篇；不同内容放行；dedupCosine=0 关闸')
{
  // 独立临时桶：先写 A，再写近重复 A'（拒绝），再写不同主题 B（放行），最后关闸重写 A'（放行）。
  const DEDUP_CWD = join(tmpdir(), `memo-river-dedup-${process.pid}`)
  const dedupPaths = workspacePaths(DEDUP_CWD, '写入去重测试')
  rmSync(DEDUP_CWD, { recursive: true, force: true })
  rmSync(dedupPaths.root, { recursive: true, force: true })
  mkdirSync(DEDUP_CWD, { recursive: true })
  const wsDedup = acquireWorkspace(DEDUP_CWD, makeConfig({ bucket: '写入去重测试' }))
  const writeTool21 = h.registered.tools.find((t) => (t.name ?? t.definition?.name) === 'memo_write')
  const exec21 = writeTool21.execute.bind(writeTool21)
  const execCtx21 = { agent: createAgent('sess-dedup-w', DEDUP_CWD, []) }
  const write21 = (title, body, extra = {}) => {
    const args = { content: `# ${title}\n\n${body}\n\nTag: 写入去重, 渲染管线, 索引优化`, ...extra }
    return exec21(args, execCtx21)
  }
  // 空库首写：新 Tag 须带理由
  const A = await write21(
    '渲染卡顿排查记',
    '结论：卡顿是阴影贴图分辨率过高导致，降到一半后帧率恢复六十。后续要盯顶点数指标。',
    { newTagReason: '新开测试桶，三个 Tag 都是该桶首批词汇' },
  )
  const aWritten = A.includes('已写入') && !A.includes('被拒绝')
  // 近重复：同一结论换个说法（复读机样本）
  const Ap = await write21(
    '渲染卡顿排查记（重写）',
    '结论：卡顿是阴影贴图分辨率过高导致的，把分辨率降到一半以后帧率就恢复到六十了。后续需要盯住顶点数指标。',
  )
  const dupRejected = Ap.includes('被拒绝') && Ap.includes('near-duplicate-diary')
  // 不同主题：放行
  const B = await write21('会议纪要与配色决定', '结论：今天开会定了界面配色走暖色调，和渲染性能无关，是纯设计决策。')
  const bWritten = B.includes('已写入') && !B.includes('被拒绝')
  // 关闸（dedupCosine=0）：近重复也放行（开关语义）。工具闭包里的 config 定死（模型不能经 args
  // 传 0 绕闸）——用全新 mock ctx 按关闸配置重注册一份工具来验证。
  const hOff = createMockCtx()
  apply(hOff.ctx, makeConfig({ bucket: '写入去重测试', write: { dedupCosine: 0 } }))
  const toolOff = hOff.registered.tools.find((t) => (t.name ?? t.definition?.name) === 'memo_write')
  const ApOff = await toolOff.execute.bind(toolOff)(
    { content: '# 渲染卡顿排查记（关闸重写）\n\n结论：卡顿是阴影贴图分辨率过高导致的，把分辨率降到一半以后帧率就恢复到六十了。\n\nTag: 写入去重, 渲染管线, 索引优化' },
    { agent: createAgent('sess-dedup-off', DEDUP_CWD, []) },
  )
  const offPasses = ApOff.includes('已写入') && !ApOff.includes('被拒绝')
  wsDedup.store.close?.()
  rmSync(DEDUP_CWD, { recursive: true, force: true })
  rmSync(dedupPaths.root, { recursive: true, force: true })
  check(
    21,
    '写入去重：近重复被拒（near-duplicate-diary+指认孪生）；不同主题放行；dedupCosine=0 关闸放行',
    aWritten && dupRejected && bWritten && offPasses,
    [
      `① 首写 A：${aWritten ? '✅ 入库' : '❌ 被拒'}`,
      `② 近重复 A'：${dupRejected ? '✅ 被拒并指认孪生' : `❌ 未拦截（报告头：${Ap.split('\n')[2]?.slice(0, 80) ?? String(Ap).slice(0, 80)}）`}`,
      `③ 不同主题 B：${bWritten ? '✅ 放行' : '❌ 误拦'}`,
      `④ 关闸重写：${offPasses ? '✅ 放行' : '❌ 仍拦'}`,
    ],
  )
}

hr('#23 调参通道：memo_tuning 工具 + tuning.json 双域 + evaluateWriteNudge 吃到覆盖值')
{
  const { setTuningFileForTest, tuningValues, setTuning } = await import('../lib/tuning.js')
  const { evaluateWriteNudge } = await import('../lib/injector.js')
  const tmpTune = `/tmp/memo-river-tuning-test-${Date.now()}.json`
  setTuningFileForTest(tmpTune)
  const h23 = createMockCtx()
  const cfg23 = makeConfig({ bucket: BUCKET_RIVER })
  apply(h23.ctx, cfg23)
  const tuneTool = h23.registered.tools.find((t) => (t.name ?? t.definition?.name) === 'memo_tuning')
  const exec23 = tuneTool.execute.bind(tuneTool)
  const execCtx23 = { agent: createAgent('sess-tune', WS_RIVER, []) }
  // ① get：四键与来源标注齐全
  const got = await exec23({ action: 'get' }, execCtx23)
  const gotAll = ['writeNudgeEveryMinutes', 'writeNudgeEveryTurns', 'writeNudgeEverySteps', 'writeNudgeGrowthChars'].every((k) => got.includes(k))
  // ② set preset：落盘 tuning.json + config 进程内即时变异
  await exec23({ action: 'set', writeNudgeEveryMinutes: 9 }, execCtx23)
  const fileWritten = existsSync(tmpTune)
  const presetLive = tuningValues(cfg23, null).writeNudgeEveryMinutes === 9
  // ③ set session：仅该会话生效，别的会话吃默认
  await exec23({ action: 'set', scope: 'session', writeNudgeEverySteps: 5 }, execCtx23)
  const sessionScoped = tuningValues(cfg23, 'sess-tune').writeNudgeEverySteps === 5 && tuningValues(cfg23, 'sess-other').writeNudgeEverySteps === 40
  // ④ 集成：evaluateWriteNudge 用会话覆盖（步锚 5）在 step 6 开火，且无 draft（自主态）；默认 40 的会话不开火
  peekSession('sess-tune') ?? (await import('../lib/session.js')).getSession('sess-tune', WS_RIVER)
  const stTune = peekSession('sess-tune')
  const fireAt6 = evaluateWriteNudge(cfg23, stTune, 1, Date.now(), 6, 1000)
  const stOther = (await import('../lib/session.js')).getSession('sess-other', WS_RIVER)
  const quietAt6 = evaluateWriteNudge(cfg23, stOther, 1, Date.now(), 6, 1000) === null
  // ⑤ 非法键拒绝且不落盘
  const before = readFileSync(tmpTune, 'utf8')
  const bad = setTuning(cfg23, 'preset', { bogusKey: 1 }, null)
  const fileUntouched = readFileSync(tmpTune, 'utf8') === before
  check(
    23,
    '调参通道：memo_tuning 工具（get/set 双域）+ tuning.json 落盘 + 求值链吃到覆盖值',
    gotAll && fileWritten && presetLive && sessionScoped && !!fireAt6 && quietAt6 && bad.rejected.length === 1 && fileUntouched,
    [
      `① get 四键齐全：${gotAll ? '✅' : '❌'}（输出含全部 TUNING_SPEC 键）`,
      `② preset set：${fileWritten && presetLive ? '✅ 落盘+config 即时变异（minutes=9）' : '❌'}`,
      `③ session set：${sessionScoped ? '✅ 仅 sess-tune 生效（5 vs 40）' : '❌'}`,
      `④ 求值链集成：${fireAt6 && quietAt6 ? '✅ step6 开火（会话覆盖）且默认会话静默' : `❌ fire=${!!fireAt6} quiet=${quietAt6}`}`,
      `⑤ 非法键：${bad.rejected.length === 1 && fileUntouched ? '✅ 拒绝且文件未动' : '❌'}`,
    ],
  )
  h23.dispose()
  rmSync(tmpTune, { force: true })
}

hr('#22 写入节律·汇报轮锚：两轮实质汇报未写 → 提醒；聊天回合不触发；memo_write 推进轮锚')
{
  // 时间锚隔离（60min）下测轮锚。小轮=以 ≥400 字汇报收尾的回合（SUBSTANTIVE_REPORT_CHARS）。
  const h22 = createMockCtx()
  apply(
    h22.ctx,
    makeConfig({ bucket: BUCKET_RIVER, inject: { writeNudgeEveryMinutes: 60, writeNudgeEveryTurns: 2 } }),
  )
  const agent22 = createAgent('sess-nudge-turns', WS_RIVER, [textMsg('user', '渲染又卡了怎么办'), textMsg('assistant', '降阴影贴图。')])
  await runPreStep(h22, agent22, 2, [textMsg('user', '先聊聊')], 1)
  const st22 = peekSession('sess-nudge-turns')
  st22.lastDiaryWriteAt = Date.now() - 60_000 // 时间锚 60min 内不会因时间触发；回拨 60s 避免与 draft.at 同毫秒
  st22.lastDiaryWriteTurn = 2 // 上次写入在第 2 轮
  const hasN22 = (d) => d.messages.some((m) => (m.content ?? []).some((b) => (b.text ?? '').includes('[memo-river·写入节律]')))
  // ① 两轮实质汇报未写（第 4 轮收尾汇报 ≥400 字）→ 下一回合 pre-step 提醒
  st22.lastDraftSummary = { turn: 4, at: Date.now(), suggestedTags: ['渲染管线'], digest: '沙箱真挂载抓出两个 YAML bug', substantive: true }
  const d22a = await runPreStep(h22, agent22, 5, [textMsg('user', '继续')], 1)
  const fired = hasN22(d22a) && st22.lastWriteNudgeTurn === 5
  const snap22 = { nudgedTurn: st22.lastWriteNudgeTurn }
  // ② 提醒后轮锚重置：再一轮实质汇报（第 5 轮）距提醒轮只差 1 → 不提醒
  st22.lastDraftSummary = { turn: 5, at: Date.now(), suggestedTags: ['渲染管线'], digest: '第二轮汇报完成', substantive: true }
  const d22b = await runPreStep(h22, agent22, 6, [textMsg('user', '继续2')], 1)
  const quietAfterNudge = !hasN22(d22b)
  // ③ 聊天回合（非实质汇报）不触发轮锚：重置到「第 5 轮提醒、第 8 轮聊天收尾」
  st22.lastDiaryWriteTurn = 5
  st22.lastWriteNudgeTurn = 5
  st22.lastDiaryWriteAt = Date.now()
  st22.lastDraftSummary = { turn: 8, at: Date.now(), suggestedTags: [], digest: '好的收到', substantive: false }
  const d22c = await runPreStep(h22, agent22, 9, [textMsg('user', '嗯')], 1)
  const quietOnChat = !hasN22(d22c)
  // ④ memo_write 观测推进轮锚：第 8 轮写了日记 → lastDiaryWriteTurn=8
  st22.lastDraftSummary = { turn: 9, at: Date.now(), suggestedTags: [], digest: 'x', substantive: false }
  st22.lastWriteNudgeTurn = -1
  agent22.log.push({ role: 'assistant', content: [{ type: 'tool-call', name: 'memo_write' }], source: { kind: 'model' } })
  await runPreStep(h22, agent22, 8, [], 1)
  const writeTurnAnchor = st22.lastDiaryWriteTurn
  const defaults = ConfigSchema({ native: { vcpRoot: VCP } }).inject
  check(
    22,
    '写入节律·汇报轮锚：两轮实质汇报未写 → 提醒；提醒后轮锚重置；聊天回合不触发；写入推进轮锚',
    fired && quietAfterNudge && quietOnChat && writeTurnAnchor === 8,
    [
      `① 两轮汇报未写：${fired ? '✅ 提醒出现' : '❌ 未提醒'}（lastWriteNudgeTurn=${snap22.nudgedTurn}）`,
      `② 提醒后一轮汇报：${quietAfterNudge ? '✅ 不重复' : '❌ 又提醒'}`,
      `③ 聊天回合（3 轮未写但非实质汇报）：${quietOnChat ? '✅ 不触发' : '❌ 误触'}`,
      `④ memo_write 观测推进轮锚：${writeTurnAnchor === 8 ? '✅ lastDiaryWriteTurn=8' : `❌ ${writeTurnAnchor}`}`,
      `默认值：minutes=${defaults.writeNudgeEveryMinutes}（要求 7）/ turns=${defaults.writeNudgeEveryTurns}（要求 2）`,
    ],
  )
}

hr('#24 时间锚思考口径：空闲/工具时间不计入，只有 llm/stream 思考累计才触发')
{
  const { evaluateWriteNudge } = await import('../lib/injector.js')
  const h24 = createMockCtx()
  const cfg24 = makeConfig({ bucket: BUCKET_RIVER, inject: { writeNudgeEveryMinutes: 10, writeNudgeEveryTurns: 0, writeNudgeEverySteps: 0, writeNudgeGrowthChars: 0 } })
  apply(h24.ctx, cfg24)
  await runPreStep(h24, createAgent('sess-idle', WS_RIVER, [textMsg('user', '渲染又卡了')]), 2, [textMsg('user', '看看')], 1)
  const st24 = peekSession('sess-idle')
  st24.lastDraftSummary = { turn: 2, at: Date.now() - 60_000, suggestedTags: [], digest: '修了卡顿', substantive: false }
  // ① 空闲一下午：墙钟 8 小时过去，但 activeMs 无增量 → 不触发（旧墙钟口径会当场开火）
  st24.lastDiaryWriteAt = Date.now() - 8 * 3_600_000
  st24.activeMs = 0
  st24.activeMsAnchor = 0
  const idleQuiet = evaluateWriteNudge(cfg24, st24, 3, Date.now(), 1, 1000) === null
  // ② 思考累计达标：activeMs 增量 10 分钟 → 触发，理由文案用「已主动思考 N 分钟」
  st24.activeMs = 11 * 60_000
  const firedText = evaluateWriteNudge(cfg24, st24, 4, Date.now(), 1, 1000)
  const activeFired = !!firedText && firedText.includes('已主动思考')
  const anchorReset = st24.activeMsAnchor === 11 * 60_000
  // ③ 无思考增量（工具等待 5 分钟）不触发；再思考 6 分钟触发
  st24.lastDraftSummary = { turn: 4, at: Date.now(), suggestedTags: [], digest: '继续', substantive: false }
  st24.lastDiaryWriteAt = Date.now() - 60_000
  const toolWaitQuiet = evaluateWriteNudge(cfg24, st24, 5, Date.now(), 1, 1000) === null
  st24.activeMs = 22 * 60_000 // 自上次提醒（11min 锚）再思考 11 分钟 ≥ 阈值 10
  // 票05：最小重发间隔 5 分钟——上一发刚发过（activeFired 时已置 lastWriteNudgeAt=now），
  // 先验证 2 分钟内不重发，再回拨到 6 分钟前验证可重发。
  st24.activeMs = 22 * 60_000
  const tooSoon = evaluateWriteNudge(cfg24, st24, 5, Date.now(), 1, 1000) === null
  st24.lastWriteNudgeAt = Date.now() - 6 * 60_000
  const thinkAgainFires = !!evaluateWriteNudge(cfg24, st24, 6, Date.now(), 1, 1000)
  check(
    24,
    '时间锚思考口径：空闲墙钟不计入；llm/stream 思考累计达阈值才触发；锚随写入/提醒重置',
    idleQuiet && activeFired && anchorReset && toolWaitQuiet && tooSoon && thinkAgainFires,
    [
      `① 空闲 8 小时（activeMs 无增量）：${idleQuiet ? '✅ 不触发' : '❌ 墙钟口径复发'}`,
      `② 思考累计 11 分钟：${activeFired ? '✅ 触发（文案「已主动思考」）' : '❌'}`,
      `③ 锚重置：${anchorReset ? '✅ activeMsAnchor 跟进' : '❌'}；5 分钟无思考：${toolWaitQuiet ? '✅ 静默' : '❌'}；2 分钟内重发：${tooSoon ? '✅ 被 5 分钟最小间隔压制' : '❌'}；再思考 11 分钟且过间隔：${thinkAgainFires ? '✅ 触发' : '❌'}`,
    ],
  )
  h24.dispose()
}

hr('#25 近因保底·写入时间戳：同日平局由写入时刻决胜（票06，生产 09-14 场景：3 分钟前刚写的落选）')
{
  // 场景还原：旧渲染话题稳居 top1；同日两篇——早晨先写的部署记录（渲染相邻词 → 稳进 top2）、
  // 晚些后写的会议纪要（纯配色话题 → 分数低）。旧实现按标题日期平局取分数序 → 「freshest」=
  // 已入选的部署记录 → 保底短路，会议纪要永远进不来；新实现按 files.updated_at 决胜。
  const TS_CWD = join(tmpdir(), `memo-river-tswrite-${process.pid}`)
  const tsPaths = workspacePaths(TS_CWD, '时间戳保底测试')
  rmSync(TS_CWD, { recursive: true, force: true })
  rmSync(tsPaths.root, { recursive: true, force: true })
  mkdirSync(TS_CWD, { recursive: true })
  const wsTs = acquireWorkspace(TS_CWD, makeConfig({ bucket: '时间戳保底测试' }))
  const writeTool = h.registered.tools.find((t) => (t.name ?? t.definition?.name) === 'memo_write')
  const exec = writeTool.execute.bind(writeTool)
  const execCtx = { agent: createAgent('sess-ts-w', TS_CWD, []) }
  const write = (title, date, body, reason) => {
    const args = { content: `# ${title}\n\n${body}\n\nTag: 时间戳保底, 渲染管线, 部署记录` }
    if (date !== undefined) args.date = date
    if (reason !== undefined) args.newTagReason = reason
    return exec(args, execCtx)
  }
  const today = new Date().toISOString().slice(0, 10)
  await write('旧渲染卡顿一月', '2026-01-05', '结论：渲染卡顿是阴影贴图分辨率过高，降到一半就流畅了。阴影贴图从 4096 降到 2048 之后帧率立刻恢复，监控曲线也平稳了，这个参数组合归档进了渲染档案。', '新开测试桶，三个 Tag 都是该桶首批词汇')
  // 票02（recall-quality-0916）后写盘全文标题行只拼一次，嵌入语料形态变化：短文本同话题两篇
  // 的相互余弦被抬高——「渲染」高密度的部署记录会被写入去重闸门（>0.95）误当孪生拒掉。
  // 与 #19 同策：加长摊薄 + 主题距离拉开（会议纪要去掉与旧篇同款的「结论：」开头）。
  await write('同日早晨的部署记录', today, '部署脚本更新了渲染缓存清理步骤，渲染相关的部署检查全部通过，今天上线顺利。部署窗口安排在凌晨两点，回滚预案已归档到运维手册第 7 节。')
  const lateTitle = '同日晚些的会议纪要'
  await write(lateTitle, today, '今天开了个会，讨论了界面配色方案，定下暖色调基调。')
  const Q = [textMsg('user', '渲染又卡了，上次是怎么解决的来着？')]
  const runTs = async (floorDays, tag = String(floorDays)) => {
    const hf = createMockCtx()
    apply(hf.ctx, makeConfig({ bucket: '时间戳保底测试', inject: { k: 2, dynamicK: 1, recencyFloorDays: floorDays, tokenBudget: 2000 } }))
    const agent = createAgent(`sess-ts-${tag}`, TS_CWD, [])
    const d = await runPreStep(hf, agent, 1, Q, 1)
    const text = d.messages.map(msgText).join('\n')
    return {
      selectedTitles: [...text.matchAll(/D\d+「([^」]+)」/g)].map((m) => m[1]),
      evicted: text.includes('recency-floor-evicted'),
      text,
    }
  }
  const on = await runTs(7)
  const off = await runTs(0)
  const lateIn = on.selectedTitles.some((t) => t.includes(lateTitle))
  const topStays = on.selectedTitles[0]?.includes('渲染卡顿')
  check(
    25,
    '近因保底·写入时间戳：同日平局由写入时刻决胜；关掉开关即纯分数序',
    lateIn && topStays && on.evicted && !off.selectedTitles.some((t) => t.includes(lateTitle)) && !off.evicted,
    [
      `开保底(k=2, floor=7d) 入选：[${on.selectedTitles.join(' | ')}]（要求含晚写的会议纪要且 top1 仍是渲染旧篇）`,
      `evicted 标记：${on.evicted ? '✅ recency-floor-evicted' : '❌ 缺失'}；关保底控制组：[${off.selectedTitles.join(' | ')}]`,
    ],
  )

  // #26 退路：updated_at 置空（模拟老数据）→ 保底退回标题日期，不崩溃不劣化
  let nulled = false
  try {
    wsTs.store.db.prepare('UPDATE files SET updated_at = NULL').run()
    nulled = true
  } catch {
    /* db 直接访问失败 → 断言前提不成立，按跳过处理（仍要求选集非空） */
  }
  const fb = await runTs(7, 'fb')
  const fallbackOk = fb.selectedTitles.length > 0
  check(
    26,
    '近因保底·退路：写入时间戳缺失时回退标题日期（同日平局退化为分数序，不崩溃）',
    fallbackOk,
    [
      `置空 updated_at(${nulled ? '成功' : '跳过'}) 后开保底入选：[${fb.selectedTitles.join(' | ')}]（标题日期同日 → 平局按分数序；要求选集非空且无异常）`,
      `原始返回：${(fb.text || '').slice(0, 260).replace(/\n/g, ' ')}`,
    ],
  )
  wsTs.dispose?.()
}

hr('#27 空桶注入留痕：inject-skip reason=empty-corpus 落桶日志且带 session（票03——生产排查 f23d80 时疑缺此行）')
{
  const E_CWD = join(tmpdir(), `memo-river-empty-${process.pid}`)
  const ePaths = workspacePaths(E_CWD, '空桶测试')
  rmSync(E_CWD, { recursive: true, force: true })
  rmSync(ePaths.root, { recursive: true, force: true })
  mkdirSync(E_CWD, { recursive: true })
  const h27 = createMockCtx()
  apply(h27.ctx, makeConfig({ bucket: '空桶测试' }))
  const agent27 = createAgent('sess-empty-27', E_CWD, [])
  await runPreStep(h27, agent27, 1, [textMsg('user', '今天做点什么好？')], 1)
  let log27 = ''
  try {
    log27 = readFileSync(join(ePaths.root, 'memo-river.log'), 'utf8')
  } catch {
    /* 日志文件不存在 = 留痕失败，断言自然红 */
  }
  const skipOk = log27.includes('inject-skip') && log27.includes('empty-corpus')
  const sessionOk = log27.includes('session=sess-empty-27')
  check(
    27,
    '空桶：注入评估留 empty-corpus 跳过行 + session 归因（票02/03）',
    skipOk && sessionOk,
    [`桶日志片段：${log27.split('\n').filter((l) => l.includes('empty-corpus') || l.includes('inject-skip')).slice(-2).join(' ⏎ ') || '（无）'}`],
  )
}

hr('#28 注入日志可归因：inject 成功行带 session + gate 分数（票02——校准实验缺通过样本分布的补齐）')
{
  const h28 = createMockCtx()
  apply(h28.ctx, makeConfig({ bucket: BUCKET_RIVER, inject: { autonomousInjectEverySteps: 2 } }))
  const agent28 = createAgent('sess-log-28', WS_RIVER, [
    textMsg('user', '我这边现在渲染又卡了，上次教室那个是怎么解决的？'),
    textMsg('assistant', '上次是把阴影贴图降了一档。'),
  ])
  await runPreStep(h28, agent28, 1, [], 1)
  await runPreStep(h28, agent28, 1, [], 3)
  const riverLog = readFileSync(join(workspacePaths(WS_RIVER, BUCKET_RIVER).root, 'memo-river.log'), 'utf8')
  const ours = riverLog.split('\n').filter((l) => l.includes('session=sess-log-28'))
  const injectLine = ours.find((l) => l.includes('] [info] inject bucket='))
  const gateOk = !!injectLine && injectLine.includes('gate={passed:true') && injectLine.includes('maxKnn:') && injectLine.includes('retrievalMaxKnn:')
  check(
    28,
    '注入成功行带 session id 与 gate 分数块（maxKnn/threshold/gateVector/retrievalMaxKnn）',
    ours.length >= 1 && gateOk,
    [`本会话日志行数=${ours.length}；inject 行 gate 块：${injectLine?.slice(injectLine.indexOf('gate='), injectLine.indexOf('gate=') + 90) || '（无）'}`],
  )
}

hr('#29 增量锚工具输出封顶（截尾均值）+ 最小重发间隔（票05 用户拍板口径）')
{
  const { cappedToolChars, evaluateWriteNudge } = await import('../lib/injector.js')
  const { getSession } = await import('../lib/session.js')
  // 截尾均值：8 样本 [1000..3000]，去最高 10%（3000）最低 10%（1000）→ 均值 2000
  const warm = [1000, 2000, 3000, 2000, 1500, 2500, 1800, 2200]
  const capWarm = cappedToolChars(warm, 60000) === 2000
  const capCold = cappedToolChars([1000, 2000], 60000) === 4000 // 样本 <8 → 保守默认 4000
  const capSmall = cappedToolChars(warm, 2500) === 2500 // 未超默认上限的小输出不折
  const cfg29 = makeConfig({ bucket: BUCKET_RIVER, inject: { writeNudgeEverySteps: 10 } })
  const st29 = getSession('sess-nudge-29', null)
  st29.lastDiaryWriteStep = 0
  st29.lastWriteNudgeStep = 0
  st29.nudgeAnchorChars = 0
  st29.lastWriteNudgeAt = Date.now() - 2 * 60_000
  const blocked = evaluateWriteNudge(cfg29, st29, 1, Date.now(), 20, 1000) === null // stepDue 到位但 2 分钟内 → 压制
  st29.lastWriteNudgeAt = Date.now() - 6 * 60_000
  st29.lastWriteNudgeStep = 0
  const fired = !!evaluateWriteNudge(cfg29, st29, 1, Date.now(), 20, 1000) // 过 5 分钟 → 放行
  // 票01 handler 全路径：nudge 触发后 write-nudge 行必须落**桶日志**（deps.log 宿主面生产实测不可见）
  const h29h = createMockCtx()
  apply(
    h29h.ctx,
    makeConfig({
      bucket: BUCKET_RIVER,
      inject: { writeNudgeGrowthChars: 50, writeNudgeEverySteps: 0, writeNudgeEveryMinutes: 0, writeNudgeEveryTurns: 0 },
    }),
  )
  const agent29h = createAgent('sess-nudge-29h', WS_RIVER, [textMsg('user', '做点教室建模的事')])
  await runPreStep(h29h, agent29h, 1, [], 1) // step1：state 由召回路径惰性创建（本步 handler 看不到 wstate）
  await runPreStep(h29h, agent29h, 1, [], 2) // step2：wstate 就位 → nudgeAnchorChars 打底（growth=0）
  agent29h.log.push(textMsg('assistant', '第一段实质进展汇报：完成沙箱验证链路的布线与契约测试基线，接下来接线被动记账。'.repeat(3)))
  await runPreStep(h29h, agent29h, 1, [], 3) // step3：增量 ≥50 → 触发 → handler 落桶日志
  let nudgeLogLine = ''
  try {
    nudgeLogLine =
      readFileSync(join(workspacePaths(WS_RIVER, BUCKET_RIVER).root, 'memo-river.log'), 'utf8')
        .split('\n')
        .filter((l) => l.includes('write-nudge session=sess-nudge-29h'))
        .pop() ?? ''
  } catch {
    /* 读不到即断言红 */
  }
  const nudgeLogged = nudgeLogLine.includes('turn=') && nudgeLogLine.includes('reason=')
  check(
    29,
    '截尾均值封顶 + 5 分钟最小重发间隔 + write-nudge 触发行落桶日志（票01+05）',
    capWarm && capCold && capSmall && blocked && fired && nudgeLogged,
    [
      `封顶：warm=${capWarm ? '✅60000→2000' : `❌${cappedToolChars(warm, 60000)}`}；cold=${capCold ? '✅→4000' : '❌'}；small=${capSmall ? '✅25 不折' : '❌'}`,
      `间隔：2分钟内=${blocked ? '✅压制' : '❌'}；6分钟后=${fired ? '✅触发' : '❌'}；桶日志 write-nudge 行=${nudgeLogged ? '✅ ' + nudgeLogLine.slice(nudgeLogLine.indexOf('write-nudge'), nudgeLogLine.indexOf('write-nudge') + 70) : '❌ 未落盘'}`,
    ],
  )
}

hr('#30 digest 现取：自主态锚用最近助手实质文本，交互态锚优先回合摘要（票05）')
{
  const { evaluateWriteNudge } = await import('../lib/injector.js')
  const { getSession } = await import('../lib/session.js')
  const cfg30 = makeConfig({ bucket: BUCKET_RIVER, inject: { writeNudgeEverySteps: 5 } })
  const st30 = getSession('sess-nudge-30', null)
  st30.lastAssistantDigest = '完成了沙箱验证链路与契约测试'
  st30.lastDraftSummary = { turn: 2, at: Date.now(), suggestedTags: [], digest: '上一回合的旧战况', substantive: true }
  st30.lastDiaryWriteStep = 0
  st30.lastWriteNudgeStep = 0
  st30.lastWriteNudgeAt = 0
  st30.nudgeAnchorChars = 0
  const r30 = evaluateWriteNudge(cfg30, st30, 1, Date.now(), 10, 1000) // stepDue=自主态 → 鲜 digest
  const freshUsed = !!r30 && r30.includes('沙箱验证链路') && !r30.includes('旧战况')
  const cfg30b = makeConfig({
    bucket: BUCKET_RIVER,
    inject: { writeNudgeEveryTurns: 2, writeNudgeEveryMinutes: 0, writeNudgeEverySteps: 0, writeNudgeGrowthChars: 0 },
  })
  const st30b = getSession('sess-nudge-30b', null)
  st30b.lastAssistantDigest = '自主工作的助手文本'
  st30b.lastDraftSummary = { turn: 9, at: Date.now(), suggestedTags: [], digest: '回合摘要优先', substantive: true }
  st30b.lastDiaryWriteAt = Date.now() - 60_000
  st30b.lastDiaryWriteTurn = 1
  st30b.lastWriteNudgeTurn = 1
  st30b.lastWriteNudgeAt = 0
  st30b.activeMs = 0
  st30b.activeMsAnchor = 0
  const r30b = evaluateWriteNudge(cfg30b, st30b, 9, Date.now(), 1, 1000) // turnsDue=交互态 → draft 优先
  const draftPreferred = !!r30b && r30b.includes('回合摘要优先')
  check(
    30,
    '自主态 digest=最近助手实质文本（非陈旧 draft）；交互态 digest=回合摘要优先',
    freshUsed && draftPreferred,
    [
      `自主态：${freshUsed ? '✅ 用鲜弹药' : `❌ ${String(r30).slice(0, 120)}`}`,
      `交互态：${draftPreferred ? '✅ draft 优先' : `❌ ${String(r30b).slice(0, 120)}`}`,
    ],
  )
}

hr('#31 压缩后查询锚：注入选材取压缩后首段内容而非摘要摊平的旧热点（票07 生产场景复现）')
{
  const CA_CWD = join(tmpdir(), `memo-river-canchor-${process.pid}`)
  const caPaths = workspacePaths(CA_CWD, '压缩锚测试')
  rmSync(CA_CWD, { recursive: true, force: true })
  rmSync(caPaths.root, { recursive: true, force: true })
  mkdirSync(CA_CWD, { recursive: true })
  acquireWorkspace(CA_CWD, makeConfig({ bucket: '压缩锚测试' }))
  const wTool = h.registered.tools.find((t) => (t.name ?? t.definition?.name) === 'memo_write')
  const execW = wTool.execute.bind(wTool)
  const wCtx = { agent: createAgent('sess-ca-w', CA_CWD, []) }
  const exec = (title, date, body, reason) => {
    const args = { content: `# ${title}\n\n${body}\n\nTag: 压缩锚, 渲染管线, 热载方案` }
    if (date !== undefined) args.date = date
    if (reason !== undefined) args.newTagReason = reason
    return execW(args, wCtx)
  }
  await exec('旧渲染卡顿复盘', '2026-01-05', '结论：渲染卡顿是阴影贴图分辨率过高，降到一半就流畅了。', '新开测试桶，三个 Tag 都是该桶首批词汇')
  await exec('预设热载方案', undefined, '结论：会话级热载走注册到 agent.ctx 的路径，进程级路由一个进程只能挂一次。')
  const compact31 = {
    role: 'user',
    content: [{ type: 'text', text: 'Compressed 2 block(s), ~9286 tokens reclaimed. 摘要：本轮之前在排查渲染卡顿，讨论了阴影贴图与分辨率。 (id=acc31-c1)' }],
    source: { kind: 'plugin', plugin: 'compact', compactionId: 'acc31-c1' },
  }
  const h31 = createMockCtx()
  apply(h31.ctx, makeConfig({ bucket: '压缩锚测试', inject: { k: 1, dynamicK: 1, autonomousInjectEverySteps: 99, dedupeRefreshTurns: 99, tokenBudget: 900 } }))
  const agent31 = createAgent('sess-canchor-31', CA_CWD, [
    textMsg('user', '渲染又卡了，上次怎么解决的来着？'),
    compact31,
    textMsg('assistant', '热载方案：先写契约测试，然后把会话级注册走 agent.ctx，进程级路由只能挂一次要绕开。'),
  ])
  const d31 = await runPreStep(h31, agent31, 1, [], 2) // 无新输入；压缩事件触发
  const t31 = d31.messages.map(msgText).join('\n')
  const titles31 = [...t31.matchAll(/D\d+「([^」]+)」/g)].map((m) => m[1])
  const pickedHot = titles31.some((t) => t.includes('热载'))
  const notOld = !titles31.some((t) => t.includes('渲染'))
  let log31 = ''
  try {
    log31 = readFileSync(join(caPaths.root, 'memo-river.log'), 'utf8')
  } catch {
    /* 读不到日志不阻塞选材断言 */
  }
  const triggerOk = log31.includes('trigger=compaction') && log31.includes('session=sess-canchor-31')
  check(
    31,
    '压缩联动注入选材=压缩后内容（热载篇）而非摘要旧热点（渲染篇）；日志带 trigger 与 session',
    pickedHot && notOld && triggerOk,
    [
      `入选：[${titles31.join(' | ')}]（k=1 强制二选一；要求热载篇胜出）`,
      `日志：trigger=compaction+session=${triggerOk ? '✅' : '❌'}`,
    ],
  )
}

/* ══════════════════════ #32 票⑧ gate 锚拼接 ══════════════════════ */

hr('#32 gate 锚拼接 max(gU,gA)：短指令误杀修复（校准 A 方案）+ 回滚开关 + 无误放')
{
  const ws32 = acquireWorkspace(WS_RIVER, config)
  const LONG_ON =
    '教室建模这边把课桌的阵列摆完了：每张桌子复制后要应用旋转和缩放，不应用会导致实例属性残留；' +
    '材质统一给了木纹贴图，UV 要按 0.5 的比例缩放否则会重复平铺；渲染测试里阴影贴图分辨率开到 2048 会卡，' +
    '降到 1024 帧率就稳了。接下来把讲台和黑板的模型补进场景，再连一次光照烘培，顺便把窗户的光斑效果调出来。'
  const LONG_OFF =
    '晚饭我打算做红烧肉：五花肉焯水后冰糖炒糖色，加生抽老抽和黄酒，小火炖四十分钟收汁；' +
    '配一个番茄炒蛋，蛋要先煎到定型再出锅；汤用紫菜虾皮冲开水加点香油。周末还想试一次蛋糕，' +
    '低筋面粉加玉米油牛奶，蛋白打发到硬性发泡再翻拌，烤箱预热一百六十度烤四十分钟。'

  /* (a) handler 全路径：>150 字在题助手陈述被提取为锚 → 门控放行（gateVector=assistant） */
  const logs32 = []
  const off32 = ws32.logger.onLine((l) => logs32.push(l))
  const agent32 = createAgent('sess-gate-32a', WS_RIVER, [
    textMsg('user', '教室建模进行到哪了？'),
    textMsg('assistant', LONG_ON),
  ])
  const d32 = await runPreStep(h, agent32, 2, [textMsg('user', '继续吧')], 1)
  off32()
  const t32 = d32.messages.map(msgText).join('\n')
  const gateLine32 = logs32.find((l) => l.includes('inject ') && l.includes('sess-gate-32a')) ?? ''
  const rescuedHandler = t32.includes(BLOCK_CLOSE) && gateLine32.includes('gateVector:assistant')

  /* (a2) 直调 recall：数学口径——assistant 胜选 + 败选用户锚留痕 diagnostics
   * 注意 queryText 必须与 gateText 不同（同文守卫：gateText===queryText 时 gU 不算）。 */
  const opt32 = (qid, gateText, gateAssistantText) => ({
    mode: 'topology_v3', k: 3, tokenBudget: 600, dynamicK: 1, gate: true,
    gateThreshold: config.inject.gateThreshold, minKnnForReward: config.inject.minKnnForReward,
    queryId: qid, gateText, gateAssistantText,
  })
  const qf32 = buildQueryField(['教室建模进行到哪了？', LONG_ON, '继续吧'], config.inject.queryLookback)
  const outA = await ws32.recall(qf32, opt32('acc32a', '继续吧', LONG_ON))
  const mathOk =
    outA.injected && outA.gate.passed && outA.gate.gateVector === 'assistant' &&
    typeof outA.diagnostics.gateUserKnn === 'number' && outA.diagnostics.gateUserKnn < outA.gate.threshold

  /* (b) 回滚开关 gateAssistantAnchor=false → 同场景回到用户锚单选，压制如初 */
  const h32b = createMockCtx()
  apply(h32b.ctx, makeConfig({ bucket: BUCKET_RIVER, inject: { gateAssistantAnchor: false } }))
  const agent32b = createAgent('sess-gate-32b', WS_RIVER, [
    textMsg('user', '教室建模进行到哪了？'),
    textMsg('assistant', LONG_ON),
  ])
  const d32b = await runPreStep(h32b, agent32b, 2, [textMsg('user', '继续吧')], 1)
  const t32b = d32b.messages.map(msgText).join('\n')
  const rolledBack = !t32b.includes(BLOCK_CLOSE)

  /* (c) 无误放：长助手陈述离题（做饭）→ 双锚全低 → 仍压制 */
  const outC = await ws32.recall('继续吧', opt32('acc32c', '继续吧', LONG_OFF))
  const noFalsePass = !outC.injected && outC.fallbackReason === 'gate-below-threshold'

  check(
    32,
    'gate 锚拼接：max(gU,gA)@0.55 短指令误杀 0/17 口径落地；开关可回滚；无误放',
    rescuedHandler && mathOk && rolledBack && noFalsePass,
    [
      `(a) handler：注入=${t32.includes(BLOCK_CLOSE) ? '✅' : '❌'}  gateVector:assistant=${gateLine32.includes('gateVector:assistant') ? '✅' : '❌'}`,
      `(a2) 数学：passed=${outA.gate.passed ? '✅' : '❌'}  vector=${outA.gate.gateVector}  gU(留痕)=${typeof outA.diagnostics.gateUserKnn === 'number' ? outA.diagnostics.gateUserKnn.toFixed(4) : 'n/a'}  gA(胜选)=${outA.gate.maxKnn.toFixed(4)}`,
      `(b) 回滚开关(false)：压制=${rolledBack ? '✅' : '❌'}（回到用户锚单选）`,
      `(c) 误放防线：离题长助手陈述 → ${noFalsePass ? '✅ 仍压制' : `❌ gateVector=${outC.gate.gateVector} maxKnn=${outC.gate.maxKnn.toFixed(4)}`}`,
    ],
  )
}

/* ══════════════════════ #33 票⑥A artifactSig 确定性 ══════════════════════ */

hr('#33 artifactSig 确定性：同库连打 3 次构建 sig 逐位一致（票⑥A Rust 浮点定序回归线）')
{
  const ws33 = acquireWorkspace(WS_RIVER, config)
  const loaded33 = await ws33.ensureLoaded()
  const sigs33 = []
  let nodes33 = 0
  if (loaded33) {
    for (let i = 0; i < 3; i++) {
      const st = await ws33.engine.ensureArtifact()
      sigs33.push(st.artifactSig)
      nodes33 = st.nodeCount
    }
  }
  const unique33 = [...new Set(sigs33)]
  check(
    33,
    'artifactSig 确定性：HashMap 迭代序×f64 累加定序后，同库多次构建逐位一致（跨进程版见 scripts/probe-sig-determinism.mjs）',
    loaded33 && sigs33.length === 3 && unique33.length === 1 && nodes33 > 0,
    [
      `构建器真跑=${sigs33.length === 3 ? '✅ 3 次' : '❌'}  nodes=${nodes33 > 0 ? nodes33 : '❌ 0（空构建？）'}`,
      `sig 唯一数=${unique33.length === 1 ? '✅ 1' : `❌ ${unique33.length}`}  sig=${unique33[0]?.slice(0, 24) ?? 'n/a'}…`,
      `修复前基线：全新副本库 6/6 唯一（D24）；Rust 修复=build_transport 三处排序化（memo_artifact_builder.rs）`,
    ],
  )
}

/* ══════════════════════ #34 票⑥B artifact 行换代清理 ══════════════════════ */

hr('#34 artifact 行换代清理：每 schema 保最新 K 代；幂等；runOnce 挂钩触发（票⑥B）')
{
  const { WorkspaceDaemon, pruneArtifactGenerations } = await import('../lib/daemon.js')
  const ws34 = acquireWorkspace(WS_RIVER, config)
  const loaded34 = await ws34.ensureLoaded()
  let unitOk = false
  let removed34 = -1
  let kept34 = []
  let idempotent = false
  let wiringOk = false
  if (loaded34) {
    const db34 = ws34.store.db
    const now34 = Date.now()
    const fake = [
      ['gc-sig-a', now34 - 50_000],
      ['gc-sig-b', now34 - 40_000],
      ['gc-sig-c', now34 - 30_000],
      ['gc-sig-d', now34 - 20_000],
      ['gc-sig-e', now34 - 10_000],
    ]
    for (const [sig, ts] of fake) {
      db34.prepare(
        `INSERT OR REPLACE INTO rivermemo_artifacts
         (artifact_sig, schema_version, algorithm_version, source_v9_artifact_sig, source_graph_generation,
          model_sig, config_hash, database_generation, provenance_generation, payload,
          status, node_count, edge_count, created_at, updated_at)
         VALUES (?, 'test-gc-v1', 'probe', 'probe', 'probe', 'probe', 'probe', 'probe', 'probe', x'00', 'ready', 1, 1, ?, ?)`,
      ).run(sig, ts, ts)
    }
    /* (a) 单元：5 代 → 保 3 代，留的是 updated_at 最新三行（removed 是跨 schema 总数——
           real schema 的历史漂移行同轮被清属正确行为，断言只盯 test-gc-v1） */
    removed34 = pruneArtifactGenerations(ws34, 3)
    kept34 = (db34.prepare(
      `SELECT artifact_sig FROM rivermemo_artifacts WHERE schema_version = 'test-gc-v1' ORDER BY updated_at DESC`,
    ).all()).map((r) => r.artifact_sig)
    unitOk = kept34.length === 3 && kept34[0] === 'gc-sig-e' && kept34[2] === 'gc-sig-c' && removed34 >= 2
    /* (b) 幂等：再来一次零删除 */
    idempotent = pruneArtifactGenerations(ws34, 3) === 0
    /* (c) 接线：守护轮 runOnce 触发 GC 并落日志行（先补 2 行陈旧代供其清理） */
    const now34c = Date.now()
    for (const [sig, ts] of [
      ['gc-sig-f', now34c - 80_000],
      ['gc-sig-g', now34c - 70_000],
    ]) {
      db34.prepare(
        `INSERT OR REPLACE INTO rivermemo_artifacts
         (artifact_sig, schema_version, algorithm_version, source_v9_artifact_sig, source_graph_generation,
          model_sig, config_hash, database_generation, provenance_generation, payload,
          status, node_count, edge_count, created_at, updated_at)
         VALUES (?, 'test-gc-v1', 'probe', 'probe', 'probe', 'probe', 'probe', 'probe', 'probe', x'00', 'ready', 1, 1, ?, ?)`,
      ).run(sig, ts, ts)
    }
    const logs34 = []
    const daemon34 = new WorkspaceDaemon({
      config: { ...config, maintenance: { ...config.maintenance, drafts: false } },
      workspace: ws34,
      log: (_lv, msg) => logs34.push(msg),
      setInterval: () => () => {},
      takeDrafts: () => [],
    })
    await daemon34.runOnce()
    wiringOk = logs34.some((l) => /artifact-gc removed=2 keep=3/.test(l))
    /* 清理夹具 */
    db34.prepare(`DELETE FROM rivermemo_artifacts WHERE schema_version = 'test-gc-v1'`).run()
  }
  check(
    34,
    'artifact 行换代清理：每 schema 保最新 K 代（活跃代永不删）；幂等；守护轮挂钩',
    loaded34 && unitOk && idempotent && wiringOk,
    [
      `(a) 单元=${unitOk ? `✅ 5→3 代，留最新三行（本轮跨 schema 共清 ${removed34} 行，含 real schema 历史漂移残留）` : `❌ kept=${kept34.join(',')}`}`,
      `(b) 幂等=${idempotent ? '✅ 二次调用 0 删除' : '❌'}`,
      `(c) runOnce 接线=${wiringOk ? '✅ guardian artifact-gc 日志行出现' : '❌ 未触发'}`,
      `生产存量对照：dsh-memo-river 桶 218 行 / preset-composer 桶 136 行（票⑥A 修复前漂移产物，首轮守护即清）`,
    ],
  )
}

/* ══════════════════════ #35 票05 草稿队列可见性 ══════════════════════ */

hr('#35 草稿队列可见性：nudge 带队列数与最老年龄；面板常显各桶计数（票05）')
{
  const { tuningSnapshot, serveTuningPanel } = await import('../lib/tuning.js')
  const H = 3_600_000
  const NQ_CWD = join(tmpdir(), `memo-river-nudge-queue-${process.pid}`)
  const nq = workspacePaths(NQ_CWD, '草稿队列可见性测试')
  rmSync(NQ_CWD, { recursive: true, force: true })
  rmSync(nq.root, { recursive: true, force: true })
  mkdirSync(nq.pendingDir, { recursive: true })
  const now35 = Date.now()
  const mk35 = (name, ageH) => {
    const p = join(nq.pendingDir, name)
    writeFileSync(p, `# ${name}\n\n- 桶：草稿队列可见性测试\n- 回合：1 @ ${new Date(now35 - ageH * H).toISOString()}\n`)
    utimesSync(p, new Date(now35 - ageH * H), new Date(now35 - ageH * H)) // mtime = 最老年龄的量尺
  }
  mk35('2026-09-15T10-turn3.md', 3)
  mk35('2026-09-14T09-turn2.md', 27)
  acquireWorkspace(NQ_CWD, makeConfig({ bucket: '草稿队列可见性测试' })) // 落 manifest，面板桶名可读

  /* (a) 面板数据：计数 = pending/ 实际 .md 文件数；最老年龄 ≈ 27h */
  const snapA = tuningSnapshot(config, {}, () => [])
  const entryA = snapA.draftQueue.find((b) => b.hash === nq.hash)
  const filesA = readdirSync(nq.pendingDir).filter((f) => f.endsWith('.md')).length
  const panelDataOk = !!entryA && entryA.pending === filesA && entryA.pending === 2 && Math.abs(entryA.oldestAgeHours - 27) < 0.5

  /* (b)(c) nudge：队列非空带「N 篇待批（最老 X 小时）」；空队列不显示误导数字 */
  const h35 = createMockCtx()
  apply(h35.ctx, makeConfig({ bucket: '草稿队列可见性测试', inject: { writeNudgeEveryMinutes: 30 } }))
  const armNudge35 = async (sessId) => {
    const ag = createAgent(sessId, NQ_CWD, [textMsg('user', '队列可见性测试'), textMsg('assistant', '好的。')])
    await runPreStep(h35, ag, 2, [textMsg('user', '继续')], 1) // 惰性建 session state（此步无提醒条件）
    const st = peekSession(sessId)
    st.lastDiaryWriteAt = Date.now() - 35 * 60_000
    st.activeMs = 35 * 60_000 // 时间锚只量模型思考时长（与 #20 同口径）
    st.lastDraftSummary = { turn: 2, at: Date.now() - 60_000, suggestedTags: ['写入去重'], digest: '把积压的可见性做完' }
    const d = await runPreStep(h35, ag, 3, [textMsg('user', '再看一步')], 1)
    return d.messages.map(msgText).filter((t) => t.includes('[memo-river·写入节律]')).join('\n')
  }
  const nudgeA = await armNudge35('sess-nudge-queue-a')
  const queueLine = nudgeA.split('\n').find((l) => l.includes('篇待批')) ?? ''
  const nudgeOk =
    nudgeA.includes('草稿队列 2 篇待批（最老 27 小时）') &&
    nudgeA.includes('memo_write') &&
    nudgeA.includes('现在正是写日记的时机') &&
    queueLine.length > 0 &&
    queueLine.length <= 80 &&
    nudgeA.split('\n').length === 3
  for (const f of readdirSync(nq.pendingDir)) rmSync(join(nq.pendingDir, f))
  const nudgeB = await armNudge35('sess-nudge-queue-b')
  const emptyOk =
    nudgeB.includes('[memo-river·写入节律]') &&
    nudgeB.includes('memo_write') &&
    !nudgeB.includes('草稿队列') &&
    !nudgeB.includes('待批') &&
    nudgeB.split('\n').length === 2

  /* (d) 面板数据（清空后）：空桶在列显示 0 而非消失；面板 HTML 常显队列区 */
  const snapB = tuningSnapshot(config, {}, () => [])
  const entryB = snapB.draftQueue.find((b) => b.hash === nq.hash)
  const zeroOk = !!entryB && entryB.pending === 0 && entryB.oldestAgeHours === null
  let html35 = ''
  serveTuningPanel({ setHeader() {}, end(b) { html35 = String(b ?? '') } })
  const htmlOk = html35.includes('id="queue"') && html35.includes('草稿队列')

  check(
    35,
    '草稿队列可见性：nudge 带队列计数与最老年龄；面板常显各桶 pending（空=0）',
    panelDataOk && nudgeOk && emptyOk && zeroOk && htmlOk,
    [
      `(a) 面板读数=${panelDataOk ? `✅ pending=${entryA?.pending}（目录实际 ${filesA} 篇）最老=${entryA?.oldestAgeHours?.toFixed(1)}h` : `❌ ${JSON.stringify(entryA)}`}`,
      `(b) nudge 带队列=${nudgeOk ? `✅「${queueLine}」` : `❌ ${JSON.stringify(nudgeA)}`}`,
      `(c) 空队列不显示数字=${emptyOk ? '✅ 无队列行，原两行提醒保留' : `❌ ${JSON.stringify(nudgeB)}`}`,
      `(d) 空桶显示 0=${zeroOk ? '✅ pending=0 / oldest=null' : `❌ ${JSON.stringify(entryB)}`}；面板 HTML 队列区=${htmlOk ? '✅' : '❌'}；全局桶数=${snapB.draftQueue.length}`,
    ],
  )
  h35.dispose()
  rmSync(NQ_CWD, { recursive: true, force: true })
  rmSync(nq.root, { recursive: true, force: true })
}

/* ══════════════════════ #36 票06 守护循环草稿预审三态 ══════════════════════ */

hr('#36 守护预审三态：垃圾稳定「建议丢弃」；Tag 边界「需人工」；可批「可一键批」；纯只读不代批（票06）')
{
  const { WorkspaceDaemon } = await import('../lib/daemon.js')
  const { tuningSnapshot, serveTuningPanel } = await import('../lib/tuning.js')
  const { readDraftStatus, draftStatusPath } = await import('../lib/drafts.js')
  const PC_CWD = join(tmpdir(), `memo-river-precheck-${process.pid}`)
  const pc = workspacePaths(PC_CWD, '预审测试')
  rmSync(PC_CWD, { recursive: true, force: true })
  rmSync(pc.root, { recursive: true, force: true })
  mkdirSync(PC_CWD, { recursive: true })
  const ws36 = acquireWorkspace(PC_CWD, makeConfig({ bucket: '预审测试' }))
  const byName = (n) => h.registered.tools.find((t) => (t.name ?? t.definition?.name) === n)
  const wTool = byName('memo_write')
  const wExec = wTool.execute.bind(wTool)
  const dTool = byName('memo_drafts')
  const dExec = dTool.execute.bind(dTool)
  const aTool = byName('memo_approve')
  const aExec = aTool.execute.bind(aTool)
  const ctx36 = { agent: createAgent('sess-precheck', PC_CWD, []) }

  /* 嵌入桩（近重复路径专用）：正文含「孪生」→ 固定基向量；其余按 sha256 造近似正交向量。
   * 种子日记正文带「孪生」→ 其 chunk 向量 = twinVec；孪生样本草稿合成全文含「孪生」→
   * 余弦 1.0 > 0.95 踩响闸门；可批样本 → hashVec，与 twinVec 余弦 |cos| ≤ ~0.31，放行。 */
  const dim36 = ws36.resolved.dimension
  const twinVec = new Float32Array(dim36)
  twinVec[0] = 1
  const hashVec = (text) => {
    const dg = createHash('sha256').update(text).digest()
    const v = new Float32Array(dim36)
    for (let i = 0; i < dg.length; i++) v[i] = dg[i] / 127.5 - 1
    return v
  }
  let embedCalls = 0
  ws36.embed.embed = async (texts) => {
    embedCalls += 1
    /* 票02：内容判定（kNN）是 Tag 的**唯一**来源，故「Tag 不足 ⇒ 需人工」只剩两条可达路径——
     * 空词表，或**嵌入不可用**。这里用后者：对含「嵌入失败」的文本抛错，走 `knnTagsForDraft`
     * 的 catch 分支（`src/drafts.ts:380-382`）⇒ tags=[] ⇒ manual。
     * 旧判据「建议 Tag ∩ 词汇表 < 3」在非空桶已**不可构造**：非空桶必有 ≥3 个 Tag，
     * 而 `curateTags` 无余弦地板（词表里最近的几个总会被取到）。 */
    return texts.map((t) => {
      if (t.includes('嵌入失败')) throw new Error('stub-embed-down')
      return t.includes('孪生') ? twinVec : hashVec(t)
    })
  }
  Object.defineProperty(ws36.embed, 'configured', { get: () => true, configurable: true })

  /* ① 种子词汇（3 个可复用 Tag）+ 近重复锚（chunk 向量 = twinVec） */
  const seed36 = await wExec(
    {
      content: '# 种子：预审基线\n\n结论：近重复比对的孪生锚，正文提及孪生标记以命中桩向量。\n\nTag: 预审渲染, 预审卡顿, 预审复盘',
      newTagReason: '预审测试空库，三概念首引',
    },
    ctx36,
  )
  const seedOk = seed36.includes('✅ 已写入')

  /* ② 四类样本草稿（junk 是 D10 红线样本：空用户+空助手，但 Tag 够 3 个——机械批准时代它会入库污染）。
   *   票02 后「Tag 边界」样本改走**嵌入不可用**路径（见上面的桩）：assistant 文本带「嵌入失败」标记
   *   ⇒ 内容判定拿不到 Tag ⇒ manual；仍保留四态分布 {ok:1, manual:2, discard:1}。 */
  const draftBody36 = (turn, user, assistant, tags) =>
    [
      '# 候选草稿（等确认，未入库）',
      '',
      `- 会话：session-precheck-${turn}`,
      `- 回合：${turn} @ 2026-09-15T0${turn}:00:00.000Z`,
      `- 桶：${ws36.paths.bucket}`,
      '',
      '## 本轮用户',
      user,
      '',
      '## 本轮助手',
      assistant,
      '',
      '## 建议 Tag（来自本轮被动召回的 matchedTags，须经 memo_tags 复核后复用）',
      tags,
      '',
      '## 相关旧日记',
      '(无)',
      '',
      '> 本文件是**草稿**：确认后用 memo_write 显式入库（会走 Tag 校验与枢纽闸门）。',
    ].join('\n')
  mkdirSync(pc.pendingDir, { recursive: true })
  const P = {
    ok: join(pc.pendingDir, '2026-09-15-可批样本-t10.md'),
    bnd: join(pc.pendingDir, '2026-09-15-边界样本-t11.md'),
    junk: join(pc.pendingDir, '2026-09-15-垃圾样本-t12.md'),
    twin: join(pc.pendingDir, '2026-09-15-孪生样本-t13.md'),
  }
  writeFileSync(P.ok, draftBody36(10, '预审怎么分级', '结论：垃圾丢、Tag 不足人工、其余看过近重复再放行。', '预审渲染, 预审卡顿, 预审复盘'))
  writeFileSync(P.bnd, draftBody36(11, '边界样本问一句', '结论：嵌入失败时内容判定不可用 ⇒ 需人工。', '预审渲染, 预审卡顿'))
  writeFileSync(P.junk, draftBody36(12, '', '', '预审渲染, 预审卡顿, 预审复盘'))
  writeFileSync(P.twin, draftBody36(13, '孪生问题再问一遍', '结论：与种子同途的孪生复述，应当被指认。', '预审渲染, 预审卡顿, 预审复盘'))
  writeFileSync(join(pc.pendingDir, '孤儿检验.md.status.json'), '{"state":"ok"}\n') // 孤儿状态文件：对应 .md 不存在 → 本轮被清扫

  /* 守护轮前的读数：4 篇全部 unchecked；快照 .md 字节/mtime/库计数做只读对照基线 */
  const snapPre = tuningSnapshot(config, {}, () => []).draftQueue.find((b) => b.hash === pc.hash)
  const uncheckedOk = snapPre?.precheck.unchecked === 4 && snapPre?.precheck.ok === 0
  const bytesBefore = Object.fromEntries(Object.entries(P).map(([k, p]) => [k, readFileSync(p, 'utf8')]))
  const mtimesBefore = Object.fromEntries(Object.entries(P).map(([k, p]) => [k, statSync(p).mtimeMs]))
  const countsBefore = JSON.stringify(await ws36.readSync(() => ws36.store.counts()))

  /* ③ 守护轮 ×2：落伴随 .status.json、随轮刷新、判定稳定（垃圾两轮都建议丢弃） */
  const logs36 = []
  const daemon36 = new WorkspaceDaemon({
    config: makeConfig({ bucket: '预审测试' }),
    workspace: ws36,
    log: (_lv, m) => logs36.push(m),
    setInterval: () => () => {},
    takeDrafts: () => [],
  })
  const round1 = await daemon36.runOnce()
  const round2 = await daemon36.runOnce()
  const st = Object.fromEntries(Object.entries(P).map(([k, p]) => [k, readDraftStatus(p)]))
  const statesOk =
    round1.ok && round2.ok && st.ok?.state === 'ok' && st.bnd?.state === 'manual' && st.junk?.state === 'discard' && st.twin?.state === 'manual'
  const junkStable = st.junk?.state === 'discard' && st.junk.reason.includes('空用户+空助手')
  const twinReason = st.twin?.nearDup && st.twin.nearDup.score > 0.95 && st.twin.reason.includes('近重复')
  const roundFieldOk = JSON.stringify(round1.draftPrecheck) === JSON.stringify({ ok: 1, manual: 2, discard: 1, failures: 0 }) && JSON.stringify(round2.draftPrecheck) === JSON.stringify(round1.draftPrecheck)
  const logLineOk = logs36.some((m) => m.includes('draft-precheck') && m.includes('ok=1') && m.includes('manual=2') && m.includes('discard=1'))
  const sweepOk = !existsSync(join(pc.pendingDir, '孤儿检验.md.status.json'))

  /* ④ 只读红线：.md 字节/mtime 不动、库计数不变（不写库/不改正文/不动体检资产） */
  const readonlyOk =
    Object.entries(P).every(([k, p]) => readFileSync(p, 'utf8') === bytesBefore[k] && statSync(p).mtimeMs === mtimesBefore[k]) &&
    JSON.stringify(await ws36.readSync(() => ws36.store.counts())) === countsBefore

  /* ⑤ 面板/草稿列表的三态分布展示 */
  const snapPost = tuningSnapshot(config, {}, () => []).draftQueue.find((b) => b.hash === pc.hash)
  const entryOk = snapPost?.pending === 4 && JSON.stringify(snapPost?.precheck) === JSON.stringify({ ok: 1, manual: 2, discard: 1, unchecked: 0 })
  let html36 = ''
  serveTuningPanel({ setHeader() {}, end(b) { html36 = String(b ?? '') } })
  const htmlOk = html36.includes('id="queue"') && html36.includes('预审三态')
  const drafts36 = String(await dExec({ all: true, limit: 200 }, ctx36))
  const draftsOk = drafts36.includes('预审分布') && drafts36.includes('[可一键批]') && drafts36.includes('[建议丢弃]') && drafts36.includes('[需人工]') && drafts36.includes('垃圾样本')

  /* ⑥ 出队带走伴随状态文件：approve 可批样本 → approved/ 同进 .md + .status.json，队列读数联动 */
  const appr36 = String(await aExec({ ids: ['可批样本'] }, ctx36))
  const approvedDir = join(pc.root, 'approved')
  const moveOk =
    existsSync(join(approvedDir, '2026-09-15-可批样本-t10.md')) &&
    existsSync(join(approvedDir, '2026-09-15-可批样本-t10.md.status.json')) &&
    !existsSync(P.ok) &&
    !existsSync(draftStatusPath(P.ok)) &&
    !appr36.includes('全部跳过')
  const snapAfter = tuningSnapshot(config, {}, () => []).draftQueue.find((b) => b.hash === pc.hash)
  const afterOk = snapAfter?.pending === 3 && snapAfter?.precheck.ok === 0 && snapAfter?.precheck.manual === 2 && snapAfter?.precheck.discard === 1

  check(
    36,
    '守护预审三态：discard 稳定/边界 manual/可批 ok/近重复 manual；纯只读；面板+列表+出队联动',
    seedOk && statesOk && junkStable && !!twinReason && roundFieldOk && logLineOk && sweepOk && readonlyOk && uncheckedOk && entryOk && htmlOk && draftsOk && moveOk && afterOk,
    [
      `(a) 三态判定=${statesOk ? '✅ ok→ok、嵌入失败→manual、junk→discard、孪生→manual' : `❌ ${JSON.stringify(Object.fromEntries(Object.entries(st).map(([k, v]) => [k, v?.state ?? null])))}`}`,
      `(b) D10 红线（垃圾稳定丢弃，Tag 够也拦）=${junkStable ? `✅ ${st.junk?.reason.slice(0, 40)}…` : `❌ ${JSON.stringify(st.junk)}`}`,
      `(c) 近重复指认=${twinReason ? `✅ score=${st.twin?.nearDup?.score.toFixed(4)} twin=${st.twin?.nearDup?.path.slice(-40)}` : `❌ ${JSON.stringify(st.twin)}`}`,
      `(d) GuardianRound/日志=${roundFieldOk && logLineOk ? `✅ ${JSON.stringify(round1.draftPrecheck)}` : `❌ ${JSON.stringify(round1.draftPrecheck)}`}（嵌入批调用=${embedCalls} 次）`,
      `(e) 只读红线（.md 字节+mtime+库计数不变）=${readonlyOk ? '✅' : '❌'}；孤儿清扫=${sweepOk ? '✅' : '❌'}；守护前 unchecked=${uncheckedOk ? '✅ 4/4' : `❌ ${JSON.stringify(snapPre?.precheck)}`}`,
      `(f) 队列读数=${entryOk ? '✅ {ok:1,manual:2,discard:1,unchecked:0}' : `❌ ${JSON.stringify(snapPost?.precheck)}`}；面板三态列=${htmlOk ? '✅' : '❌'}；memo_drafts 三态=${draftsOk ? '✅' : '❌'}`,
      `(g) 出队联动=${moveOk && afterOk ? `✅ approved/ 同进 .md+.status.json；队列余 pending=${snapAfter?.pending}（ok=0/manual=2/discard=1）` : `❌ move=${moveOk} after=${JSON.stringify(snapAfter?.precheck)}`}；批准回报头：${appr36.split('\n')[0]?.slice(0, 60)}`,
    ],
  )
  rmSync(PC_CWD, { recursive: true, force: true })
  rmSync(pc.root, { recursive: true, force: true })
}

/* ══════════════════════ #37 票05（recall-quality-0916）write-nudge 场景感知文案 ══════════════════════ */

hr('#37 write-nudge 场景感知：普通含质量锚≤3行；委托变体（depth/工具闩锁）；memo_write 后回落；四锚参数不动（票05）')
{
  const { renderWriteNudge } = await import('../lib/render.js')
  const ANCHOR = '写增量（延续/转折/因果），不复述已入河内容'
  const tags37 = ['写入去重', '回合边界依赖']

  /* (a) 快照：普通形态——质量锚折进第 2 行，基底 2 行；带队列恰 3 行（≤3 红线）
   * 2026-09-28 断言漂移修正：文案升级（工具输出/提交状态排除 + Tag 内容词指引 + 候选 Tag 措辞）
   * 后字节级冻结断言失效——改为**结构断言**（行数红线 + 决定性片段），文案微升不再炸断言。 */
  const normSnap = renderWriteNudge('已 2 轮汇报未写入', 5, '把队列可见性做完', tags37, null, false)
  const normQueueSnap = renderWriteNudge('已 2 轮汇报未写入', 5, '把队列可见性做完', tags37, { pending: 2, oldestAgeHours: 27 }, false)
  const normSnapOk =
    normSnap.split('\n').length === 2 &&
    !normSnap.includes('委托进行中') &&
    normSnap.includes(ANCHOR) &&
    normSnap.includes('不复述已入河内容、工具输出、提交状态或压缩记录') &&
    normSnap.includes('本轮候选 Tag：写入去重、回合边界依赖') &&
    normSnap.includes('规范见「写日记规范」段')
  const normQueueOk = normQueueSnap.split('\n').length === 3 && normQueueSnap.includes('草稿队列 2 篇待批（最老 27 小时）')

  /* (b) 快照：委托形态——先落盘+读者点明+锚三要素齐；基底 3 行；带队列 4 行（同上：结构断言） */
  const delSnap = renderWriteNudge('已 2 轮汇报未写入', 5, '扇出前的关键进展', tags37, null, true)
  const delSnapOk =
    delSnap.split('\n').length === 3 &&
    delSnap.includes('委托进行中——先落盘当前进展：子代理/兄弟代理可立即召回') &&
    delSnap.includes('读者是兄弟代理而非未来的自己') &&
    delSnap.includes(ANCHOR) &&
    delSnap.includes('本轮候选 Tag：写入去重、回合边界依赖')
  const delQueueLines = renderWriteNudge('已 2 轮汇报未写入', 5, '扇出前的关键进展', tags37, { pending: 2, oldestAgeHours: 27 }, true).split('\n').length
  const delQueueOk = delQueueLines === 4

  /* (c) 探测全链路（真实 seam）：subagent 工具调用闩锁 → 变体；memo_write 观测 → 闩清回落 */
  const h37 = createMockCtx()
  apply(h37.ctx, makeConfig({ bucket: BUCKET_RIVER, inject: { writeNudgeEveryMinutes: 30 } }))
  const toolMsg37 = (name) => ({ role: 'assistant', content: [{ type: 'tool-call', name }], source: { kind: 'model' } })
  const ag37 = createAgent('sess-nudge-37', WS_RIVER, [textMsg('user', '场景感知测试'), textMsg('assistant', '好的。')])
  const nudgesOf37 = (d) => d.messages.map(msgText).filter((t) => t.includes('[memo-river·写入节律]')).join('\n')
  const arm37 = (st, digest) => {
    st.lastDiaryWriteAt = Date.now() - 35 * 60_000
    st.activeMs += 35 * 60_000 // 时间锚只量思考时长（与 #20/#35 同口径）
    st.lastDraftSummary = { turn: 3, at: Date.now() - 60_000, suggestedTags: ['写入去重'], digest, substantive: true }
    st.lastWriteNudgeAt = Date.now() - 6 * 60_000 // 过 5 分钟最小重发间隔
  }
  await runPreStep(h37, ag37, 2, [textMsg('user', '先聊')], 1) // 惰性建 session state
  const st37 = peekSession('sess-nudge-37')
  arm37(st37, '扇出前的关键进展')
  const nA = nudgesOf37(await runPreStep(h37, ag37, 3, [textMsg('user', '继续')], 1))
  const normalFired = nA.includes(ANCHOR) && !nA.includes('委托进行中') && nA.split('\n').length === 2 // WS_RIVER 队列空 → 无队列行
  ag37.log.push(toolMsg37('subagent')) // 委托调用进日志 → 下一拍闩上
  arm37(st37, '扇出进行中')
  const nB = nudgesOf37(await runPreStep(h37, ag37, 3, [textMsg('user', '看看兄弟')], 2))
  const latchOn =
    st37.delegationActive === true &&
    nB.includes('先落盘当前进展：子代理/兄弟代理可立即召回') &&
    nB.includes('读者是兄弟代理而非未来的自己') &&
    nB.includes(ANCHOR) &&
    nB.split('\n').length === 3
  ag37.log.push(toolMsg37('memo_write')) // 进展已落盘 → 闩清
  await runPreStep(h37, ag37, 3, [textMsg('user', '落盘了')], 3)
  const latchedOff = st37.delegationActive === false && st37.lastDiaryWriteAt > Date.now() - 5_000
  arm37(st37, '写完继续推进')
  const nC = nudgesOf37(await runPreStep(h37, ag37, 3, [textMsg('user', '继续推进')], 4))
  const backToNormal = nC.includes(ANCHOR) && !nC.includes('委托进行中')

  /* (d) delegationDepth 路径：被派的孩子会话（header.delegationDepth=2，零委托调用）→ 变体 */
  const deepLog = [textMsg('user', '孩子会话'), textMsg('assistant', '好的。')]
  const agDeep = { session: { id: 'sess-nudge-37-deep', header: { cwd: WS_RIVER, delegationDepth: 2 }, deriveMessages: () => deepLog }, log: deepLog }
  await runPreStep(h37, agDeep, 2, [textMsg('user', '孩子先聊')], 1)
  const stDeep = peekSession('sess-nudge-37-deep')
  arm37(stDeep, '兄弟代理的检索基底')
  const nD = nudgesOf37(await runPreStep(h37, agDeep, 3, [textMsg('user', '孩子继续')], 1))
  const depthVariant = nD.includes('委托进行中') && nD.includes('子代理/兄弟代理可立即召回') && stDeep.delegationActive === false // 纯 depth 触发，非闩锁

  /* (e) 遥测：write-nudge 桶日志行带 delegation 标记（变体触发可归因） */
  let logDeepOk = false
  let logNormOk = false
  try {
    const lines37 = readFileSync(join(workspacePaths(WS_RIVER, BUCKET_RIVER).root, 'memo-river.log'), 'utf8').split('\n')
    logDeepOk = lines37.some((l) => l.includes('write-nudge session=sess-nudge-37 ') && l.includes('delegation=1(depth=0+latch)'))
    logNormOk = lines37.some((l) => l.includes('write-nudge session=sess-nudge-37 ') && l.includes('delegation=0'))
  } catch {
    /* 读不到即断言红 */
  }

  /* (f) 四锚参数回归（票面红线：7min/2turns/40steps/50K chars 不动） */
  const cfg37 = makeConfig()
  const anchorsOk =
    cfg37.inject.writeNudgeEveryMinutes === 7 &&
    cfg37.inject.writeNudgeEveryTurns === 2 &&
    cfg37.inject.writeNudgeEverySteps === 40 &&
    cfg37.inject.writeNudgeGrowthChars === 50_000

  check(
    37,
    'write-nudge 场景感知：普通形态含质量锚（≤3 行）；委托变体三要素；memo_write 回落；四锚不动（票05）',
    normSnapOk && normQueueOk && delSnapOk && delQueueOk && normalFired && latchOn && latchedOff && backToNormal && depthVariant && logDeepOk && logNormOk && anchorsOk,
    [
      `(a) 普通快照=${normSnapOk ? '✅ 2 行含锚' : `❌ ${JSON.stringify(normSnap)}`}；带队列=${normQueueOk ? '✅ 3 行' : `❌ ${normQueueSnap.split('\n').length} 行`}`,
      `(b) 委托快照=${delSnapOk ? '✅ 三要素（先落盘/读者点明/锚）齐' : `❌ ${JSON.stringify(delSnap)}`}；带队列=${delQueueOk ? '✅ 4 行' : `❌ ${delQueueLines} 行`}`,
      `(c) 探测链路：普通触发=${normalFired ? '✅' : '❌'}；subagent 闩锁=${latchOn ? '✅ 变体' : `❌ ${JSON.stringify(nB.slice(0, 80))}`}；memo_write 回落=${latchedOff && backToNormal ? '✅ 闩清+普通形态' : `❌ latch=${st37.delegationActive} 回落=${backToNormal}`}`,
      `(d) delegationDepth=2=${depthVariant ? '✅ 变体（纯 depth，非闩锁）' : `❌ ${JSON.stringify(nD.slice(0, 80))}`}；日志 delegation 标记=${logDeepOk && logNormOk ? '✅ 1(depth+latch)/0 两态' : `❌ deep=${logDeepOk} norm=${logNormOk}`}`,
      `(e) 四锚默认=${anchorsOk ? '✅ 7min/2turns/40steps/50K' : `❌ ${JSON.stringify({ m: cfg37.inject.writeNudgeEveryMinutes, t: cfg37.inject.writeNudgeEveryTurns, s: cfg37.inject.writeNudgeEverySteps, c: cfg37.inject.writeNudgeGrowthChars })}`}`,
    ],
  )
  h37.dispose()
}

/* ══════════════════════ 汇总 ══════════════════════ */

h.dispose()
hr('验收汇总')
const pass = results.filter((r) => r.pass).length
for (const r of results.sort((a, b) => a.id - b.id)) line(`  #${String(r.id).padStart(2)} ${r.pass ? '✅' : '❌'}  ${r.title}`)
line(`\n  通过 ${pass}/${results.length}`)
process.exit(pass === results.length ? 0 : 1)
