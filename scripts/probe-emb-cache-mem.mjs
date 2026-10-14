/**
 * probe-write-mem.mjs — 鲸鱼修复的**内存验收台**（2026-10-14）。
 *
 * 判据（用户口径）：对 genshin 桶（184 活 chunk / 缓存 116MB）**真发一次 memo_write**，
 * 0.5s 采样 RSS 峰值增量 < 50MB、无秒级事件循环停顿。
 *
 * 做法：完全隔离——`DSH_HOME` 指向 .scratch 下的临时河流根，工作区 cwd 也是临时的，
 * 桶里塞的是 genshin 真库的**副本** + 真缓存（116MB JSON → 迁移 / 或已清淤的 .bin）。
 * 嵌入端点用本地 stub（3072 维确定性向量），不碰生产额度、不碰生产桶。
 * 驱动的是真 `writeDiaryCore`（tools.ts:435，memo_write/approve/update/merge 共同入口）。
 *
 * 用法（A/B 对照是这台探针的核心价值——同一台探针必须能把「修复前」判红）：
 *   # 新实现（生产形态：已清淤的 .bin）
 *   node scripts/probe-emb-cache-mem.mjs
 *   # 负对照：把修复前的 lib 编到别处，再用同一台探针跑同一份 116MB 缓存
 *   git worktree add /tmp/oldtree HEAD && (cd /tmp/oldtree && node .../tsc.js -p .)
 *   PROBE_LIB=/tmp/oldtree/lib MEMO_PROBE_BUCKET=<桶目录> node scripts/probe-emb-cache-mem.mjs
 * 环境变量：MEMO_PROBE_BUCKET（被测桶，缺省 genshin 4bde2299850f027e）、PROBE_LIB（被测 lib）、
 *          MEMO_PROBE_WORK（临时工作根，缺省 $TMPDIR/memo-emb-probe）。
 */
import { createServer } from 'node:http'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { monitorEventLoopDelay } from 'node:perf_hooks'

const SCRATCH = process.env.MEMO_PROBE_WORK || join(tmpdir(), 'memo-emb-probe')
const DSH_HOME = join(SCRATCH, 'dsh-home')
const GENSHIN = process.env.MEMO_PROBE_BUCKET || '/home/h/.dsh/memo-river/4bde2299850f027e'
const GENSHIN_DB = join(GENSHIN, 'knowledge_base.sqlite')
const GENSHIN_JSON = (() => {
  // 清淤后原 emb-cache.json 会改名 .precompact-<ts>：两种都认
  const direct = join(GENSHIN, 'emb-cache.json')
  if (existsSync(direct)) return direct
  const bak = readdirSync(GENSHIN).filter((f) => f.startsWith('emb-cache.json')).sort().pop()
  return bak ? join(GENSHIN, bak) : direct
})()
const GENSHIN_BIN = join(GENSHIN, 'emb-cache.bin')
const DIM = 3072
const LIB = process.env.PROBE_LIB || '/home/h/dsh-plugins/dsh-memo-river/lib'

/* 隔离河流根：必须在 import lib/runtime.js 之前设好 */
process.env.DSH_HOME = DSH_HOME
process.env.TAG_EMBED_PROXY = '' // 关代理（resolveProxyUrl: 空串 → undefined），直连本地 stub
process.env.MEMO_EMB_CACHE_MAX_MB = process.env.MEMO_EMB_CACHE_MAX_MB ?? '48'

const rssMb = () => Number(/VmRSS:\s+(\d+)/.exec(readFileSync('/proc/self/status', 'utf8'))[1]) / 1024
const hwmMb = () => Number(/VmHWM:\s+(\d+)/.exec(readFileSync('/proc/self/status', 'utf8'))[1]) / 1024
/** 把内核峰值 RSS 计数器重置到当前值（Linux 4.0+：clear_refs 写 5）——这样 VmHWM 增量
 *  就是该阶段的**真峰值**，不受采样频率影响（0.5s 采样会漏掉亚秒级尖峰）。 */
const resetHwm = () => {
  try {
    writeFileSync('/proc/self/clear_refs', '5')
  } catch {
    /* 内核不支持就退回采样口径 */
  }
}

/* ── 本地嵌入 stub：/v1/embeddings ── */
let embedCalls = 0
let embedTexts = 0
const server = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    let input = []
    try {
      input = JSON.parse(body).input ?? []
    } catch {
      /* ignore */
    }
    embedCalls++
    embedTexts += input.length
    const data = input.map((text, index) => {
      // 确定性伪随机向量（文本哈希播种，L2 归一化不做——KNN 会自己算余弦）
      let h = 2166136261
      for (let i = 0; i < text.length; i++) h = (h ^ text.charCodeAt(i)) * 16777619 >>> 0
      const vec = new Array(DIM)
      for (let i = 0; i < DIM; i++) {
        h = (h * 1103515245 + 12345) >>> 0
        vec[i] = (h / 4294967296) * 2 - 1
      }
      return { index, embedding: vec }
    })
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ data }))
  })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const PORT = server.address().port
console.log(`stub 嵌入端点 http://127.0.0.1:${PORT}/v1/embeddings`)

/* ── 准备桶副本 ── */
function setupBucket(name, cacheFrom) {
  const wsDir = join(SCRATCH, 'ws', name)
  rmSync(wsDir, { recursive: true, force: true })
  mkdirSync(wsDir, { recursive: true })
  return wsDir
}

const { Config } = await import(join(LIB, 'config.js'))
const { workspacePaths } = await import(join(LIB, 'runtime.js'))
const { acquireWorkspace } = await import(join(LIB, 'workspace.js'))
const { writeDiaryCore } = await import(join(LIB, 'tools.js'))
const { DatabaseSync } = await import('node:sqlite')

function configFor() {
  // schemastery 的 schema 是**可调用**的（不是 zod 的 .parse）
  return Config({
    bucket: 'whaleprobe',
    native: { vcpRoot: '/home/h/app/VCPToolBox' },
    embed: { apiUrl: `http://127.0.0.1:${PORT}`, apiKey: 'stub-key', model: 'stub-model', dimension: DIM },
  })
}

/** 把 genshin 真库拷成某个 cwd 的桶；可选把真缓存按形态放进桶。整桶先清空（幂等复跑）。 */
function seedBucket(cwd, cacheMode) {
  const paths = workspacePaths(cwd, 'whaleprobe')
  rmSync(paths.root, { recursive: true, force: true }) // 桶根也清（否则上一跑的 .bin/.md 残留）
  mkdirSync(paths.root, { recursive: true })
  cpSync(GENSHIN_DB, paths.dbPath)
  for (const s of ['-wal', '-shm']) if (existsSync(`${GENSHIN_DB}${s}`)) cpSync(`${GENSHIN_DB}${s}`, `${paths.dbPath}${s}`)
  if (cacheMode === 'legacy-json' && existsSync(GENSHIN_JSON)) cpSync(GENSHIN_JSON, paths.embCachePath)
  if (cacheMode === 'bin' && existsSync(GENSHIN_BIN)) {
    cpSync(GENSHIN_BIN, paths.embCachePath.replace(/\.json$/, '.bin'))
  } else if (cacheMode === 'bin' && !existsSync(GENSHIN_BIN) && existsSync(GENSHIN_JSON)) {
    cpSync(GENSHIN_JSON, paths.embCachePath)
  }
  return paths
}

/* ── 一次真 memo_write（copy 桶） ── */
async function runWrite(label, wsDir, cacheMode, date) {
  console.log(`\n──── ${label}（缓存形态=${cacheMode}）`)
  const paths = seedBucket(wsDir, cacheMode)
  const tags = (() => {
    const db = new DatabaseSync(paths.dbPath, { readOnly: true })
    const out = db.prepare('SELECT name FROM tags ORDER BY id LIMIT 4').all().map((r) => r.name)
    db.close()
    return out
  })()
  const base = rssMb()
  const t0 = Date.now()
  const ws = acquireWorkspace(wsDir, configFor())
  const loadMs = Date.now() - t0
  const afterLoad = rssMb()
  console.log(`  桶库=${paths.dbPath}`)
  console.log(`  冷载入 ${loadMs}ms：RSS ${base.toFixed(0)} → ${afterLoad.toFixed(0)}MB（+${(afterLoad - base).toFixed(0)}MB）`)
  if (ws.embed.cacheStats) {
    const s = ws.embed.cacheStats
    console.log(
      `  缓存：${s.entries} 条 / 值 ${(s.liveBytes / 1048576).toFixed(2)}MB / 文件 ${(s.fileBytes / 1048576).toFixed(2)}MB` +
        `${s.migratedFrom ? ` / 已迁移自 ${s.migratedFrom.replace(/^.*\//, '')}` : ''}${s.evicted ? ` / 逐出 ${s.evicted}` : ''}`,
    )
  }

  // 0.5s（生产口径）+ 50ms（细节）双采样 + 内核峰值 RSS（真尖峰，不漏亚秒）
  const samples = []
  const peak = { rss: 0 }
  const timer = setInterval(() => {
    const r = rssMb()
    samples.push(r)
    if (r > peak.rss) peak.rss = r
  }, 50)
  timer.unref?.()
  const h = monitorEventLoopDelay({ resolution: 20 })
  h.enable()

  const before = rssMb()
  resetHwm()
  const hwmBefore = hwmMb()
  const t1 = Date.now()
  const content =
    `# 鲸鱼修复内存验收探针 ${date}\n\n` +
    `本行是 writeDiaryCore 的真写入路径探针（桶副本），用于量取 memo_write 周期的 RSS 峰值与事件循环停顿。\n` +
    Array.from({ length: 24 }, (_, i) => `- 探针填充行 ${i}：${'鲸'.repeat(40)}（仅用于让切块器切出多块向量）`).join('\n')
  const result = await writeDiaryCore(ws, {
    content,
    tags,
    title: `鲸鱼修复内存验收探针 ${date}`,
    date,
    bucket: 'whaleprobe',
    newTagReason: '',
    dedupCosine: 0.88,
    preamble: '',
    toolName: 'memo_write',
  })
  const writeMs = Date.now() - t1
  const hwmAfter = hwmMb()
  await ws.embed.flushCache?.()
  await new Promise((r) => setTimeout(r, 300))
  clearInterval(timer)
  h.disable()
  const after = rssMb()
  const peakDelta = hwmAfter - hwmBefore // 内核口径真峰值增量
  const sampleDelta = peak.rss - before
  console.log(`  写入 ${result.status} ${writeMs}ms → RSS ${before.toFixed(0)} → ${after.toFixed(0)}MB`)
  console.log(`  真峰值（VmHWM 重置口径）：+${peakDelta.toFixed(0)}MB；采样 ${samples.length} 点峰值增量 +${sampleDelta.toFixed(0)}MB`)
  console.log(
    `  事件循环延迟 p50=${(h.percentile(50) / 1e6).toFixed(1)}ms p99=${(h.percentile(99) / 1e6).toFixed(1)}ms max=${(h.max / 1e6).toFixed(1)}ms`,
  )
  console.log(`  嵌入调用 ${embedCalls} 批 / ${embedTexts} 条`)
  console.log(`  ${peakDelta < 50 ? '✅' : '❌'} 写入峰值增量 ${peakDelta.toFixed(0)}MB ${peakDelta < 50 ? '<' : '≥'} 50MB`)
  console.log(`  ${h.max / 1e6 < 1000 ? '✅' : '❌'} 事件循环最长停顿 ${(h.max / 1e6).toFixed(0)}ms < 1000ms`)
  return { peakDelta, maxLag: h.max / 1e6, loadMs, afterLoad: afterLoad - base, status: result.status }
}

const out = {}
out.pruned = await runWrite('A 生产形态：已清淤 + 二进制缓存', setupBucket('pruned'), 'bin', '2026-10-14')
out.legacy = await runWrite('B 迁移路径：首次读到 116MB 旧 JSON', setupBucket('legacy'), 'legacy-json', '2026-10-13')

console.log('\n================ 汇总 ================')
for (const [k, v] of Object.entries(out)) {
  console.log(
    `${k}: 状态=${v.status} 冷载入=${v.loadMs}ms(+${v.afterLoad.toFixed(0)}MB) 写入峰值=+${v.peakDelta.toFixed(0)}MB 最长停顿=${v.maxLag.toFixed(0)}ms`,
  )
}
console.log(`本进程 VmHWM=${hwmMb().toFixed(0)}MB`)
server.close()
process.exit(0)
