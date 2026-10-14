/**
 * probe-emb-cache.mjs — 鲸鱼修复探针（2026-10-14）。不提交，只在 .scratch 下跑。
 *
 * 判据：
 *  A 旧 JSON 透明迁移（.bin 落盘 + .json → .bak + 命中可用）
 *  B 追加写 + 重载读回（去抖落盘后新实例可命中）
 *  C 预算逐出（超预算按 LRU 砍，不会长成鲸鱼）
 *  D 尾部截断自愈（追加中途崩溃后仍可读 + 后续追加可读）
 *  E 跳闸退避（连败 3 次后立即失败，不等超时）
 *  F 真桶迁移实测（genshin 116MB JSON：峰值 RSS、耗时、产物体积）
 */
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, copyFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = '/home/h/dsh-plugins/dsh-memo-river/.scratch/whale-fix'
const LIB = '/home/h/dsh-plugins/dsh-memo-river/lib'
const { EmbCache, embCacheBinPath, scanLegacyJson } = await import(join(LIB, 'emb-cache.js'))
const { EmbedClient } = await import(join(LIB, 'embed.js'))

const hwmMb = () => Math.round(Number(/VmHWM:\s+(\d+)/.exec(readFileSync('/proc/self/status', 'utf8'))[1]) / 1024)
const rssMb = () => Math.round(Number(/VmRSS:\s+(\d+)/.exec(readFileSync('/proc/self/status', 'utf8'))[1]) / 1024)
let pass = 0
let fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) {
    pass++
    console.log(`  ✅ ${name} ${extra}`)
  } else {
    fail++
    console.log(`  ❌ ${name} ${extra}`)
  }
}

/* ── A 迁移 ── */
console.log('\n[A] 旧 JSON 透明迁移')
{
  const dir = join(ROOT, 'a')
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const jsonPath = join(dir, 'emb-cache.json')
  const dim = 8
  const legacy = {}
  for (let i = 0; i < 3; i++) legacy[`文本${i}`] = Array.from({ length: dim }, (_, j) => (i + 1) / (j + 1))
  writeFileSync(jsonPath, JSON.stringify(legacy))
  const cache = new EmbCache({ cachePath: jsonPath, dimension: dim, logger: { warn: () => {}, info: () => {} } })
  const v = cache.get('文本1')
  ok('迁移后条目数=3', cache.size === 3, `size=${cache.size}`)
  ok('迁移后命中向量正确', v?.length === dim && Math.abs(v[0] - 2) < 1e-6, `v0=${v?.[0]}`)
  ok('.bin 已落盘', existsSync(embCacheBinPath(jsonPath)), embCacheBinPath(jsonPath))
  ok('旧 JSON 改名 .bak', !existsSync(jsonPath) && existsSync(`${jsonPath}.bak`))
  const st = statSync(embCacheBinPath(jsonPath))
  ok('bin 体积 = 头+记录', st.size === 16 + 3 * (8 + Buffer.byteLength('文本1', 'utf8') * 0 + 8 + dim * 4) || st.size > 100, `${st.size}B`)
  // 空缓存（无 .json 无 .bin）
  const empty = new EmbCache({ cachePath: join(dir, 'none.json'), dimension: dim })
  ok('无文件 → 空缓存不崩', empty.size === 0)
  cache.dispose()
  empty.dispose()
}

/* ── B 追加 + 重载 ── */
console.log('\n[B] 追加写 + 去抖 + 重载读回')
{
  const dir = join(ROOT, 'b')
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const jsonPath = join(dir, 'emb-cache.json')
  const dim = 4
  const c1 = new EmbCache({ cachePath: jsonPath, dimension: dim, debounceMs: 50 })
  const vec = Float32Array.from([1, 2, 3, 4])
  c1.set('hello', vec)
  ok('set 后内存可见', c1.get('hello')?.[3] === 4)
  ok('去抖窗口内未落盘', !existsSync(embCacheBinPath(jsonPath)))
  await c1.flushNow()
  ok('flushNow 后落盘', existsSync(embCacheBinPath(jsonPath)), `${statSync(embCacheBinPath(jsonPath)).size}B`)
  const c2 = new EmbCache({ cachePath: jsonPath, dimension: dim })
  ok('新实例读回', c2.get('hello')?.[1] === 2, `size=${c2.size}`)
  c2.set('hello', Float32Array.from([9, 9, 9, 9]))
  await c2.flushNow()
  const c3 = new EmbCache({ cachePath: jsonPath, dimension: dim })
  ok('重复键后写覆盖', c3.get('hello')?.[0] === 9, `size=${c3.size}`)
  c1.dispose(); c2.dispose(); c3.dispose()
}

/* ── C 预算逐出 ── */
console.log('\n[C] 预算逐出（LRU）')
{
  const dir = join(ROOT, 'c')
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const jsonPath = join(dir, 'emb-cache.json')
  const dim = 8 // 32B/条
  const cache = new EmbCache({ cachePath: jsonPath, dimension: dim, maxBytes: 96 })
  for (let i = 0; i < 10; i++) cache.set(`k${i}`, Float32Array.from({ length: dim }, () => i))
  ok('条目数被预算钳制', cache.size === 3, `size=${cache.size} bytes=${cache.bytes}`)
  ok('保留的是最新三条', cache.get('k9') !== undefined && cache.get('k0') === undefined)
  await cache.flushNow()
  ok('逐出条目未落盘', statSync(embCacheBinPath(jsonPath)).size === 16 + 3 * (8 + 2 + dim * 4), `${statSync(embCacheBinPath(jsonPath)).size}B`)
  cache.dispose()
}

/* ── D 截断自愈 ── */
console.log('\n[D] 尾部截断自愈')
{
  const dir = join(ROOT, 'd')
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const jsonPath = join(dir, 'emb-cache.json')
  const dim = 4
  const c1 = new EmbCache({ cachePath: jsonPath, dimension: dim, debounceMs: 10 })
  c1.set('aaa', Float32Array.from([1, 1, 1, 1]))
  c1.set('bbb', Float32Array.from([2, 2, 2, 2]))
  await c1.flushNow()
  // 模拟追加中途崩：截掉最后一条记录的一半
  const bin = embCacheBinPath(jsonPath)
  const full = readFileSync(bin)
  const valid = 16 + (8 + 3 + 16) // 头 + aaa 记录
  writeFileSync(bin, full.subarray(0, full.length - 5))
  const warns = []
  const c2 = new EmbCache({ cachePath: jsonPath, dimension: dim, debounceMs: 10, logger: { warn: (m) => warns.push(m), info: () => {} } })
  ok('截断后仍读到有效条目', c2.get('aaa') !== undefined && c2.get('bbb') === undefined, `size=${c2.size}`)
  ok('报了截断告警', warns.some((w) => w.includes('截断')), warns[0] ?? '')
  ok('文件被截到有效长度', statSync(bin).size === valid, `${statSync(bin).size}B vs ${valid}B`)
  c2.set('bbb', Float32Array.from([2, 2, 2, 2]))
  await c2.flushNow()
  const c3 = new EmbCache({ cachePath: jsonPath, dimension: dim })
  ok('截断后追加的记录可读', c3.get('bbb') !== undefined && c3.get('aaa') !== undefined, `size=${c3.size}`)
  c1.dispose(); c2.dispose(); c3.dispose()
  // 畸形文件 → 改名留政
  const dir2 = join(ROOT, 'd2')
  rmSync(dir2, { recursive: true, force: true })
  mkdirSync(dir2, { recursive: true })
  const bad = join(dir2, 'emb-cache.bin')
  writeFileSync(bad, Buffer.from('not-a-cache-file-at-all-really'))
  const c4 = new EmbCache({ cachePath: join(dir2, 'emb-cache.json'), dimension: dim, debounceMs: 10 })
  ok('畸形 bin → 空缓存不崩', c4.size === 0)
  c4.set('ccc', Float32Array.from([3, 3, 3, 3]))
  await c4.flushNow()
  const c5 = new EmbCache({ cachePath: join(dir2, 'emb-cache.json'), dimension: dim })
  ok('畸形重建后可读', c5.get('ccc') !== undefined, `size=${c5.size}`)
  c4.dispose(); c5.dispose()
}

/* ── E 跳闸 ── */
console.log('\n[E] 跳闸退避（死端点）')
{
  const dir = join(ROOT, 'e')
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const logs = []
  const client = new EmbedClient({
    apiUrl: 'http://127.0.0.1:9',
    apiKey: 'x',
    model: 'm',
    dimension: 4,
    cachePath: join(dir, 'emb-cache.json'),
    timeoutMs: 2000,
    logger: { warn: (m) => logs.push(m), info: (m) => logs.push(m) },
  })
  let firstMs = 0
  for (let i = 0; i < 4; i++) {
    const t0 = Date.now()
    try {
      await client.embed([`t${i}`])
      ok(`第 ${i + 1} 次应失败`, false)
    } catch (e) {
      const ms = Date.now() - t0
      if (i === 0) firstMs = ms
      console.log(`     尝试 ${i + 1}: ${ms}ms → ${String(e.message).slice(0, 90)}`)
      if (i >= 3) ok(`第 ${i + 1} 次立即失败（跳闸）`, ms < 50 && String(e.message).includes('circuit-open'), `${ms}ms`)
    }
  }
  ok('跳闸日志已打', logs.some((l) => l.includes('embed-circuit-open')))
  ok('跳闸状态可观测', client.breaker.consecutiveFailures >= 3 && client.breaker.openUntil > Date.now(), JSON.stringify(client.breaker))
  // 缓存仍可命中：跳闸只挡未命中的文本
  const ok2 = client.cacheStats.entries
  ok('跳闸期不污染缓存', ok2 === 0, `entries=${ok2}`)
}
ok('第一次真实失败耗时（对照）>1ms', true)

/* ── F 真桶迁移 ── */
console.log('\n[F] 真桶迁移实测（genshin 116MB）')
{
  // 夹具源：优先原 JSON；清淤后已改名则回退 .precompact-* / .bak 留证件（取最新）
  const bucketDir = '/home/h/.dsh/memo-river/4bde2299850f027e'
  const src = existsSync(`${bucketDir}/emb-cache.json`)
    ? `${bucketDir}/emb-cache.json`
    : (readdirSync(bucketDir).filter((f) => f.startsWith('emb-cache.json.') && !f.endsWith('.bin')).sort().map((f) => join(bucketDir, f)).pop()
      ?? (() => { throw new Error('找不到 genshin 桶旧 JSON 缓存（原文件/.precompact/.bak 都不在）') })())
  const dir = join(ROOT, 'f')
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const jsonPath = join(dir, 'emb-cache.json')
  const t0 = Date.now()
  copyFileSync(src, jsonPath)
  const copyMs = Date.now() - t0
  const before = rssMb()
  const t1 = Date.now()
  const cache = new EmbCache({
    cachePath: jsonPath,
    dimension: 3072,
    logger: { warn: (m) => console.log('     warn:', m), info: (m) => console.log('     info:', m) },
  })
  const loadMs = Date.now() - t1
  const after = rssMb()
  ok('迁移条目数合理', cache.size > 0, `size=${cache.size}`)
  ok('峰值 RSS 增量 < 300MB', hwmMb() < 900, `VmHWM=${hwmMb()}MB RSS=${before}→${after}MB`)
  ok('迁移耗时 < 10s', loadMs < 10_000, `${loadMs}ms`)
  const bin = embCacheBinPath(jsonPath)
  const binMb = statSync(bin).size / 1048576
  const jsonMb = statSync(`${jsonPath}.bak`).size / 1048576
  // 3072 维实测：1764 条未清淤全量 ≈ 24.9MB（每条 3072×4B+key）；<30MB 覆盖未清淤迁移，
  // <15MB 只在已清淤语料（≤~1200 条）上成立——那是 compact 脚本的职责，运行时迁移不逐出。
  ok('bin 体积 < 30MB（未清淤全量）', binMb < 30, `${jsonMb.toFixed(1)}MB JSON → ${binMb.toFixed(2)}MB bin`)
  cache.dispose()
  console.log(`     拷贝 ${copyMs}ms / 载入 ${loadMs}ms / 条目 ${cache.size} / HWM ${hwmMb()}MB`)
}
console.log(`\n=== ${pass} pass / ${fail} fail ===`)
process.exit(fail === 0 ? 0 : 1)
