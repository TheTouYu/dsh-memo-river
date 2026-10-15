#!/usr/bin/env node
/**
 * scripts/probe-embed-splitbatch.mjs — 注入嵌入「拆批 1+2」受控 A/B（2026-10-15，D265 复核）。
 *
 * 为什么测：注入每个 pre-step 嵌 3 条文本 [query(≤4000字), gU(短指令), gA(≤1200字)]。
 * D265 受控实验称本地 bge-m3 按「批内最长条 padding」计费：合批 3 条 1299ms vs 拆 3 请求
 * 662ms（-49%）。但生产 [req] 日志出现矛盾信号（n=3 chars=5338 enc=1342 ≈3×最长条 ✓padding；
 * 另有 n=2 chars=4600 enc=416 ≈字符和 ✗padding）——成分未知，必须用**已知成分**复测。
 *
 * 三形态（同一客户端、真 EmbedClient 代码路径）：
 *   F0 合批 3 条一次请求（改动前生产形态）
 *   F1 拆 1+2：embed([query]) ∥ embed([gU,gA]) 两请求并行（本次改动采用）
 *   F2 拆 1+1+1：三条各自单发并行（对照）
 *
 * 方法学：
 *   · 文本形状对齐 D265：query 4000 字 / gU 9 字 / gA 1200 字；尾签内嵌在开头保证等长且互异。
 *   · 每轮每形态独立 nonce（防客户端 emb-cache 与服务端 120s TTL/在飞去重命中——
 *     服务端 dedup 键 = sha1(整批 join)，批成分不同即 miss）。
 *   · 形态间交错执行，对冲 GPU 时钟漂移（文档记录过 1.6×）与生产并发流量。
 *   · 客户端墙钟（用户体感，含服务端排队）之外，跑完用 journalctl '\[req\]' 对时窗核
 *     enc=/wait=（纯前向 vs 排队分开看）。
 *   · 向量漂移单独一轮：同文本 F0（主客户端合批）vs 单发（**独立缓存的第二客户端**），
 *     逐元素最大差 + cos（合批≠单发已实测过，这里定量进改动注释）。
 *
 * 用法：node scripts/probe-embed-splitbatch.mjs [rounds=8]
 *   PROBE_EMBED_API_URL（缺省 http://127.0.0.1:8099）/ PROBE_EMBED_DIM（缺省 1024）
 * 只发嵌入请求，不写任何日记；缓存落 /var/tmp（不碰生产桶）。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const ROUNDS = Number(process.argv[2] ?? 8)
const { EmbedClient, cosine } = await import('../lib/embed.js')

const API = process.env.PROBE_EMBED_API_URL ?? 'http://127.0.0.1:8099'
const DIM = Number(process.env.PROBE_EMBED_DIM ?? 1024)
const MODEL = process.env.PROBE_EMBED_MODEL ?? 'BAAI/bge-m3'

const TMP = mkdtempSync(join(tmpdir(), 'embed-split-'))
const mkClient = (tag) =>
  new EmbedClient({
    apiUrl: API,
    apiKey: process.env.PROBE_EMBED_API_KEY ?? 'local',
    model: MODEL,
    dimension: DIM,
    cachePath: join(TMP, `emb-cache-${tag}.bin`),
    timeoutMs: 30_000,
    logger: { warn: (m) => console.error(`[warn] ${m}`), info: () => {} },
  })
const client = mkClient('main')
console.log(`端点: ${API}  模型: ${MODEL}  维度: ${DIM}  轮数: ${ROUNDS}（交错）  开始: ${new Date().toISOString()}`)

/* 等长文本：**全局自增序号放开头**（短文本放尾会被 slice 截掉 → 跨轮重复 → 客户端缓存
 * 命中 → 形态被偷换。第一版实测翻车：F0 从第 2 轮起实际发 n=2 [q,gA]。） */
const CORPUS = '教室建模渲染管线排查记录阴影贴图分辨率帧率恢复锚文本采样判定余弦门控召回注入'
let seq = 0
const shape = (n, tag) => (String(++seq).padStart(8, '0') + '·' + tag + '·' + CORPUS.repeat(Math.ceil(n / 32))).slice(0, n)
const mkTexts = (form, round) => {
  const s = `${form}r${round}`
  return { q: shape(4000, `Q${s}`), gu: shape(9, `U${s}`), ga: shape(1200, `A${s}`) }
}

const FORMS = [
  ['F0_batch3', (t) => client.embed([t.q, t.gu, t.ga])],
  ['F1_1+2', async (t) => {
    const [a, b] = await Promise.all([client.embed([t.q]), client.embed([t.gu, t.ga])])
    return [...a, ...b]
  }],
  ['F2_1+1+1', async (t) => {
    const [a, b, c] = await Promise.all([client.embed([t.q]), client.embed([t.gu]), client.embed([t.ga])])
    return [...a, ...b, ...c]
  }],
]

/* ── 向量漂移一轮（先跑：独立 nonce，不受计时轮影响）──
 * 关键：单发侧必须用**独立缓存**的第二个客户端——批响应会按条目写入 EmbCache，
 * 同客户端后发单发必命中缓存，测出假漂移 0.00e+0（第一版翻车实录：读数来自
 * 缓存记录而非嵌入对象）。服务端侧批键 = sha1(整批 join)，批成分不同即真 encode。 */
{
  const single = mkClient('drift-single')
  const t = { q: shape(4000, 'Qdrift'), gu: shape(9, 'Udrift'), ga: shape(1200, 'Adrift') }
  const v0 = await client.embed([t.q, t.gu, t.ga]) // 合批 3
  const v1q = (await single.embed([t.q]))[0] // 单发 query
  const v2u = (await single.embed([t.gu]))[0] // 单发 gU
  const v2a = (await single.embed([t.ga]))[0] // 单发 gA
  const drift = (name, a, b) => {
    let maxAbs = 0
    for (let i = 0; i < a.length; i++) maxAbs = Math.max(maxAbs, Math.abs(a[i] - b[i]))
    console.log(`漂移 ${name}: 逐元素最大差 ${maxAbs.toExponential(2)}  cos ${cosine(a, b).toFixed(8)}`)
  }
  console.log('── 向量漂移（同文本，合批 vs 单发；非逐位相等是预期）──')
  drift('query(4000字) 合批↔单发', v0[0], v1q)
  drift('gU(9字)     合批↔单发', v0[1], v2u)
  drift('gA(1200字)  合批↔单发', v0[2], v2a)
  try { await single.flushCache() } catch { /* 尽力而为 */ }
}

/* ── 计时轮（交错）── */
const times = { F0_batch3: [], 'F1_1+2': [], 'F2_1+1+1': [] }
for (let round = 0; round < ROUNDS; round++) {
  for (const [name, fn] of FORMS) {
    const t = mkTexts(name, round)
    const t0 = performance.now()
    try {
      await fn(t)
      times[name].push(performance.now() - t0)
    } catch (e) {
      console.error(`[${name} r${round}] 失败: ${String(e.message).slice(0, 140)}`)
    }
    await new Promise((r) => setTimeout(r, 200))
  }
}
const pct = (arr, p) => [...arr].sort((a, b) => a - b)[Math.min(arr.length - 1, Math.floor((p / 100) * arr.length))]
const stats = (arr) => ({
  n: arr.length,
  min: Math.round(Math.min(...arr)),
  p50: Math.round(pct(arr, 50)),
  mean: Math.round(arr.reduce((a, b) => a + b, 0) / arr.length),
  max: Math.round(Math.max(...arr)),
})
console.log(`\n── 计时（客户端墙钟 ms，含服务端排队；形态交错对冲漂移）──`)
const out = {}
for (const [name] of FORMS) {
  out[name] = stats(times[name])
  console.log(`${name.padEnd(10)} n=${out[name].n} min=${out[name].min} p50=${out[name].p50} mean=${out[name].mean} max=${out[name].max}`)
}
const f0 = out.F0_batch3.mean
const f1 = out['F1_1+2'].mean
const f2 = out['F2_1+1+1'].mean
if (f0 && f1) console.log(`F1(1+2) vs F0(合批3) mean: ${f1} vs ${f0} ms → ${(((f0 - f1) / f0) * 100).toFixed(1)}% ｜ F2(1+1+1) mean: ${f2}`)
console.log(`\n服务端对时核验：journalctl --user -u dsh-embed --since "${new Date(Date.now() - ROUNDS * 3 * 900).toISOString().slice(11, 19)}" --no-pager | grep '\\[req\\]'`)
try { await client.flushCache() } catch { /* 尽力而为 */ }
rmSync(TMP, { recursive: true, force: true })
