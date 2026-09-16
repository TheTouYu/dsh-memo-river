# 11 — 委托态 write-nudge 豁免/降频（治 R4：nudge 击穿红线）

**What to build:** write-nudge 注入前判断会话委托态：delegationDepth>0 或 delegationActive 闩锁（票 05 已落的双信号，injector 侧现成）时**跳过 nudge 或间隔放大 10×**——短命/被委托的子代理不该被催写：父代理会代写综合日记（D75 协议），子代理被催出来的 6 篇（D66-D74）只推爆了 hub。配置级开关（preset），缺省豁免。与票 06 hub-gate 互补：06 挡"写了什么"，本票挡"该不该催"。

**证据：** recall-quality-0916 工作流 9 子代理被轰炸 4-15 次/个，prompt 明令禁写生产桶仍 18 次 memo_write、6 篇落河；「被动召回」「记忆自驱」hub 双双 ≥37%（docs/EVAL-工作流效率-0916.md R4）。

**Blocked by:** None — can start immediately（依赖票 05 的 delegation 信号已在 HEAD）

**Status:** ready-for-agent

- [ ] delegationDepth>0 或闩锁激活时 nudge 跳过（或 10× 降频），可配可关
- [ ] 交互/自主主会话的 nudge 行为回归不变
- [ ] acceptance：模拟委托会话全生命周期 0 nudge；普通会话节律不变
- [ ] 与票 06 hub-gate 的组合行为说明（豁免漏网时 enforce 仍兜底）
