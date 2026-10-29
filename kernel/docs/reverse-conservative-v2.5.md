# RiverMemo conservative-topology-v2.5-confidence-rrf 逆向契约（P3 对齐基线 9aa1f67）

> 逆向对象：`/home/h/app/VCPToolBox-2.0`（git HEAD = `9aa1f67`，已钉 tag `p3-baseline-9aa1f67`，2026-10-29 01:46 merge PR#560）。
> 上代契约：本仓 `kernel/docs/reverse-topology-v3.md`（对齐基线 174a5e1，算法标识 `rivermemo.topology-v3.1`）。
> 本文行号全部指上游 9aa1f67 版源码；写法沿用上代契约（公式 + 常量 + 条件树 + 边界）。
> 上游只读铁律：本文档只描述、绝不改动上游任何文件。

## 0. 版本地图与模块清单

| 标识 | 值 | 出处 |
| :-- | :-- | :-- |
| 读出算法标识 | `rivermemo.conservative-topology-v2.5-confidence-rrf` | `rivermemo_topology_v3.rs:22` |
| 结果 schema | `rivermemo-topology-v3-native-result-v1`（**未变**） | `rivermemo_topology_v3.rs:21` |
| 管线算法标识 | `memo.conservative-topology-v2.2`（管线层未随读出版升级） | `memo_pipeline.rs:23` |
| 读出基线算法（回执） | `rivermemo.conservative-topology-v2.2` | `rivermemo_topology_v3.rs:3169` |
| Sense 算法标识 | `tagmemo.spike-v9.1-rust-shared`（未变） | `memo_sensing.rs:10` |
| 几何算法标识 | `unified_geometry_ags_t4_cached_reorth`（旧 `unified_geometry_ags_v2`） | `memo_geometry.rs:383` |
| 主题面缓存标识 | `ags-global-star-t4-cached-reorth` | `memo_geometry.rs:899` |

模块（行数）：`rivermemo_topology_v3.rs` 3891（旧 2897）、`rivermemo_wormhole.rs` 469（**新模块**）、`memo_pipeline.rs` 3100、`memo_sensing.rs` 1104、`memo_geometry.rs` 1346（旧 972）、`memo_projection.rs` 464（仅 1 常量变）、`memo_workspace.rs` 333（新：几何/建图共享 mmap 快照工作区）。

五连版时间线（`git log --oneline 174a5e1..9aa1f67`，中间夹无关提交）：
`4a3386b` stage1 safe readout/独占锚 → `6d57e0f` 显式种子落地/残差焦点点燃 → `6b98a21` ship v2.2 → `08ed1ed` 2.3fix → `a06e5fc` 2.4fix → `1ac7761` 2.5 大手术（topology 砍 1908 行重写、虫洞独立成模块）→ `4a2da0b` 2.5fix test2 → `3394bdc` refined global gate → `d941bdb` confidence RRF → `f14290a` 重写 README → `9aa1f67` merge。两阶段实验施工说明：`git show 4a3386b:docs/RIVERMEMO_TWO_STAGE_EXPERIMENT.md`（v2.2 施工史，文档已删）。

执行链总览（一次读出请求）：
1. **管线** `memo_pipeline.rs:1986` `run_pipeline_with_connection`：EPA 门控 → 残差金字塔（safe-stoploss）→ 显式核心解析 → 种子门控 → 动态虫洞上下文 → Spike 传播（sense_with_context）→ 观测融合（增强向量）→ 双场求解 + 流域投影 → 观测入 MemoRuntime（句柄复用）。
2. **读出** `rivermemo_topology_v3.rs:2702` `run_native_with_connection`：候选加载/权限过滤 → 七源超集选择 → 挂 Tag → 虫洞模型 build/gate/refine → 并行逐候选评估（场共振/路径/拓扑/锚）→ Ω → `assign_v3_scores` 四项记账 → 基线排序 → `wormhole::fuse_rrf` 条件式融合 → 终排序 → 取 top_k。

---

## 1. 评分方程 S = clip[0,1](B + P + G + A)

主公式（`assign_v3_scores` `rivermemo_topology_v3.rs:2556-2619`，逐候选独立记账）：

```
final_score = clamp01( pure_score + path_bonus + gated_bonus + anchor_bonus )
            = clamp01( B + P + G + A )
```

- **B（查询基础分 + 有界场共振）**＝`pure_score`，由 `field_resonance` `:1722-1742` 计算：
  - `query = clamp01(curve.query_score)`（查询向量×正文余弦，`:2816`）；
  - local/transfer 权重：仅当对应向量全部有限且 ‖v‖²>1e-12 才取 `pure_local_weight=0.2` / `pure_transfer_weight=0.1`，否则该场权重记 0；
  - `field = (0.2·clamp01(local_score) + 0.1·clamp01(transfer_score)) / 0.3`（无有效场时 `field = query`）；
  - `λ = total / (pure_query_weight + total)`，`pure_query_weight = 0.7`（语义读出权重 0.7/0.2/0.1）；
  - `gain = min( min(0.03, λ·[field−query]₊) · clamp01(support), 1−query )` —— **场共振先封顶 0.03 再乘支持度**，且永不把 B 抬过 1；
  - `B = query + gain`。无场向量时 `(B, field, 0) = (query, query, 0)`（测试 `:3746-3763`）。
  - `support = s_c = max(scalar_field_support(local_coverage, local_mean), scalar_field_support(transfer_coverage, transfer_mean))`，`scalar_field_support` `:1976-1983`：`C=min(1,cov/0.5)`，`V=min(1,pot/0.02)`，`s=max(√(C·V), 0.1·√(pot/(pot+0.02)))`（域主项或 0.1 尾项取大）。
- **P（路径奖励，不乘 Ω）**＝`path_bonus`，`:2956-2972`：
  ```
  Q_c(path_quality) 由 evaluate_path(:1523-1657) 得出（§1.1）
  U_c = clamp01(0.35·local_cov + 0.25·transfer_cov + 0.25·clamp01(local_pot) + 0.15·clamp01(transfer_pot))   (:2958-2964)
  topology_raw   = clamp01(0.625·path_quality + 0.375·U_c)
  path_reliab    = clamp01(path_quality / 0.15)            # topology_path_saturation
  topology_reliab= √(path_reliab · query_chunk_score)
  P = min(C_T · topology_raw · topology_reliab, C_T)       # C_T=0.08
  ```
- **G（候选自身图证据，乘 Ω）**＝`gated_bonus`：
  ```
  g_c(graph_score) = 形态加权混合(:2973-2982)：
      atomic       = 0.75·node_graph_score + 0.25·edge_graph_score
      propositional= 0.25·node_graph + 0.75·edge_graph
      narrative    = 0.15·node_graph + 0.85·edge_graph
      graph_score  = clamp01(Σ morphology_weight_i · score_i)   # 权重来自 §1.2 查询形态学
  χ_b(branch_confidence) = √(branch_coverage · clamp01(mean_closure) · clamp01(node_alignment_score))   (:1717-1720)
  δ_c(direction)  = matched_edges>0 ? 0.25+0.75·direction_score : 0.25                              (:2586-2588)
  π_c(precision_grounding) = (exact==0 且 strongest_quality<0.65) ? 0.65 : 1.0                       (:1709-1713)
  v2_bonus = min(C_T · g_c · χ_b · δ_c · π_c, C_T)                                                  (:2589-2591)
  G = min(v2_bonus · Ω^γ, [C_T − P]₊)                                                               (:2615-2616)
  ```
  **共享预算：P + G ≤ C_T = 0.08**（不变量测试 `:3878`）。角色不乘任何倍率（"candidate-self-no-role-multiplier" `:3189`）；加无关候选不改变既有候选奖励（池不变性测试 `:3864-3881`）；旧 reliability 不再重复乘入（`:3831-3834`）。
- **A（直接锚奖励，不乘 Ω，独立上限）**＝`anchor_bonus`：
  ```
  activation = anchor.strength ≤ 0.05 ? 0
             : smoothstep( (strength − 0.05) / (0.20 − 0.05) )      # t²(3−2t)
  A = 0.10 · activation                                             # C_A=0.10, τ_A=0.05, s_A=0.20   (:2598-2609)
  ```
  绝对激活阈值——与同伴无关（测试 `:3652-3666`）。

### 1.1 路径质量 evaluate_path（`:1523-1657`）

段（Span-1/Span-2）枚举：`start=0..len−2`，`span∈{1,2}`；相同端点对（min,max 归一，含反向）只计一次 `used_relations`。
- `local_potential = √(L(t_i)·L(t_j))`、`transfer_potential = √(T(t_i)·T(t_j))`（场读数除以本场最大值归一，`normalize_field :1480-1503`）；
- `direction = f>0 ? clamp01(forward/(forward+reverse)) : direction_floor(0.05)`（全局 CSR 边权）；
- `continuity = clamp01(0.5·semantic_continuity + 0.5·field_continuity)`，semantic=clamp01((cos(v_i,v_j)+1)/2)，field=√(max场势_i·max场势_j)；
- `supported`：两端同属至少一场有效域 且 CSR 有正权边（`forward>0 ∨ reverse>0`）；
- `activity_gain = 0.5 + 0.5·√active`（active=请求河网实际边流，仅全局连接无实测流时 0.5）；`span_gain = span==2 ? 0.7 : 1.0`；
- `quality = supported ? clamp01(potential · √direction · √continuity · activity_gain · span_gain) : 0`；active>0 时 direction 用实测流向前向占比替代静态 direction（`:1580-1587`）；
- `path_core = quality_mass/段数`；`tag_closure = mean((chunk_cosine − closure_floor)/(1 − closure_floor))`，closure_floor=0；
- **`path_quality = clamp01(path_core · (0.5 + 0.25·support_coverage + 0.25·tag_closure))`**；
- 单标签退化：`path_core = max(L,T)·0.5`（`:1626-1636`）。

### 1.2 查询形态学 compute_query_morphology（`:2246-2473`，未随版本变，但 G 项消费方式变）

特征：effective_depth=1−exp(−加权hop/1.75)；shallow_energy_ratio(hop≤1)；energy_concentration=归一 HHI；chainness=chain_fit·√forward_ratio·(0.35+0.65·depth)·(1−0.5·branching)；三 logit（atomic 1.45·shallow+0.9·concentration−1.25·depth−0.65·growth−0.45·chainness 等，`:2422-2434`）经 softmax(T=1.0) 再与先验 1/3 按 confidence 混合（confidence=√((1−e^{−n/8})(1−e^{−m/8}))·完整观测系数）。dominant_mode=atomic|propositional|narrative。

### 1.3 Ω（`compute_omega :2490-2554`，公式同旧版）

`Ω_E = clamp01(edges/(κ_E·seeds))`、κ_E=0.5；`Ω_N = clamp01(emergent/(κ_R·seeds))`、κ_R=0.3；`Ω_F` = 正边流归一熵（单边 0.5）；`Ω = clamp01(cbrt(max(Ω_E,ε)·max(Ω_N,ε)·max(Ω_F,ε)) · 观测系数)`，ε=0.02，观测系数 完整=1 / 非完整=0.5；regime：<0.12 collapsed、<0.45 sparse、否则 dense。
**新语义（README §6.3）：Ω 只门控 G，不门控 P/A**；空图 Ω 不必为 0（ε 底值），但无结构证据时 G 仍为 0。

### 1.4 retiredControls 回执（`:3190-3193`，共 11 项）

```
["conditionalBandwidth","conditionalClosureBandwidth","conditionalDirectBandwidth",
 "minimumPeers","minimumEffectivePeers","innovationConfidenceZ","innovationScale",
 "anchorActivationZ","anchorFrontierContrast","anchorFrontierAbsFloor",
 "reliabilitySeedSaturation"]
```
语义：旧 topology-v3.1 的**条件同伴创新核**（同伴核带宽 0.04/0.1/0.12、minimum_peers=3、innovation z-score、批级锚异常/前沿控制、种子饱和可靠性）整体退役——这些键在 `NativeConfig :371-423` 仍解析（兼容读取），但**不参与任何奖励计算**。移植时保留字段解析、删除消费路径即可。`rag_params.json` 的 `topology` 段仍带这些旧键（供回滚），同样无效。

### 1.5 NativeConfig 全默认值（`:371-423`，48 项；★=与 174a5e1 默认不同）

```
query_k=100  denoised_k=100  local_field_k=100  transfer_field_k=100
bm25_k=50  anchor_k=50  max_union_candidates=300
local_weight=0.6  transfer_weight=0.4  direction_floor=0.05  closure_floor=0.0
semantic_node_threshold=0.48  relative_distance_temperature=0.35  reverse_direction_credit=0.25
minimum_river_edge_flow=0.015  maximum_river_edges=96  node_only_reliability_cap=0.2
kappa_edge=0.5  kappa_ratio=0.3  omega_epsilon=0.02  collapsed_threshold=0.12  sparse_threshold=0.45
semantic_anchor_threshold=0.88 ★(旧默认0.8；且代码硬下限 max(threshold,0.88) 见 :2091/:2160——
                              rag_params 传 0.8 也会被抬到 0.88)
semantic_anchor_discount=0.7  specificity_floor=0.35  rarity_floor=0.15
reliability_seed_saturation=2.0(退役)  fallback_reliability_cap=0.5
pure_query_weight=0.7 ★(旧0.25)  pure_local_weight=0.2  pure_transfer_weight=0.1 ★(旧0.15)
topology_bonus_cap=0.08  topology_path_saturation=0.15
conditional_bandwidth=0.04 …(退役10项同旧值)…
omega_gamma=1.0  struct_role_min_omega=0.12
anchor_bonus_cap=0.1  anchor_activation_z=2.0(退役)  anchor_activation_floor=0.05
anchor_saturation=0.2  anchor_frontier_contrast=2.0(退役)  anchor_frontier_abs_floor=0.1(退役)
```

### 1.6 候选超集与排序（`select_superset :1369-1468`，未变）

七源：query_knn/denoised_field_knn/local_field_knn/transfer_field_knn/bm25/time(取 query_k)/anchor_direct；源内 min-max 归一（spread≤1e-12 → 1/rank）；`union_score = clamp01(0.5·max + 0.25·mean + 0.25·clamp01(20·Σ1/(60+rank)) + min(0.05·(源数−1), 0.2))`；排序：源数 desc → union_score desc → id asc；截断 300。基线终排序（fuse 前）：final_score desc → union_score desc → union_rank asc（`:3007-3020`）。

### 1.7 角色（`assign_v3_scores :2563-2580`，判据换代）

```
mode=="atomic"                          → atomic_concept
closure≥0.55 ∧ anchor.explicit_exact_contacts>0 → direct_answer     # 须真实显式精确接触
structural = cbrt(edge_coverage·reliability·closure) ≥ 0.35          → structural_explanation
其余                                     → thematic_neighbor
Ω<0.12 时 structural_explanation 降级 thematic_neighbor(:2610-2614)
```
角色只解释证据、不分配奖励（`graphReward: candidate-self-no-role-multiplier`）。

### 1.8 直接锚 compute_anchors（`:2075-2204`）

- 资格种子：`direct_ids = hop==0 ∧ source_type∈{core,lexical_seed,seed}`（`:2854-2862`）；无显式种子时 fallback=全部 source_field，可靠性封顶 0.5（`fallback_reliability_cap`）。种子预过滤：`mass ≥ max_seed·0.2` 或 属 core_ids（core/lexical_seed 显式豁免）（`:2882-2886`）。
- 接触（`anchor_contacts :2075-2110`）：精确 id 或 余弦 ≥ `max(semantic_anchor_threshold, 0.88)`；**先枚举全部边再贪心分配**（精确接触保留双端点）；每候选最多 **3** 个接触。
- 每接触贡献：`clamp01(normalized_mass · specificity · chunk_cosine · rarity · match_weight · grounding_gain)`：
  - normalized_mass：显式最大种子质量归一（无显式才用全体最大，显式归一独立于候选命中 `:3635-3637`）；
  - specificity = max(0.35, 1−√(inbound/max_inbound))（全局图入度）；rarity = max(0.15, specificity)；
  - match_weight：精确=1；语义=0.7·clamp01((sim−0.88)/(1−0.88))（超阈比例连续计权×折扣 0.7）；
  - grounding_gain：非显式（implicit）接触永久 ×0.35（`:2163-2165`）。
- noisy-OR：`score = 1−Π(1−contribution)`。
- 可靠性：`√mean_closure × (有精确接触 ? 1 : 0.7)`；fallback 再 ≤0.5；**纯隐式候选（implicit_only）可靠性 ≤0.35、strength=clamp01(score·reliability) ≤0.035**（低于激活阈 0.05，默认拿不到 A）。
- strength ≤ 0.035 < τ_A=0.05 ⇒ 隐式锚默认零奖励（测试 `:3610-3638`）。

---

## 2. safe-stoploss 金字塔（`memo_pipeline.rs`）

### 2.1 层接受/止损（`analyze_pyramid_with_pool :651-795`）

每层：残差向量 `search_sql` Top-K=10（clamp 1..128）→ **先过滤图外标签再正交投影**（eligible=artifact.node_index，图内无出边节点仍合格，不补位 `:690-693`）→ 读 SQL 原始向量（索引只供 id）→ Gram-Schmidt 投影。
- `contribution = coefficient / ‖residual‖`（`:721`）；
- `energy_explained = [‖r_l‖² − ‖r_{l+1}‖²]₊ / ‖q‖²`；**`energy_explained < 0.03`（min_layer_explained_energy）→ 拒绝该层且不发布其标签/残差**（`:729-731`）；
- `residual_energy/original_energy < 0.1`（min_energy_ratio）→ 停止（`:756`）；
- `max_levels=3`（clamp 1..8）；原查询能量 ≤1e-12 → 全空返回（novelty=1）。

### 2.2 种子门控 gate_tags_for_graph（`:924-1074`）

动态增益：`effective_boost = 0.6 · dynamic_factor · clamp([0.3,2.0])`，dynamic_factor=logic_depth·(1+ln(1+resonance))/(1+0.5·entropy)·activation_multiplier（`:930-940`）；`dynamic_core_boost = 1.2 + core_metric·0.2`，core_metric=0.5·logic_depth+0.5·(1−coverage)（`:942-945`）。

逐层逐标签（`:961-1057`）：
- **贡献门槛**：`threshold = max(同层最大贡献 × 0.10, 0.05)`（seed_contribution_ratio/floor）；普通非核心标签须 `contribution ≥ threshold ∧ similarity > 0`，否则丢弃；
- **字面豁免**：`lexical_grounding ≥ 0.5`（查询/标签名的小写词元交集占比；ASCII 连续词元、CJK 相邻双字＋单字，`lexical_tokens :808-829`）→ 豁免贡献门槛，且 `effective = max(contribution, 0.6·sponsor, 0.6·maximum)`，非核心字面标签权重 ×1.6，层衰减豁免（layer_gain=1）（`:976-977, :1006-1008, :1042-1046`）；
- **赞助者（sponsor）**：同层已达门槛且 similarity>0 的同伴，与目标余弦 ≥0.80，sponsor=contribution·tightness 取最大（`:980-985`）；alias=目标 similarity≥0.20 ∧ sponsor>0 → `effective = max(contribution, 0.6·sponsor·clamp(sim,0.2,1))`；
- **强贡献标签减层衰减**：`layer_gain = decay + (1−decay)·independent_support`，decay=0.7^level，independent_support=clamp01(effective/同层最大)——贡献越接近层最大、衰减越轻（恢复不放大，`:1039-1044`）；
- 权重：`weight = clamp01ᶜᵒʳᵉ( effective·layer_gain·language_gain·core_gain·(lexical∧¬core?1.6:1) )`，非核心封顶 1.0，核心不封顶；core_gain=dynamic_core_boost·(0.95+0.1·relevance)（`:1019-1047`）；
- **共线冗余保护**：dominant=首标签 `contribution²>0.85 ∧ similarity>0`；冗余标签条件=非核心非字面 ∧ contribution<1e-6 ∧ similarity≥0.75 ∧ 与首项余弦≥0.90；**至多保护 2 个**（redundancy_slots=2），每个借 `min(0.15·c₁·clamp(sim₁/sim)·clamp(cos), redundancy_left)`，总借额 ≤0.3·c₁（首项贡献 30%）；额度用尽的同类标签直接丢弃（`:965-1001`）；
- **显式核心**：核心名（含显式解析出的 SQL id）若已在门控集中则提升 is_core 且 weight≥dynamic_core_boost，否则以 dynamic_core_boost 直接入列——空金字塔也能点燃显式核心（`:1059-1071`）；
- **隐式种子等比例缩放**（`scale_implicit_seeds :874-886`）：存在显式（core/lexical 且图内）时，若最大隐式权重 > 0.35×显式最大权重，全体隐式 ×（0.35·显式最大/隐式最大）——**显式最大 0.35 倍**上限；图外显式不参与基准。
- 语言惩罚：技术名（ASCII、>3 字符）在非技术世界域时 gain=penalty（unknown 0.05 / 跨域 0.2，人文域取 √）（`:1024-1038`）。

种子类型映射（`:2043-2056`）：is_core→`core`、lexical→`lexical_seed`、其余→`seed`；energy=weight。

### 2.3 尾残差路由条件（`:761-768`）

动态虫洞开启时：每个**已接受层**保留投影前残差；全部层完成后，若 `尾残差能量 > 1e-12` 且 `尾残差/原查询能量 ≥ 0.02` → 追加为最后一个路由输入（共 L 或 L+1 个）；**只供选边、不加层**。被拒层不贡献残差。

### 2.4 PipelineConfig 全默认（`:142-177`）

```
base_tag_boost=0.6  core_boost_factor=1.33  local_alpha=0.15  transfer_alpha=0.55
field_max_iterations=80  local_tolerance=1e-9  transfer_tolerance=1e-9
local_mass_ratio=0.8  transfer_mass_ratio=0.9  max_field_projection_nodes=256
max_levels=3  pyramid_top_k=10  min_energy_ratio=0.1  layer_decay=0.7
min_layer_explained_energy=0.03  seed_contribution_ratio=0.1  seed_contribution_floor=0.05
activation_multiplier=[0.5,1.5]  dynamic_boost_range=[0.3,2.0]  core_boost_range=[1.2,1.4]
lang_confidence_enabled=true  lang_penalty_unknown=0.05  lang_penalty_cross_domain=0.2
deduplication_threshold=0.88  max_fusion_tags=128  max_emergent_nodes=50
tech_tag_threshold=0.08  normal_tag_threshold=0.015  epa_gate_mode="backgroundRelative"
spike_routing=SenseConfig::default()（§3）
```

EPA（`analyze_epa_with_mode :306`，`calibrated_gate :254-264`）：r_Q=Σ⟨x,b_k⟩²/‖x‖²（k≤k_sem=8）；b_iso=(k_sem/d + Σ⟨μ,b_k⟩²)/(1+‖μ‖²)（`decode_epa_basis :285-306`）；backgroundRelative 门 `gated = baseline≤background+1e-8 ? 0 : clamp01((r_Q−background)/(baseline−background))`；逻辑深度=(1−H_Q)·g_Q。EPA 缓存行进程级复用（raw+dimension 相同才复用）。

---

## 3. Sense 与请求级动态虫洞（`memo_sensing.rs`）

### 3.1 SenseConfig 默认（`:75-100`，19 项）

```
max_safe_hops=4  base_momentum=2.0  firing_threshold=0.10  base_decay=0.25
wormhole_decay=0.70  tension_threshold=1.0  max_neighbors_per_node=20
return_flow_factor=0.15  fir_gamma=0.6  max_propagation_states=2000
minimum_injected_current=0.01  max_output_nodes=0(不截断)  max_output_edges=0
max_transition_records=0  dynamic_wormholes=true  dynamic_wormhole_threshold=0.2
dynamic_wormhole_slots=2  dynamic_wormhole_max_targets=4096
```

### 3.2 传播规则（`sense_with_context :385-849`）

- 种子准入：id>0、能量有限>0；图中不存在的种子计 missing（显式 core/lexical_seed 单独上报）；重复种子能量合并；状态键=(previous_index, node_index)。
- **发火**：`energy ≥ 0.10 ∧ momentum ≥ 0` 才传播；动量初始 2.0，**普通跳 −1、虫洞跳 −0**；`momentum<0 ∧ ¬wormhole` → 该状态停止（软非回溯）。
- **注入电流**：`injected = energy · conductance · decay · (immediate_return ? 0.15 : 1)`，decay=普通 0.25/虫洞 0.70；immediate_return=目标恰为该状态前驱；**`injected < 0.01`（minimum_injected_current）→ 丢弃**；回流被抑制的质量计入诊断。
- 虫洞判定：`dynamic_wormhole标记 ∨ 持久化边标记 ∨ conductance·anchor_gain ≥ 1.0`（tension_threshold）。
- 邻居名额：普通路径取 CSR 行内**正权重前缀前 20 个**（行按权重 desc、同权 id asc 预排序）。
- FIR 累计：`a_h = γ^h / Σγ^r`（γ=0.6，clamp [0.05,0.95]，h=0..4）（`:251-263`）；节点累计能量 `E = Σ_h a_h·e^(h)`；**零跳种子只按 weights[0] 计入**（hop 循环内 `:707-711`）。累计能量≥最低电流才继续下一跳。
- 状态上限：每跳后状态数 >2000（min 100）按能量 desc、(prev,node) asc 截断；被截目的地对应的转移记录剔除（确定性测试 `:1058-1071`：不同 hash 种子位级一致）。
- 输出：normalized_energy=能量/最大节点能量；normalized_flow=flow/最大边流；source_field=节点能量/总质量。

### 3.3 动态虫洞（`DynamicWormholeContext :281-374` + 主循环 `:492-528`）

- 残差来源：§2.3 的 L(+1) 个路由残差；`seed_levels`=种子首次出现的金字塔层（`:2060-2063`）；状态 residual_level 继承来源层（合并取最早）。
- **共鸣**：`R(j|L) = max_{layer>L} cos(residual_layer, v_j)`（正余弦、截到 1，`:339-359, :369-373`）；金字塔曾算过的 (layer,id) 相似度经 `reuse_score` 请求级复用（`:2069-2071`）。
- 候选边：源状态发火 ∧ `residual_level+1 < 残差数`，扫**完整 CSR 出边行**（非静态 Top-K）；`resonance ≤ 0 或 < 0.2（dynamic_wormhole_threshold）` → 丢弃；**预筛先按虫洞衰减+回流惩罚算最低电流，不达标不占席位**（`:499-507`）。
- **动态排名 = conductance · resonance⁴**（R^4 选边），desc 排序取前 **2**（dynamic_wormhole_slots）个动态席位——**包含在 20 个邻居名额内**；余下席位按静态权重顺序补齐（`:510-524`）。
- **评估预算 4096**：请求内不同目标向量总数上限（dynamic_wormhole_max_targets）；超预算只跳过相应目标的动态判定，静态路径不受影响（`:327-329`）。
- 电流：动态边注入按 `energy·conductance·wormhole_decay(0.70)·回流惩罚`——无保底、无重归一、无额外增益；诊断区分 candidates/selected/fired/promoted(静态 Top-K 外提升)。

---

## 4. 双场求解与流域投影（`memo_pipeline.rs` + `memo_projection.rs`）

### 4.1 双场迭代（`solve_dual_fields_with_pool :1776-1917`）

- 源：观测 source_field 归一化到质量和 1；
- 迭代：`u ← (1−α)·S + α·T(u)`（T=共享传输 CSR 正权邻接，`apply_transport_pair :1394` 一遍服务双场）；**局部 α_L=0.15、迁移 α_T=0.55**；max 80 轮；L1 残差 ≤ 1e-9（tolerance，下限 clamp 1e-15）即收敛；一场收敛后不再更新。
- **有效域**（`effective_domain :1446-1479`）：按场质量 desc 累计至占比 ≥ 阈值——局部 **0.8**、迁移 **0.9**。
- 标量保留（`:1871-1878`）：`mass ≥ max·1e-12` 或属于（两域并集 ∪ 河网节点）——标量域不随投影 K 截断。
- **流域投影 K=256**（max_field_projection_nodes）：约束**两场选点去重并集**（含全部核心骨架），非每场 256。选点=`memo_projection::grow`（多源 BFS 流域森林，负对数传输率为距离）；每"流域×场"通道轮转 **2** 个外圈机会、每批 ≤4；全局处理 8192 出队状态 / 发现 8192 状态 / 扫描 65536 边；`memo_projection.rs` 常量 **RESERVED=2（旧 8，P3 必改）**、STATE_LIMIT=8192、EDGE_LIMIT=65536、BATCH=4（`:8-11`）。正预算 < 核心骨架 → 显式 `MEMO_PROJECTION_CORE_EXCEEDS_BUDGET` 错误。
- **温和入度折减**（`project_basin_fields :1739-1743`）：`projection_gain = 河网节点 ? 1.0 : 1/(1+√(inbound/maxInbound))`——只作用投影加权，不改标量场、不动河网核心。
- 投影向量 = Σ v·mass·gain / projected_mass，再归一化。

---

## 5. 虫洞通道 rivermemo_wormhole.rs（strict-global-gate / explanation-weighted-RRF / untouched-baseline-channel）

管线接入（`rivermemo_topology_v3.rs:2903-2905`）：`build → gate → refine`；基线排序后 `fuse_rrf`（`:3021`）。

### 5.1 路线资格 build（`:141-179`）

分母=**原始观测全体边最大正电流**（非候选池统计）；路线=河网观测中 wormhole=true 的边，须同时满足：非即时回流、source≠target、id>0、flow>0、**CSR 真实正权边**（artifact.edge_weight>0）、目标向量有限且 ‖v‖²>1e-15；同向端点对留最大电流；`relative_flow = clamp01(flow/max)`；按 flow desc 排序截 `maximum_river_edges=96`；eligible_routes=截断前条数。

### 5.2 严格全局门控 gate+refine（`:33-124`）

两段式，全部拒则该路线出局：
1. **gate（:33-57）**：`SELECT DISTINCT file_id` 同时含来源、终点两标签的文件 ≥ **2 个不同文件**（全局 file_tags 图，与候选/检索范围无关；同文件多行只算一个）。
2. **refine（:59-124）**：FILE_LIMIT=128、TAG_LIMIT=128（各读 129 探测超限，**任一超限即 truncated → 拒**）；对文件对 (a,b) 要求：校验和均非空且**互不相同**（相同内容不算独立见证）；存在第三标签 bridge=两文件共享、且 ∉ {路线两端} ∪ 显式焦点集（hop=0 的 core/lexical_seed）；存在另一显式焦点 anchor（≠两端）出现在至少一个见证文件中。witness JSON 记入诊断；`different checksums do not prove independence` 是作者自注。
门控模式回执（`:3160`）：`global-two-joint-files-distinct-checksums-third-tag-explicit-focus`。

### 5.3 强路线评分 correction（`:224-251`）

前置：`complete_observation ∧ Ω>0`；路线须 `relative_flow ≥ 0.5`（wormholeStrongFlowRatio，**原始观测分母，准入后不重归一**）且 source ∈ 显式焦点集；候选正文余弦 body=clamp01(cos(v_target, chunk))>0；候选标签须精确命中目标 id（相似度按 1 过检）或与目标余弦 > semantic_node_threshold(0.48) 且该标签 chunk_cosine>0（取最大相似度标签）。
**`E_e(c) = relative_flow · body · Ω^γ`**（evidence，落地证据）。

### 5.4 confidence-RRF 融合 fuse_rrf（`:415-469`）

```
K = 60.0
f_ref = max(非虫洞 ∧ 非即时回流 ∧ 非自环 普通边正电流)；无普通边 → max(全体边正电流)
对每条路线 e：
    对全部候选算 correction → 有资格者按 evidence desc 排名 re = 1,2,…
    w_e = (f_e / f_ref) · Ω^γ                          # 可 >1
    contribution_e(c) = w_e / (K + re(c))
若 ∃c: contribution > 0（active）：
    final(c) = 1/(K + r0(c)) + max_e contribution_e(c)   # r0=完整基线排序名次(从1起)
否则：final(c) 逐位不变（不转 RRF）
```
- **untouched-baseline-channel**：基线四项 B+P+G+A 的任何分量不被 RRF 改写；`scoreClipping` 相对基线记账（`:3108-3110` = B+P+G+A − trace.baselineScore）；多路线取 max 不相加；融合后再按 final_score 稳定排序（平分保留基线顺序，`:3023`）。
- trace 字段（`:445-466`）：active/k/baselineRank/baselineScore/baselineContribution/wormholeContribution/winner{sourceId,targetId,flow,relativeFlow,referenceFlow,weight,routeRank,contribution,grounding}/fusedScore/referenceMode。
- `parameters` 回执（`:3165-3168`）：`wormholeScoring="strict-global-gate; explanation-weighted-RRF; untouched-baseline-channel"`、`wormholeRrfK=60`、`wormholeStrongFlowRatio=0.5`、`wormholeWeightReference=…`。
- 旧辅助通道 `evaluate/augment`（`:181-270`）仍在（只测试用）：augment 只能在 [gated, C_T−P] 内**抬高** gated_bonus，不改其他项——生产主链已全部走 fuse_rrf。

---

## 6. AGS 几何变化（memo_geometry.rs 972→1346，+581/−208，4 提交）

**结论：数学默认值全部未变，变的是数值内核、缓存与工作区。**

### 6.1 内核替换（提交 744a698/b81d2e6）

- 旧（174a5e1）：`gram_gs` + `select_axes_lazy`——Gram 空间增量正交化（系数即轴，LAZY_GRAM_DIAGONAL_LIMIT=1e150 惰性列），O(K·n²) 投影不触维度。
- 新：`direct_axes_core :167-326`——**原空间**贪心选轴：
  - 选点分：局部 `|⟨t,u_i⟩|·p_i`（u_i=扣除已选基后的残差方向），全局 `‖u_i‖²·p_i`；同分按 Tag ID 升序；
  - **两遍重正交化**：`orthogonal_residual_with_projections :96-139`——首遍消元直接复用缓存投影系数（零点积），第二遍 4 轴分块 CGS 再正交；**估计剩余能量 ≤ 1e-3×原能量（严重相消）或缓存缺失 → 回退两遍逐轴 MGS2**（`orthogonal_residual :77-91`，dot_exact 保 tie-break）；评分阶段 `norm_sq ≤ 1e-8·diagonal` → 重算原空间残差（`:239-247`）；
  - 增量标量累计（proj_sq_sum/proj_target_sum）保持 IEEE 左折叠加法序，位级可复现；
  - 数值阈：正交范数 ≤1e-6 不入基；目标残差能量 <1e-14×原能量报零。
- **锚增益有界映射（写库值，公式未变）**：`gain = clamp[0.5, 2.0](0.75 + 1.25 · r_t^1.0)`（base/scale/gamma/min/max；`:905-910, :939-940`）→ `tag_intrinsic_residuals.v9_anchor_gain`；r_t=局部 Explain 残差范数（clamp 0..1）。
- **星团方向混合 0.8（公式未变）**：`star_direction :393-409`——`dir = (1−mix)·(target−mean) + Σ mix·wᵢ/Σw·(vᵢ−mean)`，归一化失败退 target−mean；mix=starMix=0.8（candidateMode=star 时；anchor 模式 0）。

### 6.2 性能/架构变化（提交 08c155d/45c9c3a）

- `UnitVectorWorkspace :445-572`：构建期一次性 mmap f64 单位向量快照（临时文件、Unix unlinked、Windows delete-on-close），Rayon 只借 mapped 切片；
- `memo_workspace.rs`（新 333 行）：几何与建图（memo_artifact_builder）**共享同快照向量工作区**（SnapshotKey + handoff.offer）；
- 每个 Tag 向量只读一次、同一对 Tag 语义增益只算一次；`read_unit_vectors` 按 128/批；
- 邻接预过滤+预排序（max_keep=max(48,starNeighbors) 截一次），支持度仍对完整共现邻居求和；
- 签名公式未变：`hash(ALGORITHM|dimensions|model_sig|config_hash|content)`——**ALGORITHM 变更（v2→t4_cached_reorth）会使签名变化、触发几何重建**。

### 6.3 几何默认值（新旧一致，`rag_params.json geometry` 段）

local: maxNeighbors=48 minNeighbors=3 maxBasis=4 minGain=0.015 positionDecay=0.15 semanticGate{enabled,peak=0.65,sigma=0.25,floor=0.35,hardFloor=−1} anchorGain{base=0.75,scale=1.25,gamma=1,min=0.5,max=2}；global: candidatePool=512 candidateMode=star priorMode=support starNeighbors=48 starMix=0.8 minSupport=3 supportExponent=0.65 residualExponent=0.35 kMax=32 kSem=8 epsilon=0.1 kneeDelta=0 minGain=0.02。
邻接权重=exp(−decay·(|Δpos|−1))，文件 2..100 标签才计入；语义权重 `0.5+0.8·exp(−(sim−peak)²/2σ²)`，sim<hardFloor→0、sim≤0→floor（`:385-389`）。
注：README 自述把该代几何称 **v4**（`unified_geometry_ags_v4_cached_reorth`），**代码标识符实为 `t4`**（`:383`）——以代码为准。

---

## 7. 旧（topology-v3.1 @174a5e1）→ 新（conservative-v2.5-confidence-rrf @9aa1f67）差异清单

| # | 旧（174a5e1） | 新（9aa1f67） | 落点 |
| :-- | :-- | :-- | :-- |
| 1 | `S=clamp01(pure + gated_bonus + anchor_bonus)`，pure=(0.25q+0.2l+0.15t)/0.6+min(topo,0.08) | `S=clip[B+P+G+A]` 四项独立记账 | `rivermemo_topology_v3.rs assign_v3_scores :2556-2619` |
| 2 | 语义读出权重 0.25/0.2/0.15（归一分母 0.6） | 0.7/0.2/0.1；场只贡献有界共振 min(0.03,·) | `field_resonance :1722-1742`、NativeConfig `:382-385` |
| 3 | gated_bonus=v2_bonus·Ω^γ（v2=条件同伴创新核） | G=候选自身图分·χ_b·δ·π，乘 Ω，共享预算 P+G≤0.08 | `:2582-2592, :2615-2616` |
| 4 | 条件同伴核（带宽 0.04/0.1/0.12、minPeers=3、innovation z/scale）、锚异常/前沿控制、种子饱和 → 11 项全退役 | retiredControls 回执 | `:3190-3193` |
| 5 | anchor 晋升 direct_answer：strength≥0.1 ∧ ≥2×次强 | direct_answer=closure≥0.55 ∧ 真实显式精确接触>0；绝对激活 smoothstep(0.05→0.20) | `:2563-2565, :2598-2609` |
| 6 | semantic_anchor_threshold=0.8 | 默认 0.88，且代码硬下限 max(·,0.88) | `:2091, :2160` |
| 7 | 隐式种子可竞争锚 | 隐式接触×0.35、纯隐式强度≤0.035（默认零锚奖励） | `compute_anchors :2163-2190` |
| 8 | reliability（cbrt 覆盖积）乘进奖励链 | 只作诊断/角色解释，奖励用 branch_confidence | `branch_confidence :1717-1720`、`:3831-3834` |
| 9 | 无虫洞通道；wormhole 只在 sensing 传播（衰减 0.70） | 新增独立虫洞读出模块：strict-global-gate + confidence RRF | `rivermemo_wormhole.rs` 全文、`fuse_rrf :415-469`、接入 `:3021` |
| 10 | 金字塔层无止损（能量账任意） | 边际解释能量 0.03 止损、贡献门槛 max(10%,0.05)、字面豁免、共线保护 2、隐式缩放 0.35 | `memo_pipeline.rs :651-795, :924-1086` |
| 11 | 显式种子不保证优先 | 显式核心独立基准幅、隐式种子等比例 ≤0.35×显式最大 | `resolve_core_seeds :890`、`scale_implicit_seeds :874` |
| 12 | 无请求级动态虫洞 | 残差共鸣 R⁴ 选边、2 动态席位（含于 20）、预算 4096、共鸣阈 0.2、尾残差 ≥0.02 追加 | `memo_sensing.rs :281-528`、`memo_pipeline.rs :761-768` |
| 13 | 双场投影无共享预算 | K=256 去重并集流域投影、温和入度折减、RESERVED 8→2 | `memo_projection.rs :8`、`project_basin_fields :1684` |
| 14 | 几何 gram-space 惰性 Gram | 原空间 direct_axes_core + 两遍重正交 + mmap 工作区；ALGORITHM v2→t4 | `memo_geometry.rs :77-326, :383` |
| 15 | 结果仅 score 分解 | 新增 baseScore/fieldScore/fieldResonanceBonus/pathBonus/graphBonus/anchorBonus/scoreClipping/wormholeRrf 明细 | `NativeResultItem :2621-2651, :3096-3125` |
| 16 | evaluate_topology 无形态混合 | graph_score 按 atomic/propositional/narrative 权重（0.75/0.25 等）混合 | `:2973-2982` |

逐项判定函数未变（可直接沿用我方实现）：`compute_omega`、`compute_query_morphology`、`evaluate_path` 主体、`evaluate_topology` 对齐/边匹配、`select_superset`、`support_density`、Ω 常数。

---

## 8. rag_params.json 新增键（diff 174a5e1→9aa1f67，共 5 处）

| 键 | 默认 | 语义 | 消费点 |
| :-- | :-- | :-- | :-- |
| `ContextFoldingV2.contextWeights` | [0.7, 0.3] | 上下文折叠向量=用户消息 0.7 / 助手消息 0.3 加权平均（与 RAGDiaryPlugin.mainSearchWeights 对齐） | `Plugin/ContextFoldingV2/ContextFoldingV2.js:361` |
| `RAGDiaryPlugin.base64MemoLimit` | 5 | 注入用 base64 备忘条数上限（env `BASE64_MEMO_LIMIT` 可覆盖） | `Plugin/RAGDiaryPlugin/RAGDiaryPlugin.js:1720` |
| `KnowledgeBaseManager.resultDeduplication.hydrationBatchSize` | 500 | 去重管线向量 hydrate 的 SQL 批大小（代码 clamp ≤900） | `ResultDeduplicator.js:62-63,275` |
| `KnowledgeBaseManager.resultDeduplication.slowLogMs` | 25 | 去重慢日志阈值（ms） | `ResultDeduplicator.js:65-66,119` |
| `riverMemo.spikeRouting.minimumInjectedCurrent` | 0.01 | 注入内核 SenseConfig.minimum_injected_current（§3.2 电流门槛） | `rust-vexus-lite/src/memo_sensing.rs:62` |

注意：`rag_params.json` 的 `riverMemo.directAnchor.semanticThreshold` 仍为 0.8，但内核硬下限 0.88（§7#6）——调参时以下限为准。`topology` 段的退役键仍存在（兼容回滚，无行为）。

---

## 9. 作者 README 自述要点（`rust-vexus-lite/README.md` @f14290a，638 行，2026-10-29）

作者把 vexus-lite 定位为「读写搜一体原生记忆数据库」，与我们移植相关的自述：
- **五层架构**：SQLite 权威事实层（事务先立事实）→ TDB 2-bit 冲程检索（近似找候选）→ AGS 统一背景场（预计算长期结构）→ Spike 有界传播+请求级动态虫洞（本次查询实际激活）→ RiverMemo 双场+统一泛函（精确裁决）。「把近似用在寻找候选，把原始精度留给数学与裁决」。
- **三种图必须分清**：TDB 向量导航图 ≠ AGS 传输图 ≠ 请求级河网。
- **双渠道定位**：RAGDiary 被动渠道（回答形成前的记忆背景，占位符/日记本作用域/门控约束，非无条件召回）；LightMemo 主动渠道（显式追问）。系统层共享同一基础设施。
- **四项基线**（§6.4）：B 不含路径奖励、共振先封顶 0.03 再乘支持；P 不乘 Ω 优先占预算；G 乘 Ω 受剩余预算；A 独立限额。角色只解释证据；池不变性（加无关候选不改既有奖励）。
- **虫洞 RRF**（§6.5）：「不是普遍情况、不是常驻全局评分因子」，针对边缘稀疏场景；实现**不含按 Ω 工况的稀疏开关**；全局见证是图证据不是排序因子；至少一个候选正贡献才启用，否则基线逐位不变。
- **资产依赖链**：统一几何 → 传输 Artifact → 运行时发布；几何签名变（含算法标识）必须按链重建派生背景。几何（背景资产层）与 Topology V3 读出（请求读出层）独立版本标识。
- **预算分立**：动态虫洞 4096 目标预算独立于双场 256 选点预算；3072 维下 4096 个 FP32 ≈48MiB。
- README 称几何代际为 v4、代码标识为 t4（§6.3 注）；README 行号引用与 9aa1f67 源码基本对齐（±数行漂移）。

---

## 10. 移植注意事项（P3 施工判据）

1. **改哪些文件**：`kernel/src/` 需对齐 `rivermemo_topology_v3.rs`（重写评分段）、新增 `rivermemo_wormhole.rs` 复刻、`memo_sensing.rs`（动态虫洞席位/共鸣）、`memo_pipeline.rs`（金字塔止损/门控/隐式缩放）、`memo_projection.rs`（**RESERVED 8→2**）、`memo_geometry.rs`（数值内核换血，数学默认不变）。
2. **diff-runner 五腿**是验收；健康史分数差 ≤1e-6（历史 1.11e-16）。位级要点：`ordered_states` 排序（sensing `:245-249`）、BTreeMap 收敛顺序（`evaluate_topology :1756`）、FIR/累加左折叠、`total_cmp` 全链——上游处处为位级确定性设防，复刻时**不得改换浮点归约顺序**。
3. Ω 只门控 G；`field_resonance` 的 gain 封顶顺序是 **先 min(0.03,·) 再乘 support 再 min(1−query)**（测试 `:3756-3760`：0.1 支持 ×0.03=0.003）。
4. fuse_rrf 前的 work 必须已按基线比较器排好序（r0=数组位次）；无正贡献时 final_score 位级不动（测试 `:3564-3567`）。
5. 语义锚阈硬下限 0.88 写死两处（`anchor_contacts :2091`、match_weight `:2160`）——配置传低无效。
6. 虫洞 gate/refine 是两段 SQL 查询（prepare_cached）：refine 任何 129 超限即拒，不能「尽力而为」。
7. 金字塔拒绝层不留任何痕迹（标签/残差/门控全不发布）；尾残差只在 `dynamic_wormholes=true` 才收集。
8. 构建侧：几何 ALGORITHM 改名会使签名失效→全量重建；memo_workspace 共享快照是可选优化（不做不影响分数，但上游内存行为不同）。
9. `docs/RIVERMEMO_TOPOLOGY_V3.md`（560 行）是上游数学契约正典；本文与其冲突时以**源码行号**为准（例如 README 的 v4/t4 命名）。
10. 红线复述：上游仓只读；本仓不碰 `kernel/src`（本任务只交付 docs）；`rag_params.json` 属上游，我方等价配置在 `src/` 侧另行落。
