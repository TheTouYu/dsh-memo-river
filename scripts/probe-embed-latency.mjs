/**
 * scripts/probe-embed-latency.mjs — **嵌入端点真实延时完整核验**（2026-10-14）。
 *
 * 为什么测：注入路径的查询文本**永远不命中缓存**（一次性 query），所以每次注入都要付真实往返；
 * 注入预算是硬顶 3s（`inject.embedTimeoutMs`），写侧是 15s + 重试 1 次（`WRITE_EMBED_OPTIONS`）。
 * D192 把验收 flaky 归因为「缓存未命中的 embed 真实往返偶发超预算」，本探针把这条量化：
 * 各形态的 p50/p90/p99/max、超预算比例、以及 5 分钟持续观测里的 stall 次数。
 *
 * 相位：
 *   P0 解析端点（密钥脱敏）+ 代理自检
 *   P1 冷启动（进程内前 3 次 vs 稳态）
 *   P2 顺序单文本 ×N（注入形态：短 query）—— 决定 inject-skip 的那个分布
 *   P3 顺序批量 32（批量形态：chunk 级文本）
 *   P4 并发 5 × 批量 8（客户端的 TAG_VECTORIZE_CONCURRENCY 真实并发形状）
 *   P5 长文本 ×M（写侧形态：整篇日记正文）
 *   P6 经 EmbedClient 真实代码路径：注入冷缓存 / 命中缓存（≈0） / 写侧 5 文本
 *   P7 持续观测（每 5s 一次单文本 ×60 ≈ 5 分钟）：抓偶发 stall
 *   P8 直连 vs 代理（能直连才测；否则记为「必须走代理」）
 *
 * 用法：node scripts/probe-embed-latency.mjs [--quick]
 * 缓存文件写在 /tmp（不碰生产桶）；只发嵌入请求，不写任何日记。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const QUICK = process.argv.includes('--quick')
const { Config: ConfigSchema } = await import('../lib/index.js')
const { resolveEmbed } = await import('../lib/workspace.js')
const { workspacePaths } = await import('../lib/runtime.js')
const { EmbedClient, WRITE_EMBED_OPTIONS, WRITE_EMBED_TIMEOUT_MS, WRITE_EMBED_RETRIES } = await import('../lib/embed.js')

const VCP = '/home/h/app/VCPToolBox'
const config = ConfigSchema({ bucket: '', native: { vcpRoot: VCP } })
const paths = workspacePaths(join(tmpdir(), 'memo-river-embedlat-probe'), '')
const resolved = resolveEmbed(config, paths)
const TMP = mkdtempSync(join(tmpdir(), 'embedlat-'))

const redact = (s) => (typeof s === 'string' && s.length > 8 ? `${s.slice(0, 4)}…${s.slice(-2)}（${s.length} 字符）` : '（未设）')
console.log('════════ 嵌入端点真实延时核验 ════════')
console.log(`端点  : ${resolved.apiUrl}   模型: ${resolved.model}   维度: ${resolved.dimension}   来源: ${resolved.source}   providerOrder: ${JSON.stringify(resolved.providerOrder ?? null)}`)
console.log(`密钥  : ${redact(resolved.apiKey)}   TAG_EMBED_PROXY=${JSON.stringify(process.env.TAG_EMBED_PROXY ?? null)}   NODE_USE_ENV_PROXY=${JSON.stringify(process.env.NODE_USE_ENV_PROXY ?? null)}`)
console.log(`模式  : ${QUICK ? '--quick（样本减半）' : '完整'}`)
console.log('')

const N_SINGLE = QUICK ? 15 : 40
const N_BATCH = QUICK ? 4 : 8
const N_CONC_ROUNDS = QUICK ? 1 : 3
const N_LONG = QUICK ? 3 : 6
const N_SUSTAIN = QUICK ? 12 : 60
const BATCH = 32
// 预算从**真实配置**读（别硬编码——2026-10-15 教训：预算已从 3000 改成 8000）
const INJECT_BUDGET_MS = config.inject?.embedTimeoutMs ?? 8000
const WRITE_BUDGET_MS = WRITE_EMBED_TIMEOUT_MS * (1 + WRITE_EMBED_RETRIES)

let nonce = 0
const uniq = (s) => `${s} #${++nonce}-${Math.random().toString(36).slice(2, 8)}`

const pct = (arr, p) => {
  if (!arr.length) return NaN
  const s = [...arr].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]
}
const stats = (arr) => ({
  n: arr.length,
  min: Math.round(Math.min(...arr)),
  p50: Math.round(pct(arr, 50)),
  p90: Math.round(pct(arr, 90)),
  p95: Math.round(pct(arr, 95)),
  p99: Math.round(pct(arr, 99)),
  max: Math.round(Math.max(...arr)),
  mean: Math.round(arr.reduce((a, b) => a + b, 0) / arr.length),
})
const over = (arr, ms) => arr.filter((x) => x > ms).length
const table = []
const record = (phase, note, arr, budget) => {
  if (!arr.length) {
    table.push([phase, note, '—', '—', '—', '—', '—', '—', '0'])
    console.log(`${phase}  ${note}: 无成功样本`)
    return
  }
  const s = stats(arr)
  table.push([phase, note, s.n, s.p50, s.p90, s.p95, s.p99, s.max, String(over(arr, budget))])
  console.log(
    `${phase}  ${note}: n=${s.n} min=${s.min} p50=${s.p50} p90=${s.p90} p95=${s.p95} p99=${s.p99} max=${s.max} ` +
      `| 超 ${budget}ms：${over(arr, budget)}`,
  )
}

const makeClient = (tag) => new EmbedClient({
  apiUrl: resolved.apiUrl,
  apiKey: resolved.apiKey,
  model: resolved.model,
  dimension: resolved.dimension,
  cachePath: join(TMP, `emb-cache-${tag}.json`),
  providerOrder: resolved.providerOrder,
  timeoutMs: 60_000,
  logger: { warn: (m) => console.log(`   [warn] ${m}`), info: () => {} },
})

/* ── P1 冷启动 ── */
console.log('── P1 冷启动（进程内首次连接 vs 稳态）──')
const c1 = makeClient('cold')
const cold = []
const warm = []
for (let i = 0; i < 6; i++) {
  const t = performance.now()
  try {
    await c1.embed([uniq('冷启动探测：这是一段用于测量嵌入往返的短文本。')])
    const ms = performance.now() - t
    ;(i < 3 ? cold : warm).push(ms)
    console.log(`   第 ${i + 1} 次：${Math.round(ms)}ms`)
  } catch (e) {
    console.log(`   第 ${i + 1} 次：失败 ${String(e.message).slice(0, 120)}`)
  }
}
if (cold.length && warm.length) {
  console.log(`   前 3 次均值 ${Math.round(cold.reduce((a, b) => a + b) / cold.length)}ms → 稳态均值 ${Math.round(warm.reduce((a, b) => a + b) / warm.length)}ms（差=连接建立/保活开销）`)
}

/* ── P2 顺序单文本（注入形态）── */
console.log('\n── P2 顺序单文本 ×' + N_SINGLE + '（注入形态；预算 ' + INJECT_BUDGET_MS + 'ms）──')
const p2 = []
let p2fail = 0
for (let i = 0; i < N_SINGLE; i++) {
  const t = performance.now()
  try {
    await c1.embed([uniq('渲染又卡了，上次是怎么解决的来着？阴影贴图分辨率要不要降一半。')])
    p2.push(performance.now() - t)
  } catch (e) {
    p2fail++
    console.log(`   第 ${i + 1} 次失败：${String(e.message).slice(0, 120)}`)
  }
  await new Promise((r) => setTimeout(r, 250))
}
record('P2', `单文本×${N_SINGLE}`, p2, INJECT_BUDGET_MS)
if (p2fail) console.log(`   （另有 ${p2fail} 次失败）`)

/* ── P3 顺序批量 32 ── */
console.log(`\n── P3 顺序批量 ${BATCH} ×${N_BATCH}（批量形态）──`)
const p3 = []
for (let i = 0; i < N_BATCH; i++) {
  const texts = Array.from({ length: BATCH }, (_, k) => uniq(`批量文本 ${k}：教室建模的渲染管线与阴影贴图设置说明，用于测量批量嵌入往返延时。`))
  const t = performance.now()
  try {
    await c1.embed(texts)
    p3.push(performance.now() - t)
  } catch (e) {
    console.log(`   批 ${i + 1} 失败：${String(e.message).slice(0, 120)}`)
  }
}
record('P3', `批${BATCH}`, p3, INJECT_BUDGET_MS)

/* ── P4 并发 5 × 批 8 ── */
console.log(`\n── P4 并发 5 × 批 8 ×${N_CONC_ROUNDS}（客户端真实并发形状）──`)
const p4 = []
for (let r = 0; r < N_CONC_ROUNDS; r++) {
  const t = performance.now()
  try {
    await Promise.all(
      Array.from({ length: 5 }, (_, j) =>
        c1.embed(Array.from({ length: 8 }, (_, k) => uniq(`并发批 ${r}-${j}-${k}：并发形态测量用文本。`))),
      ),
    )
    p4.push(performance.now() - t)
  } catch (e) {
    console.log(`   轮 ${r + 1} 失败：${String(e.message).slice(0, 120)}`)
  }
}
record('P4', '并发5×批8', p4, WRITE_BUDGET_MS)

/* ── P5 长文本（写侧形态）── */
console.log(`\n── P5 长文本（~3000 字）×${N_LONG}（写侧整篇日记形态；预算 ${WRITE_BUDGET_MS}ms）──`)
const longBody = ('教室建模项目的渲染管线排查记录。'.repeat(12) + '结论：阴影贴图分辨率 2048 导致帧率减半，降到 1024 后恢复 60fps。').repeat(8)
console.log(`   样本长度：${longBody.length} 字符`)
const p5 = []
for (let i = 0; i < N_LONG; i++) {
  const t = performance.now()
  try {
    await c1.embed([uniq(longBody)])
    p5.push(performance.now() - t)
  } catch (e) {
    console.log(`   第 ${i + 1} 次失败：${String(e.message).slice(0, 120)}`)
  }
}
// 写侧真实形态：一次 5 条（新 Tag + 正文）
const p5b = []
for (let i = 0; i < Math.max(2, Math.floor(N_LONG / 2)); i++) {
  const t = performance.now()
  try {
    await c1.embed([uniq('渲染管线'), uniq('阴影贴图'), uniq('帧率排查'), uniq('教室建模'), uniq(longBody)])
    p5b.push(performance.now() - t)
  } catch (e) {
    console.log(`   写侧批 ${i + 1} 失败：${String(e.message).slice(0, 120)}`)
  }
}
record('P5', '长文本单条', p5, WRITE_BUDGET_MS)
record('P5b', '写侧 5 条批', p5b, WRITE_BUDGET_MS)

/* ── P6 经 EmbedClient：注入冷缓存 / 命中缓存 / 写侧预算 ── */
console.log('\n── P6 经 EmbedClient 真实代码路径 ──')
const c2 = makeClient('paths')
const injectTexts = [uniq('渲染又卡了，上次教室那个是怎么解决的？'), uniq('阴影贴图分辨率'), uniq('帧率恢复'), uniq('渲染管线排查')]
const tInject = performance.now()
const injectVecs = await c2.embed(injectTexts)
const injectMs = performance.now() - tInject
const tHit = performance.now()
await c2.embed(injectTexts) // 同文本 → 必命中
const hitMs = performance.now() - tHit
console.log(`   注入形态（query+3 锚，冷缓存，3s 预算）：${Math.round(injectMs)}ms ${injectMs > INJECT_BUDGET_MS ? '❌ 超预算' : '✅'}`)
console.log(`   同批命中缓存：${hitMs.toFixed(2)}ms（向量 ${injectVecs.length} 条）→ 缓存价值 ${(injectMs / Math.max(hitMs, 0.01)).toFixed(0)}×`)
// 注入形态重复取样：这是**唯一每次都付真金白银**的生产路径（query 永不命中缓存）
const p6 = []
for (let i = 0; i < (QUICK ? 4 : 10); i++) {
  const texts = [
    uniq(`注入查询 ${i}：渲染又卡了，上次教室那个是怎么解决的？`),
    uniq(`门控锚 ${i}-1 渲染管线`),
    uniq(`门控锚 ${i}-2 阴影贴图`),
    uniq(`门控锚 ${i}-3 帧率恢复`),
  ]
  const t = performance.now()
  try {
    await c2.embed(texts)
    p6.push(performance.now() - t)
  } catch (e) {
    console.log(`   注入样本 ${i + 1} 失败：${String(e.message).slice(0, 110)}`)
  }
  await new Promise((r) => setTimeout(r, 300))
}
record('P6', `注入形态(query+3锚)×${QUICK ? 4 : 10}`, p6, INJECT_BUDGET_MS)
const tWrite = performance.now()
await c2.embed([uniq('渲染管线'), uniq('阴影贴图'), uniq('帧率排查'), uniq('教室建模'), uniq(longBody)], WRITE_EMBED_OPTIONS)
const writeMs = performance.now() - tWrite
console.log(`   写侧形态（5 文本，15s+重试预算）：${Math.round(writeMs)}ms ${writeMs > WRITE_BUDGET_MS ? '❌ 超预算' : '✅'}`)
console.log(`   缓存统计：${JSON.stringify(c2.cacheStats)}`)

/* ── P7 持续观测：抓偶发 stall ── */
console.log(`\n── P7 持续观测：每 5s 一次单文本 ×${N_SUSTAIN}（≈${Math.round((N_SUSTAIN * 5) / 60)} 分钟）──`)
const p7 = []
const stalls = []
for (let i = 0; i < N_SUSTAIN; i++) {
  const t = performance.now()
  try {
    await c1.embed([uniq(`持续观测第 ${i} 次：渲染卡顿排查的短查询。`)])
    const ms = performance.now() - t
    p7.push(ms)
    if (ms > 1000) {
      stalls.push(Math.round(ms))
      console.log(`   ⚠ 第 ${i + 1} 次 ${Math.round(ms)}ms（>1s）`)
    }
    if (ms > INJECT_BUDGET_MS) console.log(`   ❌ 第 ${i + 1} 次 ${Math.round(ms)}ms 超注入预算 ${INJECT_BUDGET_MS}ms`)
  } catch (e) {
    console.log(`   第 ${i + 1} 次失败：${String(e.message).slice(0, 120)}`)
  }
  await new Promise((r) => setTimeout(r, 5000))
}
record('P7', `持续×${N_SUSTAIN}`, p7, INJECT_BUDGET_MS)
console.log(`   >1s 的 stall：${stalls.length} 次 ${stalls.length ? JSON.stringify(stalls) : ''}`)
if (p7.length) {
  const all = [...p2, ...p7]
  console.log(`   P2+P7 合并（单文本全样本 n=${all.length}）：p50=${Math.round(pct(all, 50))} p90=${Math.round(pct(all, 90))} p99=${Math.round(pct(all, 99))} max=${Math.round(Math.max(...all))}｜超 ${INJECT_BUDGET_MS}ms：${over(all, INJECT_BUDGET_MS)}/${all.length}`)
}

/* ── P8 直连 vs 代理 ── */
console.log('\n── P8 直连 vs 代理 ──')
const savedProxy = process.env.TAG_EMBED_PROXY
process.env.TAG_EMBED_PROXY = '' // 空串 = 关代理
const directClient = new EmbedClient({
  apiUrl: resolved.apiUrl,
  apiKey: resolved.apiKey,
  model: resolved.model,
  dimension: resolved.dimension,
  cachePath: join(TMP, 'emb-cache-direct.json'),
  providerOrder: resolved.providerOrder,
  timeoutMs: 8000,
  logger: { warn: () => {}, info: () => {} },
})
const direct = []
for (let i = 0; i < 3; i++) {
  const t = performance.now()
  try {
    await directClient.embed([uniq('直连测量：渲染卡顿排查。')])
    direct.push(performance.now() - t)
  } catch (e) {
    console.log(`   直连第 ${i + 1} 次失败：${String(e.message).slice(0, 110)}`)
  }
}
process.env.TAG_EMBED_PROXY = savedProxy
if (direct.length) {
  record('P8', '直连（无代理）', direct, INJECT_BUDGET_MS)
  console.log(`   代理侧对照（P2）：p50=${Math.round(pct(p2, 50))}ms；直连：p50=${Math.round(pct(direct, 50))}ms`)
} else {
  console.log('   直连全部失败/超时 → **必须走代理**（TAG_EMBED_PROXY）')
}

/* ── 汇总 ── */
console.log('\n════════ 汇总（ms）════════')
console.log(['相位', '形态', 'n', 'p50', 'p90', 'p95', 'p99', 'max', '超预算数'].join('\t'))
for (const row of table) console.log(row.join('\t'))
console.log('')
console.log(`注入预算 ${INJECT_BUDGET_MS}ms（inject.embedTimeoutMs）｜写侧预算 ${WRITE_BUDGET_MS}ms（WRITE_EMBED_OPTIONS）`)
const single = [...p2, ...p7]
if (single.length) {
  const p = pct(single, 99)
  console.log(`单文本（注入形态）全样本：p99=${Math.round(p)}ms → 超 3s 概率约 ${(over(single, INJECT_BUDGET_MS) / single.length * 100).toFixed(1)}%`)
}
for (const c of [c1, c2]) { try { await c.flushCache() } catch { /* 收尾尽力而为 */ } }
rmSync(TMP, { recursive: true, force: true })
