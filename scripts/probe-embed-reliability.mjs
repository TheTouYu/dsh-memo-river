/**
 * scripts/probe-embed-reliability.mjs — 嵌入端点**可靠性专项**（2026-10-14，与延时探针配套）。
 *
 * 由头：延时探针第二轮在第 17 次后开始出现
 *   `embed-http-400: Invalid JSON payload received. Unknown name "requests": Cannot find field`
 * ——这是 **Gemini 原生 schema** 的报错，说明中转把 OpenAI 形态的请求打到了另一种 API 形态的后端
 * （上游路由不一致），并连续失败触发跳闸。本探针把这件事量化：**逐次**记录结果、状态码、错误类、
 * 延时；**关掉跳闸**（EMB_BREAKER=0 在客户端构造前设）以便看到端点真实面貌，不被退避截断。
 *
 * 用法：node scripts/probe-embed-reliability.mjs [N=120] [间隔ms=200]
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const N = Number(process.argv[2]) || 120
const GAP = Number(process.argv[3] ?? 200)
process.env.EMB_BREAKER = '0' // 量测端点本身，不量测跳闸

const { Config: ConfigSchema } = await import('../lib/index.js')
const { resolveEmbed } = await import('../lib/workspace.js')
const { workspacePaths } = await import('../lib/runtime.js')
const { EmbedClient } = await import('../lib/embed.js')

const resolved = resolveEmbed(ConfigSchema({ bucket: '', native: { vcpRoot: '/home/h/app/VCPToolBox' } }), workspacePaths(join(tmpdir(), 'rel-probe'), ''))
const TMP = mkdtempSync(join(tmpdir(), 'rel-'))
const client = new EmbedClient({
  apiUrl: resolved.apiUrl, apiKey: resolved.apiKey, model: resolved.model, dimension: resolved.dimension,
  cachePath: join(TMP, 'c.json'), timeoutMs: 15_000, logger: { warn: () => {}, info: () => {} },
})
console.log(`可靠性专项：N=${N} 间隔=${GAP}ms 端点=${resolved.apiUrl} 模型=${resolved.model}（跳闸已关）`)

const rows = []
let nonce = 0
for (let i = 0; i < N; i++) {
  const t = performance.now()
  let status = 'ok', err = ''
  try {
    await client.embed([`可靠性第 ${i} 次探测：教室渲染卡顿排查 #${++nonce}`])
  } catch (e) {
    const msg = String(e.message)
    status = msg.includes('http-400') ? 'http-400' : msg.includes('timeout') ? 'timeout' : msg.includes('http-5') ? 'http-5xx' : 'other'
    err = msg.slice(0, 90)
  }
  rows.push({ i, ms: Math.round(performance.now() - t), status, err })
  if (status !== 'ok') console.log(`   #${i} ${status} ${rows[rows.length - 1].ms}ms ${err}`)
  if (GAP) await new Promise((r) => setTimeout(r, GAP))
}

const ok = rows.filter((r) => r.status === 'ok')
const bad = rows.filter((r) => r.status !== 'ok')
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? NaN) }
const lat = ok.map((r) => r.ms)
console.log(`\n成功 ${ok.length}/${N}（${((ok.length / N) * 100).toFixed(1)}%）  失败 ${bad.length}`)
const byClass = {}
for (const b of bad) byClass[b.status] = (byClass[b.status] ?? 0) + 1
console.log(`失败分类：${JSON.stringify(byClass)}`)
if (lat.length) console.log(`成功样本延时：min=${Math.min(...lat)} p50=${pct(lat, 50)} p90=${pct(lat, 90)} p95=${pct(lat, 95)} p99=${pct(lat, 99)} max=${Math.max(...lat)}｜超 3000ms：${lat.filter((x) => x > 3000).length}/${lat.length}`)
// 故障是否成簇（连续失败段）
let runs = [], cur = 0
for (const r of rows) { if (r.status === 'ok') { if (cur) runs.push(cur); cur = 0 } else cur++ }
if (cur) runs.push(cur)
console.log(`连续失败段：${runs.length ? JSON.stringify(runs) : '无'}（长度分布 → ${runs.length > 1 ? '成簇' : runs.length === 1 ? '单段' : '无'}）`)
const firstFail = rows.find((r) => r.status !== 'ok')
console.log(`首次失败出现在第 ${firstFail ? firstFail.i : '—'} 次${firstFail ? `（第 ${((firstFail.i / N) * 100).toFixed(0)}% 处）` : ''}`)
try { await client.flushCache() } catch {}
rmSync(TMP, { recursive: true, force: true })
