# 09 — 复刻 topology_v3 + dtsc（2897 + 1655 行，深水区）

**What to build:** `kernel/src/rivermemo_topology_v3.rs` + `memo_dtsc.rs`：Ω regime / 角色 / 锚奖励 / 压制语义（03 票逆向文档为准）+ DTSC 读出。这是作者与 AI 探讨的决策史所在，「代码 + 行为」双反推的唯一地带。

**Blocked by:** 08 + 03 + 04（逆向先行，硬前置）

**Status:** done — 2026-09-28（a: d720932 判分心脏 / b: 6884bd8 dtsc）

- [x] 差分全绿：五腿 **PASS**（notImpl=0），27 查询×4 语料双读出名次/分数/Ω/角色全一致，分数最大差 1.11e-16
- [x] compare.md 金数值表复现：Topo 三查询前五全对上（Ω=0.6000/0.7843/0.5707）；DTSC 查询C 前五逐位对上（0.9141/0.9039/0.8902/0.5863/0.566）
- [ ] 17 误杀 / 8 误放标注集：复刻版误杀 0/17 且误放 0/8（gate 行为不劣化）——挂票 11 全量验收（gate 在 JS 壳层，内核不涉门控；差异面为 0 风险，留验收占位）
- [x] sparse 场景：三生产桶 24 查询含 sparse regime（dsh-memo-river 桶 Ω 0.26-0.27 sparse 实测），regime/角色判定双轨一致
