// 票 07（recall-quality-0916）：direct_answer=0/37 根因诊断的离线复放器。
//
// 做什么：复放 genshin-ts 桶（4bde2299850f027e）会话夜（09-15T13Z~19Z，本地 21:03→02:01 CST）
// 的全部被动注入（36 条 inject 行）与全部 memo_recall 主动查询（4 条），量化 direct_answer
// 判定链路（queryMode / closure / direct_evidence / 锚晋升 / omega）每一环的数值与阈值距离。
//
// ⚠️ 夜语料不能直接用生产库：09-16 晨会话续跑做了 tag 手术（memo_update 全量改写）与
// merge（27→23 文件），夜里 files.updated_at 时间线已被破坏。本脚本**从考古材料重建**
// 夜语料库：
//   · 写事件全集 = 生产日志 memo_write 行（path/chunk=D-id/tags/ts，权威顺序）；
//   · 每次写的精确正文 = 会话文件 tool/call（name=memo_write/memo_update）的
//     arguments.content（含 Tag 行，逐字节原样；按 tags 集合+时间窗 join 日志行）；
//   · D1/D2（09-13）磁盘文件未被晨间手术触碰 → 缺 call 时退回读盘；
//   · 向量全部吃生产 emb-cache.json（键=原文，逐字节一致即同向量——写入时嵌过）；
//   · writeDiary 约定对齐 tools.ts:484（checksum=sha256(full)、size=byteLength、
//     mtime=写时刻、file_tags position=序+1），updated_at 写后 UPDATE 回日志 ts；
//   · 断言门：重建的 chunkId 必须逐条等于日志行 chunk=D<n>（D10/D11 双写同 path 复现）。
//
// 生产桶只读（日志/会话文件/emb-cache）；一切写入在 /tmp，用完自净。
// 复放保真度固有上界：生产 native 二进制（09-14 15:39）早于确定性修复（15:56），
// 同输入下 top-3 近并列排序可漂——结论落在分布层面（见 docs/EVAL-诊断-direct-answer.md）。
//
// 用法：node scripts/replay-direct-answer.mjs [--json <out.json>] [--quiet]
import { execSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const LIB = join(HERE, '..', 'lib')

/* ── 生产只读路径 ── */
const PROD_ROOT = process.env.MEMO_PROD_ROOT || `${process.env.HOME}/.dsh/memo-river/4bde2299850f027e`
const PROD_LOG = join(PROD_ROOT, 'memo-river.log')
const PROD_DAILY = join(PROD_ROOT, 'dailynote', 'genshin-ts')
const PROD_EMB_CACHE = join(PROD_ROOT, 'emb-cache.json')
const SESSIONS_ROOT = `${process.env.HOME}/.dsh/sessions/--home-h-genshin-ts--`
const VCP_ROOT = '/home/h/app/VCPToolBox'

/* ── 2026-09-15 夜生产配置（DSH 进程 09-14 21:08 启动未重启；live=b498127，
 *    recall 选择逻辑与 HEAD 一致，仅嵌入合批不同——向量逐位等价） ── */
const CFG = {
  k: 3,
  tokenBudget: 600,
  dynamicK: 1,
  mode: 'topology_v3',
  gate: true,
  gateThreshold: 0.55,
  minKnnForReward: 0.6,
  queryLookback: 6,
  recencyFloorDays: 7,
  bucket: 'genshin-ts',
}

/* 会话夜：09-15 21:03 CST → 09-16 02:01 CST = 09-15T13:03Z→18:01Z（报告「37」=时区滑窗
 * 多算 1 条晨间续跑注入；真口径=36：父 8 + 15 子会话 28）。 */
const T0 = Date.parse('2026-09-15T13:00:00Z')
const T1 = Date.parse('2026-09-15T19:00:00Z')

const args = process.argv.slice(2)
const jsonOut = args.indexOf('--json') >= 0 ? args[args.indexOf('--json') + 1] : null
const quiet = args.includes('--quiet')

/* ════════ ① 生产日志：inject 行 + write 事件 ════════ */
function parseLog() {
  const injects = []
  const writes = []
  const injectRe =
    /^\[(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\.\d+Z\] \[info\] inject bucket=genshin-ts ids=([\w,]+) omega=([\d.]+) regime=(\w+) mode=(\w+) chars=\d+ candidates=(\d+) dropped=(\d+) injectMode=(\w+)(?: trigger=(\w+))? session=([\w-]+) gate=\{passed:(\w+),maxKnn:([\d.]+),threshold:([\d.]+),gateVector:(\w+),retrievalMaxKnn:([\d.]+)\}/
  const writeRe =
    /^\[(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\.\d+Z\] \[info\] memo_write bucket=genshin-ts file=(\S+) chunk=D(\d+) tags=(.*?) newTags=/
  for (const line of readFileSync(PROD_LOG, 'utf8').split('\n')) {
    let m = injectRe.exec(line)
    if (m) {
      const t = Date.parse(`${m[1]}Z`)
      if (t < T0 || t > T1) continue
      injects.push({
        t,
        tsLabel: m[1],
        ids: m[2].split(','),
        omega: +m[3],
        regime: m[4],
        candidates: +m[6],
        dropped: +m[7],
        injectMode: m[8],
        trigger: m[9] ?? '',
        session: m[10],
        logGate: { maxKnn: +m[12], gateVector: m[14], retrievalMaxKnn: +m[15] },
      })
      continue
    }
    m = writeRe.exec(line)
    if (m) {
      const t = Date.parse(`${m[1]}Z`)
      if (t > T1) continue // 夜终点之后（晨间手术）不进重建
      writes.push({
        t,
        tsLabel: m[1],
        path: m[2],
        chunk: Number(m[3]),
        tags: (m[4] ?? '').split(',').map((s) => s.trim()).filter(Boolean),
      })
    }
  }
  injects.sort((a, b) => a.t - b.t)
  writes.sort((a, b) => a.t - b.t)
  return { injects, writes }
}

/* ════════ ② 会话流（查询重建 + write 正文提取） ════════ */
const messageText = (msg) => {
  if (!msg || typeof msg !== 'object') return ''
  const content = msg.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block && typeof block === 'object' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n')
}

function loadSession(sessionId) {
  const file = join(SESSIONS_ROOT, sessionId, 'session.v3.jsonl.zstd')
  if (!existsSync(file)) return null
  const raw = execSync(`zstd -dc ${JSON.stringify(file)}`, { maxBuffer: 512 * 1024 * 1024 }).toString()
  const dialog = []
  const claimedPool = []
  const compactions = []
  const recallCalls = []
  const writeCalls = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let e
    try {
      e = JSON.parse(line)
    } catch {
      continue
    }
    const t = e.time ?? 0
    if (e.type === 'user/message') {
      const msg = e.data
      const kind = msg?.source?.kind ?? ''
      claimedPool.push({ t, role: 'user', kind, text: messageText(msg) })
      if (kind !== 'plugin' && kind !== 'tool') dialog.push({ t, role: 'user', kind, text: messageText(msg) })
    } else if (e.type === 'assistant/message') {
      const text = messageText(e.data?.message)
      dialog.push({ t, role: 'assistant', kind: '', text })
      claimedPool.push({ t, role: 'assistant', kind: '', text })
    } else if (e.type === 'compaction/end') {
      compactions.push(t)
    } else if (e.type === 'tool/call') {
      const d = e.data ?? {}
      const name = typeof d.name === 'string' ? d.name : ''
      if (name !== 'memo_write' && name !== 'memo_update' && name !== 'memo_recall') continue
      const a = typeof d.arguments === 'string' ? safeJson(d.arguments) : (d.arguments ?? {})
      if (name === 'memo_recall') recallCalls.push({ t, query: String(a.query ?? ''), k: typeof a.k === 'number' ? a.k : null })
      else writeCalls.push({ t, name, content: String(a.content ?? ''), title: typeof a.title === 'string' ? a.title : '', tags: Array.isArray(a.tags) ? a.tags.map(String) : [] })
    }
  }
  return { dialog, claimedPool, compactions, recallCalls, writeCalls }
}
const safeJson = (s) => {
  try {
    return JSON.parse(s)
  } catch {
    return {}
  }
}

/** 注入时刻 T 的 msgs 重建（injector 口径）：
 *  历史 = <=T、最后 compaction/end 之后的对话消息；
 *  claimed（角色过滤，含 plugin 类）= interactive/compaction 触发时 T 之后日志里的
 *  连续 user/message 段。claimed 的构成逐事件有差异（有时带 runtime 快照/compact
 *  摘要、有时只有真实用户消息）——用生产 emb-cache 当 oracle：对每个事件试多个
 *  变体，取查询场逐字节命中缓存者；全不命中则按 injectMode 取缺省变体并标记。 */
function claimedVariants(sess, ev) {
  const lastComp = sess.compactions.filter((t) => t <= ev.t).pop() ?? -Infinity
  const history = sess.dialog.filter((m) => m.t > lastComp && m.t <= ev.t)
  const after = []
  let started = false
  for (const m of sess.claimedPool) {
    if (m.t <= ev.t) continue
    if (m.role === 'assistant') {
      if (started) break
      continue
    }
    after.push(m)
    started = true
  }
  const dialogOnly = after.filter((m) => m.kind !== 'plugin')
  return {
    A: { history, claimed: [] }, // 无新输入（autonomous）
    B: { history, claimed: dialogOnly.slice(0, 1) }, // 只带下一条真实对话 user 消息
    C: { history, claimed: after.slice(0, 2) }, // 带 claimed 段前两条（含 plugin 快照/摘要）
    D: { history, claimed: after.filter((m) => m.kind === 'plugin').slice(0, 1) }, // 只带 compact 摘要/快照
  }
}

/** oracle：按缓存命中挑变体。返回 {history, claimed, variant, qfCacheHit} */
function pickVariant(sess, ev, prodCacheKeys) {
  const order = ev.injectMode === 'interactive' || ev.trigger === 'compaction' ? ['C', 'B', 'D', 'A'] : ['A', 'B']
  let fallback = null
  for (const v of order) {
    const { history, claimed } = claimedVariants(sess, ev)[v]
    const qf = buildQueryField([...history, ...claimed].map((m) => m.text), CFG.queryLookback)
    if (!qf) continue
    if (prodCacheKeys.has(qf)) return { history, claimed, variant: v, qf, qfCacheHit: true }
    if (!fallback) fallback = { history, claimed, variant: v, qf, qfCacheHit: false }
  }
  return fallback ?? { history: sess.dialog.filter((m) => m.t <= ev.t), claimed: [], variant: 'X', qf: '', qfCacheHit: false }
}

const buildQueryField = (texts, lookback) => {
  const picked = []
  for (let i = texts.length - 1; i >= 0 && picked.length < lookback; i--) {
    const text = (texts[i] ?? '').trim()
    if (text) picked.unshift(text)
  }
  return picked.join('\n').slice(-4000)
}

/* ════════ ③ 嵌入（resolveEmbed 同款回退链） ════════ */
const { loadEnvFile } = await import(join(LIB, 'runtime.js'))
const env = loadEnvFile(`${VCP_ROOT}/config.env`, {})
const EMBED_CFG = {
  apiUrl: env.API_URL ?? '',
  apiKey: env.API_Key ?? '',
  model: env.WhitelistEmbeddingModel || 'gemini-embedding-2-preview',
  dimension: Number(env.VECTORDB_DIMENSION) || 3072,
}

/* ════════ 主流程 ════════ */
const { injects, writes } = parseLog()
const sessions = new Map()
for (const ev of injects) if (!sessions.has(ev.session)) sessions.set(ev.session, loadSession(ev.session))
for (const dir of readdirSync(SESSIONS_ROOT, { withFileTypes: true })) {
  if (!dir.isDirectory() || sessions.has(dir.name)) continue
  const s = loadSession(dir.name)
  if (s && (s.recallCalls.length || s.writeCalls.length)) sessions.set(dir.name, s)
}

/* write 正文 join：call 先于日志行（嵌入+写入耗时），窗口 [t-300s, t+10s]，
 * tags 集合相等优先（1e9 压过毫秒级时间差），其次时间近者。 */
const allWriteCalls = [...sessions.values()].flatMap((s) => s.writeCalls).sort((a, b) => a.t - b.t)
const usedCalls = new Set()
function callForWriteEvent(ev) {
  const want = new Set(ev.tags)
  let best = null
  for (const c of allWriteCalls) {
    if (usedCalls.has(c)) continue
    const dt = ev.t - c.t
    if (dt < -10_000 || dt > 300_000) continue
    const callTagLine = /Tag\s*[:：]\s*(.+)$/m.exec(c.content)
    const callTags = new Set(
      (c.tags.length ? c.tags : callTagLine ? callTagLine[1].split(/[,，、]/).map((s) => s.trim()) : []).map(String),
    )
    const tagsEq = callTags.size === want.size && [...want].every((x) => callTags.has(x))
    const score = (tagsEq ? 1e9 : 0) - Math.abs(dt)
    if (!best || score > best.score) best = { call: c, score, tagsEq }
  }
  if (best) {
    usedCalls.add(best.call)
    return { call: best.call, tagsEq: best.tagsEq }
  }
  return { call: null, tagsEq: false }
}

/* 生产 live 代码（b498127）writeDiaryCore 的 full 构造——夜向量是对 full 嵌的，不是 content 参数：
 *   title = 显式 title 参数 || 正文首行 `# ` 标题 || `${date} 未命名`（未命名 bug 属实装行为）
 *   body  = stripTagLine(content)（**保留标题行** → 标题行重复拼两次 bug 也是 live 行为）
 *   full  = `# ${title}\n\n${body}\n\nTag: ${tags.join(', ')}\n` */
const TAG_LINE_RE = /^Tag\s*[:：]\s*(.+)$/im
const stripTagLine = (c) => c.replace(TAG_LINE_RE, '').replace(/\n{3,}/g, '\n\n').trimEnd()
const titleFromContent = (c, fb) => {
  const first = c.split(/\r?\n/).find((l) => l.trim().length > 0)
  return first && first.trim().startsWith('# ') ? first.trim().slice(2).trim() : fb
}
function fullOf(call, ev) {
  const date = ev.tsLabel.slice(0, 10)
  const title = (call.title ?? '').trim() || titleFromContent(call.content, `${date} 未命名`)
  const body = stripTagLine(call.content)
  return `# ${title}\n\n${body}\n\nTag: ${ev.tags.join(', ')}\n`
}

/* recall 查询（对照实验） */
const recallEvents = []
for (const [sid, sess] of sessions) {
  for (const call of sess?.recallCalls ?? []) {
    if (!call.query || call.t < T0 || call.t > T1) continue
    recallEvents.push({ ...call, session: sid, tsLabel: new Date(call.t).toISOString().slice(0, 19) })
  }
}
recallEvents.sort((a, b) => a.t - b.t)
if (!quiet)
  console.error(
    `[1/6] 日志：inject ${injects.length} 条（父=${injects.filter((e) => e.session.startsWith('session-')).length}）/ write ${writes.length} 事件 / memo_recall ${recallEvents.length} 条`,
  )

/* ── 工作目录 + 只读快照素材 ── */
const work = mkdtempSync(join(tmpdir(), 'replay-da-'))
const embCacheCopy = join(work, 'emb-cache.json')
if (existsSync(PROD_EMB_CACHE)) cpSync(PROD_EMB_CACHE, embCacheCopy)
const prodCacheKeys = existsSync(PROD_EMB_CACHE)
  ? new Set(Object.keys(JSON.parse(readFileSync(PROD_EMB_CACHE, 'utf8'))))
  : new Set()

const { KnowledgeStore } = await import(join(LIB, 'store.js'))
const { EmbedClient, cosine } = await import(join(LIB, 'embed.js'))
const { MemoEngine } = await import(join(LIB, 'native.js'))
const { recall } = await import(join(LIB, 'recall.js'))
const embed = new EmbedClient({ ...EMBED_CFG, cachePath: embCacheCopy })

/* ════════ ④ 夜语料重建 ════════ */
const rebuiltDb = join(work, 'night-corpus.sqlite')
{
  const store = new KnowledgeStore(rebuiltDb)
  const tagIds = new Map()
  const tagFirstUse = new Map() // tagId -> 首次写入时刻
  const rebuildLog = []
  for (const ev of writes) {
    const { call, tagsEq } = callForWriteEvent(ev)
    let content = null
    let source = call ? 'tool-call' : 'missing'
    let fullCacheHit = null
    if (call) {
      content = fullOf(call, ev)
      fullCacheHit = prodCacheKeys.has(content)
    } else {
      /* 退回磁盘：盘上文件 = 写盘时的 full（09-13 的 D1/D2 未被晨间手术触碰） */
      const disk = join(PROD_DAILY, ev.path.split('/').pop())
      if (existsSync(disk)) {
        content = readFileSync(disk, 'utf8')
        source = 'disk'
        fullCacheHit = prodCacheKeys.has(content)
      }
    }
    if (!content) {
      rebuildLog.push({ ts: ev.tsLabel, path: ev.path.split('/').pop(), chunk: ev.chunk, error: 'content-missing' })
      continue
    }
    const newTags = ev.tags.filter((t) => !tagIds.has(t))
    const vecs = await embed.embed([...newTags, content])
    for (const t of newTags) tagIds.set(t, store.upsertTag(t, vecs[newTags.indexOf(t)]))
    for (const t of ev.tags) if (!tagFirstUse.has(tagIds.get(t))) tagFirstUse.set(tagIds.get(t), ev.t)
    const written = store.writeDiary({
      path: ev.path,
      diaryName: CFG.bucket,
      checksum: createHash('sha256').update(content).digest('hex'),
      mtime: ev.t,
      size: Buffer.byteLength(content, 'utf8'),
      content,
      chunkVector: vecs[newTags.length],
      tagIds: ev.tags.map((t) => tagIds.get(t)),
    })
    /* writeDiary 的 updated_at=now（重建时刻）→ 改回日志写时刻（语料态过滤的依据） */
    execSync(`sqlite3 ${JSON.stringify(rebuiltDb)} "UPDATE files SET updated_at=${ev.t} WHERE id=${written.fileId};"`)
    rebuildLog.push({
      ts: ev.tsLabel,
      path: ev.path.split('/').pop(),
      chunk: ev.chunk,
      rebuiltChunk: written.chunkId,
      idOk: written.chunkId === ev.chunk,
      contentSource: source,
      tagsEq,
      fullCacheHit,
    })
  }
  store.close()
  writeFileSync(join(work, 'rebuild-log.json'), JSON.stringify(rebuildLog, null, 1))
  const idOkN = rebuildLog.filter((r) => r.idOk).length
  const fullHitN = rebuildLog.filter((r) => r.fullCacheHit).length
  const tagsEqN = rebuildLog.filter((r) => r.tagsEq).length
  if (!quiet)
    console.error(
      `[2/6] 夜语料重建：${rebuildLog.length} 写事件；D-id 断言 ${idOkN}/${rebuildLog.length}；full 逐字节命中生产缓存 ${fullHitN}/${rebuildLog.length}（=向量与生产同源）；join tagsEq ${tagsEqN}/${rebuildLog.length}`,
    )
  globalThis.__tagFirstUse = [...tagFirstUse.entries()]
}

/* 语料时间线 */
const timeline = (() => {
  const store = new KnowledgeStore(rebuiltDb)
  const owners = store.chunkOwners()
  const rows = [...owners.entries()].map(([chunkId, o]) => ({ chunkId, fileId: o.fileId, writtenAt: o.writtenAt }))
  store.close()
  return rows
})()
const tagFirstUse = new Map(globalThis.__tagFirstUse ?? [])

/* 按语料态分组 */
function stateKeyOf(t) {
  return timeline
    .filter((r) => r.writtenAt != null && r.writtenAt <= t)
    .map((r) => r.chunkId)
    .join(',')
}
const states = new Map()
for (const ev of [...injects.map((e) => ({ ...e, isInject: true })), ...recallEvents.map((e) => ({ ...e, isInject: false }))]) {
  const key = stateKeyOf(ev.t)
  if (!states.has(key)) states.set(key, { visible: key ? key.split(',').map(Number) : [], events: [] })
  states.get(key).events.push(ev)
}
if (!quiet) console.error(`[3/6] 语料态分组：${states.size} 个态（${injects.length + recallEvents.length} 条事件）`)

/* 状态库过滤：删未来文件 + tag 按首用时刻/引用回收 + 清派生表 */
const DERIVED_TABLES = [
  'tag_intrinsic_residuals',
  'tag_intrinsic_residual_status',
  'tag_pair_similarity',
  'tag_pair_similarity_status',
  'rivermemo_artifacts',
  'tagmemo_artifacts',
  'v10_chunk_tag_geometry',
  'v10_vector_metrics',
  'v10_derived_asset_status',
  'tag_index_baselines',
  'tag_index_baseline_entries',
]

/* ════════ ⑤ 复放 ════════ */
async function replayOne(engine, store, queryField, gateUserText, gateAssistantText, queryId, withGate) {
  const batch = [queryField]
  const trimmed = queryField.trim()
  const guIdx = withGate && gateUserText && gateUserText !== trimmed ? batch.push(gateUserText) - 1 : -1
  const gaIdx = withGate && gateAssistantText && gateAssistantText !== trimmed ? batch.push(gateAssistantText) - 1 : -1
  const vectors = await embed.embed(batch)
  const queryVector = vectors[0]

  const outcome = await recall({ store, embed, engine, dimension: EMBED_CFG.dimension }, queryField, {
    mode: CFG.mode,
    k: CFG.k,
    tokenBudget: CFG.tokenBudget,
    dynamicK: CFG.dynamicK,
    gate: withGate,
    gateThreshold: CFG.gateThreshold,
    minKnnForReward: CFG.minKnnForReward,
    recencyFloorDays: CFG.recencyFloorDays,
    queryId,
    gateText: guIdx >= 0 ? gateUserText : '',
    gateAssistantText: gaIdx >= 0 ? gateAssistantText : '',
  })

  const chunks = store.chunks().filter((c) => c.vector !== null)
  const knn = chunks
    .map((c) => ({ id: c.id, score: cosine(queryVector, c.vector.subarray(0, EMBED_CFG.dimension)) }))
    .sort((a, b) => b.score - a.score)
  const trace = await engine.runExclusive(async () => {
    const pipe = await engine.runPipeline(queryId, queryField, queryVector, [], [])
    const handle = pipe.metadata.observationHandle
    if (typeof handle !== 'string' || !handle) return null
    return await engine.rerankTopologyV3(queryId, queryField, handle, pipe.metadata, knn)
  })
  const knnById = new Map(knn.map((k) => [k.id, k.score]))
  let traceOut = null
  if (trace && Array.isArray(trace.results)) {
    const strengths = trace.results.map((r) => r.topologyV3?.anchorStrength ?? 0).sort((a, b) => b - a)
    const maxPure = Math.max(...trace.results.map((r) => r.topologyV3?.pureScore ?? 0))
    traceOut = {
      queryMode: trace.queryMode ?? null,
      omega: trace.omega?.omega ?? null,
      regime: trace.omega?.regime ?? null,
      morphology: trace.queryMorphology
        ? {
            atomic: round3(trace.queryMorphology.atomicWeight),
            prop: round3(trace.queryMorphology.propositionalWeight),
            narr: round3(trace.queryMorphology.narrativeWeight),
            mode: trace.queryMorphology.dominantMode,
          }
        : null,
      promotion: {
        strongest: round3(strengths[0] ?? 0),
        second: round3(strengths[1] ?? 0),
        promotedId: trace.results.find((r) => r.role === 'direct_answer')?.chunkId ?? null,
        promoted: (strengths[0] ?? 0) >= 0.1 && (strengths[0] ?? 0) >= 2.0 * (strengths[1] ?? 0),
      },
      cands: trace.results.map((r) => ({
        id: r.chunkId,
        role: r.role,
        knn: round4(knnById.get(r.chunkId)),
        closure: round4(r.observables?.closure),
        direct: round4(r.observables?.direct),
        semanticBoundary: round4(r.observables?.semanticBoundaryScore),
        queryChunk: round4(r.observables?.queryChunkScore),
        anchorStrength: round4(r.topologyV3?.anchorStrength),
        pureScore: round4(r.topologyV3?.pureScore),
        finalScore: round4(r.topologyV3?.finalScore),
      })),
      maxPure: round4(maxPure),
    }
  }
  return { outcome, trace: traceOut }
}
const round3 = (x) => (typeof x === 'number' ? Math.round(x * 1000) / 1000 : null)
const round4 = (x) => (typeof x === 'number' ? Math.round(x * 10000) / 10000 : null)

const results = []
const recallResults = []
let stateIdx = 0
for (const [, state] of states) {
  stateIdx++
  const dbPath = join(work, `state-${stateIdx}.sqlite`)
  cpSync(rebuiltDb, dbPath)
  const visibleSet = new Set(state.visible)
  const futureFileIds = [...new Set(timeline.filter((r) => !visibleSet.has(r.chunkId)).map((r) => r.fileId))]
  const tOfState = Math.min(...state.events.map((e) => e.t))
  const lateTagIds = [...tagFirstUse.entries()].filter(([, t0]) => t0 > tOfState).map(([id]) => id)
  const sqls = DERIVED_TABLES.map((tb) => `DELETE FROM ${tb};`).concat(["DELETE FROM kv_store WHERE key='epa_basis_cache';"])
  if (futureFileIds.length > 0) {
    const ids = futureFileIds.join(',')
    sqls.push(
      `DELETE FROM chunks WHERE file_id IN (${ids});`,
      `DELETE FROM file_tags WHERE file_id IN (${ids});`,
      `DELETE FROM files WHERE id IN (${ids});`,
    )
  }
  if (lateTagIds.length > 0) sqls.push(`DELETE FROM tags WHERE id IN (${lateTagIds.join(',')});`, 'DELETE FROM tags WHERE id NOT IN (SELECT tag_id FROM file_tags);')
  execSync(`sqlite3 ${JSON.stringify(dbPath)} ${JSON.stringify(sqls.join(' '))}`)

  const store = new KnowledgeStore(dbPath)
  const engine = new MemoEngine({
    vcpRoot: VCP_ROOT,
    dimension: EMBED_CFG.dimension,
    modelSig: `${EMBED_CFG.model}@relayrouter`,
    diaryName: CFG.bucket,
    store,
  })

  for (const ev of state.events) {
    if (ev.isInject) {
      const sess = sessions.get(ev.session)
      const row = { kind: 'inject', ts: ev.tsLabel, session: ev.session, injectMode: ev.injectMode, trigger: ev.trigger, log: { ...ev.logGate, ids: ev.ids, omega: ev.omega, regime: ev.regime, candidates: ev.candidates, dropped: ev.dropped } }
      if (!sess) {
        row.error = 'session-file-missing'
        results.push(row)
        continue
      }
      const picked = pickVariant(sess, ev, prodCacheKeys)
      const { history, claimed } = picked
      const all = [...history, ...claimed]
      const queryField = picked.qf || buildQueryField(all.map((m) => m.text), CFG.queryLookback)
      let gateUserText = ''
      for (const pool of [claimed, history]) {
        for (let i = pool.length - 1; i >= 0; i--) {
          if (pool[i].role === 'user') {
            gateUserText = pool[i].text.trim()
            break
          }
        }
        if (gateUserText) break
      }
      let gateAssistantText = ''
      for (let i = all.length - 1; i >= 0; i--) {
        if (all[i].role !== 'assistant') continue
        const t = all[i].text.trim()
        if (t.length > 150) {
          gateAssistantText = t.slice(0, 1200)
          break
        }
      }
      row.recon = {
        variant: picked.variant,
        historyN: history.length,
        claimedN: claimed.length,
        claimedKinds: claimed.map((c) => c.kind),
        qfChars: queryField.length,
        qfHead: queryField.slice(0, 70).replace(/\n/g, '⏎'),
        gateUserChars: gateUserText.length,
        gateAssistantChars: gateAssistantText.length,
        qfCacheHit: queryField ? picked.qfCacheHit : null,
        guCacheHit: !gateUserText || gateUserText === queryField.trim() ? null : prodCacheKeys.has(gateUserText),
        gaCacheHit: !gateAssistantText || gateAssistantText === queryField.trim() ? null : prodCacheKeys.has(gateAssistantText),
      }
      if (!queryField) {
        row.error = 'empty-reconstruction'
        results.push(row)
        continue
      }
      try {
        const { outcome, trace } = await replayOne(engine, store, queryField, gateUserText, gateAssistantText, `replay-${ev.tsLabel}`, true)
        row.replay = {
          fallback: outcome.fallbackReason,
          candidateCount: outcome.candidateCount,
          selectedIds: outcome.selected.map((c) => `D${c.id}`),
          droppedCount: outcome.dropped.length,
          omega: outcome.omega,
          regime: outcome.regime,
          gate: { maxKnn: round4(outcome.gate.maxKnn), gateVector: outcome.gate.gateVector, retrievalMaxKnn: round4(outcome.gate.retrievalMaxKnn) },
          selectedRoles: outcome.selected.map((c) => c.role),
        }
        row.match = {
          ids: JSON.stringify(row.replay.selectedIds) === JSON.stringify(ev.ids),
          idsSet: JSON.stringify([...row.replay.selectedIds].sort()) === JSON.stringify([...ev.ids].sort()),
          omega: Math.abs((outcome.omega ?? 0) - ev.omega) < 0.05,
          candidates: outcome.candidateCount === ev.candidates,
          gateVector: outcome.gate.gateVector === ev.logGate.gateVector,
          gateMaxKnn: Math.abs(outcome.gate.maxKnn - ev.logGate.maxKnn) < 0.05,
          retrMaxKnn: Math.abs(outcome.gate.retrievalMaxKnn - ev.logGate.retrievalMaxKnn) < 0.05,
        }
        row.trace = trace
      } catch (e) {
        row.error = String(e.message ?? e)
      }
      results.push(row)
    } else {
      const row = { kind: 'recall', ts: ev.tsLabel, session: ev.session, query: ev.query.slice(0, 100), k: ev.k }
      try {
        const { outcome, trace } = await replayOne(engine, store, ev.query, '', '', `replay-recall-${ev.tsLabel}`, false)
        row.replay = {
          candidateCount: outcome.candidateCount,
          top12Roles: outcome.candidates.slice(0, 12).map((c) => c.role),
          top3Ids: outcome.candidates.slice(0, 3).map((c) => `D${c.id}`),
          omega: outcome.omega,
        }
        row.trace = trace
      } catch (e) {
        row.error = String(e.message ?? e)
      }
      recallResults.push(row)
    }
  }
  /* 确定性探针：锚晋升分歧（replay 5/36 vs 生产 0）是否源于 native 非确定性
   * （生产二进制 09-14 15:39 早于 15:56 确定性修复）。对 14:15:07 事件：
   * 同 artifact 再跑一遍 + 新库新 artifact 再跑一遍，记录晋升/omega/ids 漂移。 */
  if (!globalThis.__probeDone && state.events.some((e) => e.tsLabel === '2026-09-15T14:15:07')) {
    globalThis.__probeDone = true
    const ev = state.events.find((e) => e.tsLabel === '2026-09-15T14:15:07')
    const sess = sessions.get(ev.session)
    if (sess) {
      const picked = pickVariant(sess, ev, prodCacheKeys)
      const qf = picked.qf || buildQueryField([...picked.history, ...picked.claimed].map((m) => m.text), CFG.queryLookback)
      const probeRuns = []
      for (let i = 0; i < 2; i++) {
        const { outcome, trace } = await replayOne(engine, store, qf, '', '', `probe-same-${i}`, true)
        probeRuns.push({ run: `same-artifact-${i}`, ids: outcome.selected.map((c) => `D${c.id}`).join(','), omega: round3(outcome.omega), promoted: trace?.promotion.promoted ?? null, strongest: trace?.promotion.strongest ?? null, second: trace?.promotion.second ?? null })
      }
      /* 新库 + 新 artifact */
      const dbPath2 = join(work, `probe-fresh.sqlite`)
      cpSync(rebuiltDb, dbPath2)
      const visibleSet2 = new Set(state.visible)
      const fut = [...new Set(timeline.filter((r) => !visibleSet2.has(r.chunkId)).map((r) => r.fileId))]
      const sqls2 = DERIVED_TABLES.map((tb) => `DELETE FROM ${tb};`).concat(["DELETE FROM kv_store WHERE key='epa_basis_cache';"])
      if (fut.length) {
        const ids2 = fut.join(',')
        sqls2.push(`DELETE FROM chunks WHERE file_id IN (${ids2});`, `DELETE FROM file_tags WHERE file_id IN (${ids2});`, `DELETE FROM files WHERE id IN (${ids2});`, 'DELETE FROM tags WHERE id NOT IN (SELECT tag_id FROM file_tags);')
      }
      execSync(`sqlite3 ${JSON.stringify(dbPath2)} ${JSON.stringify(sqls2.join(' '))}`)
      const store2 = new KnowledgeStore(dbPath2)
      const engine2 = new MemoEngine({ vcpRoot: VCP_ROOT, dimension: EMBED_CFG.dimension, modelSig: `${EMBED_CFG.model}@relayrouter`, diaryName: CFG.bucket, store: store2 })
      const { outcome, trace } = await replayOne(engine2, store2, qf, '', '', 'probe-fresh', true)
      probeRuns.push({ run: 'fresh-artifact', ids: outcome.selected.map((c) => `D${c.id}`).join(','), omega: round3(outcome.omega), promoted: trace?.promotion.promoted ?? null, strongest: trace?.promotion.strongest ?? null, second: trace?.promotion.second ?? null })
      engine2.dispose()
      store2.close()
      globalThis.__probe = probeRuns
    }
  }
  try {
    engine.dispose()
    store.close()
  } catch {}
  if (!quiet) console.error(`[4/6] 态 ${stateIdx}/${states.size}（inject ${results.length} / recall ${recallResults.length}）`)
}

/* ════════ ⑥ 汇总 ════════ */
const agg = { n: 0, cacheHitQf: 0, guTot: 0, guHit: 0, gaTot: 0, gaHit: 0, match: { ids: 0, idsSet: 0, omega: 0, candidates: 0, gateVector: 0, gateMaxKnn: 0, retrMaxKnn: 0 }, variants: {} }
const roleCount = { selected: {}, allCands: {} }
const modeCount = {}
const gapRows = []
for (const r of results) {
  agg.n++
  if (r.recon?.qfCacheHit) agg.cacheHitQf++
  const v = r.recon?.variant ?? '?'
  agg.variants[v] = (agg.variants[v] ?? 0) + 1
  if (r.recon?.guCacheHit != null) {
    agg.guTot++
    if (r.recon.guCacheHit) agg.guHit++
  }
  if (r.recon?.gaCacheHit != null) {
    agg.gaTot++
    if (r.recon.gaCacheHit) agg.gaHit++
  }
  if (r.match) for (const key of Object.keys(agg.match)) if (r.match[key]) agg.match[key]++
  for (const role of r.replay?.selectedRoles ?? []) roleCount.selected[role] = (roleCount.selected[role] ?? 0) + 1
  for (const c of r.trace?.cands ?? []) roleCount.allCands[c.role] = (roleCount.allCands[c.role] ?? 0) + 1
  if (r.trace?.queryMode) modeCount[r.trace.queryMode] = (modeCount[r.trace.queryMode] ?? 0) + 1
  if (r.trace) {
    const top = r.trace.cands[0]
    gapRows.push({
      ts: r.ts,
      mode: r.trace.queryMode,
      promoted: r.trace.promotion.promoted,
      strongest: r.trace.promotion.strongest,
      second: r.trace.promotion.second,
      secondRatio: round3(r.trace.promotion.strongest / Math.max(1e-9, r.trace.promotion.second)),
      bestClosure: round4(Math.max(...r.trace.cands.map((c) => c.closure ?? 0))),
      bestDirect: round4(Math.max(...r.trace.cands.map((c) => Math.max(c.semanticBoundary ?? 0, c.direct ?? 0)))),
      bestKnn: round4(Math.max(...r.trace.cands.map((c) => c.knn ?? 0))),
      top1Knn: top?.knn ?? null,
    })
  }
}
const recallAgg = { n: recallResults.length, modeCount: {}, directEvents: 0, roleTop12: {} }
for (const r of recallResults) {
  if (r.trace?.queryMode) recallAgg.modeCount[r.trace.queryMode] = (recallAgg.modeCount[r.trace.queryMode] ?? 0) + 1
  if ((r.replay?.top12Roles ?? []).includes('direct_answer')) recallAgg.directEvents++
  for (const role of r.replay?.top12Roles ?? []) recallAgg.roleTop12[role] = (recallAgg.roleTop12[role] ?? 0) + 1
}

const summary = {
  injectLines: injects.length,
  writeEvents: writes.length,
  recallLines: recallEvents.length,
  corpusStates: states.size,
  agg,
  roleCount,
  modeCount,
  recallAgg,
  gapRows,
  determinismProbe: globalThis.__probe ?? null,
}
if (!quiet) {
  console.log(`夜语料重建 D-id 断言与正文来源：见 ${join(work, 'rebuild-log.json')}`)
  console.log(`被动注入复放 ${agg.injectLines ?? agg.n} 事件；查询场 cache 命中 ${agg.cacheHitQf}/${agg.n}`)
  console.log(`对齐（inject）：${JSON.stringify(agg.match)}`)
  console.log(`被动 role：selected=${JSON.stringify(roleCount.selected)} 全候选=${JSON.stringify(roleCount.allCands)}`)
  console.log(`被动 queryMode：${JSON.stringify(modeCount)}；锚晋升 ${gapRows.filter((g) => g.promoted).length}/${gapRows.length}`)
  console.log(`主动 memo_recall：${recallAgg.n} 查询；mode=${JSON.stringify(recallAgg.modeCount)}；direct 事件 ${recallAgg.directEvents}/${recallAgg.n}；roles=${JSON.stringify(recallAgg.roleTop12)}`)
}
if (jsonOut) {
  const rebuildLog = existsSync(join(work, 'rebuild-log.json')) ? JSON.parse(readFileSync(join(work, 'rebuild-log.json'), 'utf8')) : []
  writeFileSync(jsonOut, JSON.stringify({ summary, results, recallResults, rebuildLog }, null, 1))
}

/* 自净（--keep 可留现场排查） */
if (!args.includes('--keep')) {
  try {
    embed.close?.()
  } catch {}
  rmSync(work, { recursive: true, force: true })
  if (!quiet) console.error('[6/6] /tmp 工作目录已清理（--keep 保留）')
}
