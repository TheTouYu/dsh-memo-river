# 02 — 差分对账器：双轨驱动 + 比较 + 自校验 + 回放（阶段②）

**What to build:** `kernel/tools/diff-runner.mjs`——同一 sqlite 库副本 + 同一查询载荷，分别经 oracle 模块（`/home/h/app/VCPToolBox/rust-vexus-lite`）与候选模块（`kernel/`）跑 `rebuildMemoArtifact → runMemoPipeline → rerankMemoDtsc / rerankRivermemoTopologyV3` 全链，逐项对账。载荷构造照抄 classroom-flow `native.cjs` 的生产形状（KnowledgeBaseManager.js:1422/:1783、RiverMemoEngine.js:333）。产出 JSON + markdown 差分报告。

**Blocked by:** 01 — crate 骨架与加载链就位。

**Status:** ready-for-agent

- [ ] **自校验腿（零误报证明）**：oracle vs oracle 全绿——同库同查询双跑，名次/分数/Ω/角色 100% 一致（bit-exact 已证，对账器不得引入自身噪声）
- [ ] **classroom-flow 腿**：三版语料（v0 孤岛 / v1 河流15Tag / v2 均衡，若 sandbox 仅含单版则以现有库+三查询为准并注明）× 三查询 × dtsc+topo 双读出，对账判据：选集 ID 名次完全一致 / 分数差 ≤1e-6 / Ω 相等 / 角色序列相等
- [ ] **enhancedVector 对账**：余弦 ≥0.999999（数值判据，非逐位）
- [ ] **生产桶回放腿**：三真实桶副本（sqlite+wal+shm 三件套 cp 到 /tmp，不碰 live 库）回放确定性查询（chunk 均匀采样 + 归一混合向量，免嵌入端点、跨次可复现），对账同判据；memo-river.log 历史查询重建（D144 方法）为票 11 全量差分的增强项
- [ ] 报告产物：`kernel/tools/diff-report/`（JSON 全量 + markdown 摘要：通过率/最大偏差/首个分歧点定位）
- [ ] 候选轨当前为骨架（无算法实现），对账器允许「候选未实现→SKIP」状态——票 07 起逐模块点亮
