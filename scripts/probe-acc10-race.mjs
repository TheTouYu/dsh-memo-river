#!/usr/bin/env node
/* probe-acc10-race.mjs — #10「并发 == 串行」恒等断言的聚焦复现器（2026-10-15 拆批 A/B 归因用）
 *
 * 背景：拆批改动后主套件 4/4 跑红 #10（sess-B 第 4 席并发 8↔串行 1），改前代码一跑 37/37
 * 绿（D278）。桶日志已证：翻转不在嵌入（串行 B2 纯缓存命中、gate 逐字段相同）而在选择
 * 阶段的有状态读取（票04 曝光/近因台账）。本探针把 #10 场景抽出来一次铺台多次迭代，
 * 分离「确定性破坏」与「环境竞态被拨动」：
 *   · 第 1 迭代 = 冷缓存（等价主套件首轮：并发 A/B 的 embed 各 ~1.8s，台账读写竞态窗口宽）；
 *   · 第 2..N 迭代 = 暖缓存（embed ~7ms，竞态窗口收窄到亚毫秒）——若暖窗口仍恒翻，
 *     则不是时序竞态而是确定性的选择状态效应。
 * 每迭代全新 session id（绕开同集合去重），同一工作区（台账跨迭代累积，与长寿命 harness 一致）。
 * 用法：node scripts/probe-acc10-race.mjs [迭代数=6]
 * A/B 跑法：本文件不动，`git stash push src/... && tsc 重建 && 跑 && git stash pop && tsc 重建`。 */
import { ensureSelftestFixtures } from './isolated-env.mjs'
import { join } from 'node:path'
import { apply, Config as ConfigSchema } from '../lib/index.js'
import { BLOCK_CLOSE } from '../lib/render.js'

const ROOT = new URL('..', import.meta.url).pathname
const VCP = '/home/h/app/VCPToolBox'
const WS_RIVER = join(ROOT, '.selftest', '教室建模归档')
const BUCKET_RIVER = '教室建模归档'
const ITER = Number(process.argv[2] ?? 6)

await ensureSelftestFixtures() // 隔离 home 内自铺（真向量；每次重铺 ~20s，顺带清台账/缓存 = 冷启动）

/* ↓↓ 与 acceptance.mjs 同源的最小替身（:107-139、:163-181、:212-213）↓↓ */
const config = ConfigSchema({ bucket: BUCKET_RIVER, native: { vcpRoot: VCP } })
config.inject.embedTimeoutMs = 10_000 // 与主套件同口径（宽松预算，不量降级）
config.embed.providerOrder = 'Parasail' // 套件端点 = config.env（OpenRouter 单通道）钉 Parasail
if (process.env.PROBE_W0) {
  // 机制钉死用：选择权重全零 → weightsOn=false → eff≡score 静态序（D155）。
  // 若翻转随之消失 ⇒ 根因=台账驱动的选择权重，与嵌入无关。
  config.inject.selectionTagCap = 0
  config.inject.selectionExposureCap = 0
  config.inject.selectionRecencyCap = 0
  console.log('[probe] 选择权重全零（weightsOn=false 预期）')
}

function createMockCtx() {
  const listeners = new Map()
  const registered = { sections: [], contexts: [], tools: [] }
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    on(event, fn, opts) {
      const list = listeners.get(event) ?? []
      ;(opts?.prepend ? list.unshift : list.push).call(list, { fn, opts })
      listeners.set(event, list)
      return () => list.splice(list.indexOf(listeners.get(event)), 1)
    },
    effect(cb) {
      return () => { try { cb()?.() } catch { /* 静默 */ } }
    },
    systemPrompt: { section: () => () => {}, context: () => () => {} },
    tools: { register: () => () => {} },
    get: () => undefined,
    interval(fn, ms) {
      const t = setInterval(fn, ms); t.unref?.(); return () => clearInterval(t)
    },
  }
  return { ctx, listeners, registered }
}
const textMsg = (role, text) => ({ role, content: [{ type: 'text', text }], source: { kind: role === 'user' ? 'user' : 'model' } })
const pluginMsg = (text, plugin = 'runtime-context') => ({ role: 'user', content: [{ type: 'text', text }], source: { kind: 'plugin', plugin, form: 'snapshot' } })
function createAgent(sessionId, cwd, priorLog = []) {
  const log = [...priorLog]
  return { session: { id: sessionId, header: { cwd }, deriveMessages: () => log }, log }
}
async function runPreStep(h, agent, turn, claimed, step = 1) {
  const list = h.listeners.get('agent/pre-step') ?? []
  const runtimeContext = pluginMsg('Current runtime context. This snapshot supersedes earlier runtime-context snapshots.')
  let next = async () => ({ kind: 'enter', messages: [...claimed, runtimeContext] })
  for (let i = list.length - 1; i >= 0; i--) {
    const fn = list[i].fn
    const downstream = next
    next = () => fn({ agent, messages: claimed, turn, step, signal: { aborted: false } }, downstream)
  }
  const decision = await next()
  if (decision?.kind === 'enter') agent.log.push(...decision.messages)
  return decision
}
/* ↑↑ 与 acceptance.mjs 同源 ↑↑ */

const h = createMockCtx()
apply(h.ctx, config)

const qA = '我这边现在渲染又卡了，上次教室那个是怎么解决的？'
const qB = '那个视频到底是怎么做到真 60 帧的？编码卡在哪一步？'
const msgText = (m) => (m?.content ?? []).map((b) => b.text ?? '').join('\n')
const idsOf = (dec) => {
  const t = dec.messages.map(msgText).find((x) => x.includes(BLOCK_CLOSE)) ?? ''
  return [...t.matchAll(/^D(\d+)「/gm)].map((m) => Number(m[1]))
}
const t0 = Date.now()
let flips = 0
for (let i = 1; i <= ITER; i++) {
  const phase = i === 1 ? '冷' : '暖'
  const [decA, decB] = await Promise.all([
    runPreStep(h, createAgent(`pA-${i}`, WS_RIVER, []), 1, [textMsg('user', qA)]),
    runPreStep(h, createAgent(`pB-${i}`, WS_RIVER, []), 1, [textMsg('user', qB)]),
  ])
  const sA = await runPreStep(h, createAgent(`sA-${i}`, WS_RIVER, []), 1, [textMsg('user', qA)])
  const sB = await runPreStep(h, createAgent(`sB-${i}`, WS_RIVER, []), 1, [textMsg('user', qB)])
  const idsA = idsOf(decA), idsB = idsOf(decB), rA = idsOf(sA), rB = idsOf(sB)
  const okA = JSON.stringify(idsA) === JSON.stringify(rA)
  const okB = JSON.stringify(idsB) === JSON.stringify(rB)
  if (!okA || !okB) flips++
  const seat = okB ? '' : ` 翻席:${idsB.map((x, j) => (rB[j] === x ? null : `#${j + 1} ${x}→${rB[j]}`)).filter(Boolean).join(' ')}`
  console.log(`迭代${i}(${phase}) A=[${idsA}]${okA ? '✓' : `✗串行=[${rA}]`} B=[${idsB}]${okB ? '✓' : `✗串行=[${rB}]${seat}`}`)
}
console.log(`\n结果：${ITER} 迭代，并发==串行 破坏 ${flips}/${ITER} ｜ 用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`)
console.log(`（构建核对请另行 grep -c SPLIT-BATCH lib/recall.js）`)
