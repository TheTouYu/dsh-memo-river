#!/usr/bin/env node
/**
 * probe-query-morphology.mjs —— 查询形态（QueryMorphology）判读探针（票 01 / corpus-governance-0926）。
 *
 * 由头：契约段承诺 role 有四级（atomic_concept / structural_explanation / thematic_neighbor /
 * direct_answer），但实测生产 6/6 查询全是 `queryMode=atomic`，而 Rust 侧
 * `rivermemo_topology_v3.rs:2231` `let direct_answer = mode != "atomic" && …`、
 * `:2238 item.role = if mode == "atomic" { "atomic_concept" } …`
 * ⇒ **atomic 模式下 `structural_explanation` 结构性不可达**（后段只可能晋升 direct_answer
 * 或把 structural 降级 thematic）。
 *
 * 本探针回答两件事：
 *   ① mode 到底由什么决定？—— 读源码确认：logits 由**观测图拓扑**算出（`:2088-2100`
 *      shallow_energy_ratio / energy_concentration / effective_depth / chainness / …），
 *      与查询文本措辞无关；`confidence = sqrt((1-e^{-nodes/8})(1-e^{-edges/8})) × completeness`
 *      （`:2077-2086`），`weights = confidence·softmax(logits) + (1-confidence)·[⅓,⅓,⅓]`（`:2109-2113`），
 *      平局归 atomic（`:2114`）——低置信度时权重趋向均匀先验，**atomic 是默认档**。
 *   ② 形态权重根本没进 TS —— 直接跑 ≥8 种查询形态，把 `queryMorphology` 全字段打出来。
 *
 * 只读纪律：桶 `cp -a` 到工作区 `.scratch/morph-probe/` 再动；生产桶一字不写。
 * 用法：node scripts/probe-query-morphology.mjs [桶哈希] [输出md路径]
 *   PROBE_SRC=<dir>  源桶目录（缺省 $HOME/.dsh/memo-river/<hash>；可指副本）
 */
import { cpSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const LIB = join(ROOT, 'lib')
const VCP_ROOT = '/home/h/app/VCPToolBox'
const HOME = process.env.HOME

const BUCKET_HASH = process.argv[2] ?? '50d29236c1297d2c'
const OUT_MD = process.argv[3] ?? join(ROOT, '.scratch', 'corpus-governance-0926', '01-morphology.md')
const PROD_BUCKET = process.env.PROBE_SRC || join(HOME, '.dsh/memo-river', BUCKET_HASH)
const WORK_ROOT = join(ROOT, '.scratch', 'morph-probe')

/* 10 种查询形态：纯标签词 / 短问题 / 长命题式（≥40 字）/ 长叙事式（≥40 字）/ 中英混 / 单词。 */
const SHAPES = [
  { kind: '标签词·流程', q: '干跑验证' },
  { kind: '标签词·内容', q: '推送闸门脏增量' },
  { kind: '短问题', q: '为什么嵌入端点变慢了' },
  { kind: '短问题', q: '会话迁移会不会覆盖旧会话' },
  { kind: '中文短语', q: '预设 bundle 的相对路径怎么解析' },
  { kind: '长命题式', q: '在 0.1.7-rc.2 上三个补丁器的老锚点为什么全部失效，变体锚点机制又是如何在保留 0.1.5 兼容的前提下解决这个问题的' },
  { kind: '长叙事式', q: '这次升级里我踩了几个坑，先是从假 HOME 混装树验出假局限，后来整装树又让探针不可达，最后会话迁移还发现原文件根本不会被覆盖' },
  { kind: '长命题式', q: '从 0.1.5 到 0.1.7-rc.2 的迁移过程中，哪些自有组件需要改、每个改动的判据是什么、以及哪一处最容易在升级当天翻车' },
  { kind: '混合', q: '干跑验证 0.1.7 补丁器' },
  { kind: '单词·英文', q: 'bundle' },
]

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
    .toString().trim().split('\n')
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

const tagFreq = store.tagFrequency()
const fileCount = store.files(DIARY).length
const chunks = store.chunks(DIARY).filter((c) => c.vector !== null)

console.log(`桶=${BUCKET_HASH}  日记名=${DIARY}  文件=${fileCount}  tag=${store.tags().length}  查询形态=${SHAPES.length}`)
console.log(`最大 Tag 频次：${tagFreq[0]?.name} ${tagFreq[0]?.count}/${fileCount}`)

const rows = []
await engine.runExclusive(async () => {
  if (!engine.isLoaded) await engine.load()
  await engine.ensureArtifactLocked()
  const art = engine.artifactState
  console.log(`artifact: nodes=${art?.nodeCount} edges=${art?.edgeCount} sig=${String(art?.artifactSig).slice(0, 12)}`)

  for (const shape of SHAPES) {
    const [qv] = await embed.embed([shape.q])
    const knn = chunks
      .map((c) => ({ id: c.id, score: cosine(qv, c.vector.subarray(0, EMBED_CFG.dimension)) }))
      .sort((a, b) => b.score - a.score)
    const pipe = await engine.runPipeline('probe-morph', shape.q, qv, [], [])
    const handle = pipe.metadata.observationHandle
    if (typeof handle !== 'string' || !handle) { rows.push({ ...shape, error: 'no-handle' }); continue }
    const readout = await engine.rerankTopologyV3('probe-morph', shape.q, handle, pipe.metadata, knn)
    const m = (readout.queryMorphology ?? {}) || {}
    const strengths = (readout.results ?? []).map((r) => r.topologyV3?.anchorStrength ?? 0)
    const max = strengths.length ? Math.max(...strengths) : 0
    const roles = {}
    for (const r of readout.results ?? []) roles[r.role] = (roles[r.role] ?? 0) + 1
    rows.push({
      kind: shape.kind,
      q: shape.q,
      chars: [...shape.q].length,
      mode: readout.queryMode ?? null,
      omega: round(readout.omega?.omega, 4),
      regime: readout.omega?.regime ?? null,
      atomic: round(m.atomicWeight, 4),
      propositional: round(m.propositionalWeight, 4),
      narrative: round(m.narrativeWeight, 4),
      confidence: round(m.confidence, 4),
      effectiveDepth: round(m.effectiveDepth, 4),
      depthVariance: round(m.depthVariance, 4),
      energyConcentration: round(m.energyConcentration, 4),
      shallowEnergyRatio: round(m.shallowEnergyRatio, 4),
      chainness: round(m.chainness, 4),
      branching: round(m.branching, 4),
      growthPersistence: round(m.growthPersistence, 4),
      forwardFlow: round(m.forwardFlowRatio, 4),
      maxStrength: round(max, 4),
      topRole: Object.entries(roles).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null,
      seedNodes: pipe.metadata?.diagnostics?.seedNodes ?? null,
      matchedTags: (pipe.metadata?.matchedTags ?? []).length,
    })
  }
})

writeFileSync(join(WORK_ROOT, 'morphology.json'), JSON.stringify({ bucket: BUCKET_HASH, diary: DIARY, artifact: engine.artifactState, rows }, null, 2))

const pad = (s, n) => String(s ?? '').padEnd(n)
console.log(`\n${pad('形态', 12)}${pad('字', 4)}${pad('queryMode', 14)}${pad('Ω', 8)}${pad('regime', 8)}${pad('atomic', 8)}${pad('prop', 8)}${pad('narr', 8)}${pad('conf', 8)}${pad('depth', 8)}${pad('chain', 8)}${pad('aStrMax', 8)}topRole`)
for (const r of rows) {
  console.log(`${pad(r.kind, 12)}${pad(r.chars, 4)}${pad(r.mode, 14)}${pad(r.omega, 8)}${pad(r.regime, 8)}${pad(r.atomic, 8)}${pad(r.propositional, 8)}${pad(r.narrative, 8)}${pad(r.confidence, 8)}${pad(r.effectiveDepth, 8)}${pad(r.chainness, 8)}${pad(r.maxStrength, 8)}${r.topRole}`)
}

const md = [
  `# 票 01 实测：查询形态（QueryMorphology）只认图拓扑，不认查询措辞`,
  '',
  `- 桶：\`${BUCKET_HASH}\`（日记名 ${DIARY}，${fileCount} 篇 / ${store.tags().length} Tag）`,
  `- artifact：nodes=${engine.artifactState?.nodeCount} edges=${engine.artifactState?.edgeCount} sig=${String(engine.artifactState?.artifactSig).slice(0, 12)}`,
  `- 形态数：${SHAPES.length}（含 3 种 ≥40 字长句）`,
  '',
  '| 形态 | 字数 | queryMode | Ω | regime | atomicW | propW | narrW | confidence | effDepth | chainness | aStrMax | topRole |',
  '|---|---|---|---|---|---|---|---|---|---|---|---|---|',
  ...rows.map((r) => `| ${r.kind} | ${r.chars} | ${r.mode} | ${r.omega} | ${r.regime} | ${r.atomic} | ${r.propositional} | ${r.narrative} | ${r.confidence} | ${r.effectiveDepth} | ${r.chainness} | ${r.maxStrength} | ${r.topRole} |`),
  '',
  `原始 JSON：\`.scratch/morph-probe/morphology.json\``,
  '',
].join('\n')
mkdirSync(dirname(OUT_MD), { recursive: true })
writeFileSync(OUT_MD, md)
console.log(`\n表已写入 ${OUT_MD}`)
