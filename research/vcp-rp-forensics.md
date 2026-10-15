# VCPToolBox「残差金字塔（ResidualPyramid / RP）」独立取证报告

- 取证对象：`/home/h/app/VCPToolBox/`（本地节选副本，只读）
- 对照真件：`/home/h/app/VCPToolBox/rust-vexus-lite/`（napi-rs 原生实现）
- 取证日期：2026-10-15
- 方法：全文精读 ResidualPyramid.js（394 行）、result_deduplicator.rs（286 行）、EPAModule.js、TagMemoEngine.js 关键段、lib.rs/memo_pipeline.rs/memo_artifact_builder.rs/memo_dtsc.rs/memo_sensing.rs/rivermemo_topology_v3.rs/knowledge_runtime.rs 相关函数、rag_params.json、config.env.bak、docs/_rust_memo_kernel_reverse.md、sandbox/classroom-flow/run.log；全仓 grep 交叉验证。
- **副本完整性声明（影响若干结论的强度）**：本副本根目录只有 4 个 JS 文件（ResidualPyramid.js / TagMemoEngine.js / EPAModule.js / EmbeddingUtils.js）+ modules/knowledgeBase/ + tests/ + docs/ + sandbox/ + dailynote/。宿主类 KnowledgeBaseManager（`_getOrLoadDiaryIndex` / `applyTagBoostAsync` 的**定义者**）不在副本内，无 .git 历史。凡结论依赖「生产 JS 侧无调用者」，均限定为「本副本内未见」，宿主类是明示盲区。

---

## 总判决

> 委托方原话：「上游 RP 算的是『查询向量 ↔ tag 海』（新颖度 / 覆盖率），不是候选条目之间的去重；V9.1 的节点级『内生残差』也只用作锚增益（加权），不是过滤。」

**判定：主体成立，但有一个必须修正的隐含推论。**

- 前半句（RP 作用域）：**成立**。RP 的输入是单个查询向量，搜的是 tag 向量索引，作用域是「查询（及其逐层残差）↔ topK tag 子空间」，从头到尾不接触候选条目（ResidualPyramid.js 全文 0 处 chunk/candidate 引用）。
- 后半句（V9.1 内生残差只加权不过滤）：**成立**，且比委托方说的更彻底——JS 与 Rust 双侧、全部 6 个消费点逐一核实，全部是乘法加权/门控，零过滤；连 raw_residual_ratio 本体都在 artifact 构建时加载后即弃（`_raw_residuals` 下划线未用），payload 里的 `rawResidualRatioView` 硬编码为空数组。
- **必须修正的隐含推论**：如果委托方由此推出「上游没有候选条目之间的去重，所以把（任何）条目级去重迁过去都算新增量」——**这是错的**。上游有**条目（chunk）级语义去重**：`rust-vexus-lite/src/result_deduplicator.rs`，机制是**裸余弦阈值（缺省 0.92）贪心抑制**，经 `#[napi] search_diary_indices_deduplicated` / `execute_river_query` 暴露（本副本内仅 tests/ 调用，生产 JS 链路未见接线）。所以精确表述是：**上游已占住「条目级去重」这个功能位（余弦机制），没有的是「残差/正交投影机制用于条目去重」**。「残差机制迁到条目空间」仍是上游没有的东西，但必须作为「对既有余弦去重的机制升级」来论证增量，而不是「从无到有」。

---

## Q1. 数据流：analyze() 的输入、搜索对象、输出语义

**输入 = 单个查询向量（Float32Array）。**

- `ResidualPyramid.js:25` `analyze(queryVector)` —— 唯一入参。
- 调用点 `TagMemoEngine.js:994`：`const pyramid = this.residualPyramid.analyze(originalFloat32);` 其中 `originalFloat32` 是 `applyTagBoost(vector, ...)` 的查询向量本体（`TagMemoEngine.js:965`：`const originalFloat32 = vector instanceof Float32Array ? vector : new Float32Array(vector);`）。

**搜的是 tag 向量索引（tags 表的向量），用当前残差做查询：**

- `ResidualPyramid.js:53` `tagResults = this.tagIndex.search(currentResidual, this.config.topK);`（注释：「🚀 优化：直接传递 Float32Array，利用 napi-rs 的零拷贝特性」）
- `ResidualPyramid.js:354-360`（`_getTagVectors`）SQL：`SELECT id,name,vector FROM tags WHERE id IN (...)` —— 向量来自 **tags 表**，不是 chunks 表。
- 全文 grep：ResidualPyramid.js **零处**出现 chunk / candidate / 条目字样。

**输出四件套：**

- `levels[]`：每层 `{tags:[{id,name,similarity,contribution,handshakeMagnitude}], projectionMagnitude, residualMagnitude, residualEnergyRatio, energyExplained, handshakeFeatures}`。`contribution = basisCoefficients[i]`，即该 tag 正交基分量承载的投影系数绝对值（`ResidualPyramid.js:183-184`：`basisCoefficients[i] = Math.abs(coeff); // 记录绝对贡献`）。
- `totalExplainedEnergy`：`ResidualPyramid.js:29` 注释原文「被Tag解释的总能量比例 (0~1)」；逐层累加 `energyExplainedByLevel = (旧残差能量−新残差能量)/原始能量`（:80 附近）。
- `finalResidual`：最终残差向量（:30 注释「最终残差向量」；循环里 `currentResidual = residual; // 更新残差用于下一轮`，:110-112）。
- `features`（`_extractPyramidFeatures`，:317-352）：
  - `coverage = Math.min(1.0, pyramid.totalExplainedEnergy)`，注释原文「// 覆盖率 = 解释的总能量 (0~1)」
  - `novelty = (residualRatio * 0.7) + (directionalNovelty * 0.3)`，注释原文「// 真正的"新"，是现有的 Tag 解释不了的部分 (Residual Energy)」
  - `coherence = handshake.patternStrength`
  - `tagMemoActivation = coverage * coherence * (1 - (handshake?.noiseSignal || 0))`，注释原文「// 🌟 综合决策指标：是否激活 TagMemo 增强？」
  - `expansionSignal = novelty`

**Rust 镜像同构**：`rust-vexus-lite/src/memo_pipeline.rs:534-660` `analyze_pyramid` 与 JS 逐段对应——`index.search(&residual, pyramid_top_k)`（tag usearch 索引）、`orthogonal_projection`、`analyze_handshakes`、`if residual_energy / original_energy < config.min_energy_ratio { break; }`。`docs/_rust_memo_kernel_reverse.md:23` 也以数学式记录了同一语义（「Gram-Schmidt 正交投影 `orthogonal_projection:403`，系数 c_j=|⟨q,u_j⟩|；能量解释 e_l=(E_{l-1}-E_l)/E_0；残差比 < 0.1 停止」）。

## Q2. 谁消费输出、怎么消费

RP 输出**进入打分与向量融合，改变最终用于 ANN 检索的查询向量与 tag 权重**；不做任何候选过滤。消费点（`applyTagBoost` 内）：

1. **激活系数→融合强度**（TagMemoEngine.js:1005-1010）：
   ```js
   const activationMultiplier = actRange[0] + features.tagMemoActivation * (actRange[1] - actRange[0]);
   const dynamicBoostFactor = (logicDepth * (1 + resonanceBoost) / (1 + entropyPenalty * 0.5)) * activationMultiplier;
   const effectiveTagBoost = baseTagBoost * Math.max(boostRange[0], Math.min(boostRange[1], dynamicBoostFactor));
   ```
   → :1337-1346 `[6] 最终融合`：`fused[d] = (1 - alpha) * originalFloat32[d] + alpha * contextVec[d];`（`alpha = Math.min(1.0, effectiveTagBoost)`）→ **fused 即返回的新查询向量**。
2. **核心标签加权**（:1014-1017）：`const coreMetric = (logicDepth * 0.5) + ((1 - features.coverage) * 0.5);` → `dynamicCoreBoostFactor`（注释原文：「逻辑深度越高（意图明确）或覆盖率越低（新领域需要锚点），核心标签权重越高」）。
3. **逐层 tag 权重**（:1051-1101）：levels 展开收集 allTags，`adjustedWeight = (t.contribution||t.weight||0) * layerDecay(0.7^level) * langPenalty * coreBoost`（:1096 附近）——**RP 的 contribution 直接成为 tag 权重系数**。
4. **诊断回传**（:1395-1415）：`info.pyramid`（coverage/novelty/coherence/activation/depth/levels）作为返回值的一部分，供上层观测。
5. **生产接线**（modules/knowledgeBase/searchService.js）：`_searchSpecificIndex` 在 ANN 前 `await this.applyTagBoostAsync(new Float32Array(vector), tagBoost, ...)`（:146-152），结果 `results = idx.search(searchVecFloat, candidateK)`（:186）；`_searchSelectedIndices` 同构（:393）。即：**RP 在生产读链路上改写查询向量后进 ANN 搜索**。（`applyTagBoostAsync` 的定义在宿主类，不在本副本。）
6. Rust 侧同构消费在 `memo_pipeline.rs` `run_pipeline`（fuse_observation 等），由 `#[napi] run_memo_pipeline`（lib.rs:851）导出——本副本内仅 tests/ 调用。

## Q3. RP 的作用域：「查询 ↔ tag 海」还是别的？

**明确：是「查询向量（及其逐层残差）↔ tag 海」，且只与每层 topK≈10 个 tag 交互，不是候选条目空间。**

区分两种读法的代码证据：
- **输入侧**：`analyze(queryVector)` 单查询向量（:25）；`tagIndex.search(currentResidual, this.config.topK)`（:53）——搜索对象是 tag 索引；`_getTagVectors` 的 SQL 是 `SELECT id,name,vector FROM tags`（:354-360）。
- **投影侧**：`_computeOrthogonalProjection(currentResidual, rawTags)`（:69-71，注释原文「// 3. 🌟 核心修正：Gram-Schmidt 正交投影 // 计算当前残差在这些 Tag 张成的子空间上的精确投影」）——把**查询/残差**投影到 **tag 子空间**。
- **负证据**：ResidualPyramid.js 全文无 chunk/candidate 引用（grep 零命中）；searchService.js 的条目检索路径（idx.search 后的排序/rerank）无任何 残差/正交/ResidualPyramid 引用（grep 零命中）。
- 唯一容易误读的点：`_analyzeHandshakes` 里的 `pairwiseSim` 是「前 5 个**(query−tag_i) 差值方向**两两点积」（:287-297），看起来像"集合内两两比较"，但比较对象是**差值方向**（query 相对每个 tag 的偏移方向是否一致），不是候选条目之间的相似性。

## Q4. 仓库里有没有「候选条目之间」的残差/正交/去重机制？

分两半回答：

**残差/正交机制作用于候选条目之间：没有。** 全仓核对：
- ResidualPyramid.js：查询↔tag 子空间（见 Q3）。
- 内生残差（V9.1）：tag 节点↔其共现邻居基（lib.rs:2810-2963），写 tag_intrinsic_residuals 表，作用对象是 tag 图节点。
- EPAModule.js：查询↔全局 PCA 基（EPA 全文无 residual/intrinsic 引用，grep 证实）。
- searchService.js 条目链路、geodesic rerank：无正交/残差。
- **结论：上游不存在「条目向量间 Gram-Schmidt/残差扣除」的任何代码。这一半是干净的「无」。**

**候选条目之间的去重：有——这是对委托方前提的修正项。**
- `rust-vexus-lite/src/result_deduplicator.rs:152-274` `deduplicate(db_path, candidates, query, dimension, threshold, max_results)`：从 `chunks` 表批量取候选向量（:128-131 `SELECT id, vector FROM chunks WHERE id IN (...)`）；按「与 query 的余弦优先→候选分数→原始位置」排序（:193-211，注释原文「// 与 JS 参考实现一致：有效 Query 相似度优先，其次候选分数，最后原始位置。」）；贪心抑制：`if cosine(&descriptor, existing) >= threshold { redundant = true; suppressed += 1; break; }`（:237-241）；threshold 非法时缺省 **0.92**（:213-217）。**机制是裸余弦阈值，无 Gram-Schmidt、无残差扣除、无投影。**
- 接线：`knowledge_runtime.rs:525-556`（NativeMultiIndexAnnTask：candidate_k 候选池 → 语义去重 → 补足 final_k；:515 注释原文「// candidate_k 控制进入 hydrate/语义比较的候选池；final_k 只控制最终输出。// 二者分离后，高重复候选池可以从后续候选补足最终 Top-K。」）；`#[napi] search_diary_indices_deduplicated`（:961）、`execute_river_query`（:1140+，文档注释原文「多索引 ANN → Chunk ID 合并 → SQLite 批量向量 hydrate → 语义去重 → RiverMemo Topology V3」）、`execute_river_query_hybrid`。index.d.ts:196/203/211 有声明。
- **但生产 JS 未接线（本副本范围内）**：全仓 grep `searchDiaryIndicesDeduplicated|executeRiverQuery`，JS 生产代码（modules/、根 JS）零命中，仅 tests/ 引用；`rag_params.json` 的 `KnowledgeBaseManager.resultDeduplication.{semanticThreshold:0.92, finalSemanticThreshold:0.97}` 在 JS/Rust 源码中零消费者。docs/_rust_memo_kernel_reverse.md 对同类导出 `fuseMemoContext` 的判词是「仅 index.d.ts:277 声明，全仓无 JS 调用者」。宿主类不在本副本，无法终判生产是否经宿主走此路径——盲区已明示。
- 另有一处**tag 空间**（非条目空间）去重：TagMemoEngine.js:1256-1302 `[5.5] 语义去重 (Semantic Deduplication)`——注释原文「消除冗余标签(如委内瑞拉局势与委内瑞拉危机)，为多样性腾出空间」；`const dedupThreshold = config.deduplicationThreshold ?? 0.88; if (similarity > dedupThreshold)`（:1288-1289）→ 权重×0.2 合并进已选代表+继承 isCore。Rust 快速路径同构：memo_pipeline.rs:954-963（`deduplication_threshold: 0.88` 见 :163）。作用对象是候选 **tag**，不是候选条目。

## Q5. `_computeHandshakes` / `computeHandshakes` 的语义

**语义 = 查询向量与每个入选 tag 的差向量（能量幅值 + 单位方向），纯几何量，不是「残差毛刺扫描」。**

- JS（ResidualPyramid.js:244-266）：
  ```js
  delta[d] = query[d] - tagVec[d];   // 差向量
  magSq += delta[d] * delta[d];      // 能量
  dir[d] = delta[d] / mag;           // 单位方向
  ```
- Rust（lib.rs:1127-1188）`compute_handshakes`：`let diff = (q[d] - tag_vec[d]) as f64; delta[d] = diff; mag_sq += diff * diff;` 与 JS 逐行同构。
- 消费在 `_analyzeHandshakes`（:271-312）：`directionCoherence` = 差值方向的平均一致度，注释原文「// Coherence 高：Query 在所有 Tag 的"外部" (新领域) // Coherence 低：Query 被 Tag 包围在"中间" (已知领域的细节)」；`patternStrength` = 前 5 个差值方向两两 |dot| 的均值；`noveltySignal: directionCoherence`；`noiseSignal: (1 - directionCoherence) * (1 - avgPairwiseSim)`。
- 「能量差/毛刺扫描」的口播对应物：能量差≈差向量幅值（有代码）；「毛刺被扫描仪找到」≈ 下一层用残差重新 ANN 检索（:53 `search(currentResidual, topK)`）——是「拿残差去搜 tag 海」，不是「扫描毛刺」。

## Q6. RP 的基座从哪来；与 EPAModule 的性质差异

**RP 基座**：每层 `tagIndex.search(当前查询或残差, topK=10)` 召回的 10 个 tag 向量 → Modified Gram-Schmidt 正交化成局部基 → 查询在该子空间上的投影/残差。
- `ResidualPyramid.js:159` 注释原文「// 1. 构建正交基 (Modified Gram-Schmidt 算法，数值更稳定)」；逐个 tag 对已建基扣除（:166-173），归一化（:176-179），线性相关（模≈0）则 `basisCoefficients[i] = 0; // 该 Tag 线性相关，无独立贡献`（:186）；`residual = vector - projection`（:199-204）。Rust 快路径 lib.rs:1054-1125 同构（含 `basis_coefficients[i] = coeff.abs()`、`residual[d] = query[d] - projection[d]`）。
- 性质：**局部 / 在线 / 逐查询 / 逐层动态**——基随查询变、随层变，三层各自张基。

**EPAModule 基座**（EPAModule.js）：
- 全库 `SELECT id, name, vector FROM tags WHERE vector IS NOT NULL`（:41）→ 鲁棒 K-Means 聚类（:63）→ **加权中心化 PCA** `_computeWeightedPCA`（:66-68）→ 选主成分 K（≤ maxBasisDim=64，:9-16）→ `orthoBasis / basisMean / basisEnergies / basisLabels`（:73-77）→ 缓存复用（initialize 走 `_loadFromCache`，:44-47）。
- 投影强制去中心化，:89 注释原文「⚠️ 修正：必须先减去平均向量 (Centering)，否则投影没有统计意义」；Rust 快路径 `vexusIndex.project(vec, flattenedBasis, basisMean, K)`（:100-104）。
- 性质：**全局 / 离线（启动或重建时算一次）/ 语料级** PCA 主轴，与 RP 的查询级动态基完全不同轴。EPA 全文无 residual/intrinsic 引用——它与内生残差无涉。

## Q7. 参数与阈值：实际取值与来源

- **JS RP**（ResidualPyramid.js:8-16 构造缺省）：`maxLevels: config.maxLevels || 3`；`topK: config.topK || 10`；`minEnergyRatio: config.minEnergyRatio || 0.1`（注释原文「// 修正：使用能量阈值。0.1 表示当残差能量低于原始能量的 10% 时停止 (即解释了 90%)」）；`dimension: config.dimension || 3072`。
- **实例化**（TagMemoEngine.js:644-646）：`this.residualPyramid = new ResidualPyramid(this.tagIndex, this.db, { dimension })` —— **只传 dimension，maxLevels/topK/minEnergyRatio 全用代码缺省**。rag_params.json 中无任何金字塔键（grep maxLevels/minEnergyRatio 零命中）。
- **停止判据原文**（ResidualPyramid.js:113-115）：
  ```js
  if ((residualEnergy / originalEnergy) < this.config.minEnergyRatio) {
      break;
  }
  ```
  外层还有 `maxLevels` 层数上限与「ANN 空结果/Tag 空结果即 break」两个提前出口。
- **Rust 管线缺省**（memo_pipeline.rs:141-171 PipelineConfig::default）：`max_levels: 3`、`pyramid_top_k: 10`、`min_energy_ratio: 0.1`（运行时 clamp：`max_levels.clamp(1,8)`、`pyramid_top_k.clamp(1,128)`、`min_energy_ratio.clamp(0.0,1.0)`，见 :557-559 附近）；同一份缺省表里 `deduplication_threshold: 0.88`、`layer_decay: 0.7`、`activation_multiplier: [0.5,1.5]`、`dynamic_boost_range: [0.3,2.0]`、`core_boost_range: [1.2,1.4]`。
- **V9.1 映射参数**（rag_params.json → `KnowledgeBaseManager.intrinsicResidual`）：`maxBasis=4, v9AnchorBase=0.75, v9AnchorScale=1.25, v9AnchorGamma=1, v9AnchorMin=0.5, v9AnchorMax=2`；沙箱实跑印证（sandbox/classroom-flow/run.log:50）：`"method":"anchored_gs","maxNeighbors":48,"maxBasis":4,"minNeighbors":3,...,"v9AnchorBase":0.75,"v9AnchorScale":1.25,...`，实算 raw 残差范围 `raw_min=0.274379, raw_max=0.996440`（run.log:52）。
- **条目去重阈值**：rag_params.json `resultDeduplication.semanticThreshold=0.92`、`finalSemanticThreshold=0.97`（源码中零消费者）；result_deduplicator.rs 非法值兜底也是 0.92（:213-217）。tag 去重 `deduplicationThreshold=0.88`（rag_params.json + 代码缺省双源一致）。

## Q8. RP 是生产接线还是实验田？

**JS 侧：生产主链路。** 证据链：
1. searchService.js:146-152（`_searchSpecificIndex`）与 :393（`_searchSelectedIndices`）：`if (tagBoost > 0 && this.tagMemoEngine) { const boostResult = await this.applyTagBoostAsync(...) }` → 改写后的 `searchVecFloat` 进入 `idx.search(...)`（:186）。这是条目检索的正主路径。
2. TagMemoEngine.js:988-994：`applyTagBoost` 的链路注释原文「[1] EPA 分析 (逻辑深度与共振)…[2] 残差金字塔分析 (新颖度与覆盖率) - 90% 能量截断」+ `const pyramid = this.residualPyramid.analyze(originalFloat32);`——RP 是管线固定二级，无开关、无条件分支跳过。
3. 初始化固定挂载：TagMemoEngine.js:644-646。
（限定：`applyTagBoostAsync` 包装函数定义在宿主类，不在本副本；但 searchService.js 本身就是生产检索模块，其调用点构成主链路证据。）

**Rust 侧：导出齐全、本副本内仅 tests/ 调用。** `runMemoPipeline`（含 analyze_pyramid 全套）在 lib.rs:851 导出；JS 生产代码零调用（仅 tests/nativeMemoManifestCompatibility.test.js:135 等）。与条目去重导出同格局：**机制完整落地在原生层，JS 生产接线状态在本副本不可见**。

## Q9. 口播 vs 代码逐点对账

口播原文（委托方转述）：「直接计算查询向量和 tag 海里每一个 tag 之间的能量差……残差毛刺被扫描仪找到」。

| 口播成分 | 代码对账 | 判定 |
|---|---|---|
| 「查询向量和 tag 之间的能量差」 | `_computeHandshakes` 确实逐 tag 算 `query − tag_i` 的幅值（:244-266）；但这是**诊断特征**，主机制是投影（:69-72） | **部分成立**：差向量存在且有能量量纲；但被口播放大成了主机制，实际主角是 Gram-Schmidt 投影 + 能量记账 |
| 「tag 海里**每一个** tag」 | 每层只取 `search(currentResidual, topK=10)` 召回的 10 个（:53），三层最多 30 个 tag 参与运算；「每一个」不成立 | **口播夸张** |
| 「残差毛刺被扫描仪找到」 | 代码事实：每层结束把残差当新查询再 ANN 检索（:53 + :110-112 `currentResidual = residual`）——「拿残差去 tag 海里扫下一批」有代码支撑；「毛刺」无任何信号处理意义上的检测器 | **比喻部分成立**：「扫描」=残差再检索是真的；「毛刺检测」是修辞 |
| （隐含）这是某种筛选/去重 | RP 输出只调制权重与融合强度（Q2 五个消费点全是加权），不筛除任何候选 | **无代码支撑** |

## Q10. V9.1「节点级内生残差 r_i」的用法：锚增益（加权）还是过滤？

**判定：全部是锚增益/加权/门控，零过滤。JS 与 Rust 双侧一致。**

**计算侧**（rust lib.rs，写入 `tag_intrinsic_residuals` 表）：
- 每 tag 取共现图邻居（adjacency，:2820 附近），经 V8.2-γ 语义缓存做 `semantic_gate` 过滤（semantic<=0 剔除，:2826-2837），按 `weight*semantic` 降序截到 maxNeighbors=48，<minNeighbors=3 跳过（status=insufficient_neighbors，:2855-2858）。
- 三种方法（:2861-2866）：`AnchoredGs`（缺省）= 锚定贪心 Gram-Schmidt——`score = explain_gain * orth_norm * ln(1+coocWeight) * semantic` 选最优锚（:2353-2366），`best_gain < min_gain` 停（:2372-2374），`residual -= <residual,best_unit>*best_unit`（:2377-2380），返回 ‖residual‖；另有 `Centroid`（:2285-2317）与 `Svd`（:2398-2432，nalgebra）。
- `raw_residual_ratio = value.clamp(0.0, 1.0)`（:2872-2873，注释原文「// 输入已单位化且基底正交，理论范围为 [0,1]；夹逼仅吸收浮点误差。」）。
- **映射**（:2960-2963）：`v9_anchor_gain = (v9_anchor_base + v9_anchor_scale * raw_residual.powf(v9_anchor_gamma)).clamp(v9_anchor_min, v9_anchor_max)` = 0.75+1.25·r ∈ [0.5,2]，单调增——**残差越高（邻居越解释不了）增益越大**。注释原文（:2916-2918）：「// V9.1 单轨：原始 residual ratio 直接进入固定、数据库无关的锚增益映射。// 不再计算依赖全库分布的 V8.3 median/MAD 兼容增益」。

**消费侧（全部消费点清单）：**

| 消费点 | 代码 | 用法 |
|---|---|---|
| JS 传播核边构建 | TagMemoEngine.js:473-476 `const residual = residualMap?.get(targetId) ?? 1; const isWormhole = evidence * residual >= tensionThreshold; const rawConductance = evidence * (isWormhole ? wormholeGain : 1);` | 虫洞门控+边增益 |
| JS 脉冲传播 | TagMemoEngine.js:759-762 `const neighborResidual = queryResiduals?.get(neighborId) ?? 1.0; const tension = coocWeight * neighborResidual;` → wormhole 判定 | 门控 decay 路径 |
| Rust DTSC 读出 | memo_dtsc.rs:806-812 `let anchor = artifact.anchor_gain.get(&tag.id).copied().unwrap_or(1.0).clamp(0.5,2.0); let mass = (closure * anchor * positional * specificity).max(0.02);` | **乘法加权**（mass 进入 DTSC 曲线质量，影响读出强度，不删条目） |
| Rust 感知 | memo_sensing.rs:282-284 `let residual = artifact.anchor_gain.get(&target_id).copied().unwrap_or(1.0); ... conductance * residual >= config.tension_threshold` | 虫洞门控 |
| Rust artifact 构建 | memo_artifact_builder.rs:331 `dynamic_reverse *= anchor_gain[...]`；:385-386 虫洞式判定；:669-670 fact 矩阵/transport 均以 anchor_gain 为输入 | 边权标定 |
| Topology V3 | rivermemo_topology_v3.rs:308 字段 / :769-779 从 payload `anchorGainView` 解析 / :850 传入——**grep 全文件仅此 4 处，未见下游打分消费**（`anchor_bonus` 用的是 `anchor.strength`=clamp01(score*reliability)，:1865、:2388-2404，与内生残差无关） | 传递但（在该文件内）未消费 |

**过滤零证据**：
- 无任何「r_i 超阈值→剔除 tag/边/候选」的代码。缺行（insufficient_neighbors）时消费端 `?? 1.0`/`unwrap_or(1.0)` 取中性默认，不排除。
- `raw_residual_ratio` 本体在 artifact builder 加载后未用（memo_artifact_builder.rs:668 `let (anchor_gain, _raw_residuals, residual_sig) = load_anchor_gains(...)` —— 下划线变量）；payload 序列化里 `"rawResidualRatioView": []`（:646-647）**硬编码空数组**——只导出映射后的增益，不导出原始残差。
- JS 侧 bundle 发布（TagMemoEngine.js:611-616）：注释原文「// 明确物理量语义；residualMap 仅保留为旧调用兼容别名。」——字段改名都只朝「增益」语义收敛。

---

## 附：证据强度与盲区清单

1. **宿主类盲区**：KnowledgeBaseManager（`applyTagBoostAsync`/`_getOrLoadDiaryIndex` 定义）不在本副本；「Rust 导出件（runMemoPipeline / search_diary_indices_deduplicated / execute_river_query）在生产是否被宿主调用」无法在本副本内终判。但 searchService.js 是生产检索模块本体，其 `applyTagBoostAsync` 调用构成 RP 生产接线证据。
2. **无 git 历史**：无法考证 RP 的演进时间线（实验田→生产 or 反之）。
3. **口播无法独立核实**：Q9 只对照委托方转述的口播文本与代码，未看视频原片。
4. 沙箱 run.log（sandbox/classroom-flow/run.log:42-52）为 V9.1 内生残差管线提供了实跑配置与输出范围（raw∈[0.274, 0.996]，54 tags 全部 computed），佐证该管线可运行且产出全量 tag 行。

## 一句话判决（给委托方）

**成立（RP=查询↔tag 海、只产出新颖度/覆盖率特征进加权融合；V9.1 内生残差 JS+Rust 六个消费点全部是锚增益/门控，零过滤），但附带一个修正：上游已有条目（chunk）级语义去重（rust-vexus-lite result_deduplicator.rs，裸余弦 0.92 贪心抑制，napi 已导出、本副本内生产 JS 未接线）——「残差机制迁到条目空间做去重」是上游没有的机制，但「条目级去重」这个功能位上游已占，增量论证必须写成「机制升级」而非「从无到有」。**
