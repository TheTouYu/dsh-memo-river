#!/usr/bin/env node
/**
 * probe-anchor-trace.mjs —— 锚（证据分级）读出链的**单次可判别**探针（2026-09-25）。
 *
 * 背景：生产召回里 `anchor=0.000` 是 100%——`role` 恒为 `atomic_concept`，
 * `direct_answer`/`structural_explanation` 从未出现，契约的「证据等级」在实现上是死的。
 * 症状是黑盒：Rust 侧 `runMemoPipeline` → `rerankRivermemoTopologyV3` 一条龙，
 * TS 只拿到 anchorBonus=0，看不出死在 (a) source_field 空 / (b) direct_ids 与它无交集
 * / (c) 有 seed 但接触算不出来。
 *
 * 做什么：在**桶的副本**上复跑同一查询，把 Rust 已经序列化但 TS 未消费的
 * `topologyV3` 逐候选字段（anchorScore / anchorReliability / anchorStrength /
 * contactedSeeds / exactContacts / semanticContacts / meanClosure）全部落盘。
 * 判据（一次查询即分辨）：
 *   · 全部 contactedSeeds=0 + metadata.diagnostics.seedNodes=0 → 种子在源头就空
 *   · 全部 contactedSeeds=0 + seedNodes>0                     → 种子非空但无候选接触
 *   · 有 contactedSeeds>0 而 anchorScore=0                    → 接触算出了 0（公式/量纲）
 *
 * 只读纪律：先把桶 `cp -a` 到工作区 `.scratch/anchor-probe/` 再动；生产桶一字不写。
 * 用法：node scripts/probe-anchor-trace.mjs [查询文本] [桶哈希]
 */
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const LIB = join(ROOT, 'lib')
const VCP_ROOT = '/home/h/app/VCPToolBox'
const HOME = process.env.HOME

const QUERY = process.argv[2] ?? '干跑验证'
const BUCKET_HASH = process.argv[3] ?? '50d29236c1297d2c'
/* 源桶目录：缺省 = 生产根；PROBE_SRC=<dir> 可指到任意副本（如 retag 后的桶）——只读拷贝用。 */
const PROD_BUCKET = process.env.PROBE_SRC || join(HOME, '.dsh/memo-river', BUCKET_HASH)
const WORK_ROOT = join(ROOT, '.scratch', 'anchor-probe')

const round = (x, n = 4) => (typeof x === 'number' ? Math.round(x * 10 ** n) / 10 ** n : null)

/* ── 只读副本 ── */
rmSync(WORK_ROOT, { recursive: true, force: true })
mkdirSync(WORK_ROOT, { recursive: true })
const bucket = join(WORK_ROOT, 'bucket')
cpSync(PROD_BUCKET, bucket, { recursive: true })
const dbPath = join(bucket, 'knowledge_base.sqlite')
if (!existsSync(dbPath)) throw new Error(`副本缺库：${dbPath}`)

const { loadEnvFile } = await import(join(LIB, 'runtime.js'))
const { KnowledgeStore } = await import(join(LIB, 'store.js'))
const { EmbedClient, cosine } = await import(join(LIB, 'embed.js'))
const { MemoEngine } = await import(join(LIB, 'native.js'))

const env = loadEnvFile(`${VCP_ROOT}/config.env`, {})
const EMBED_CFG = {
  apiUrl: env.API_URL ?? '',
  apiKey: env.API_Key ?? '',
  model: env.WhitelistEmbeddingModel || 'gemini-embedding-2-preview',
  dimension: Number(env.VECTORDB_DIMENSION) || 3072,
}
const DIARY = (() => {
  const rows = execSync(`sqlite3 ${JSON.stringify(dbPath)} "SELECT diary_name, COUNT(*) FROM files GROUP BY diary_name;"`)
    .toString()
    .trim()
    .split('\n')
  return rows.map((r) => r.split('|')).sort((a, b) => Number(b[1]) - Number(a[1]))[0][0]
})()

const store = new KnowledgeStore(dbPath)
const embed = new EmbedClient({ ...EMBED_CFG, cachePath: join(bucket, 'emb-cache.json') })
const engine = new MemoEngine({
  vcpRoot: VCP_ROOT,
  dimension: EMBED_CFG.dimension,
  modelSig: `${EMBED_CFG.model}@relayrouter`,
  diaryName: DIARY,
  store,
})

/* ── 语料体检面 ── */
const tagFreq = store.tagFrequency()
const fileCount = store.files(DIARY).length
const chunks = store.chunks(DIARY).filter((c) => c.vector !== null)
const tags = store.tags()

console.log(`查询=${JSON.stringify(QUERY)}  桶=${BUCKET_HASH}  日记名=${DIARY}`)
console.log(`文件=${fileCount}  chunk=${chunks.length}  tag=${tags.length}`)
console.log(`Tag 频次：${tagFreq.map((t) => `${t.name} ${t.count}/${fileCount}`).join(' · ')}`)
const top = tagFreq[0]
console.log(`最大 Tag 频次：${top?.name} ${top?.count}/${fileCount} = ${(top.count / fileCount).toFixed(3)}（判据 <0.333）`)

/* ── 查询向量（缓存优先；缓存命中则零网络） ── */
const [queryVector] = await embed.embed([QUERY])
const knn = chunks
  .map((c) => ({ id: c.id, score: cosine(queryVector, c.vector.subarray(0, EMBED_CFG.dimension)) }))
  .sort((a, b) => b.score - a.score)

const out = { query: QUERY, bucket: BUCKET_HASH, diary: DIARY, tagFreq, fileCount, chunkCount: chunks.length, knnTop: knn.slice(0, 5).map((k) => ({ id: k.id, score: round(k.score) })) }

await engine.runExclusive(async () => {
  if (!engine.isLoaded) await engine.load()
  await engine.ensureArtifactLocked()
  const pipe = await engine.runPipeline('probe-anchor', QUERY, queryVector, [], [])
  out.artifact = engine.artifactState
    ? { sig: engine.artifactState.artifactSig, nodes: engine.artifactState.nodeCount, edges: engine.artifactState.edgeCount, assets: engine.artifactState.assets }
    : null
  out.pipelineDiagnostics = pipe.metadata.diagnostics ?? null
  out.matchedTags = pipe.metadata.matchedTags ?? null
  out.coreTagsMatched = pipe.metadata.coreTagsMatched ?? null
  const handle = pipe.metadata.observationHandle
  if (typeof handle !== 'string' || !handle) {
    out.error = 'no-observation-handle'
    out.metadataKeys = Object.keys(pipe.metadata)
    return
  }
  const readout = await engine.rerankTopologyV3('probe-anchor', QUERY, handle, pipe.metadata, knn)
  out.queryMode = readout.queryMode ?? null
  out.omega = readout.omega ?? null
  out.readoutDiagnostics = readout.diagnostics ?? null
  out.cands = (readout.results ?? []).map((r) => {
    const t = r.topologyV3 ?? {}
    return {
      id: r.chunkId,
      role: r.role,
      knn: round(knn.find((k) => k.id === r.chunkId)?.score),
      matchedTags: r.matchedTags ?? [],
      contactedSeeds: t.contactedSeeds ?? null,
      exactContacts: t.exactContacts ?? null,
      semanticContacts: t.semanticContacts ?? null,
      anchorScore: round(t.anchorScore),
      anchorReliability: round(t.anchorReliability),
      anchorStrength: round(t.anchorStrength),
      meanClosure: round(t.meanClosure),
      anchorBonus: round(t.anchorBonus),
      v2Bonus: round(t.v2Bonus),
      gatedV2Bonus: round(t.gatedV2Bonus),
      pureScore: round(t.pureScore),
      finalScore: round(t.finalScore),
      closure: round(r.observables?.closure),
      direct: round(r.observables?.direct),
      semanticBoundary: round(r.observables?.semanticBoundaryScore),
      queryChunk: round(r.observables?.queryChunkScore),
    }
  })
})

writeFileSync(join(WORK_ROOT, 'trace.json'), JSON.stringify(out, null, 2))

/* ── 判别输出 ── */
const cands = out.cands ?? []
const seedNodes = out.pipelineDiagnostics?.seedNodes ?? null
const contactedTotal = cands.reduce((s, c) => s + (c.contactedSeeds ?? 0), 0)
console.log(`\n── 判别面 ──`)
console.log(`artifact: nodes=${out.artifact?.nodes} edges=${out.artifact?.edges}`)
console.log(`pipeline.diagnostics.seedNodes（门控过的 Tag 数，建图前口径）= ${seedNodes}`)
console.log(`pipeline.matchedTags = ${JSON.stringify(out.matchedTags)}  coreTagsMatched = ${JSON.stringify(out.coreTagsMatched)}`)
console.log(`queryMode=${out.queryMode}  omega=${round(out.omega?.omega, 4)}  regime=${out.omega?.regime}`)
console.log(`候选=${cands.length}  联系（contactedSeeds 求和）= ${contactedTotal}`)
console.log(`\n${'id'.padEnd(5)}${'role'.padEnd(24)}${'knn'.padEnd(8)}${'contact'.padEnd(9)}${'exact'.padEnd(7)}${'sem'.padEnd(5)}${'aScore'.padEnd(9)}${'aRel'.padEnd(7)}${'aStr'.padEnd(9)}${'closure'.padEnd(9)}${'pure'.padEnd(9)}tags`)
for (const c of cands.slice(0, 20)) {
  console.log(
    `D${String(c.id).padEnd(4)}${String(c.role).padEnd(24)}${String(c.knn).padEnd(8)}${String(c.contactedSeeds).padEnd(9)}${String(c.exactContacts).padEnd(7)}${String(c.semanticContacts).padEnd(5)}${String(c.anchorScore).padEnd(9)}${String(c.anchorReliability).padEnd(7)}${String(c.anchorStrength).padEnd(9)}${String(c.closure).padEnd(9)}${String(c.pureScore).padEnd(9)}${(c.matchedTags ?? []).join(',')}`,
  )
}
/* ── 判决面：锚激活闸门（assign_v3_scores）与晋升闸门（promote） ──
 * Rust 源码：rivermemo_topology_v3.rs
 *   :2372 threshold = clamp01(max(anchor_activation_floor, mean + anchor_activation_z * std))
 *   :2394 activation = strength <= threshold ? 0 : smoothstep(...)
 *   :2404 anchor_bonus = anchor_bonus_cap * activation
 *   :2385 promote  = strongest >= anchor_frontier_abs_floor && strongest >= contrast * second
 * 默认常数（rivermemo_topology_v3.rs:291-296）：
 *   anchor_bonus_cap=0.1  anchor_activation_z=2.0  anchor_activation_floor=0.05
 *   anchor_saturation=0.2 anchor_frontier_contrast=2.0 anchor_frontier_abs_floor=0.1 */
const Z = 2.0
const FLOOR = 0.05
const SAT = 0.2
const CAP = 0.1
const ABS_FLOOR = 0.1
const CONTRAST = 2.0

if (cands.length > 0) {
  const s = cands.map((c) => c.anchorStrength ?? 0)
  const mean = s.reduce((a, b) => a + b, 0) / s.length
  const std = Math.sqrt(s.reduce((a, b) => a + (b - mean) ** 2, 0) / s.length)
  const max = Math.max(...s)
  const sorted = [...s].sort((a, b) => b - a)
  const second = sorted[1] ?? 0
  const threshold = Math.min(1, Math.max(FLOOR, mean + Z * std))
  const above = s.filter((v) => v > threshold).length
  const sim = (z, floor) => {
    const t = Math.min(1, Math.max(floor, mean + z * std))
    const n = s.filter((v) => v > t).length
    const bonus = s.map((v) => (v <= t || SAT - t <= 1e-12 ? 0 : CAP * (() => { const u = Math.min(1, Math.max(0, (v - t) / (SAT - t))); return u * u * (3 - 2 * u) })()))
    return { z, floor, threshold: round(t), above: n, maxBonus: round(Math.max(...bonus)) }
  }
  const gate = {
    strengths: { mean: round(mean, 5), std: round(std, 5), max, second, maxOverSecond: round(second > 0 ? max / second : null, 3) },
    activation: { threshold: round(threshold, 5), above, gapMaxToThreshold: round(max - threshold, 5) },
    promotion: { absFloor: ABS_FLOOR, contrast: CONTRAST, absOk: max >= ABS_FLOOR, contrastOk: max >= CONTRAST * second, promoted: max >= ABS_FLOOR && max >= CONTRAST * second },
    sweep: [2.0, 1.5, 1.0, 0.5, 0].map((z) => sim(z, FLOOR)),
  }
  out.gate = gate
  writeFileSync(join(WORK_ROOT, 'trace.json'), JSON.stringify(out, null, 2))
  console.log(`\n── 判决面：锚闸门 ──`)
  console.log(`strength: mean=${gate.strengths.mean} std=${gate.strengths.std} max=${max} second=${second} max/second=${gate.strengths.maxOverSecond}`)
  console.log(`激活闸门 z=${Z} floor=${FLOOR} → threshold=${gate.activation.threshold}；超过它的候选=${above}/${s.length}；max 距 threshold 差 ${gate.activation.gapMaxToThreshold}`)
  if (above === 0) console.log(`  ⇒ anchor_bonus 全 0 的**充分原因**：threshold=max(floor, mean+z·std) 是**相对量**，池内同质时它必然高过 max。`)
  console.log(`晋升闸门 absFloor=${ABS_FLOOR} contrast=${CONTRAST} → absOk=${gate.promotion.absOk} contrastOk=${gate.promotion.contrastOk} promoted=${gate.promotion.promoted}`)
  console.log(`z 扫描：`)
  for (const r of gate.sweep) console.log(`  z=${r.z} floor=${r.floor} → threshold=${r.threshold} 超阈=${r.above}/${s.length} max bonus=${r.maxBonus}`)
}

console.log(`\n全量 trace: ${join(WORK_ROOT, 'trace.json')}`)
