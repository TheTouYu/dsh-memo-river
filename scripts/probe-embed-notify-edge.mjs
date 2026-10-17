/**
 * scripts/probe-embed-notify-edge.mjs — 嵌入链路通知**状态转换沿**专项（2026-10-17 §1）。
 *
 * 判据（PLAN「两真会话注入通道工程优化」§1）：
 *  A 进程启动即 ok（recovered 无降级前史）→ 对话通道 0 条
 *  B 持续降级：连续 10 次 failover（时间跨度 > 旧冷却窗 5min）→ 恰 1 条
 *  C 恢复：插入 recovered → 恰 1 条
 *  D 再降级：新一轮 failover → 再 1 条
 *  E 抖动覆盖：failover(报) → recovered(未消费) → failover(新) → 不翻旧账（null）
 *  F all-failed 仍不进对话通道（2026-10-15 语义保留）
 *  G 面板/日志可见性：静默吸收不丢事件（snapshot().events 全量保留）
 *  H 多 lane 独立：fallback 的 recovered（从未报过该 lane 降级）→ 静默
 *  I 行为读数：同一 13h 模拟场景，旧冷却窗语义 vs 新状态沿语义的通知条数对照
 *
 * 用法：node scripts/probe-embed-notify-edge.mjs
 */
const { embedHealth } = await import('../lib/embed-health.js')

let pass = 0, fail = 0
const ok = (n, c, extra = '') => { c ? pass++ : fail++; console.log(`  ${c ? '✅' : '❌'} ${n} ${extra}`) }

/** 模拟注入路径的「取一条播一条」（injector.ts pending→markAnnounced 循环）。 */
function drainNotices() {
  let n = 0
  for (;;) {
    const ev = embedHealth.pending()
    if (!ev) break
    embedHealth.markAnnounced(ev)
    n++
    if (n > 100) throw new Error('drain runaway')
  }
  return n
}
const failover = (at, lane = 'primary') => embedHealth.record({  kind: 'failover', lane, endpoint: 'http://127.0.0.1:8099', reason: 'ECONNREFUSED',
  detail: '主端点失败→回退', hint: '排障', at,
})
const recovered = (at, lane = 'primary') => embedHealth.record({
  kind: 'recovered', lane, endpoint: 'http://127.0.0.1:8099', reason: 'ok',
  detail: '端点恢复', hint: '无需处置', at,
})
const MIN = 60_000

console.log('[A] 进程启动即 ok：recovered 无降级前史 → 0 条')
embedHealth.reset()
recovered(Date.now())
ok('0 条', drainNotices() === 0)

console.log('[B] 持续降级：10 次 failover 跨 60 分钟（>旧冷却窗）→ 恰 1 条')
embedHealth.reset()
const t0 = Date.now() - 60 * MIN
for (let i = 0; i < 10; i++) failover(t0 + i * 6 * MIN) // 每 6 分钟一次（旧语义每个冷却窗都会报）
ok('恰 1 条（旧语义此处=10 条）', drainNotices() === 1, '')

console.log('[C] 恢复 → 恰 1 条')
recovered(Date.now())
ok('恰 1 条', drainNotices() === 1)

console.log('[D] 再降级 → 再 1 条')
failover(Date.now())
ok('恰 1 条', drainNotices() === 1)

console.log('[E] 抖动覆盖：failover(已报)→recovered(未消费)→failover(新) → 不翻旧账')
embedHealth.reset()
failover(t0); ok('首条报出', drainNotices() === 1)
failover(t0 + MIN) // 未消费就来了恢复+再降级
recovered(t0 + 2 * MIN)
failover(t0 + 3 * MIN)
const ev5 = embedHealth.pending()
ok('null（最新状态=degraded 与已播报一致；被覆盖的 recovered 不翻出来）', ev5 === null)

console.log('[F] all-failed 不进对话通道（2026-10-15 语义保留）')
embedHealth.reset()
embedHealth.record({ kind: 'all-failed', lane: 'primary+fallback', endpoint: 'x', reason: 'r', detail: 'd', hint: 'h', at: Date.now() })
failover(t0)
ok('只报 failover 1 条，all-failed 不出', drainNotices() === 1)

console.log('[G] 面板可见性：静默吸收不丢事件')
embedHealth.reset()
for (let i = 0; i < 5; i++) failover(t0 + i * MIN)
drainNotices()
ok('snapshot().events 仍 5 条全量', embedHealth.snapshot().events.length === 5)

console.log('[H] 多 lane 独立：fallback lane 的 recovered（该 lane 没报过降级）→ 静默')
embedHealth.reset()
failover(t0, 'primary')
drainNotices()
recovered(t0 + MIN, 'fallback')
ok('0 条', drainNotices() === 0)

console.log('[I] 行为读数：13h 模拟场景（每 6min 一次 failover）新旧语义对照')
embedHealth.reset()
// 旧冷却窗语义模拟器（与 2026-10-17 前实现逐句等价）：announcedIds 防同 id；冷却 5min 过后新事件新 id 可报
const OLD_COOLDOWN_MS = 5 * MIN
let oldAnnouncedAt = -Infinity, oldCount = 0
for (let i = 0; i < 130; i++) {
  const at = t0 + i * 6 * MIN
  failover(at)
  if (at - oldAnnouncedAt >= OLD_COOLDOWN_MS) { oldCount++; oldAnnouncedAt = at }
}
const newCount = drainNotices()
ok('新语义 13h 恰 1 条', newCount === 1)
console.log(`    行为读数：旧冷却窗语义=${oldCount} 条（生产实证 77 条/13h，同形） → 新状态沿语义=${newCount} 条`)
ok('降幅 ≥95%', newCount <= Math.ceil(oldCount * 0.05))

console.log(`\n=== ${pass} pass / ${fail} fail ===`)
process.exit(fail === 0 ? 0 : 1)
