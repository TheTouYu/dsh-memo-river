# 05 — 有界 tie-breaker 强化（默认关，观察数据后的远期期权）

**What to build:** 可选的打分微调层，**默认关闭**。开启后仅在 Rust 读出之后的 JS 排序处生效：对台账中「**主动使用**」信号（memo_recall 命中，非被动注入）施加有界强化。公式形态来自本轮讨论的设计决定：

```
boost = cap · tanh(activeCount / τ) · recencyFactor    // cap = ±0.05，随不使用向基线收缩
```

上限 ±0.05（远小于 anchor 奖励的 0.18），tanh 天然饱和、recency 因子保证长期不用则回落基线——防马太效应锁死。不碰 Rust、不进图资产 hash（artifactSig 不变）；`memo_tuning` 可会话级开关做实验。目标只是查询漂移时近似并列的候选重排，绝非曝光积累。

**Blocked by:** 01 — 使用台账（需要主动使用计数的持久数据源）

**Status:** done — 2026-09-14（acceptance-tiebreaker.mjs 9/9；串行回归 update 7/7 / usage 6/6 / merge 6/6 / consolidation 5/5 / 主套件 32/32 / P3 4/4）

**实现预案（2026-09-14 排队票⑧窗口时拟定）：**
- 新模块 `src/tiebreaker.ts`：`applyUsageTieBreaker(candidates, ledger, {enabled, cap=0.05, tau=2, recencyHalfLifeDays=30}, now)` 纯函数——boost = cap·tanh(activeCount/τ)·exp(-ageDays·ln2/halfLife)，仅 active 计数；enabled=false 时原样返回（逐位一致）。挂点：recall.ts Rust 读出后的 JS 选择/排序处（等票⑧提交后基于干净态接线）。
- 开关走 `memo_tuning`（tuning.ts）：`tieBreaker: {enabled:false, cap, tau, recencyHalfLifeDays}`，session 级可实验、preset 默认落盘 tuning.json——不进 config schema（避免与票⑧的 config 键撞车）。
- 验收 `scripts/acceptance-tiebreaker.mjs`：T-1 默认关=顺序与分数逐位一致（函数 no-op + 集成双跑对比）；T-2 近并列对（Δ<0.05）翻转、大差距（0.10）名次不变、陈旧 active（60 天前）factor≈0.25 不足以翻中等差距——合成候选确定性测试，不走嵌入；T-3 强化前后 tagmemo_artifacts 行逐字节不变（U-3 同款证据面）；T-4 tuning session 开/关 + preset 默认落盘；T-5 DESIGN 边界与不承诺追加 exposure bias/马太效应/只认主动信号声明。

- [ ] 默认关：分数与当前实现逐位一致（回归对比通过）
- [ ] 开启 + 预置台账：仅 Δ<0.05 的并列对发生重排，差距大的名次不变
- [ ] 强化生效前后 artifactSig 不变
- [ ] `memo_tuning` session 级可开/关，preset 默认值落盘 tuning.json
- [ ] DESIGN.md「边界与不承诺」追加反馈环风险声明（exposure bias / 马太效应 / 为何只认主动信号、拒绝被动注入计数）

**验收勾账（2026-09-14 done）：**
- [x] 默认关：分数逐位一致（T-1a 函数返回原引用 + T-1b 集成双跑同序，首跑预热后再比）
- [x] 开启+预置台账：Δ=0.002 翻转（T-2a）/ Δ=0.10 不动（T-2b）/ 陈旧 60 天有效 boost 0.0123<0.02 不翻（T-2c）/ 上界 ≤cap（T-2d）
- [x] artifactSig 不变（T-3：tagmemo_artifacts 行逐字节一致）
- [x] memo_tuning session 开/关 + preset set 落盘（T-4；preset 文件=~/.dsh/.agent-presets/memo-river/tuning.json）
- [x] DESIGN §11 反馈环风险声明（T-5）

**实现附记：**①接线=RecallOptions.tieBreaker 由调用方注入（memo_recall 按 tuning 会话值，被动注入不传=预设默认关），recall.ts 零 tuning 耦合；②tuning 数字面 0/1，四键进 config.inject+TUNING_SPEC+memo_tuning 参数面；③验收三修：T-1b 首跑资产构建并列带漂移→预热后再比（同 U-3 教训）、T-2c 原设计 Δ=0.01<0.0123 必翻（自己数学错）→改 0.02、T-4 preset 路径在 ~/.dsh/.agent-presets/。
