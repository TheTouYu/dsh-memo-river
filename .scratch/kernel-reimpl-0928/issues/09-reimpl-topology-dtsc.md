# 09 — 复刻 topology_v3 + dtsc（2897 + 1655 行，深水区）

**What to build:** `kernel/src/rivermemo_topology_v3.rs` + `memo_dtsc.rs`：Ω regime / 角色 / 锚奖励 / 压制语义（03 票逆向文档为准）+ DTSC 读出。这是作者与 AI 探讨的决策史所在，「代码 + 行为」双反推的唯一地带。

**Blocked by:** 08 + 03 + 04（逆向先行，硬前置）

**Status:** blocked

- [ ] 差分全绿：classroom-flow 三查询 × 双读出的名次 / 分数（±1e-6）/ Ω / 角色全一致
- [ ] compare.md 金数值表复现：v2 语料查询 A/B/C 的 Topo 前五名与分数逐条对上
- [ ] 17 误杀 / 8 误放标注集：复刻版误杀 0/17 且误放 0/8（gate 行为不劣化）
- [ ] sparse 场景专项：Ω sparse 判定与角色降级路径双轨一致（compare.md 查询C v0 为 sparse 样本）
