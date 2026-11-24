#!/usr/bin/env node
/**
 * acceptance-decision-rerank.mjs — P0b 判别式决策重排接缝（2026-10-16）。
 *
 * 治什么：8122 `chinese-decision-0.8b`（docs/PLAN-2026-10-15 §P0b 定案）作为**轮内重排器**
 * 接进 `src/injector.ts` 的 buildTailInjection——只重排、不当阈值、不与检索分加权
 * （RRF 0.333 vs 纯重排 0.431）；off 档**逐字节旧行为**。
 *
 * **负对照 fixture 纪律（同 #8 名次快照，不许静默自愈）**：
 *   `scripts/acceptance-decision-rerank.fixture.json` 是用**改动前 lib** 录制的 off 档
 *   三轮场景（注入 → identical-skip → 换问注入）的注入块文本 + 归一化（elapsedMs）日志行。
 *   流程：①改 src 前跑 `--record` 录制；②立刻 `--verify-fixture-only` 复跑一次证明场景
 *   跨运行稳定（分不清「我的改动」还是「场景抖动」时这条负对照就是定罪证据）；
 *   ③改动后缺省模式断逐位相等。**将来有意改注入行/渲染格式导致本套件红**：显式重录
 *   `--record` 并人工 diff fixture——禁止删断言、禁止自动覆盖。
 *
 * 决策服务桩（不依赖 8122 真服务）：node:http 本地起 good/garbage/param/stall 四种
 * 端点 + 拒连端点（127.0.0.1:1），全部在本进程内，套件可离线跑。
 *
 * 编号承接 acceptance-inject-dedup.mjs（#61-68），本套件 #69-81。
 *
 * 自建自净：`import './isolated-env.mjs'`；嵌入桩同 inject-dedup（hashVector 按
 * ws.resolved.dimension 裁剪 + configured getter）。
 * 用法：`node scripts/acceptance-decision-rerank.mjs [--record|--verify-fixture-only]`
 */
import './isolated-env.mjs' // DSH_HOME 隔离：自建自净，不碰生产桶
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import http from 'node:http'
import { apply, Config as ConfigSchema } from '../lib/index.js'
import { acquireWorkspace } from '../lib/workspace.js'
import { workspacePaths } from '../lib/runtime.js'
import { hashVector } from './embed-stub.mjs'

const RECORD = process.argv.includes('--record')
const FIXTURE_ONLY = process.argv.includes('--verify-fixture-only')
const FIXTURE_PATH = new URL('./acceptance-decision-rerank.fixture.json', import.meta.url)

const results = []
const line = (s = '') => console.log(s)
function check(id, title, pass, evidence) {
  results.push({ id, title, pass })
  line(`\n【决策重排-验收 #${id}】${title}  →  ${pass ? '✅ PASS' : '❌ FAIL'}`)
  for (const e of [].concat(evidence)) line(`    ${e}`)
}

const VCP = process.env.MEMO_VCP_ROOT ?? (process.platform === 'win32' ? 'E:/h/plugins/dsh-memo-river/.vcp-absent' : '/home/h/app/VCPToolBox')
const bucket = '决策重排'
/** 所有腿共用的会话名——inject 日志行含 session=，跨腿比对必须同名。 */
const SESSION = 'sess-decision-fixture'

/** 注入块里的入选 D 编号（切掉「[本次未注入」之后的未注入明细行——那是声明不是命中）。 */
const injectedIds = (blockText) =>
  String(blockText)
    .split('[本次未注入')[0]
    .split('\n')
    .map((l) => l.match(/^D(\d+)/))
    .filter(Boolean)
    .map((m) => Number(m[1]))

/* ── 最小 Cordis / Agent 替身（与 acceptance-inject-dedup.mjs 同款，只 mock 宿主不 mock 被测逻辑）── */
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
      disposers.push(cb())
      return () => {
        try {
          disposers.forEach((d) => d?.())
        } catch {
          /* 静默 */
        }
      }
    },
    systemPrompt: { section: () => () => {}, context: () => () => {} },
    tools: {
      register(t) {
        registered.tools.push(t)
        return () => {}
      },
    },
    get: () => undefined,
    interval: () => () => {},
  }
  return { ctx, listeners, registered, dispose: () => disposers.forEach((d) => { try { d?.() } catch { /* 静默 */ } }) }
}
const textMsg = (role, text) => ({ role, content: [{ type: 'text', text }], source: { kind: role === 'user' ? 'user' : 'model' } })
function createAgent(sessionId, cwd, priorLog = []) {
  const log = [...priorLog]
  return { session: { id: sessionId, header: { cwd }, deriveMessages: () => log }, log }
}
const textOf = (m) => {
  const c = m?.content
  if (typeof c === 'string') return c
  if (!Array.isArray(c)) return ''
  return c.map((b) => (typeof b?.text === 'string' ? b.text : '')).join('\n')
}
async function runPreStep(h, agent, turn, claimed, step = 1) {
  const list = h.listeners.get('agent/pre-step') ?? []
  let next = async () => ({ kind: 'enter', messages: [...claimed] })
  for (let i = list.length - 1; i >= 0; i--) {
    const fn = list[i].fn
    const downstream = next
    next = () => fn({ agent, messages: claimed, turn, step, signal: { aborted: false } }, downstream)
  }
  const decision = await next()
  if (decision?.kind === 'enter') agent.log.push(...decision.messages)
  return decision
}

const ROOT = join(tmpdir(), `memo-river-decrk-${process.pid}`)
mkdirSync(ROOT, { recursive: true })

/** 集成腿环境（同 inject-dedup 的 makeEnv，多挂一个 ws.logger 内存 sink 抓日志行）。 */
function makeEnv(legName, injectOverrides = {}) {
  const cwd = join(ROOT, legName)
  safeRm(cwd)
  mkdirSync(cwd, { recursive: true })
  safeRm(workspacePaths(cwd, bucket).root)
  const config = ConfigSchema({ bucket, native: { vcpRoot: VCP }, inject: injectOverrides })
  const h = createMockCtx()
  apply(h.ctx, config)
  const ws = acquireWorkspace(cwd, config)
  const dim = ws.resolved.dimension
  const vec = (text) => {
    const v = hashVector(text)
    const out = new Float32Array(dim)
    for (let i = 0; i < dim; i++) out[i] = v[i % v.length]
    return out
  }
  ws.embed.embed = async (texts) => texts.map(vec)
  Object.defineProperty(ws.embed, 'configured', { get: () => true, configurable: true })
  /** Logger 行格式 `[ISO] [level] message`（src/runtime.ts:109）——剥前缀只留 message。 */
  const logSink = []
  ws.logger.onLine((l) => logSink.push(l.replace(/^\[[^\]]+\] \[\w+\] /, '')))
  const writeTool = h.registered.tools.find((t) => (t.name ?? t.definition?.name) === 'memo_write')
  const wExec = writeTool.execute.bind(writeTool)
  const writeDiary = async (n, { title, body, tags }, sid = SESSION) => {
    const out = String(
      await wExec(
        {
          content: `# ${title}\n\n结论：${body}。\n\nTag: ${tags.join(', ')}`,
          newTagReason: `${title}：三个 Tag（${tags.join('/')}）均为本篇专属主题词，语义不重复`,
        },
        { agent: createAgent(`${sid}-w${n}`, cwd, []) },
      ),
    )
    const m = out.match(/已写入\s*D(\d+)/)
    return { ok: out.includes('已写入'), id: m ? Number(m[1]) : null, text: out }
  }
  return { cwd, config, h, ws, logSink, writeDiary, close: () => { ws.close?.(); h.dispose() } }
}

/* ── 夹具场景：5 篇两域日记（Tag 全不相同，防同义闸拒写），三轮注入 ── */
const BASE_INJECT = {
  gate: false, k: 3, adaptiveKRatio: 0, tokenBudget: 1e9, queryLookback: 1,
  dedupeSelection: true, dedupeRefreshTurns: 8, dedupeLiveEntries: true,
  // 写节律锚全关：turn 锚（2）会在第 3 轮注入写提醒、污染场景确定性。
  writeNudgeEveryMinutes: 0, writeNudgeEveryTurns: 0, writeNudgeEverySteps: 0, writeNudgeGrowthChars: 0,
}
const DIARIES = [
  { mech: '阴影贴图档位过高', body: '第 1 批的渲染卡顿来自阴影贴图档位过高，降到 1024 后帧率恢复', tags: ['阴影贴图', '档位校准', '帧率恢复'] },
  { mech: '顶点数超预算', body: '渲染卡顿来自顶点数超预算导致合批失败，按材质排序后恢复', tags: ['顶点数', '合批策略', '材质排序'] },
  { mech: '后处理采样过多', body: '渲染卡顿来自后处理 bloom 采样过多，关掉后帧率恢复', tags: ['后处理', '管线简化', '采样开销'] },
  { mech: '麦克风增益溢出', body: '音频会议爆音来自麦克风增益溢出，降到 0.7 后干净', tags: ['麦克风增益', '溢出削波', '增益校准'] },
  { mech: '缓冲区欠载', body: '音频会议爆音来自 ALSA 缓冲区欠载，加大 buffer 后稳定', tags: ['缓冲区', '欠载修复', '音频稳定'] },
]
// ⚠️ 必须 ≥16 字：shouldSkipDecision 的判空闸（DECISION_MIN_STATE_CHARS=16）——首版 15 字
//   导致 turn1 打分被跳、#76/#77/#78 全红（真实根因，别再踩）。
const QUERY_A = '渲染又卡掉了，上一批的解决方案再讲一遍'
const QUERY_B = '音频会议爆音很严重，之前是怎么修好的'

const isRecallBlock = (m) => m?.source?.kind === 'memo-river' && m?.source?.form === 'recall'
/**
 * 日志行归一化：时变量与场景变量——elapsedMs；session=（每腿必须唯一 session id，
 * 否则 injector.ts:376 时序闸 `turn < state.lastTurn` 会把第二腿的 turn1 静默吞掉，
 * 这是 2026-10-16 实测定罪的跨腿状态残留坑）；文件名随机 slug 同 normText。
 */
const norm = (l) => l.replace(/elapsedMs=\d+(\.\d+)?/g, 'elapsedMs=X').replace(/session=\S+/g, 'session=X')
/** 块文本归一化：条目标题行含日记文件名（2026-10-15-mv9t5w5x-…），slug 8 位随机——与被测行为无关。 */
const normText = (t) => (t ?? '').replace(/\d{4}-\d{2}-\d{2}-[a-z0-9]{8}-/g, 'DATE-SLUG-')
const INJECT_LINE_RE = /^(inject|inject-skip|inject-decision|decision-)\b/

/**
 * 跑一遍三轮场景（off 语义由 overrides 控制），返回可逐位比对的产物。
 * 轮 1 QUERY_A → 注入；轮 2 同问 → identical-skip；轮 3 QUERY_B → 换集注入（含条目级去重路径）。
 */
async function runScenario(legName, injectOverrides) {
  const env = makeEnv(legName, injectOverrides)
  const { h, cwd, writeDiary, close, logSink } = env
  let okW = true
  // ⚠️ 每腿唯一 session id：getSession 是模块级 Map，同 id 跨腿会让 injector.ts:376
  //    时序闸把第二腿的 turn1 静默吞掉（零日志零注入——2026-10-16 实测定罪）。
  const sid = `${SESSION}-${legName}`
  for (const [i, d] of DIARIES.entries()) {
    const w = await writeDiary(i + 1, { title: `${i < 3 ? '渲染' : '音频'}样本${i + 1}：${d.mech}`, body: d.body, tags: d.tags }, sid)
    okW = w.ok && okW
  }
  const agent = createAgent(sid, cwd, [textMsg('user', QUERY_A)])
  const turn = async (t, q) => {
    const d = await runPreStep(h, agent, t, [textMsg('user', q)], 1)
    return d.messages.filter(isRecallBlock).map(textOf).join('\n') || null
  }
  const turn1 = await turn(1, QUERY_A)
  const turn2 = await turn(2, QUERY_A)
  const turn3 = await turn(3, QUERY_B)
  // shadow 的打分行是 fire-and-forget：给异步任务一个落账窗口再收割日志。
  await new Promise((r) => setTimeout(r, 400))
  const lines = logSink.filter((l) => INJECT_LINE_RE.test(l)).map(norm)
  close()
  return {
    okW, turn1: normText(turn1), turn2, turn3: normText(turn3), lines, logSinkCount: logSink.length, rawHead: logSink.slice(0, 6),
    listeners: (h.listeners.get('agent/pre-step') ?? []).length,
  }
}

/* ═══ 负对照 fixture：record / compare ═══ */
function fixtureFromRun(run) {
  return { okW: run.okW, turn1: run.turn1, turn2: run.turn2, turn3: run.turn3, lines: run.lines }
}

if (RECORD) {
  const run = await runScenario('fixture', { ...BASE_INJECT })
  if (!run.okW || !run.turn1 || !run.turn3) {
    line(`❌ 场景不合法（okW=${run.okW} turn1=${!!run.turn1} turn3=${!!run.turn3}）——不录坏 fixture，先查夹具`)
    process.exitCode = 1
  } else {
    writeFileSync(FIXTURE_PATH, JSON.stringify(fixtureFromRun(run), null, 2) + '\n')
    line(`✅ 已录制 fixture：turn1 ${run.turn1.length} 字 / turn3 ${run.turn3.length} 字 / 日志行 ${run.lines.length} 条`)
    line(`   turn1 注入 ids=[${injectedIds(run.turn1)}]，turn3 注入 ids=[${injectedIds(run.turn3)}]`)
    for (const l of run.lines) line(`   · ${l}`)
    line(`   ⚠️ 人工核对上面这几行再继续（同 SNAPSHOT 纪律：不许静默自愈）`)
  }
} else {
  if (!existsSync(FIXTURE_PATH)) {
    line(`❌ 缺 ${FIXTURE_PATH.pathname} —— 先在【改动前】lib 上跑 --record 录制负对照`)
    process.exitCode = 1
  } else {
    const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'))
    const eq = (a, b) => a === b

    /* ═══ #74 off 缺省（不传任何 decision 键）= 改动前 fixture 逐位一致 ═══ */
    {
      const run = await runScenario('off-default', { ...BASE_INJECT })
      const sameText = eq(run.turn1, fixture.turn1) && eq(run.turn2, fixture.turn2) && eq(run.turn3, fixture.turn3)
      const sameLines = JSON.stringify(run.lines) === JSON.stringify(fixture.lines)
      const noDecisionTrace = run.lines.every((l) => !/^(inject-decision|decision-)/.test(l))
      check(
        74,
        'off 缺省 = 改动前逐位一致（注入块文本 + 归一化日志行 + 零 decision 痕迹）',
        run.okW && sameText && sameLines && noDecisionTrace,
        [
          `三轮文本逐位一致=${sameText}（turn1 ${run.turn1?.length ?? 'null'} 字 / turn3 ${run.turn3?.length ?? 'null'} 字）`,
          `inject/inject-skip 行逐位一致=${sameLines}（${run.lines.length} 条 vs fixture ${fixture.lines.length} 条）`,
          `无 inject-decision / decision-* 行=${noDecisionTrace}（off 必须零副作用：不发请求、不打日志）`,
          `这是 P0b 的回退红线：decisionRerank 缺省 off ⇒ 本刀不改变任何既有注入行为`,
        ],
      )
    }

    /* ═══ #75 显式 'off' === 缺省（两形态都咬住 fixture）═══ */
    {
      const run = await runScenario('off-explicit', { ...BASE_INJECT, decisionRerank: 'off' })
      const same = eq(run.turn1, fixture.turn1) && eq(run.turn3, fixture.turn3) && JSON.stringify(run.lines) === JSON.stringify(fixture.lines)
      const firstDiff = (a, b) => {
        if (a === b) return '(一致)'
        const la = (a ?? '').split('\n'), lb = (b ?? '').split('\n')
        const i = la.findIndex((x, j) => x !== lb[j])
        return `首异行#${i}: ${JSON.stringify(la[i])} vs ${JSON.stringify(lb[i])}`
      }
      check(75, "显式 decisionRerank:'off' 与缺省逐位一致", run.okW && same, [
        `文本+日志行与 fixture 逐位一致=${same}（运维显式关 = 等价缺省关）｜okW=${run.okW}｜listeners=${run.listeners}｜sink 行数=${run.logSinkCount}`,
        `turn1 ${firstDiff(run.turn1, fixture.turn1)}`,
        `turn3 ${firstDiff(run.turn3, fixture.turn3)}`,
        `原始日志头：${JSON.stringify(run.rawHead)}`,
      ])
    }

    if (!FIXTURE_ONLY) {
      /* ── 决策模块（改动后才存在；record/verify 模式不走到这）── */
      const {
        shouldSkipDecision, buildDecisionStateZh, clipDecisionBody, rerankByDecision,
        scoreCandidateDecision, scoreDecisionBatch, DECISION_BODY_CHARS, DECISION_MAX_CONCURRENCY,
        DECISION_INSTRUCTION, resetDecisionWarningsForTests,
      } = await import('../lib/decision.js')

      /* ── 本地决策服务桩（⑥ 是非题契约：逐字模板 / append_none:false / options 否+是 / p=D编号÷10）── */
      const readBody = (req) => new Promise((resolve) => { let s = ''; req.on('data', (c) => { s += c }); req.on('end', () => resolve(s)) })
      async function startServer(handler) {
        const srv = http.createServer(handler)
        await new Promise((r) => srv.listen(0, '127.0.0.1', r))
        return { url: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise((r) => { srv.closeAllConnections?.(); srv.close(r) }) }
      }
      /** ⑥ 桩工厂：校验请求形状（append_none=false / options / instructions / 逐字模板）、
       *  按 state_zh 里的 D 编号定 p（id/10）、回显 instructions_used。
       *  echoInstruction 给定 → 回显它而非请求值（模拟未参数化旧服务）。 */
      async function makeSixServer({ echoInstruction = undefined, delayMs = 0 } = {}) {
        const stats = { violations: [], requests: 0, maxInFlight: 0, inFlight: 0 }
        const srv = await startServer(async (req, res) => {
          stats.requests += 1
          stats.inFlight += 1
          stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight)
          try {
            const body = JSON.parse((await readBody(req)) || '{}')
            if (body.append_none !== false) stats.violations.push(`append_none=${JSON.stringify(body.append_none)}`)
            if (JSON.stringify(body.options) !== JSON.stringify([{ key: 'false', desc: '否' }, { key: 'true', desc: '是' }])) stats.violations.push(`options=${JSON.stringify(body.options)}`)
            if (body.instructions !== DECISION_INSTRUCTION) stats.violations.push(`instructions=${JSON.stringify(body.instructions)}`)
            const m = String(body.state_zh ?? '').match(/^当前任务上下文：\n[\s\S]+\n\n候选记忆（(D\d+(?:@[^\n）]*)?)｜[^\n]*）：\n[\s\S]+$/)
            if (!m) stats.violations.push(`state_zh-template=${JSON.stringify(String(body.state_zh ?? '').slice(0, 40))}…`)
            const id = m ? Number(m[1].match(/\d+/)[0]) : 0
            if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs))
            const p = id / 10
            res.setHeader('content-type', 'application/json')
            res.end(JSON.stringify({ probs: { false: 1 - p, true: p }, ranked: p >= 0.5 ? ['true', 'false'] : ['false', 'true'], instructions_used: echoInstruction ?? body.instructions }))
          } finally {
            stats.inFlight -= 1
          }
        })
        return { stats, url: srv.url, close: () => srv.close() }
      }
      const goodServer = await makeSixServer()
      const staleServer = await makeSixServer({ echoInstruction: '哪个技能最应该为这个任务加载？' })
      const slowServer = await makeSixServer({ delayMs: 500 })
      const badShapeServer = await startServer(async (req, res) => { await readBody(req); res.end(JSON.stringify({ probs: { false: 0.5 } })) })
      const garbageServer = await startServer(async (req, res) => { await readBody(req); res.end('{"probs": 这不是 JSON') })
      const http500Server = await startServer(async (req, res) => { await readBody(req); res.statusCode = 500; res.end('boom') })
      const stallStats = { requests: 0 }
      const stallServer = await startServer(async () => { stallStats.requests += 1 /* 永不响应 */ })
      const REFUSED = 'http://127.0.0.1:1'

      const mkLogger = () => { const lines_ = []; return { lines: lines_, info: (m) => lines_.push(m), warn: (m) => lines_.push(m), error: (m) => lines_.push(m) } }
      const CANDS = [
        { key: 'k2', d: 'D2', title: '标题二', body: '正文二' },
        { key: 'k1', d: 'D1', title: '标题一', body: '正文一' },
        { key: 'k3', d: 'D3', title: '标题三', body: '正文三' },
      ]

      /* ═══ #69 shouldSkipDecision ═══ */
      {
        const cases = [
          ['', true], ['   \n\t ', true], ['短问', true],
          ['这一条足够长的上下文问句超过十六字了', false],
        ]
        const pass = cases.every(([s, want]) => shouldSkipDecision(s) === want)
        check(69, 'shouldSkipDecision：空/空白/<16 字 → true（空上下文轮跳过，AUC 0.43-0.66 判据）', pass,
          cases.map(([s, want]) => `${JSON.stringify(s)} → ${shouldSkipDecision(s)}（期望 ${want}）`))
      }

      /* ═══ #70 state_zh 逐字模板 + body 截断口径 ═══ */
      {
        const zh = buildDecisionStateZh('状态甲', 'D12@父桶', '标题十二', '正文十二')
        const exact = zh === '当前任务上下文：\n状态甲\n\n候选记忆（D12@父桶｜标题十二）：\n正文十二'
        const clipped = clipDecisionBody('首段。\n\n  第二段 有空白。  \n尾段', 10)
        const clipOk = clipped === '首段。 第二段 有空' && clipped.length === 10
        const over600 = clipDecisionBody('x'.repeat(800)).length === DECISION_BODY_CHARS
        const empty = clipDecisionBody(null) === '' && clipDecisionBody(' \n \n ') === ''
        check(
          70,
          'buildDecisionStateZh/clipDecisionBody：run_gate2.py:87 逐字模板；body=非空行 join(\' \')[:600]',
          exact && clipOk && over600 && empty,
          [
            `模板逐字节=${exact}：${JSON.stringify(zh)}`,
            `多行折叠+截断=${clipOk}：${JSON.stringify(clipped)}（build_tests.py:62-70 口径）`,
            `800 字 → ${DECISION_BODY_CHARS} 字上限=${over600}；null/全空白 → ''=${empty}`,
            `⚠️ 模板任何一处不同（换行/标点）就是不同的 prompt、不同的数——改这里必须重过 gate2 一致性`,
          ],
        )
      }

      /* ═══ #71 rerankByDecision ═══ */
      {
        const rows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
        const keyOf = (c) => c.id
        const byP = rerankByDecision(rows, { a: 0.1, b: 0.5, c: 0.3 }, keyOf)
        const ties = rerankByDecision(rows, { a: 0.5, b: 0.5, c: 0.2 }, keyOf)
        const partial = rerankByDecision(rows, { b: 0.9 }, keyOf)
        const noneOnly = rerankByDecision(rows, { none: 0.95, a: 0.01 }, keyOf)
        const untouched = rows.map((r) => r.id).join('') === 'abc'
        check(
          71,
          'rerankByDecision：p 降序 / 并列稳定 / 无分沉尾保序 / 未知键忽略 / 纯函数不改输入',
          JSON.stringify(byP) === JSON.stringify([{ id: 'b' }, { id: 'c' }, { id: 'a' }]) &&
            JSON.stringify(ties) === JSON.stringify(rows) &&
            JSON.stringify(partial) === JSON.stringify([{ id: 'b' }, { id: 'a' }, { id: 'c' }]) &&
            JSON.stringify(noneOnly) === JSON.stringify([{ id: 'a' }, { id: 'b' }, { id: 'c' }]) &&
            untouched,
          [
            `全有分 {a:.1,b:.5,c:.3} → [${byP.map((r) => r.id)}]（降序）`,
            `并列 {a:.5,b:.5} → [${ties.map((r) => r.id)}]（稳定：提交序）`,
            `只有 b 有分 → [${partial.map((r) => r.id)}]（topN 只打头部 ⇒ 无分沉尾保持原相对序 = 头部置换+尾部不动）`,
            `probs 含未知键（none 等）不炸不排位 → [${noneOnly.map((r) => r.id)}]（append_none:false 后不应出现，防御性）`,
            `输入数组未被改动=${untouched}（off/降级路径共用同一引用，改输入=污染旧行为）`,
          ],
        )
      }

      /* ═══ #72 scoreCandidateDecision 降级矩阵（任何失败 → null + 记因，绝不抛）═══ */
      {
        const lg = mkLogger()
        const cases = []
        resetDecisionWarningsForTests()
        const zh = buildDecisionStateZh('状态文本足够长'.repeat(3), 'D7', '标题七', '正文七')
        const rGood = await scoreCandidateDecision(zh, { endpoint: goodServer.url, timeoutMs: 2000, logger: lg })
        cases.push([`good → p=D7 ⇒ 0.7（probs.true）`, rGood === 0.7])
        cases.push([`instructions_used 回显一致 → 无警告`, !lg.lines.some((l) => l.includes('decision-not-parameterized'))])
        const rGarbage = await scoreCandidateDecision(zh, { endpoint: garbageServer.url, timeoutMs: 2000, logger: lg })
        cases.push(['坏 JSON → null + kind=bad-json', rGarbage === null && lg.lines.some((l) => l.includes('decision-error') && l.includes('kind=bad-json'))])
        const rShape = await scoreCandidateDecision(zh, { endpoint: badShapeServer.url, timeoutMs: 2000, logger: lg })
        cases.push(['probs 无 true 位 → null + kind=bad-shape', rShape === null && lg.lines.some((l) => l.includes('kind=bad-shape'))])
        const rRefused = await scoreCandidateDecision(zh, { endpoint: REFUSED, timeoutMs: 2000, logger: lg })
        cases.push(['拒连 → null + kind=network', rRefused === null && lg.lines.some((l) => l.includes('kind=network'))])
        const r500 = await scoreCandidateDecision(zh, { endpoint: http500Server.url, timeoutMs: 2000, logger: lg })
        cases.push(['HTTP 500 → null + kind=http-500', r500 === null && lg.lines.some((l) => l.includes('kind=http-500'))])
        const tStall = Date.now()
        const rStall = await scoreCandidateDecision(zh, { endpoint: stallServer.url, timeoutMs: 150, logger: lg })
        const stallElapsed = Date.now() - tStall
        cases.push(['挂起 → timeoutMs 截断 → null + kind=timeout', rStall === null && stallElapsed < 2000 && lg.lines.some((l) => l.includes('kind=timeout'))])
        const rNoState = await scoreCandidateDecision('   ', { endpoint: goodServer.url, timeoutMs: 2000, logger: lg })
        cases.push(['空 state_zh → 直接 null（服务必填非空）', rNoState === null])
        // 未参数化服务（instructions_used 回显 ≠ 我们的⑥指令）→ 警告一次，p 照常返回
        const lg2 = mkLogger()
        resetDecisionWarningsForTests()
        const rStale = await scoreCandidateDecision(zh, { endpoint: staleServer.url, timeoutMs: 2000, logger: lg2 })
        const warnCount = () => lg2.lines.filter((l) => l.includes('decision-not-parameterized')).length
        const w1 = warnCount()
        await scoreCandidateDecision(zh, { endpoint: staleServer.url, timeoutMs: 2000, logger: lg2 })
        cases.push([`回显旧硬编码 → p 返回 + 警告一次（${w1}→${warnCount()}）`, rStale === 0.7 && w1 === 1 && warnCount() === 1])
        check(
          72,
          'scoreCandidateDecision：读 probs["true"]；坏 JSON/缺位/拒连/500/挂起/空参 全 → null + decision-error 记因；instructions_used 失配警告一次',
          cases.every(([, ok]) => ok),
          cases.map(([name, ok]) => `${name}：${ok ? '✅' : '❌'}`).concat([
            `挂起腿实际耗时 ${stallElapsed}ms（timeoutMs=150 截断）——降级铁律：任何失败返回 null，调用方保原序`,
          ]),
        )
      }

      /* ═══ #73 批量：并发 ≤2 + 整批 deadline + 不重试 ═══ */
      {
        const lg = mkLogger()
        resetDecisionWarningsForTests()
        const before = goodServer.stats.requests
        const res3 = await scoreDecisionBatch('状态文本足够长'.repeat(3), CANDS, { endpoint: goodServer.url, timeoutMs: 2000, logger: lg })
        const concOk = goodServer.stats.maxInFlight <= DECISION_MAX_CONCURRENCY
        const allOk = res3.asked === 3 && res3.answered === 3 && res3.probs.k1 === 0.1 && res3.probs.k2 === 0.2 && res3.probs.k3 === 0.3
        // 整批 deadline：slow 桩每条 500ms、timeoutMs=200 → wave1（2 条）发出即超时，第 3 条不再发
        const beforeSlow = slowServer.stats.requests
        const resD = await scoreDecisionBatch('状态文本足够长'.repeat(3), CANDS, { endpoint: slowServer.url, timeoutMs: 200, logger: lg })
        const deadlineOk = resD.asked === 2 && resD.answered === 0 && slowServer.stats.requests - beforeSlow === 2
        // 不重试：stall 桩永不响应、timeoutMs=150 → 恰好 2 个请求（wave1），绝无重发
        const beforeStall = stallStats.requests
        const resS = await scoreDecisionBatch('状态文本足够长'.repeat(3), CANDS, { endpoint: stallServer.url, timeoutMs: 150, logger: lg })
        const noRetryOk = stallStats.requests - beforeStall === 2 && resS.asked === 2 && resS.answered === 0
        check(
          73,
          'scoreDecisionBatch：并发 ≤2 / 全量成功键值正确 / 整批 deadline 不发新请求 / 超时绝不重试',
          concOk && allOk && deadlineOk && noRetryOk,
          [
            `3 候选 maxInFlight=${goodServer.stats.maxInFlight}（≤${DECISION_MAX_CONCURRENCY}）；asked=${res3.asked} answered=${res3.answered}；p k1/k2/k3=${res3.probs.k1}/${res3.probs.k2}/${res3.probs.k3}`,
            `deadline（500ms 桩/200ms 预算）：发出=${resD.asked}（wave1 恰 2 条，第 3 条到点不发）answered=${resD.answered}`,
            `不重试（挂起桩）：请求数恰 ${stallStats.requests - beforeStall}（超时后零重发）——重试会把 800ms 预算吃两遍`,
            `延迟预算依据：单条 p99=243ms，k=3 串行最坏 ≈730ms 逼近 800ms（父会话 2026-10-16 实测指令）`,
          ],
        )
      }

      /* ═══ #76 shadow：注入内容与日志行逐位不变 + 打分落独立 inject-decision 行 ═══ */
      {
        resetDecisionWarningsForTests()
        const run = await runScenario('shadow', { ...BASE_INJECT, decisionRerank: 'shadow', decisionEndpoint: goodServer.url, decisionTimeoutMs: 2000 })
        const sameText = run.turn1 === fixture.turn1 && run.turn3 === fixture.turn3
        const mainLines = run.lines.filter((l) => /^(inject|inject-skip) /.test(l))
        const sameLines = JSON.stringify(mainLines) === JSON.stringify(fixture.lines)
        const shadowLines = run.lines.filter((l) => l.startsWith('inject-decision'))
        const hasP = shadowLines.some((l) => l.includes('mode=shadow') && l.includes('decisionP=') && l.includes('asked='))
        const noPOnMain = mainLines.every((l) => !l.includes('decisionP='))
        check(
          76,
          'shadow：注入块与 inject/inject-skip 行逐位=fixture 且主行无 decisionP；打分落独立 inject-decision 行',
          run.okW && sameText && sameLines && hasP && noPOnMain,
          [
            `文本逐位=${sameText}；主日志行逐位=${sameLines}（shadow 不 await ⇒ inject 行已打印，p 值只能落后续行）`,
            `主行比对：${JSON.stringify(mainLines)} vs fixture ${JSON.stringify(fixture.lines)}`,
            `inject-decision 行 ${shadowLines.length} 条，样例：${shadowLines[0] ?? '(无)'}`,
            `设计注：与「加在既有 inject 行上」的字面意图有张力——fire-and-forget 物理上无法回填已打印行，父会话已确认此裁决`,
          ],
        )
      }

      /* ═══ #77 on + good：同步重排 + inject 行尾追加 decisionP + 请求形状零违规 ═══ */
      {
        resetDecisionWarningsForTests()
        const before = goodServer.stats.requests
        const run = await runScenario('on-good', { ...BASE_INJECT, decisionRerank: 'on', decisionEndpoint: goodServer.url, decisionTimeoutMs: 2000 })
        const offIds = injectedIds(fixture.turn1)
        const onIds = injectedIds(run.turn1)
        // 桩 p = D编号/10 ⇒ 渲染序 = id 降序；off 序 [2,1,3] → on 序 [3,2,1]
        const sorted = JSON.stringify(onIds) === JSON.stringify(offIds.slice().sort((a, b) => b - a))
        const inj1 = run.lines.find((l) => l.startsWith('inject '))
        const fx1 = fixture.lines.find((l) => l.startsWith('inject '))
        const pVals = offIds.slice(0, 3).map((id) => (id / 10).toFixed(2)).join('/')
        const suffixOk = !!inj1 && !!fx1 && inj1.startsWith(fx1) && inj1.includes(`decisionP=${pVals} decisionRerank=on`)
        const shapeOk = goodServer.stats.violations.length === 0
        const noNone = !!inj1 && !inj1.includes('none=')
        const noWarn = !run.lines.some((l) => l.includes('decision-not-parameterized'))
        check(
          77,
          'on+good：按 p(⑥)=D/10 降序重排；inject 行 = fixture 行 + decisionP 后缀（无 none 位）；请求形状零违规；回显一致无警告',
          run.okW && sorted && suffixOk && shapeOk && noNone && noWarn,
          [
            `off ids=[${offIds}] → on ids=[${onIds}]（桩 p=D/10 ⇒ id 降序）=${sorted}`,
            `inject 行后缀=${suffixOk}：${inj1 ? '…' + inj1.slice(-70) : '(无)'}`,
            `桩校验（append_none=false / options 否+是 / ⑥指令 / 逐字模板）违规 ${goodServer.stats.violations.length} 条${shapeOk ? ' ✅' : '：' + JSON.stringify(goodServer.stats.violations.slice(0, 3))}`,
            `无 none 位=${noNone}（append_none:false ⇒ 响应只有 false/true）；无未参数化警告=${noWarn}`,
          ],
        )
      }

      /* ═══ #78 on + stale 回显：警告在场，但 p 照常返回、重排照常生效 ═══ */
      {
        resetDecisionWarningsForTests()
        const run = await runScenario('on-stale', { ...BASE_INJECT, decisionRerank: 'on', decisionEndpoint: staleServer.url, decisionTimeoutMs: 2000 })
        const offIds = injectedIds(fixture.turn1)
        const onIds = injectedIds(run.turn1)
        const sorted = JSON.stringify(onIds) === JSON.stringify(offIds.slice().sort((a, b) => b - a))
        const warnOk = run.lines.some((l) => l.includes('decision-not-parameterized'))
        check(
          78,
          'on+stale（instructions_used 回显旧硬编码）：显著警告一次；transport 未坏 ⇒ p 返回、重排照常（语义脏由运维裁决）',
          run.okW && sorted && warnOk,
          [
            `ids=[${offIds}] → [${onIds}]（p 照常）=${sorted}`,
            `decision-not-parameterized 警告在场=${warnOk}（若真 8122 回滚到旧版，on 档打分是技能语义——警告让这事显形）`,
          ],
        )
      }

      /* ═══ #79/#80 on + 死端点：降级 = 逐位 fixture + 记因，无 decisionP ═══ */
      // @ts-ignore — 纯 JS 套件
      for (const [id, leg, endpointKey, timeout, wantKind] of [
        [79, 'on-refused', REFUSED, 800, 'network'],
        [80, 'on-stall', null, 150, 'timeout'],
      ]) {
        resetDecisionWarningsForTests()
        const endpoint = endpointKey ?? stallServer.url
        const run = await runScenario(leg, { ...BASE_INJECT, decisionRerank: 'on', decisionEndpoint: endpoint, decisionTimeoutMs: timeout })
        const sameText = run.turn1 === fixture.turn1 && run.turn3 === fixture.turn3
        const inj1 = run.lines.find((l) => l.startsWith('inject '))
        const noP = !!inj1 && !inj1.includes('decisionP=')
        const errOk = run.lines.some((l) => l.includes(`kind=${wantKind}`) || l.includes('decision-degraded'))
        check(
          id,
          `on+${leg === 'on-refused' ? '拒连' : '挂起'}：降级保原序——注入块逐位=fixture、inject 行无 decisionP、失败已记因`,
          run.okW && sameText && noP && errOk,
          [
            `注入块逐位一致=${sameText}（降级铁律：服务挂了记忆注入照常走，绝不因模型阻塞）`,
            `inject 行无 decisionP=${noP}；decision-error/degraded 记因=${errOk}`,
          ],
        )
      }

      /* ═══ #81 接线断言（源码级）═══ */
      {
        const src = readFileSync(new URL('../src/injector.ts', import.meta.url), 'utf8')
        const cfg = readFileSync(new URL('../src/config.ts', import.meta.url), 'utf8')
        const dec = readFileSync(new URL('../src/decision.ts', import.meta.url), 'utf8')
        const gated = /decisionMode\s*!==\s*'off'/.test(src)
        const guarded = /effective\.selected\.length\s*>\s*1/.test(src)
        const iRerank = src.indexOf('rerankByDecision(effective.selected')
        const iRender = src.indexOf('renderInjection(finalOutcome')
        const iEffective = src.indexOf('const effective: RecallOutcome')
        const ordered = iRerank > iEffective && iRender > iRerank
        const idsUntouched = /ids=\$\{outcome\.selected\.map/.test(src)
        const awaitCount = (src.match(/await scoreDecisionBatch/g) ?? []).length
        const voidCount = (src.match(/void scoreDecisionBatch/g) ?? []).length
        const suffixWired = /elapsedMs=\$\{outcome\.elapsedMs\}\$\{decisionSuffix\}/.test(src)
        const defaultOff = /decisionRerank[\s\S]*?default\('off'\)/.test(cfg)
        const templateWired = dec.includes('当前任务上下文：\\n${state}\\n\\n候选记忆（${d}｜${title}）：\\n${body}')
        const appendNoneWired = dec.includes('append_none: false')
        const noRetry = !/retry|retries/i.test(dec)
        check(
          81,
          '接线断言：off 门 + selected>1 守卫 + 重排先于渲染 + ids= 口径未动 + shadow 不 await/on 恰一次 await + 行尾后缀 + 缺省 off + ⑥ 模板/append_none/无重试',
          gated && guarded && ordered && idsUntouched && awaitCount === 1 && voidCount === 1 && suffixWired && defaultOff && templateWired && appendNoneWired && noRetry,
          [
            `decisionRerank!=='off' 门=${gated}｜selected>1 守卫=${guarded}（单条/空集无重排意义）`,
            `effective(${iEffective}) → rerank(${iRerank}) → render(${iRender}) 顺序=${ordered}`,
            `ids= 仍用 outcome.selected（含被剔条目）=${idsUntouched}——off 逐位一致红线的口径锚`,
            `await scoreDecisionBatch ×${awaitCount}（仅 on）、void ×${voidCount}（仅 shadow）`,
            `decisionSuffix 挂在 elapsedMs 之后=${suffixWired}；config 缺省 'off'=${defaultOff}`,
            `⑥ 逐字模板在 decision.ts=${templateWired}；append_none:false=${appendNoneWired}；无重试代码=${noRetry}`,
          ],
        )
      }

      await Promise.all([goodServer, staleServer, slowServer, badShapeServer, garbageServer, http500Server, stallServer].map((s) => s.close()))
    }
    safeRm(ROOT)
  }
}

const passed = results.filter((r) => r.pass).length
if (results.length > 0) {
  line('\n' + '═'.repeat(88))
  line(`决策重排验收：${passed}/${results.length} ${passed === results.length ? '✅ 全绿' : '❌ 有红'}`)
  for (const r of results) if (!r.pass) line(`  ❌ #${r.id} ${r.title}`)
  line('═'.repeat(88))
  if (passed !== results.length) process.exitCode = 1
}

import { safeRm } from './safe-rm.mjs'
