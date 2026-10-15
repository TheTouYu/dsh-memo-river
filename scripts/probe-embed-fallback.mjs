/**
 * scripts/probe-embed-fallback.mjs — 端点保底（本地主 + 远端备）**行为专项**。
 *
 * 判据（2026-10-15 用户令：测试没问题再做工程服务 + 失败回退远端 + 失败要看得见）：
 *  A 主端点死 → 自动回退保底，向量照常返回（写路径不因此拒写）
 *  B 回退事件进台账，且 `formatEmbedEvent` 是**完整可复制**的排障文本（含端点/错误原文/回退目标/处置命令）
 *  C 全链失败 → 抛错 + `all-failed` 台账事件（调用方据此降级：注入跳过/写路径拒绝）
 *  D 主端点健康时**不**触发回退（不得无谓降级）
 *  E 主端点跳闸后第二次调用**不再吃满超时**（直接跳过去打保底）
 *  F 回退取回的向量入同一缓存：此后两个端点都死，缓存仍能供数
 *
 * 用法：node scripts/probe-embed-fallback.mjs [--good http://127.0.0.1:8099]
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : d }
const GOOD = String(arg('good', 'http://127.0.0.1:8099'))
const DEAD = 'http://127.0.0.1:9'          // 立刻 ECONNREFUSED
const BLACKHOLE = 'http://10.255.255.1:9'  // 不可路由 → 吃满超时

const { EmbedClient } = await import('../lib/embed.js')
const { embedHealth, formatEmbedEvent } = await import('../lib/embed-health.js')
const TMP = mkdtempSync(join(tmpdir(), 'embfallback-'))
let pass = 0, fail = 0
const ok = (n, c, extra = '') => { c ? pass++ : fail++; console.log(`  ${c ? '✅' : '❌'} ${n} ${extra}`) }
const client = (primary, fallback, timeoutMs = 2500) => new EmbedClient({
  apiUrl: primary, apiKey: 'k', model: 'baai/bge-m3', dimension: 1024,
  cachePath: join(TMP, `c-${Math.random().toString(36).slice(2)}.json`),
  timeoutMs, ...(fallback ? { fallback: { apiUrl: fallback, apiKey: 'k', model: 'baai/bge-m3' } } : {}),
  logger: { warn: (m) => console.log(`    [warn] ${m.slice(0, 150)}`), info: () => {} },
})

console.log(`本地(好端点)=${GOOD}  死端点=${DEAD}  黑洞=${BLACKHOLE}\n`)

/* ── D 主端点健康：不应回退 ── */
console.log('[D] 主端点健康 （不得无谓降级）')
embedHealth.reset()
{
  const c = client(GOOD, DEAD)
  const [v] = await c.embed(['主端点健康时的文本 A'])
  ok('向量正常返回', v.length === 1024, `dim=${v.length}`)
  ok('无回退事件', embedHealth.pending() === null, JSON.stringify(embedHealth.snapshot().counters))
}

/* ── A/B 主端点死 → 回退 + 台账 ── */
console.log('\n[A/B] 主端点死 → 回退保底 + 可复制台账')
embedHealth.reset()
{
  const c = client(DEAD, GOOD)
  const t0 = Date.now()
  const [v] = await c.embed(['主端点死了，应该回退到保底端点 B'])
  const ms = Date.now() - t0
  ok('回退后向量照常返回', v.length === 1024, `dim=${v.length} 用时 ${ms}ms`)
  const lanes = c.lanesState
  ok('泳道状态可见', lanes.length === 2 && lanes[0].failures > 0, JSON.stringify(lanes.map((l) => [l.label, l.failures, l.endpoint])))
  const ev = embedHealth.pending()
  ok('记了 failover 事件', ev?.kind === 'failover', JSON.stringify(embedHealth.snapshot().counters))
  if (ev) {
    const text = formatEmbedEvent(ev)
    console.log('    ── 用户可见的报错文本（原样）──')
    console.log(text.split('\n').map((l) => '    ' + l).join('\n'))
    ok('文本含失败端点', text.includes(DEAD))
    ok('文本含回退目标', text.includes(GOOD))
    ok('文本含处置命令', /systemctl|curl|journalctl/.test(text))
    embedHealth.markAnnounced(ev)
    ok('播报后进入冷却（不再重复播报）', embedHealth.pending() === null)
  }
}

/* ── C 全链失败 ── */
console.log('\n[C] 全链失败 → 抛错 + all-failed 台账')
embedHealth.reset()
{
  const c = client(DEAD, DEAD)
  let err = null
  try { await c.embed(['两个端点都死了']) } catch (e) { err = e }
  ok('确实抛错（调用方可降级）', err !== null, String(err?.message).slice(0, 80))
  ok('记了 all-failed 事件', embedHealth.snapshot().counters['all-failed'] === 1, JSON.stringify(embedHealth.snapshot().counters))
  const ev = embedHealth.snapshot().events[0]
  ok('全文含两个端点与影响面', !!ev && ev.detail.includes('影响：') && ev.detail.includes('127.0.0.1:9'))
}

/* ── E 跳闸后不再吃满超时（用「接受连接但永不响应」的挂起服务逼出真超时） ── */
console.log('\n[E] 超时路径：挂起主端点 → 吃满超时回退；连败 3 次跳闸后不再吃超时')
embedHealth.reset()
{
  const net = await import('node:net')
  const hang = net.createServer((sock) => { void sock; /* 接受连接，永不响应 */ })
  await new Promise((r) => hang.listen(0, '127.0.0.1', r))
  const hangPort = hang.address().port
  const c = client(`http://127.0.0.1:${hangPort}`, GOOD, 800)
  const times = []
  for (let i = 0; i < 3; i++) {
    const t = Date.now()
    await c.embed([`超时路径第 ${i + 1} 次（主端点挂起）`])
    times.push(Date.now() - t)
  }
  ok('前三次都吃满超时再回退', times.every((x) => x >= 700), JSON.stringify(times))
  ok('连败 3 次后跳闸', c.lanesState[0].failures >= 3 && c.lanesState[0].windowMs > 0,
    JSON.stringify({ failures: c.lanesState[0].failures, windowMs: c.lanesState[0].windowMs }))
  const t4 = Date.now()
  await c.embed(['跳闸窗口内：应跳过主端点直接打保底'])
  const ms4 = Date.now() - t4
  ok('跳闸后不再吃超时（直接打保底）', ms4 < 300, `${ms4}ms（前三次 ${JSON.stringify(times)}）`)
  const ev = embedHealth.snapshot()
  ok('超时类事件也进了台账', (ev.counters['failover'] ?? 0) >= 1, JSON.stringify(ev.counters))
  hang.close()
}

/* ── F 回退向量入缓存：端点全死后仍能供数 ── */
console.log('\n[F] 回退取回的向量入同一缓存（两端点全死后仍可命中）')
embedHealth.reset()
{
  const cachePath = join(TMP, 'shared.json')
  const mk = (p, f) => new EmbedClient({
    apiUrl: p, apiKey: 'k', model: 'baai/bge-m3', dimension: 1024, cachePath, timeoutMs: 1500,
    ...(f ? { fallback: { apiUrl: f, apiKey: 'k', model: 'baai/bge-m3' } } : {}),
  })
  const c1 = mk(DEAD, GOOD)
  const [a] = await c1.embed(['这条要走回退并落缓存'])
  await c1.flushCache()
  const c2 = mk(DEAD, null) // 只有死主端点，没有保底
  const [b] = await c2.embed(['这条要走回退并落缓存'])
  ok('缓存供数成功', a.length === 1024 && b.length === 1024)
  ok('缓存值一致', a.every((x, i) => Math.abs(x - b[i]) < 1e-12))
}

console.log(`\n=== ${pass} pass / ${fail} fail ===`)
try { rmSync(TMP, { recursive: true, force: true }) } catch {}
process.exit(fail === 0 ? 0 : 1)
