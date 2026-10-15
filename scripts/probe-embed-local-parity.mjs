/**
 * scripts/probe-embed-local-parity.mjs — **本地 bge-m3 vs 远端（OpenRouter/Parasail）一致性对照**。
 *
 * 为什么必须先测这个：切本地端点 = 换了一个"向量产地"。若两边逐元素偏差大到影响余弦排序，
 * 现有全库 1024 维向量就得重嵌；若基本一致（cos≈0.9999+），可以直接切、旧向量继续用。
 * 顺带量三条基线：远端自身重现性（provider 漂移）、本地自身重现性（确定性）。
 *
 * 用法：node scripts/probe-embed-local-parity.mjs [--local-port 8099] [--n 8] [--codec bin|json]
 */
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`)
  return i >= 0 ? process.argv[i + 1] : d
}
const N = Number(arg('n', 8))
const PORT = Number(arg('local-port', 8099))

const { Config: ConfigSchema } = await import('../lib/index.js')
const { resolveEmbed } = await import('../lib/workspace.js')
const { workspacePaths } = await import('../lib/runtime.js')
const { EmbedClient } = await import('../lib/embed.js')

const config = ConfigSchema({ bucket: '', native: { vcpRoot: '/home/h/app/VCPToolBox' } })
const paths = workspacePaths(join(tmpdir(), 'parity'), '')
const remote = resolveEmbed(config, paths)
const LOCAL_URL = `http://127.0.0.1:${PORT}`

// 真实语料样本（本桶 dailynote 里的中文句子）+ 两类典型查询
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
const bucketDir = join(homedir(), '.dsh/memo-river/b94d8836d6175817/dailynote/dsh-memo-river')
const samples = []
if (existsSync(bucketDir)) {
  const files = readdirSync(bucketDir).filter((f) => f.endsWith('.md')).slice(0, 60)
  for (const f of files) {
    const body = readFileSync(join(bucketDir, f), 'utf8').replace(/^#.*$/m, '').trim()
    if (body.length > 200) samples.push(body.slice(0, 400))
    if (samples.length >= N) break
  }
}
samples.push('渲染又卡了，上次教室那个是怎么解决的？')
samples.push('阴影贴图分辨率要不要降一半')
while (samples.length < N) samples.push(`本地嵌入一致性对照样本 #${samples.length}：教室建模渲染管线排查。`)

const mk = (name, apiUrl, apiKey, model, dim, providerOrder) =>
  new EmbedClient({
    apiUrl, apiKey, model, dimension: dim,
    cachePath: join(tmpdir(), `parity-${name}-${Date.now()}.json`),
    providerOrder, timeoutMs: 30000,
    logger: { warn: (m) => console.log(`  [warn:${name}] ${m}`), info: () => {} },
  })

const local = mk('local', LOCAL_URL, 'local', 'BAAI/bge-m3', 1024, undefined)
const rem = mk('remote', remote.apiUrl, remote.apiKey, remote.model, remote.dimension, remote.providerOrder)

const cos = (a, b) => {
  let d = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
  return d / (Math.sqrt(na) * Math.sqrt(nb))
}
const maxAbs = (a, b) => { let m = 0; for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i])); return m }
const norm = (a) => Math.sqrt(a.reduce((s, x) => s + x * x, 0))

console.log(`远端: ${remote.apiUrl} model=${remote.model} dim=${remote.dimension} providerOrder=${JSON.stringify(remote.providerOrder ?? null)}`)
console.log(`本地: ${LOCAL_URL} model=BAAI/bge-m3 dim=1024`)
console.log(`样本: ${samples.length} 条（真实语料 ${Math.max(0, samples.length - 2)} 条 + 2 条查询）\n`)

// 先用一条探活，端点不通就早退（别把失败混进统计）
try {
  const [probe] = await local.embed(['探活'])
  console.log(`本地探活：dim=${probe.length} norm=${norm(probe).toFixed(4)}`)
} catch (e) {
  console.error(`❌ 本地端点不通（${LOCAL_URL}）：${String(e.message).slice(0, 200)}`)
  process.exit(2)
}

const rows = []
let ok = 0
for (const [i, text] of samples.entries()) {
  try {
    const [lv] = await local.embed([text])
    const [rv] = await rem.embed([text])
    rows.push({ i, cos: cos(lv, rv), maxAbs: maxAbs(lv, rv), lNorm: norm(lv), rNorm: norm(rv) })
    ok++
  } catch (e) {
    console.log(`  #${i} 失败：${String(e.message).slice(0, 120)}`)
  }
}

// 重现性：同一文本各打两次
const det = async (client, label) => {
  const [a] = await client.embed([samples[0]])
  const [b] = await client.embed([samples[0]])
  console.log(`${label} 自身重现性：cos=${cos(a, b).toFixed(9)} max|Δ|=${maxAbs(a, b).toExponential(2)}`)
}
await det(local, '本地')
await det(rem, '远端')

if (!rows.length) { console.error('无有效对照样本'); process.exit(1) }
const avg = (f) => rows.reduce((s, r) => s + f(r), 0) / rows.length
console.log(`\n════ 本地 vs 远端（n=${ok}）════`)
console.log(`余弦相似度：均值=${avg((r) => r.cos).toFixed(6)} 最小=${Math.min(...rows.map((r) => r.cos)).toFixed(6)}`)
console.log(`最大逐元素偏差：均值=${avg((r) => r.maxAbs).toExponential(2)} 最大=${Math.max(...rows.map((r) => r.maxAbs)).toExponential(2)}`)
console.log(`向量范数：本地 ${avg((r) => r.lNorm).toFixed(4)} / 远端 ${avg((r) => r.rNorm).toFixed(4)}（应都≈1）`)
for (const r of rows) console.log(`  #${r.i} cos=${r.cos.toFixed(6)} max|Δ|=${r.maxAbs.toExponential(2)}`)
const verdict = avg((r) => r.cos) > 0.9999 ? '✅ 可直接切（旧向量继续用）' : avg((r) => r.cos) > 0.99 ? '⚠️ 基本一致但建议评估重嵌' : '❌ 偏差过大 → 必须全库重嵌'
console.log(`\n判据：${verdict}`)
for (const c of [local, rem]) { try { await c.flushCache() } catch {} }
