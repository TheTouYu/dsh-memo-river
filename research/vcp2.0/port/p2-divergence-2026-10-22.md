# P2 开闸对照：我方复刻内核 vs VCP 2.0 oracle 的正式差异测量

> 2026-10-22 02:1x｜执行：dsh-memo-river 验证基建队友 B｜写域：`kernel/tools/{track-driver,diff-runner}.mjs`
> 判据未放宽；kernel/src 未改；`.node` 只用 `/tmp` 副本；报告由 lead 落盘 `research/vcp2.0/port/`

## 0. 一句话结论

**开闸后差异是真实的、可测的，且当前主导项不是读出层也不是「1/(1+L2) vs cosine」单点，而是图资产（builder）层**：同一份 DB、同一份 2.0 配置、两侧闸门全开时，`rebuildMemoArtifact` 产出的 artifact **每位节点 inbound mass 都不同**（bucket 108/108，maxΔ 2.56e-1），wormhole 边集 110 vs 24，artifactSig 全不一致；读出层只是把这份图差异放大成 39–46 个名次翻转（top-12 共 96 槽）+ 分数 5.09e-2 / Ω 2.16e-1。**配置面贡献 = 0（实测同数）**；「1/(1+d²) vs cosine」是**真 bug 且机制可锁到代码行**，但它直接进入融合向量的通道极小（enhanced cos 0.99999），只在动态虫洞 `known_scores` 复用 + 阈值 0.2 上被二值化放大。

## 1. 判据与回归（改造未动判据）

| 跑法 | 结果 |
|---|---|
| 基准五腿（v9.2 oracle × 我方 02:06 构建） | **5/5 PASS，总判定 OK**；selfcheck/classroom 分数最大差 **0**，三桶 **1.11e-16**，Ω 0，enhanced cos 1.000000000 |
| 2.0 selfcheck（2.0 × 2.0，2.0 配置 + 双闸开） | **PASS**，分数差 0.00e+0，Ω 0，bothAbsent=[dtsc] |
| 配置面对照：2.0 rag_params vs v9.2 rag_params（同在双闸开） | **两组读数逐位相同**（1.31e-2 / 2.63e-2 / 名次翻 7/3q / enhanced 0.999990594）⇒ 配置取值对差异贡献 = 0 |

## 2. 差异总量（P2 主测，oracle=2.0，candidate=我方 02:06 构建）

| 腿 | 判定 | 查询 | 分数 maxΔ | 分数 meanΔ | Ω maxΔ | regime 翻 | top-12 名次翻 | top-3 翻 | enhanced cos_min |
|---|---|---|---|---|---|---|---|---|---|
| classroom（原始夹具） | FAIL | 3 | **1.31e-2** | 4.16e-3 | **2.63e-2** | 0 | 7/33 | 2/3 | 0.999990594 |
| bucket dsh-memo-river（原始夹具，8 查询 270 候选） | FAIL | 8 | **6.16e-2** | 5.86e-3 | **2.77e-1** | 0 | 46/96 | 2/8 | 0.999992374 |
| classroom（剥净夹具*） | FAIL | 3 | 1.33e-2 | — | 3.83e-2 | 0 | 14/33 | — | 0.999985503 |
| bucket（剥净夹具*） | FAIL | 8 | 5.09e-2 | — | 2.16e-1 | 0 | 39/96 | — | 0.999997012 |

\* 剥净夹具 = 把 2.0 迁移会删掉的 v9.2 派生资产（tag_pair_similarity / tag_intrinsic_residuals / kv_store.epa_basis_cache / tagmemo_artifacts 的 pairwise·intrinsic 行）先行清空但**保留表结构**，使两轨看到同一世界（见 §4）。

## 3. 分阶段归因表

| 阶段 | 指标 | classroom | bucket dsh-memo-river |
|---|---|---|---|
| **图资产** | artifactSig 一致？ | 否（03b759e1 / 085f368c） | 否（0ea4bffa / a35b15ac） |
| | 节点/边数 | 15 / 78 · 15 / 78（同） | 108 / 1174 · 108 / 1174（同） |
| | inboundMassView 差异 | **15/15 节点全差**，maxΔ 1.01e-1 | **108/108 节点全差**，maxΔ 2.56e-1 |
| | wormholeView 边数 | 1 vs 0 | **110 vs 24**（仅 oracle 86） |
| | anchorGainView 条数 | 0 vs 0 | 0 vs 0 |（原始夹具上：classroom 0/14、bucket 0/55——差异来自派生资产） |
| **金字塔** | similarity maxΔ | **4.15e-1** | **4.25e-1** |
| | 层内 Tag 序翻 / 层数 | 6 / 9 层 | 8 / 24 层 |
| | Tag 集合差（成员翻） | 13 | 0（同集合、仅序） |
| **融合** | selectedTagIds 序翻 | 3/3 查询 | 8/8 查询 |
| | 计数差（requested/found/emergent） | ±1（32 vs 33） | ±1 |
| | totalWeight Δ | 2.56e-2（1.5174 vs 1.5430） | 同量级 |
| **双场** | 共有字段 maxΔ | **6.4e-12**（residual/mass 逐位同） | **1.1e-12** |
| | 我方独有诊断 | projectedNodes=14、selectedProjectionNodes=14、growth.stopReason=mass_target、budget=256 | 同（P1.3 basin 路径正常工作） |
| **融合向量** | enhanced cos_min | 0.999990594 | 0.999992374 |
| **投影/圈选（rerank 内部）** | offered / projected | 11/11 · 11/11（同） | 270/270 · 270/270（同） |
| | selectedCandidates | 11/11 | **156/155、153/144、132/131、145/142、160/159…（差 1–9）** |
| **读出** | topo 分数 maxΔ / meanΔ | 1.70e-2 / 4.16e-3 | 5.19e-2 / 5.86e-3 |
| | 名次翻 | 7/33 | 43–46/96 |
| | Ω maxΔ / regime | 2.63e-2 / 0 | 2.77e-1 / 0 |

## 4. 三个必须先说清的结构性事实（否则读数会被误读）

**(a) 2.0 的 schema 迁移会改写副本 —— 两轨原本不在同一世界。**
`rust-vexus-lite/src/schema.rs:305-322` 在 `if !switched` 分支里删：`tag_pair_similarity_status` / `tag_pair_similarity` / `kv_store['epa_basis_cache']` / `tag_intrinsic_residuals(_status)` / `tagmemo_artifacts` 的 `pairwise_similarity, intrinsic_residual` 行。已实测：同一份 classroom 源库，2.0 侧内联迁移后 `epa_basis_cache` 行数 1→0，我方侧仍是 1。

**(b) 我方内核打不开「2.0 已迁移」的库**（本次实测错误原文）：
`prepare pairwise failed: no such table: tag_pair_similarity` —— 两腿（classroom/bucket）候选轨均 error，而 2.0 在同样副本上 selfcheck PASS。⇒ 「预迁移副本 + 双轨」这条最干净的场路**今天走不通**，必须先让 builder 不再硬依赖 `tag_pair_similarity`（2.0 已用 AGS 几何取代它）。

**(c) 因此采用了「剥净副本」作为退而求其次的等场。**
清空派生资产但留表 → 我方仍能跑；读数变化：bucket 名次翻 46→39、分数 6.16e-2→5.09e-2、Ω 2.77e-1→2.16e-1（≈ 降 15–20%），classroom 名次翻反升 7→14。**说明派生资产不对称只解释一小部分**，剩下的差异在 builder 本身（inbound mass 对每个节点都不同）。

**(d) classroom 原始夹具的 EPA 不对称**：我方 `cacheAvailable=true, basisCount=13, logicDepth=0.2797`，2.0 侧 `cacheAvailable=false, basisCount=0, logicDepth=0`（迁移删了缓存）。bucket 两侧 EPA 完全一致（32 键 0 差）——所以**benchmark 判读请以 bucket 为准**，classroom 的融合差异含这层杂质。

## 5. 对「1/(1+L2) vs cosine」嫌疑的定量判决

**嫌疑成立，但公式本身要修正，且它的杀伤力在动态虫洞这一侧。**

1. **实测口径**（bucket，query=chunk84 自身向量，直接读库算）：
   - tag5：真实 cos = **0.5525** → 2.0 的 pyramid similarity = **0.553**（= cosine，逐位吻合）
   - 我方 = **0.528** = 1/(1 + **0.895**)；而 0.895 = **L2²**（L2 = 0.946）⇒ 我方是 **1/(1+L2²)**，不是 1/(1+L2)（usearch 返回的是**平方** L2）
   - tag4：cos 0.5230 → 我方 0.512（=1/(1+0.954) ✓）；tag109：cos 0.5193 → 我方 0.510 ✓
2. **代码行**：我方 `kernel/src/memo_pipeline.rs:622-626` `similarity: 1.0 / (1.0 + *distance)`；2.0 `rust-vexus-lite/src/memo_pipeline.rs:648` `let similarity = cosine(&residual, &vector);`，且 2.0 自测断言 `:2102` 相似度 = 1/√5（余弦）。讽刺的是我方 `:1585` 的注释写的就是「同层残差与目标向量的余弦就是金字塔的 similarity」——**实现与注释不符**。
3. **传播链（决定了它在 P2 才发力）**：`memo_pipeline.rs:1596` `wormholes.reuse_score(layer, tag.id, similarity)` → `memo_sensing.rs:319-323` 存入 `known_scores` → `:386-390` **有 known_scores 就跳过重算、直接把该值当作 `scores[layer]`** → `:418-425` `resonance = max(更深层 score)` → `:466` `if resonance < config.dynamic_wormhole_threshold(0.2) { continue; }`。
   - 正交/近正交时：2.0 = 余弦 ≈ 0.00（实测 L1/L2 层 0.000–0.17）→ **恒不过 0.2 阈**；我方 = 1/(1+2) = 0.333 → **恒过阈**。
   - 闸关时 `context=None`，`known_scores` 根本没被消费 ⇒ **零漂移**（这也是五腿一直绿的原因）。
4. **份量下界（可算）**：融合向量两侧余弦 0.9999–0.99999，说明这条通道**对 fused vector 的直接扰动 < 1e-4 相对量**；它真正的作用是把「近正交」二值化成「开/不开虫洞」，属**离散跳变**，不能靠分数差估算。
5. **结论**：嫌疑该修（一行：改余弦或 `sqrt(distance)`），但我**不建议**把它当 P2 差异的主因去追——它解释不了「每个节点 inbound mass 都不同」这种图级差异。**判定它份量的唯一硬实验**：只把 `memo_pipeline.rs:622-626` 改成余弦（kernel/src 属 C 域，我不动），重跑本条两个腿；若名次翻 39/96 掉到个位数即定罪，否则主因仍在 builder。

## 6. 逐位对齐需要补的开关/条件（按性价比排序）

1. **builder 对齐（最大杠杆）**：artifact 的三处视图全部不一致——`inboundMassView`（全部节点）、`wormholeView`（110 vs 24 / 原夹具 110 vs 186）、`anchorGainView`（原夹具 0 vs 14/55）。2.0 已用 AGS 几何（`memo_geometry` P0.2）取代 pairwise/intrinsic 派生表，而我方 builder 仍走旧路（证据：迁移副本上我方直接报 `no such table: tag_pair_similarity`）。**P0.2 的「几何不进读出链」不是终点——builder 侧必须接上几何先验，artifactSig 才可能收敛。**
2. **相似度口径**：`1/(1+L2²)` → `cosine`（一行 + 一条断言）。
3. **schema-v2 兼容**：builder 对 `tag_pair_similarity` 的硬依赖要去掉，否则连「等场」都造不出来（本次 F/G 两跑就是这么废的）。
4. **rerank 内部候选选取**（`selectedCandidates` 差 1–9）大概率是 1/2 的下游；等 1/2 收敛后复测，若仍差再看 `riverObservability`/`directAnchor`/`relativeTopology` 这些 2.0 rag_params 新增块（我方 `PipelineConfig` 目前没有这些字段——`topology`/`pathGeometry`/`candidateSuperset` 全未接线）。
5. **geometry 配置面**：我方 `PipelineConfig` 无 `geometry` 字段，AGS 只经独立 napi `runMemoGeometry` 暴露；2.0 的 pipeline 也不吃 geometry 配置 ⇒ 该项**当前不构成差异源**，但 builder 接线后会需要它。
6. **DTSC**：2.0 已删 `rerankMemoDtsc`，该读出永久不可比（对账器记 `bothAbsent`，不静默）。

## 7. 工具改动（我的写域，均已回归）

- `kernel/tools/track-driver.mjs`：`--config <rag_params.json>`（两侧同配置；缺省仍 VCP_ROOT 老路径，逐字不变）；扩展映射仅在有 `--config` 时启用（2.0 键名 `maxFieldProjectionNodes`、`spikeRouting`(含 v91* 别名→我方字段名)、`maxFusionTags/maxEmergentNodes/tech·normalTagThreshold/epaGateMode`，并显式补 `dynamicWormholes`——2.0 的 rag_params 里根本没这个键）。输出新增 `config` 块（路径/闸值/虫洞开关）供取证。
- `kernel/tools/diff-runner.mjs`：`--config` 透传；`--legs bucket:<名>` 单桶；`--classroom-db` / `--bucket-db` 夹具覆盖；**阶段级差异度量**（EPA/金字塔/融合/双场/enhanced/topo/Ω 的 maxΔ 与翻转计数，写入 `legs.json.meta.stages` 并出表，纯读数、不进 verdict）。
- 回归：缺省臂五腿 5/5 PASS、0 / 1.11e-16，与改造前一致（`diff-report/2026-10-21-18-13-/`）。

## 8. 复现命令

```bash
# 候选 = 02:06 构建的 /tmp 副本（含 P1.3；不碰已安装 .node）
cp kernel/target/release/libmemo_kernel.so /tmp/p2cand/memo-kernel.linux-x64-gnu.node

# P2 主测（2.0 配置 + 双闸开）
node kernel/tools/diff-runner.mjs --oracle /home/h/app/VCPToolBox-2.0/rust-vexus-lite \
  --candidate /tmp/p2cand/memo-kernel.linux-x64-gnu.node \
  --config /tmp/p2cfg/cfg-2.0-open.json --legs classroom,bucket:dsh-memo-river
# 等场版（剥净派生资产）
node kernel/tools/diff-runner.mjs ... --classroom-db /tmp/p2fix/classroom-stripped.sqlite --legs classroom
node kernel/tools/diff-runner.mjs ... --bucket-db /tmp/p2fix/bucket-stripped.sqlite --legs bucket:dsh-memo-river
```

配置件：`/tmp/p2cfg/cfg-2.0-open.json`（2.0 rag_params + `spikeRouting.dynamicWormholes=true`）、`/tmp/p2cfg/cfg-v92-open.json`（v9.2 rag_params + `effectiveSupport.maxProjectionNodes=256` + 虫洞开）。

## 9. 未解问题

1. builder 侧 inbound mass 的 2.0 语义未拆解（是否走 AGS 几何先验 / `kbm_runtime_meta` 的 derived 标记）——需 C 的 P0.2 接线后才能验证收敛。
2. `wormholeView` 我方在原夹具 186 条、剥净后 24 条，2.0 恒 110 条：**我方虫洞边集对派生资产高度敏感**，2.0 不敏感 ⇒ 边集生成口径根本不同（不是阈值差异）。
3. classroom 原始夹具的 EPA 不对称（见 §4d）应视为夹具缺陷，读数不作结论。
4. `--config` 下 gap："2.0 配置 vs v9.2 配置读数完全相同"这件事本身也值得一次反向验证（把 2.0 的 demo 数据换掉后再测），目前只有一组证据。
