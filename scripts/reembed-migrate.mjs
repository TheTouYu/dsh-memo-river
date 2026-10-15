#!/usr/bin/env node
/**
 * reembed-migrate.mjs —— 换嵌入模型时的**全库向量重嵌执行器**。
 *
 * 背景：换嵌入模型 = 换向量空间，库里每一行旧向量都作废。本脚本**只改向量，不动正文**：
 * 逐 chunk 重嵌 `chunks.content`、逐 tag 重嵌 `tags.name`，写回同一行。
 * schema 自带触发器 `trg_v10_chunks_vector_stale` / `trg_v10_tags_vector_stale` 会把
 * `v10_derived_asset_status` 标 stale，守护循环比对 artifactSig 后自动重建内核索引
 * ——所以**不需要**手动触发重建，也不该手动删索引文件。
 *
 * 用法：
 *   node scripts/reembed-migrate.mjs                       # dry-run：只统计 + 探一次端点维度
 *   node scripts/reembed-migrate.mjs --apply               # 全库重嵌（每桶一事务 + 先备份）
 *   node scripts/reembed-migrate.mjs --only <桶目录名> --apply    # 单桶试点
 *   node scripts/reembed-migrate.mjs --root /var/tmp/pilot --apply # 在副本上试点（零生产风险）
 *
 * 安全设计：
 *   · dry-run 是默认值；`--apply` 才写。
 *   · 每个桶写前把 sqlite(+wal/shm) 复制到 `<桶>/.reembed-backup-<ts>/`；失败即中止该桶。
 *   · 先全部嵌入、校验维度、再开事务写入——事务窗口只有 UPDATE 的时间，不阻塞别人读。
 *   · 嵌入缓存走独立文件（/var/tmp/memo-reembed），不与活进程的 emb-cache.bin 抢写。
 *     缓存记录自带 vecLen，混维度结构安全；旧维度条目按 `hit.length === dimension` 自动 miss。
 */
import { existsSync, readdirSync, statSync, mkdirSync, copyFileSync, readFileSync } from 'node:fs'
import { join, basename } from 'node:path'
import { homedir } from 'node:os'
import { KnowledgeStore, vectorToBlob } from '../lib/store.js'
import { EmbedClient } from '../lib/embed.js'
import { Config } from '../lib/config.js'
import { resolveEmbed } from '../lib/workspace.js'

const argv = process.argv.slice(2)
const argOf = (name, dflt) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt
}
const APPLY = argv.includes('--apply')
const ONLY = argOf('--only', null)
const RETRIES = Number(argOf('--retries', '2'))      // 上游 429 engine overloaded 是瞬时的，值得重试
const BACKOFF_MS = Number(argOf('--backoff-ms', '20000'))
const ROOT = argOf('--root', join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'memo-river'))
const CACHE_DIR = '/var/tmp/memo-reembed'
const STAMP = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)

const config = Config({ native: { vcpRoot: '/home/h/app/VCPToolBox' } })
const resolved = resolveEmbed(config, {})
if (resolved.source === 'none') {
  console.error('❌ 嵌入未配置（config.embed.* 与 config.env 都没给全）')
  process.exit(1)
}
mkdirSync(CACHE_DIR, { recursive: true })
const embed = new EmbedClient({
  apiUrl: resolved.apiUrl,
  apiKey: resolved.apiKey,
  model: resolved.model,
  dimension: resolved.dimension,
  cachePath: join(CACHE_DIR, 'emb-cache.json'), // 独立缓存：不碰活进程的 emb-cache.bin
  timeoutMs: 60_000, // 主动路径口径（读路径的 8s 预算不适合全库迁移）
})

const log = (...a) => console.log(...a)
log(`模式    : ${APPLY ? '★ APPLY（写向量）' : 'dry-run（只读）'}`)
log(`状态根  : ${ROOT}`)
log(`嵌入    : ${resolved.apiUrl}  model=${resolved.model}  dim=${resolved.dimension}  source=${resolved.source}`)
log(`缓存    : ${CACHE_DIR}/emb-cache.bin（独立于生产）\n`)

const roots = readdirSync(ROOT)
  .filter((n) => !ONLY || n === ONLY)
  .map((n) => join(ROOT, n))
  .filter((d) => {
    try {
      return statSync(d).isDirectory() && existsSync(join(d, 'knowledge_base.sqlite'))
    } catch {
      return false
    }
  })

if (ONLY && roots.length === 0) {
  console.error(`❌ 未找到桶 ${ONLY}（或它没有 knowledge_base.sqlite）`)
  process.exit(1)
}

// dry-run 也要证明端点可用：探一条最短文本
if (!APPLY) {
  const t0 = Date.now()
  const [v] = await embed.embed(['探针：确认端点与维度'])
  log(`端点探针: dim=${v.length} 期望=${resolved.dimension} ${Date.now() - t0}ms → ${v.length === resolved.dimension ? '✅' : '❌ 维度不符，别急着 --apply'}\n`)
}

const totals = { chunks: 0, tags: 0, buckets: 0, failed: 0, ms: 0 }
for (const dir of roots) {
  const name = basename(dir)
  const dbPath = join(dir, 'knowledge_base.sqlite')
  let store
  try {
    store = new KnowledgeStore(dbPath)
  } catch (err) {
    log(`✗ ${name}: 打不开库 ${String(err.message).slice(0, 80)}`)
    totals.failed += 1
    continue
  }
  try {
    const chunks = store.chunks()
    const tags = store.tags()
    if (!chunks.length && !tags.length) {
      log(`- ${name}: 空桶，跳过`)
      store.close()
      continue
    }
    const rows = [...chunks.map((c) => ({ kind: 'chunk', id: c.id, text: c.content })), ...tags.map((t) => ({ kind: 'tag', id: t.id, text: t.name }))]
    if (!APPLY) {
      totals.chunks += chunks.length
      totals.tags += tags.length
      totals.buckets += 1
      log(`- ${name}: chunks=${chunks.length} tags=${tags.length} （dry-run，未嵌入）`)
      store.close()
      continue
    }
    const t0 = Date.now()
    let vectors
    for (let attempt = 0; ; attempt += 1) {
      try {
        vectors = await embed.embed(rows.map((r) => r.text))
        break
      } catch (err) {
        if (attempt >= RETRIES) throw err
        log(`  … ${name} 第 ${attempt + 1} 次失败（${String(err.message).slice(0, 70)}），${BACKOFF_MS / 1000}s 后重试`)
        await new Promise((r) => setTimeout(r, BACKOFF_MS))
      }
    }
    if (vectors.length !== rows.length) throw new Error(`嵌入条数不符 got ${vectors.length} want ${rows.length}`)
    const bad = vectors.findIndex((v) => !v || v.length !== resolved.dimension)
    if (bad >= 0) throw new Error(`第 ${bad} 条维度 ${vectors[bad]?.length} ≠ ${resolved.dimension}，中止该桶`)

    // 备份（只读复制，不动原文件）
    const backup = join(dir, `.reembed-backup-${STAMP}`)
    mkdirSync(backup, { recursive: true })
    for (const suffix of ['', '-wal', '-shm']) {
      const f = dbPath + suffix
      if (existsSync(f)) copyFileSync(f, join(backup, basename(f)))
    }

    store.exec('BEGIN')
    const updChunk = store.db.prepare('UPDATE chunks SET vector = ? WHERE id = ?')
    const updTag = store.db.prepare('UPDATE tags SET vector = ? WHERE id = ?')
    rows.forEach((r, i) => {
      const blob = vectorToBlob(vectors[i])
      if (r.kind === 'chunk') updChunk.run(blob, r.id)
      else updTag.run(blob, r.id)
    })
    store.exec('COMMIT')

    // 回读校验：向量维度必须是新维度，且非空
    const back = store.chunks().find((c) => c.vector && c.vector.length === resolved.dimension)
    const tagBack = store.tags().find((t) => t.vector && t.vector.length === resolved.dimension)
    if (!back || !tagBack) throw new Error('回读校验失败：未能读到新维度向量')
    const ms = Date.now() - t0
    totals.chunks += chunks.length
    totals.tags += tags.length
    totals.buckets += 1
    totals.ms += ms
    log(`✓ ${name}: chunks=${chunks.length} tags=${tags.length} 重嵌+写入 ${(ms / 1000).toFixed(1)}s  备份=${basename(backup)}`)
  } catch (err) {
    totals.failed += 1
    log(`✗ ${name}: ${String(err.message).slice(0, 140)}`)
  } finally {
    try {
      store.close()
    } catch {
      /* 已关 */
    }
  }
}

log(`\n合计：桶 ${totals.buckets} 完成 / ${totals.failed} 失败，chunk ${totals.chunks}，tag ${totals.tags}，耗时 ${(totals.ms / 1000).toFixed(0)}s`)
log(`缓存条数 ${embed.cacheSize}（独立缓存，不影响生产 emb-cache.bin）`)
if (APPLY) {
  log(`\n下一步：重启 dsh-web 让新嵌入配置（bundle/进程 env）生效，再跑 ` +
    `\`node scripts/acceptance-queryfield.mjs\`（6/6）与抽查一次被动召回。`)
  log(`注意：各桶 emb-cache.bin 里会同时存在旧维度与新维度条目——记录自带 vecLen，结构安全，` +
    `旧条目按维度自动 miss，随 LRU 逐出，无需手工清理。`)
}

process.exit(totals.failed > 0 ? 1 : 0)  // 退出码必须反映失败，否则外层脚本会把半迁移当成功
