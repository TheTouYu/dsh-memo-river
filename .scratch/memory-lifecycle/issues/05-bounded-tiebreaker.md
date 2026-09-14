# 05 — 有界 tie-breaker 强化（默认关，观察数据后的远期期权）

**What to build:** 可选的打分微调层，**默认关闭**。开启后仅在 Rust 读出之后的 JS 排序处生效：对台账中「**主动使用**」信号（memo_recall 命中，非被动注入）施加有界强化。公式形态来自本轮讨论的设计决定：

```
boost = cap · tanh(activeCount / τ) · recencyFactor    // cap = ±0.05，随不使用向基线收缩
```

上限 ±0.05（远小于 anchor 奖励的 0.18），tanh 天然饱和、recency 因子保证长期不用则回落基线——防马太效应锁死。不碰 Rust、不进图资产 hash（artifactSig 不变）；`memo_tuning` 可会话级开关做实验。目标只是查询漂移时近似并列的候选重排，绝非曝光积累。

**Blocked by:** 01 — 使用台账（需要主动使用计数的持久数据源）

**Status:** ready-for-agent

- [ ] 默认关：分数与当前实现逐位一致（回归对比通过）
- [ ] 开启 + 预置台账：仅 Δ<0.05 的并列对发生重排，差距大的名次不变
- [ ] 强化生效前后 artifactSig 不变
- [ ] `memo_tuning` session 级可开/关，preset 默认值落盘 tuning.json
- [ ] DESIGN.md「边界与不承诺」追加反馈环风险声明（exposure bias / 马太效应 / 为何只认主动信号、拒绝被动注入计数）
