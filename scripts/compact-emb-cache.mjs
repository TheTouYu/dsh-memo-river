#!/usr/bin/env node
/**
 * scripts/compact-emb-cache.mjs — emb-cache 清淤 + 二进制落盘（2026-10-14「内存鲸鱼」修复第一件）。
 *
 * 干什么：遍历 `~/.dsh/memo-river/<workspace-hash>/`，把每个桶的嵌入缓存**逐出孤儿键**并落成
 * 二进制 `.bin`（`src/emb-cache.ts` 的记录格式）。孤儿判据 = **不命中桶库活集的键**：
 *   keep = `chunks.content`（切块向量——KNN 召回用的就是它）∪ `tags.name`（Tag 向量）
 * 其余（一次性 queryField / 门控锚 / 整篇日记文本 …）全删：它们几乎不会被二次命中，
 * 却按 ~68KB/条 的 JSON 文本常驻、每次 flush 全量重写。genshin 桶实测 1764 条里 1533 条是孤儿。
 *
 * 为什么要单独跑：`EmbedClient` 只在桶被真正用到时才懒迁移，而大桶必须在**下一次 dsh-web
 * 启动之前**变瘦，否则 116MB 整读 + 573MB 峰值照样发生一次。
 *
 * 安全：
 *   · 原 `.bin`/`.json` 一律改名 `<file>.precompact-<ts>` 留证（不删、不原地覆盖）；
 *   · 库读不动 / 活集为空 → **跳过该桶**（防「DB 打不开 → 把缓存清空」这类事故）；
 *   · 桶库先整拷到临时目录再只读打开（活桶缺 `-shm` 时原地开会 `unable to open database file`）；
 *   · 幂等——重复跑只是把已经干净的缓存再写一遍同内容。
 *
 * 用法：node scripts/compact-emb-cache.mjs [--dry-run] [--root DIR] [--buckets a,b] [--min-bytes N] [--tmp DIR]
 * 前置：`node ../billion-context-dsh/node_modules/typescript/lib/tsc.js -p .`（脚本读 lib/emb-cache.js）。
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const { embCacheBinPath, loadEmbCacheEntries, HEADER_BYTES } = await import(join(HERE, '..', 'lib', 'emb-cache.js'))

/* ── 参数 ── */
const argv = process.argv.slice(2)
const flag = (name, def = null) => {
  const i = argv.indexOf(`--${name}`)
  if (i < 0) return def
  const v = argv[i + 1]
  return v && !v.startsWith('--') ? v : true
}
const DRY = argv.includes('--dry-run') || argv.includes('-n')
const ROOT = String(flag('root', join(homedir(), '.dsh', 'memo-river')))
const ONLY = flag('buckets', null)
const MIN_BYTES = Number(flag('min-bytes', 0)) || 0
const TMP = String(flag('tmp', tmpdir()))
const TS = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const mb = (n) => `${(n / 1048576).toFixed(2)}MB`

/** 桶库活集：`chunks.content` ∪ `tags.name` ∪ `kv_store.value`。库先拷到 tmp 再只读开。 */
function liveKeys(bucketDir) {
  const dbPath = join(bucketDir, 'knowledge_base.sqlite')
  if (!existsSync(dbPath)) return { keys: null, reason: 'no-db' }
  const work = join(TMP, `memo-compact-${process.pid}-${basename(bucketDir)}`)
  rmSync(work, { recursive: true, force: true })
  mkdirSync(work, { recursive: true })
  const copy = join(work, 'kb.sqlite')
  try {
    copyFileSync(dbPath, copy)
    for (const suffix of ['-wal', '-shm']) {
      if (existsSync(`${dbPath}${suffix}`)) copyFileSync(`${dbPath}${suffix}`, `${copy}${suffix}`)
    }
    const db = new DatabaseSync(copy, { readOnly: true })
    const keys = new Set()
    try {
      for (const row of db.prepare('SELECT content FROM chunks').iterate()) keys.add(row.content)
      for (const row of db.prepare('SELECT name FROM tags').iterate()) keys.add(row.name)
      for (const row of db.prepare('SELECT value FROM kv_store').iterate()) {
        if (typeof row.value === 'string') keys.add(row.value)
      }
    } finally {
      db.close()
    }
    return { keys, reason: null }
  } catch (e) {
    return { keys: null, reason: `db-${String(e?.message ?? e).slice(0, 70)}` }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

function listBuckets() {
  if (!existsSync(ROOT)) return []
  const only = ONLY ? String(ONLY).split(',').map((s) => s.trim()).filter(Boolean) : null
  const out = []
  for (const name of readdirSync(ROOT).sort()) {
    if (only && !only.includes(name)) continue
    const dir = join(ROOT, name)
    try {
      if (!statSync(dir).isDirectory()) continue
    } catch {
      continue
    }
    if (existsSync(join(dir, 'emb-cache.bin')) || existsSync(join(dir, 'emb-cache.json'))) out.push(dir)
  }
  return out
}

/** 旧 JSON 无头部：用第一个向量数组的长度当维度。 */
function probeJsonDim(jsonPath) {
  const buf = readFileSync(jsonPath)
  const i = buf.indexOf(0x5b)
  if (i < 0) return 0
  const j = buf.indexOf(0x5d, i)
  if (j < 0) return 0
  const arr = JSON.parse(buf.toString('utf8', i, j + 1))
  return Array.isArray(arr) ? arr.length : 0
}

function loadEntries(jsonPath, binPath) {
  if (existsSync(binPath)) {
    const head = readFileSync(binPath)
    if (head.length < HEADER_BYTES) return new Map()
    return loadEmbCacheEntries(jsonPath, head.readUInt32LE(8))
  }
  if (!existsSync(jsonPath)) return new Map()
  const dim = probeJsonDim(jsonPath)
  return dim > 0 ? loadEmbCacheEntries(jsonPath, dim) : new Map()
}

function encodeBin(dim, entries) {
  const head = Buffer.alloc(HEADER_BYTES)
  head.write('MREC', 0, 'ascii')
  head.writeUInt32LE(1, 4)
  head.writeUInt32LE(dim, 8)
  const parts = [head]
  for (const [k, v] of entries) {
    const kb = Buffer.from(k, 'utf8')
    const rec = Buffer.allocUnsafe(8 + kb.length + v.byteLength)
    rec.writeUInt32LE(kb.length, 0)
    rec.writeUInt32LE(v.length, 4)
    kb.copy(rec, 8)
    Buffer.from(v.buffer, v.byteOffset, v.byteLength).copy(rec, 8 + kb.length)
    parts.push(rec)
  }
  return Buffer.concat(parts)
}

/* ── 主流程 ── */
const buckets = listBuckets()
console.log(`emb-cache 清淤${DRY ? '（dry-run，不写盘）' : ''}：root=${ROOT}，${buckets.length} 个桶有缓存`)
let totBefore = 0
let totAfter = 0
let totDropped = 0
let done = 0
for (const dir of buckets) {
  const jsonPath = join(dir, 'emb-cache.json')
  const binPath = embCacheBinPath(jsonPath)
  const srcPath = existsSync(binPath) ? binPath : jsonPath
  const srcBytes = statSync(srcPath).size
  const label = basename(dir)
  if (srcBytes < MIN_BYTES) {
    console.log(`  · ${label} 跳过：${mb(srcBytes)} < --min-bytes`)
    continue
  }
  const { keys: live, reason } = liveKeys(dir)
  if (!live) {
    console.log(`  ⚠️ ${label} 跳过：活集不可读（${reason}）——不动它的缓存`)
    continue
  }
  let entries
  let dim
  try {
    entries = loadEntries(jsonPath, binPath)
    dim = entries.size > 0 ? entries.values().next().value.length : 0
  } catch (e) {
    console.log(`  ⚠️ ${label} 跳过：缓存不可解析（${String(e?.message ?? e).slice(0, 70)}）`)
    continue
  }
  if (entries.size === 0) {
    console.log(`  · ${label} 跳过：缓存空`)
    continue
  }
  if (live.size === 0) {
    console.log(`  ⚠️ ${label} 跳过：活集为空（DB 无 chunks/tags/kv）——不动它的缓存`)
    continue
  }
  const kept = new Map()
  let dropped = 0
  let droppedBytes = 0
  for (const [k, v] of entries) {
    if (live.has(k)) kept.set(k, v)
    else {
      dropped++
      droppedBytes += v.byteLength
    }
  }
  const body = encodeBin(dim, kept)
  console.log(
    `  ${label}: ${entries.size} 条/${mb(srcBytes)} → 保留 ${kept.size} 条/${mb(body.length)}` +
      `（活集 ${live.size}，逐出孤儿 ${dropped} 条 ≈ ${mb(droppedBytes)} 向量）`,
  )
  totBefore += srcBytes
  totAfter += body.length
  totDropped += dropped
  done++
  if (DRY) continue
  const tmp = `${binPath}.tmp-compact-${process.pid}`
  writeFileSync(tmp, body)
  renameSync(tmp, binPath)
  if (existsSync(jsonPath)) renameSync(jsonPath, `${jsonPath}.precompact-${TS}`)
}
console.log(
  `合计：${done} 个桶 ${mb(totBefore)} → ${mb(totAfter)}，逐出孤儿 ${totDropped} 条。` +
    (DRY ? '' : '旧文件一律留 `.precompact-<ts>`（不删）。'),
)
if (!DRY && done > 0) console.log('提示：运行中的 dsh-web 仍持有旧内存，需重启才加载新缓存。')
