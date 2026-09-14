#!/usr/bin/env node
/**
 * acceptance-shared-routes.mjs —— **进程级 webserver 路由必须可重入**（事故回归闸门）
 *
 * 事故现场（2026-09-14，3105 沙箱实例"空闲却烧满一核"）：
 *   浏览器标签以 ~80 req/s 打 `POST /api/commands/list`（agentId=某会话）
 *   → 服务端每次 resolve→resume→composeAgent（**整套插件组合挂载**）
 *   → 本插件 apply() 在同进程内第二次运行
 *   → `ws.register` 撞车抛 `webserver: duplicate exact route "/memo-river/tuning"`
 *     （dsh-host-webserver/lib/index.js:178）
 *   → 组合挂载失败 → resume 失败 → 客户端无退避重试 → 无限循环
 *   → 实测 825.1 s CPU / 805 s 墙钟 = 102.5%（同 unit 基线 0.9–4.3%）。
 *
 * 为什么"第二次 apply"是常态而不是异常：
 *   · 本插件可被**多条预设行**各挂一次（D55/D56：宿主层共享 vs 预设行独占）；
 *   · 常驻（standing）挂载**不随会话结束释放**（D58 源码级结论）；
 *   · webserver 的路由表是**进程全局**的，与"挂载者身份"无关。
 *
 * 判据：
 *   R-1 同进程内 apply() 两次不抛错        （修复前：抛 duplicate exact route → 本判据变红）
 *   R-2 三条路由在册且第二次 apply 未重复登记（表内仍 3 条）
 *   R-3 引用计数正确：两挂载者各释放一次后路由仍在；全部释放后清空
 *   R-4 锚定真源码：dsh-host-webserver 仍以 throw 拒绝重复路由（上游语义变了须变红）
 *
 * 用法：node scripts/acceptance-shared-routes.mjs       （退出码 0 = 全绿）
 */
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/* 隔离：DSH_HOME 指到临时目录，cwd 也换到临时工作区 —— 不碰用户的 ~/.dsh 与真实知识库。
   注意 dshHome() 是 apply 期读 process.env，所以这里赋值即生效（不必早于 import）。 */
const SANDBOX = mkdtempSync(join(tmpdir(), 'memo-river-routes-'))
process.env.DSH_HOME = join(SANDBOX, 'dsh-home')
const WS = join(SANDBOX, 'workspace')
mkdirSync(process.env.DSH_HOME, { recursive: true })
mkdirSync(WS, { recursive: true })
process.chdir(WS)

const { apply, Config: ConfigSchema } = await import('../lib/index.js')
const VCP = '/home/h/app/VCPToolBox'
const makeConfig = (overrides = {}) => ConfigSchema({ bucket: '', native: { vcpRoot: VCP }, ...overrides })

const results = []
const line = (s) => process.stdout.write(`${s}\n`)
function check(id, title, pass, evidence = []) {
  results.push({ id, title, pass })
  line(`\n【判据 ${id}】${title}  →  ${pass ? '✅ PASS' : '❌ FAIL'}`)
  for (const e of [].concat(evidence)) line(`    ${e}`)
}

/* ── webserver 替身：语义逐字复刻 dsh-host-webserver/lib/index.js:170-192 ── */
function createWebServer() {
  const table = new Map()
  return {
    table,
    register(route) {
      if (table.has(route.path)) throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`)
      table.set(route.path, route)
      return () => {
        table.delete(route.path)
      }
    },
  }
}

/** 最小 Cordis 替身（字段与 scripts/acceptance.mjs 的 createMockCtx 同源）。 */
function createMockCtx(webServer) {
  const disposers = []
  const ctx = {
    webServer,
    logger: { info() {}, warn() {}, error() {} },
    on() {
      return () => {}
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
      section() {
        return () => {}
      },
      context() {
        return () => {}
      },
    },
    tools: { register() { return () => {} } },
    get() { return undefined },
    interval(fn, ms) {
      const h = setInterval(fn, ms)
      h.unref?.()
      return () => clearInterval(h)
    },
  }
  return { ctx, dispose: () => disposers.forEach((d) => { try { d?.() } catch { /* 静默 */ } }) }
}

const ROUTES = ['/memo-river/tuning', '/memo-river/tuning/panel', '/memo-river/tuning/active']
line(`沙箱：DSH_HOME=${process.env.DSH_HOME}\n工作区：${WS}`)

/* ── R-1 / R-2：同一进程内两次 apply（= 两条带记忆河流的预设行 / 常驻挂载 + 新挂载） ── */
const ws1 = createWebServer()
const m1 = createMockCtx(ws1)
let secondError = null
try {
  apply(m1.ctx, makeConfig())
  apply(m1.ctx, makeConfig()) // ← 修复前在这里抛 webserver: duplicate exact route
} catch (e) {
  secondError = e
}
const paths = [...ws1.table.keys()].sort()
check('R-1', '同进程内 apply() 两次不抛错（第二次挂载必须复用已登记路由）', secondError === null,
  secondError === null ? [`错误：无`] : [`第二次 apply 抛出：${String(secondError?.message ?? secondError)}`,
    `出处（真源码）：dsh-host-webserver/lib/index.js:178`])
check('R-2', '三条路由在册，且未被重复登记', paths.join(',') === [...ROUTES].sort().join(','),
  [`表内 ${paths.length} 条：${paths.join(', ') || '(空)'}`])

/* ── R-3：引用计数（一个挂载者先卸载，另一个仍在 → 路由不得提前消失） ── */
const ws3 = createWebServer()
const a = createMockCtx(ws3)
const b = createMockCtx(ws3)
let refError = null
try {
  apply(a.ctx, makeConfig({ bucket: 'ref-a' }))
  apply(b.ctx, makeConfig({ bucket: 'ref-b' }))
} catch (e) {
  refError = e
}
const afterBoth = ws3.table.size
a.dispose()
const afterOneRelease = ws3.table.size
b.dispose()
const afterAllRelease = ws3.table.size
check('R-3', '引用计数：部分释放保留路由，全部释放清空', refError === null && afterBoth === 3 && afterOneRelease === 3 && afterAllRelease === 0,
  [`两次 apply 后 = ${afterBoth}（期望 3）`, `释放第一个挂载者后 = ${afterOneRelease}（期望 3，另一个还在用）`,
    `全部释放后 = ${afterAllRelease}（期望 0）`, refError ? `异常：${String(refError.message ?? refError)}` : '异常：无'])

/* ── R-4：锚定真源码（上游若改成"重复路由不再抛"，本闸门必须变红提醒重推结论） ── */
const HOST_WS = '/home/h/.npm-dlabal/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-host-webserver/lib/index.js'
if (!existsSync(HOST_WS)) {
  check('R-4', '锚定真源码：dsh-host-webserver 仍以 throw 拒绝重复路由', true, [`SKIP：未找到 ${HOST_WS}（非本机部署布局）`])
} else {
  const src = readFileSync(HOST_WS, 'utf8')
  const hit = /throw new Error\(`webserver: duplicate \$\{route\.kind\} route "\$\{route\.path\}"`\)/.test(src)
  check('R-4', '锚定真源码：dsh-host-webserver 仍以 throw 拒绝重复路由', hit,
    hit ? [`${HOST_WS}:178 的 throw 语义未变`] : ['真源码里已找不到 "webserver: duplicate <kind> route" 的 throw —— 上游语义变了，R-1/R-3 的成立条件需重推'])
}

/* ── R-5：**两个模块实例**（两条 URL）也必须共用同一张路由池 ──
   实测事故（2026-09-14，第一次修复没生效的原因）：
     预设 A 写 `./memo-river.mjs`（wrapper）→ import('…/lib/index.js?v=<mtime>')  ← 带 query
     预设 B 写包名 `@dsh-external/dsh-memo-river`          → file:///…/lib/index.js ← 无 query
   Node 的 ESM 缓存**按 URL 键** ⇒ 两个模块实例。池若放在模块作用域，两份池互相看不见，
   第二次挂载照样撞 webserver 的进程级路由表。故池必须挂在进程全局（Symbol.for）。
   本判据用 `?inst=1/2` 显式造出两个实例，等价复刻这两条 URL。 */
const LIB = '/home/h/app/dsh-memo-river/lib/index.js'
const ws5 = createWebServer()
let instError = null
try {
  const A = await import(pathToFileURL(LIB).href + '?inst=1')
  const B = await import(pathToFileURL(LIB).href + '?inst=2')
  const ca = createMockCtx(ws5)
  const cb = createMockCtx(ws5)
  A.apply(ca.ctx, A.Config({ bucket: 'inst-a', native: { vcpRoot: VCP } }))
  B.apply(cb.ctx, B.Config({ bucket: 'inst-b', native: { vcpRoot: VCP } })) // ← 模块级池时在这里抛
} catch (e) {
  instError = e
}
check('R-5', '两个模块实例（两条 URL）共用进程级路由池', instError === null && ws5.table.size === 3,
  [`两次 apply 后表内 ${ws5.table.size} 条（期望 3）`,
    instError ? `抛出：${String(instError?.message ?? instError)}` : '异常：无',
    '两个实例来自 ?inst=1 / ?inst=2（等价于 wrapper 带 query vs 包名裸 URL）'])

/* ── R-6：路由已被"另一个域"登记（模块实例 / realm / 宿主层）→ 容忍，且不得替人注销 ──
   动机：R-5 复刻了 wrapper-vs-包名两条 URL；而 cordis 的 realm/isolate 还可能让插件活在
   不同 context（各自 globalThis），此时**连进程级池也看不见对方** —— 实测已发生。
   唯一正确的判据：「路由表是进程全局的，池不是」——同名路由已存在 = 本插件要的结果；
   但它不是本实例登记的，故注销权不归本实例（返回 no-op 清理函数）。 */
const ws6 = createWebServer()
for (const p of ROUTES) ws6.table.set(p, { kind: 'exact', path: p })
const m6 = createMockCtx(ws6)
let tolError = null
try {
  apply(m6.ctx, makeConfig({ bucket: 'tolerate' }))
} catch (e) {
  tolError = e
}
const afterApply6 = ws6.table.size
m6.dispose()
check('R-6', '路由已被别处登记 → 容忍，且不替人注销（注销权不归我）',
  tolError === null && afterApply6 === 3 && ws6.table.size === 3,
  [`apply 后 = ${afterApply6}（期望 3）`, `卸载后 = ${ws6.table.size}（期望 3：不是我登记的，不许注销）`,
    tolError ? `抛出：${String(tolError?.message ?? tolError)}` : '异常：无'])

try {
  rmSync(SANDBOX, { recursive: true, force: true })
} catch {
  /* 清理失败不影响判据 */
}
const failed = results.filter((r) => !r.pass)
line(`\n${'─'.repeat(64)}\n${failed.length === 0 ? `✅ 全绿（${results.length}/${results.length}）` : `❌ ${failed.length}/${results.length} 失败：${failed.map((f) => f.id).join(', ')}`}`)
process.exit(failed.length === 0 ? 0 : 1)
