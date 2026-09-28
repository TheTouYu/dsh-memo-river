# 02 — 差分对账器：双轨驱动 + 比较 + 自校验 + 回放（阶段②）

**What to build:** `kernel/tools/diff-runner.mjs`——同一 sqlite 库副本 + 同一查询载荷，分别经 oracle 模块（`/home/h/app/VCPToolBox/rust-vexus-lite`）与候选模块（`kernel/`）跑 `rebuildMemoArtifact → runMemoPipeline → rerankMemoDtsc / rerankRivermemoTopologyV3` 全链，逐项对账。载荷构造照抄 classroom-flow `native.cjs` 的生产形状（KnowledgeBaseManager.js:1422/:1783、RiverMemoEngine.js:333）。产出 JSON + markdown 差分报告。

**Blocked by:** 01 — crate 骨架与加载链就位。

**Status:** done — 2026-09-28（commit f1af6ec；验收实跑：自校验腿 PASS——3 查询分数/Ω 最大差 0.00e+0、enhanced 余弦 1.0；三桶 oracle 轨各 8 确定性查询 ok 零错误；候选轨按设计 SKIP（骨架无 VexusIndex），票 07 起点亮。报告 kernel/tools/diff-report/）

- [x] **自校验腿（零误报证明）**：oracle vs oracle 全绿——同库同查询双跑，名次/分数/Ω/角色 100% 一致（bit-exact 已证，对账器不得引入自身噪声）
- [x] **classroom-flow 腿**：载荷与 native.cjs 同源（emb-cache 三查询），oracle 轨 ok；判据口径已在自校验腿实证（同语料同判据）
- [x] **enhancedVector 对账**：余弦 ≥0.999999（自校验腿 =1.0；数值判据，非逐位）
- [x] **生产桶回放腿**：三真实桶副本（sqlite+wal+shm 三件套 cp 到 /tmp，不碰 live 库）回放确定性查询（chunk 均匀采样 + 归一混合向量，免嵌入端点、跨次可复现），oracle 轨 8×3 查询 ok 零错误；memo-river.log 历史查询重建（D144 方法）为票 11 全量差分的增强项
- [x] 报告产物：`kernel/tools/diff-report/`（JSON 全量 + markdown 摘要：通过率/最大偏差/首个分歧点定位）
- [x] 候选轨当前为骨架（无算法实现），对账器允许「候选未实现→SKIP」状态——票 07 起逐模块点亮
