# 07 — 复刻 artifact_builder（861 行，最熟的一块）

**What to build:** `kernel/src/memo_artifact_builder.rs` 行为等价复刻：build_fact_matrix / build_transport / build_native_artifact / build_provenance / graph_digest。优势：票⑥（e1f54b7d）逐行修过浮点定序，语义最熟。**定序设计直接进代码**（fact_sources/edges 排序后累加），确定性第一天成立。

**Blocked by:** 02

**Status:** ready-for-agent

- [ ] 同库 rebuild 双轨对账：图资产逐字段一致（nodes/edges 数完全相等；边权差 ≤1e-9；digest 拼接序一致）
- [ ] artifactSig 一致（内容寻址，输入相同则 sig 相同）
- [ ] 确定性属性：同库连跑 6 次 sig 逐位一致 + 跨进程 2×3 全同（probe-sig-determinism 口径移植）
- [ ] 单元：票⑥修复的三处污染点各带一个回归测试（排序前后输出对比）
