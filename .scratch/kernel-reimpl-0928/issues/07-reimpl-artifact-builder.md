# 07 — 复刻 artifact_builder（861 行，最熟的一块）

**What to build:** `kernel/src/memo_artifact_builder.rs` 行为等价复刻：build_fact_matrix / build_transport / build_native_artifact / build_provenance / graph_digest。优势：票⑥（e1f54b7d）逐行修过浮点定序，语义最熟。**定序设计直接进代码**（fact_sources/edges 排序后累加），确定性第一天成立。

**Blocked by:** 02

**Status:** done — 2026-09-28（commit 3a54c6f）

- [x] 同库 rebuild 双轨对账：图资产逐字段一致——payload 规范化深比对（CSR weights/nodeIds/rowOffsets/targetIndices/inbound/anchorGain/wormhole/provenance 全量）5 腿 **0 分歧 0 浮点差**（1e-9 容差未动用）；nodes/edges 15/78 对上 compare.md v2 金数值表
- [x] artifactSig 一致（内容寻址，输入相同则 sig 相同）——oracle 与候选逐位同串
- [x] 确定性属性：同库连打 6 次 sig 逐位一致 + 跨进程 2×3 全同（probe-reimpl-sig.mjs，classroom + preset-composer 双语料）
- [x] 单元：票⑥修复的三处污染点各带一个回归测试（HashMap 双实例构建序不敏感 / inbound 排序累加 / semantic_gain 公式数值锚点），cargo test 3/3
