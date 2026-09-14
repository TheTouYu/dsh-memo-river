# 06 · artifactSig 漂移根修：图边权定序求和 + artifact 行换代清理（卫生票）

**Status:** ready-for-agent（优先级低于 02-05；可与 05 捆绑，不阻塞任何主线票）

**来源**：票①验收 U-3 的假阳性排查（D24 归因记录，2026-09-14 分量级二分诊断）。

## 问题（证据已固化）

1. **漂移源**：引擎级 composite artifactSig 的分量 `source_graph_generation`（图边权摘要，
   `memo_artifact_builder.rs:666-679`）在派生缓存未齐/某些库状态下**每次重建都不同**；
   其余分量（config_hash / database_generation / provenance_generation）实测稳定。
   摘要拼接已排序——变的是**边权值本身**，根因指向权重推导路径（`build_fact_matrix` /
   `build_transport` / pairwise 回退计算）的非确定性浮点求和序（HashMap 迭代序 → 1-ulp 求和差）。
2. **噪声量级**：生产库同一语料累计出现过 16/25 种 `node_count×edge_count` 图形状变体
   （dsh-memo-river 桶 16 种、preset-composer 桶 25 种）——浮点噪声曾影响阈值切边，
   **同语料生成过多个不同版本的图**，不只是指纹噪声。
3. **已付成本**：`rivermemo_artifacts` 每次漂移调用 INSERT 一行（ON CONFLICT 不清旧行、无上限）：
   生产 23 篇语料积 148 行/754KB（合法换代仅 ~23 行）；preset-composer 31 篇积 136 行/796KB。
   漂移窗口内 builders 每轮重跑（EPA 全量重算只是症状）10–100ms/次。
4. **缓解现状**：派生缓存齐备后进入冻结态（生产 83 守护轮 0 重建）；新库/新导入必经漂移窗口。

## 修法（两处，互不依赖）

### A. Rust：权重推导定序（根修）
- 排查 `build_fact_matrix` / `build_transport` / `load_pairwise`（缓存未命中路径）中所有 f64 累加，
  改为确定序（排序后累加，或按 BTreeMap/索引序迭代），保证同输入 → 逐位相同输出。
- 验收判据：全新副本库连打 6 次 ensureArtifact，`source_graph_generation` 完全一致；
  跨进程亦一致（两个独立 node 进程各打 3 次）。
- 风险：不动算法语义（只定序）；改完跑 acceptance.mjs #8（排序一致性）+ #3-#5 主线回归。

### B. JS/SQL：artifact 行换代清理（止血）
- 重建成功后只保留每个 schema 最新一代：`DELETE FROM rivermemo_artifacts WHERE artifact_sig != ?最新`
  （或保留最近 K=3 代防回滚），可挂在 daemon 体检轮低频执行。
- 验收判据：漂移窗口连打 N 次后行数 ≤ K；生产库执行一次后 148 → ≤3 行。
- 注意与并行会话 prod-hardening 票的 daemon 改动协调（它们也动 daemon.ts——先 ping）。

## 红线

- 不改打分语义（A 只定序不改值，B 只清行不碰活跃 artifact）。
- 学习态（票①台账）已在 DESIGN §7.3 声明不得依赖 sig 稳定性——本票修好后该红线仍保留（防御性）。
