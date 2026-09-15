# 07 — tie-breaker 会话级试点（票⑤ 实验通道）

**What to build:** 用 `memo_tuning` 的 session scope 把票⑤ 有界 tie-breaker 打开（tieBreakerEnabled=1，默认参 cap 0.05 / tau 2 / 半衰期 30d），在 dsh-memo-river 桶做数日真实试点，回答一个问题：**k-limit 截断名单里的高相关条目（09-15 两轮评估中被截掉的 D19/D22/D23 等）能否被有界强化拉回注入，且不引发注入轰炸**。实验可随时开关、读数入河，结论决定 preset 级是否默认开启。

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] session scope 开关生效：开/关两状态下同一查询的注入 ids 可复现差异
- [ ] ≥2 轮真实会话对比读数：开启后被截断高相关条目的找回比例、注入条数变化、elapsedMs 无显著劣化
- [ ] tie-breaker 增幅有界（注入评分变化 ≤ cap），不出现重复条目连注
- [ ] 试点结论（含建议：默认开/关/调参）写入河流日记一篇
