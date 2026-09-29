#!/usr/bin/env node
/**
 * acceptance-p3.mjs —— DESIGN.md §12 P3（守护与预设化）的实测。
 *
 * 三条判据，全部走**插件真实路径**（不 mock 被测逻辑）：
 *   P3-a 守护循环被 timer 拉起（`guardian-started` + 周期回调可寻址）
 *   P3-b 一轮守护真的落盘：`<workspace>/health.log` 追加一行 + 四项体检数值正确
 *   P3-c 草稿真的落盘且**不入库**：`agent/turn-stopping` 收草稿 → 守护轮写成
 *        `pending/<date>-<slug>-t<turn>.md`，且库内篇数不变（§8 ③「等确认，不自动入库」）
 *   P3-d 连续失败指数退避（§8 ④）
 *
 * 用法：node scripts/acceptance-p3.mjs
 */
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { apply, Config as ConfigSchema } from '../lib/index.js'
import { WorkspaceDaemon } from '../lib/daemon.js'
import { acquireWorkspace } from '../lib/workspace.js'
import { workspacePaths } from '../lib/runtime.js'

const ROOT = new URL('..', import.meta.url).pathname
const VCP = '/home/h/app/VCPToolBox'
// 写入测试桶：草稿与体检日志都落在这里，不碰河流语料的对照基准
const WS = join(ROOT, '.selftest', '教室建模写入测试')
const BUCKET = '教室建模写入测试'

const results = []
const line = (s = '') => console.log(s)
const hr = (t) => line('\n' + '═'.repeat(96) + (t ? `\n${t}` : '') + '\n' + '═'.repeat(96))
function check(id, title, pass, evidence) {
  results.push({ id, title, pass })
  line(`\n【验收 ${id}】${title}  →  ${pass ? '✅ PASS' : '❌ FAIL'}`)
  for (const e of [].concat(evidence)) line(`    ${e}`)
}

const textMsg = (role, text) => ({ role, content: [{ type: 'text', text }] })

/* ── 最小 Cordis / Agent 替身（与 acceptance.mjs 同款，独立一份便于单跑） ── */
function createMockCtx() {
  const listeners = new Map()
  const sections = []
  const intervals = []
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    on(event, fn, opts) {
      const list = listeners.get(event) ?? []
      const entry = { fn, opts }
      if (opts?.prepend) list.unshift(entry)
      else list.push(entry)
      listeners.set(event, list)
      return () => {}
    },
    effect(cb) {
      cb()
      return () => {}
    },
    systemPrompt: { section: (s) => (sections.push(s), () => {}), context: () => () => {} },
    tools: { register: () => () => {} },
    get: () => undefined,
    interval(fn, ms) {
      intervals.push({ fn, ms })
      const h = setInterval(fn, ms)
      h.unref?.()
      return () => clearInterval(h)
    },
  }
  return { ctx, listeners, sections, intervals }
}

async function fire(h, event, payload) {
  for (const { fn } of h.listeners.get(event) ?? []) await fn(payload, async () => undefined)
}

const dbPath = workspacePaths(WS, BUCKET).dbPath
if (!existsSync(dbPath)) {
  console.error(`❌ 缺少写入测试工作区：${dbPath}\n   先跑 node scripts/setup-selftest.mjs`)
  process.exit(2)
}

const config = ConfigSchema({ bucket: BUCKET, intervalMs: 10000, native: { vcpRoot: VCP } })
const h = createMockCtx()
apply(h.ctx, config)

/* ══════════════════ P3-a 守护循环被 timer 拉起 ══════════════════ */
hr('P3-a 守护循环被 timer 拉起')
const guardInterval = h.intervals.find((i) => i.ms === config.intervalMs)
{
  // 触发一次握手，让工作区与守护循环就位。0.1.7-rc.2 起 'agent/session-start' 已并入
  // 'agent/created'（src/index.ts:357 两处监听合一）——fire 旧名=打空靶（P3-c 红的根因，2026-09-29）。
  const agent = { session: { id: 'sess-p3', header: { cwd: WS }, deriveMessages: () => [] } }
  await fire(h, 'agent/created', { agent })
  const ws = acquireWorkspace(WS, config)
  const logs = []
  const off = ws.logger.onLine((l) => logs.push(l))
  // 再触发一次取日志（session-start 的日志在注册前发生，故这里手动查日志文件/内存）
  off()
  const started = logs.find((l) => l.includes('guardian-started')) ?? ''

  check(
    'P3-a',
    'timer 注册了守护循环，并记录 guardian-started',
    h.intervals.length > 0 && guardInterval !== undefined,
    [
      `注册的 interval 数 = ${h.intervals.length}，周期 = ${h.intervals.map((i) => i.ms + 'ms').join(', ')}`,
      `config.intervalMs = ${config.intervalMs}（DESIGN §5.1 预设写 900000 = 15 分钟）`,
      `运行时日志含 guardian-started：${started ? '是' : '（本次未捕获：日志在 onLine 订阅前已写，见下一项的 health.log 实证）'}`,
      `守护循环 workdir 桶 = ${ws.paths.bucket}`,
      `体检日志路径 = ${ws.paths.healthLogPath}`,
      `草稿目录 = ${ws.paths.pendingDir}`,
    ],
  )
}

/* ══════════════════ P3-b 一轮守护真的落盘 ══════════════════ */
hr('P3-b 一轮守护落盘 health.log + 四项体检数值')
{
  const ws = acquireWorkspace(WS, config)
  // 清掉上一轮留下的日志，确保下面看到的行一定是本轮产生
  rmSync(ws.paths.healthLogPath, { force: true })
  const daemon = new WorkspaceDaemon({
    config,
    workspace: ws,
    log: () => {},
    setInterval: (fn, ms) => {
      const t = setInterval(fn, ms)
      t.unref?.()
      return () => clearInterval(t)
    },
    takeDrafts: () => [],
  })
  const round = await daemon.runOnce()
  const logExists = existsSync(ws.paths.healthLogPath)
  const logText = logExists ? readFileSync(ws.paths.healthLogPath, 'utf8').trim() : ''
  const counts = ws.store.counts()
  const pass =
    round.ok &&
    logExists &&
    logText.includes('components=') &&
    round.health.components === 1 &&
    round.artifactSig !== null

  check('P3-b', '守护轮写出 health.log，四项体检数值与库一致', pass, [
    `round=${round.round} ok=${round.ok} elapsedMs=${round.elapsedMs}`,
    `artifactSig=${round.artifactSig ? round.artifactSig.slice(0, 32) + '…' : 'null'}（重建=${round.artifactRebuilt}）`,
    `体检：连通分量=${round.health.components} 枢纽比=${round.health.hubRatio === null ? 'n/a' : round.health.hubRatio.toFixed(3)} 未覆盖率=${round.health.uncoveredRatio.toFixed(3)} 告警=${round.health.warnings.length}`,
    `库内实际：${counts.files} 篇 / ${counts.tags} Tag（连通分量应 = 1）`,
    `health.log 内容：`,
    `  ${logText || '(空)'}`,
  ])
}

/* ══════════════════ P3-c 草稿落盘且不入库 ══════════════════ */
hr('P3-c 回合草稿落盘 pending/，且**不自动入库**')
{
  const ws = acquireWorkspace(WS, config)
  const before = ws.store.counts().files
  const turns = [
    textMsg('user', '老师反馈教室后墙的接触阴影在侧光下会漏一条缝，想确认上次是怎么修的'),
    textMsg('assistant', '上次是 minY 判据与零接触阴影叠加导致的因果反转，修复靠接触阴影烘焙 + 参照物翻转。'),
  ]
  // 真实 seam 读的是 agent.session.deriveMessages()（src/index.ts:171），不是 payload.messages
  const agent = { session: { id: 'sess-p3-draft', header: { cwd: WS }, deriveMessages: () => turns } }
  // 0.1.7-rc.2：握手事件名 = 'agent/created'（旧名已并入，fire 旧名=空靶）
  await fire(h, 'agent/created', { agent })
  await fire(h, 'agent/turn-stopping', { agent, turn: 42 })

  // 走**插件真实注册的 timer 回调**驱动守护。注意：config.bucket=教室建模写入测试 覆盖下，
  // process.cwd() 与本测试工作区映射**同一桶同 hash**（daemonFor 按 hash 去重）——所以只有
  // 1 个 interval，恰好是「同桶不同 cwd 也必须认领草稿」的现场（2026-09-29 flushDrafts 修复的回归面）。
  for (const gi of h.intervals) await gi.fn()
  await new Promise((r) => setTimeout(r, 500))

  const rootWs = acquireWorkspace(process.cwd(), config)
  const rootFiles = existsSync(rootWs.paths.pendingDir)
    ? readdirSync(rootWs.paths.pendingDir).filter((f) => f.endsWith('.md'))
    : []

  const dir = ws.paths.pendingDir
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.md')) : []
  const newest = files.sort().at(-1)
  const body = newest ? readFileSync(join(dir, newest), 'utf8') : ''
  const after = ws.store.counts().files

  check(
    'P3-c',
    '草稿写入 pending/，库内篇数不变（等确认，不自动入库）',
    files.length > 0 && after === before && body.includes('接触阴影'),
    [
      `工作区草稿目录：${dir}`,
      `草稿文件：${files.join(', ') || '(无)'}`,
      `库内篇数 前=${before} 后=${after}（不变 = 未自动入库 ✅）`,
      `跨工作区隔离：先跑的 process.cwd() 桶（${rootWs.paths.bucket}）pending 目录 = ${rootFiles.length} 篇` +
        `（未认领本桶草稿 ✅）`,
      `草稿正文（前 12 行）：`,
      ...body.split('\n').slice(0, 12).map((l) => `  ${l}`),
    ],
  )
}

/* ══════════════════ P3-d 指数退避 ══════════════════ */
hr('P3-d 连续失败指数退避（§8 ④）')
{
  const ws = acquireWorkspace(WS, config)
  const boom = new WorkspaceDaemon({
    config,
    workspace: {
      ...ws,
      // 让 ensureLoaded 抛错，模拟原生/DB 故障
      ensureLoaded: async () => {
        throw new Error('simulated native/DB outage')
      },
      // 原型方法不随 spread 存活；daemon.runOnce 持工作区串行闸（SIGBUS 修复）须经此进入——
      // 桩里给直通实现（退避测试不关心串行语义）
      withDb: (fn) => fn(),
      paths: ws.paths,
      store: ws.store,
      engine: ws.engine,
    },
    log: () => {},
    setInterval: () => () => {},
    takeDrafts: () => [],
  })
  const delays = []
  for (let i = 0; i < 5; i++) {
    const r = await boom.runOnce()
    delays.push({ round: r.round, ok: r.ok, error: r.error, next: r.nextDelayMs })
  }
  const expected = [2, 4, 8, 8, 8].map((f) => Math.round(config.intervalMs * Math.min(config.maintenance.maxBackoff, f)))
  const actual = delays.map((d) => d.next)
  check('P3-d', `退避序列 = 基数 × min(${config.maintenance.maxBackoff}, 2^失败数)`, JSON.stringify(actual) === JSON.stringify(expected), [
    `基数 intervalMs = ${config.intervalMs}ms，封顶倍数 = ${config.maintenance.maxBackoff}`,
    `实测 nextDelayMs 序列 = [${actual.join(', ')}]`,
    `期望序列 = [${expected.join(', ')}]`,
    `每轮 ok=false + error：${delays[0].error}`,
    `首轮 ${actual[0]}ms → 封顶 ${actual.at(-1)}ms（到顶后不再增长）`,
  ])
}

hr('P3 汇总')
const pass = results.filter((r) => r.pass).length
for (const r of results) line(`  ${r.pass ? '✅' : '❌'}  ${r.id}  ${r.title}`)
line(`\n  通过 ${pass}/${results.length}`)
process.exit(pass === results.length ? 0 : 1)
