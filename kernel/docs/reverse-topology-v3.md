# 逆向：rivermemo_topology_v3.rs（2,897 行，打分心脏）

> 逆向快照 v1 · 2026-09-28 · 基于上游源文件逐行精读（行号指该文件）。
> 验证：kernel/tools/replay-validate-topology.mjs（classroom 三查询全链复放，判定树逐环对照）。
> 用途：票 09 复刻的唯一数学依据；冻结版本，复刻后更新验证记录不改正文结论。

## 0. 管线位置与编排（run_native :2478）

```
parse input ─(observationHandle)→ MemoRuntime 缓存恢复四向量+河网 :2487-2534
→ load_artifact_from_runtime :2548（runtime 无则读 rivermemo_artifacts 行解码发布）
→ load_curves :2549（候选 chunk 向量+file_tags 曲线，500/批 SQL）
→ compute_anchor_scores :2568（local_domain 命中归一）
→ 四余弦（query/denoised/local/transfer × chunk）:2569-2574，rayon 并行
→ select_superset :2576（七源联合，截 300）
→ FieldWorkspace :2579（双场按 max 归一）
→ 锚定 seeds：hop==0 且 core|seed，空则回退 source_field 全体 :2596-2622
→ 河网+seed 的 Tag 向量共享分块读 :2626-2636
→ compute_query_morphology :2640 → compute_anchors :2646（须在消费 curves 前：rarity 要全池）
→ 逐候选并行：evaluate_path / evaluate_topology / evaluate_observables
   + pure_score / graph_score 合成 :2668-2734
→ compute_omega :2736 → assign_v3_scores :2738
→ final_score 排序（并列按 union_score desc、union_rank asc）:2739-2752 → top_k 截断
```

observationHandle 恢复语义：`complete_observation = !source_field.is_empty()`（:2530）——空观察直接把 Ω 砍半（见 §5）。

## 1. 候选池：七源联合（select_superset :1157）

七源各取 top-K：query_knn(100) / denoised_field_knn(100) / local_field_knn(100) / transfer_field_knn(100) / bm25(50) / time(100) / anchor_direct(50)。源内 min-max 归一（spread≤1e-12 时退 1/rank）。

union_score = clamp01(0.5·max + 0.25·mean + 0.25·clamp01(20·Σ1/(60+rank)) + min(0.05·(源数−1), 0.2))（:1231-1233）。
排序：源数 desc → union_score desc → id asc；截 max_union_candidates=300。

anchor_score 的 local_domain 来源（compute_anchor_scores :1108）：hits/max_hits（池内最大命中归一），与传入 anchor_score 取 max。

## 2. 三个评估器（每候选，rayon 并行）

### 2a. 几何 evaluate_path（:1308）

对曲线相邻 Tag 对（windows(2)）：
- local/transfer_potential = √(field[a]·field[b])（双端场值几何平均）
- direction = clamp01(forward/(forward+reverse))，无边时 direction_floor=0.05（:1327-1331）
- semantic_continuity = clamp01((cos(tag_a,tag_b)+1)/2)；field_continuity = √(max(local,transfer)_next · max(双场 next))；continuity = 0.5·semantic + 0.5·field
- supported = (local 域双端 ∨ transfer 域双端) ∧ (forward>0 ∨ reverse>0)
- quality（supported 时）= clamp01(potential · √max(direction,0.05) · √continuity)，其中 potential = (0.6·local + 0.4·transfer)/1.0（local_weight/transfer_weight）
- path_core = mean(quality)；单 Tag 曲线：path_core = max(双场)·0.5（:1382-1392）
- tag_closure = mean over tags of clamp01(chunk_cosine − 0)/(1−0)（closure_floor=0）
- **path_quality = clamp01(path_core · (0.5 + 0.25·support_coverage + 0.25·tag_closure))**（:1409）

### 2b. 拓扑 evaluate_topology（:1445）

节点对齐：精确命中 quality=√chunk_cosine；语义对齐（cos(查询 Tag 向量, 候选 Tag 向量) ≥ semantic_node_threshold=0.48）quality=√(norm·chunk_cosine)，norm=(sim−0.48)/(1−0.48)。node_alignment_score = Σw·q/Σw（w=normalized_energy‖energy）。mean_closure = 对齐项 chunk_cosine 均值。

边匹配（查询河网边，flow≥minimum_river_edge_flow=0.015，取前 maximum_river_edges=96）：
- distance_similarity = exp(−|query_dist−cand_dist|/0.35)（温度=relative_distance_temperature；距离=|hop 差|/max_hop 与 |position 差|/span）
- direction_similarity：候选同向 1.0，反向 reverse_direction_credit=0.25
- independent = artifact.independent_fraction(src,tgt,file_id)（provenance 溯源，min 0.15）
- edge_quality = clamp01(√(q_src·q_tgt) · dist · dir · independent)

edge_graph_score = clamp01(0.18·node_align + 0.22·rel_dist + 0.18·direction + 0.28·edge_topo + 0.14·motif)（:1638-1644，motif=edge_topo）
node_graph_score = clamp01(√(node_alignment·mean_closure))
reliability：有配边 = cbrt(node_cov·edge_cov·mean_closure)；仅节点 = min(0.2, √(node_cov·mean_closure))（node_only_reliability_cap）
score = 边模式取 edge_graph_score，否则 node_graph_score。

### 2c. 观测量 evaluate_observables（:1681）

- exact_seed_hits：曲线 Tag 命中 source_ids 的数量；direct_contact = hits/|source_ids|
- **semantic_boundary = max over tags of √(cos(query,tag_vec)·chunk_cosine)，<0.55 整体归零**（:1729）
- direct = visible ? clamp01(max(0.75·direct_contact, semantic_boundary)) : 0（visible = 无显式 file 作用域或在该域内）
- **closure = clamp01(0.65·query_chunk + 0.35·tag_closure)**（:1735）
- thematic = (0.25·local_cov + 0.2·transfer_cov + 0.2·local_mean + 0.15·transfer_mean + 0.2·(1−|local_mean−transfer_mean|)) · (1−0.5·tail_ratio)
- structural = path_quality

## 3. pure_score 与 graph_score（:2681-2717）

- semantic_base = clamp01((0.25·query + 0.2·local + 0.15·transfer)/0.6)（pure_*_weight 三元组和归一）
- topology_raw = clamp01(0.625·path_quality + 0.375·(0.35·local_cov+0.25·transfer_cov+0.25·local_pot+0.15·transfer_pot))
- path_reliability = clamp01(path_quality/0.15)（topology_path_saturation）；topology_reliability = √(path_reliability·query_chunk)
- topology_bonus = 0.08 · topology_raw · topology_reliability（cap=topology_bonus_cap）
- **pure_score = clamp01(semantic_base + min(topology_bonus, 0.08))**
- 形态混合基：atomic=0.75·node+0.25·edge；propositional=0.25/0.75；narrative=0.15/0.85
- **graph_score = clamp01(Σ morphology.weight_i · 混合基_i)**
- direct_evidence = max(semantic_boundary, direct)（:2722）

## 4. 查询形态学（compute_query_morphology :1912）

输入 = 查询河网（节点带 hop/energy、边带 flow）。派生量：
- effective_depth = 1−exp(−加权平均 hop/1.75)；depth_variance = 1−exp(−√加权 hop 方差/1.5)
- shallow_energy_ratio = hop≤1 节点能量占比；energy_concentration = (HHI−1/n)/(1−1/n)
- forward/same_level_flow_ratio；chainness/branching/merging（度数统计）；growth_persistence = level_occupancy·√depth
- sample_reliability = √((1−e^{−n/8})(1−e^{−m/8}))；completeness = complete?1:0.5；confidence = 两者积

三 logit（:2088-2100）：
- atomic = 1.45·shallow + 0.9·concentration − 1.25·depth − 0.65·growth − 0.45·chainness
- propositional = 1.25·relational_complexity + 0.7·middle_depth + 0.35·depth_variance − 0.25·chainness
- narrative = 1.4·depth + 1.15·chainness + 0.8·forward + 0.65·growth − 0.65·branching − 0.3·concentration

softmax（T=1.0）后与均匀先验按 confidence 混合（:2109-2113）：**weight = confidence·softmax + (1−confidence)/3**。dominant_mode 取最大者（atomic > narrative > propositional 的比较序 :2114）。

## 5. Ω regime（compute_omega :2156）

- ω_e（omega_edge）= clamp01(active_edges/(0.5·seeds))（kappa_edge）
- ω_n（omega_emerge）= clamp01(emergent/(0.3·seeds))（kappa_ratio；emergent = reached − seeds）
- ω_f（omega_flow）= 流熵/ln(n)：无边 0、单边 0.5、否则 Σ−p·ln(p)/ln(n)
- Ω = clamp01((ω_e∨0.02 · ω_n∨0.02 · ω_f∨0.02)^⅓ · (complete?1:0.5))（omega_epsilon=0.02 下限，observation_factor）
- **regime：Ω<0.12 collapsed；<0.45 sparse；否则 dense**（collapsed_threshold/sparse_threshold）

## 6. 角色判定与得分合成（assign_v3_scores :2222）

### 6a. 角色（:2228-2248）

- near_frontier = pure ≥ max(pure) − 0.03
- direct_answer ⟸ mode≠atomic ∧ closure≥0.55 ∧ (direct_evidence≥0.55 ∨ (near_frontier ∧ query_chunk≥0.55))
- role 优先级：mode=atomic → atomic_concept（无条件）；direct_answer；structural=(edge_cov·reliability·closure)^⅓≥0.35 → structural_explanation；否则 thematic_neighbor

### 6b. 条件同伴创新奖励（v2_bonus，:2256-2355）

对每个候选建同伴核：weight = (同 role ? 1.0 : 0.35) · exp(−0.5·((Δpure/0.04)² + (Δclosure/0.1)² + (Δdirect/0.12)²))（三带宽 = conditional_*_bandwidth）。权重 <1e-4 剔除，不足 minimum_peers=3 补 1e-4。

- expected = Σw·graph/Σw；variance = Σw·(graph−expected)²/Σw；effective_peers = (Σw)²/Σw²
- uncertainty = √(variance·(1+1/eff_peers))；**innovation = positive(graph − expected − 1.0·uncertainty)**（innovation_confidence_z）
- candidate_confidence：atomic = √(closure·(0.55·node_cov+0.45·node_align))；其余 = cbrt(closure·(0.75·edge_cov+0.25·node_cov)·(0.7·reliability+0.3·node_align))
- statistical = clamp01(eff_peers/2.5)（minimum_effective_peers）
- requested = innovation · confidence · 0.5（innovation_scale）· multiplier
- 角色 (cap, multiplier)：atomic (0.08, 1.0) / direct_answer (0.02, 0.35) / structural (0.045, 0.7) / thematic (0.008, 0.15)
- bonus = min(requested, role_cap, 0.08)；若存在 direct_frontier 且本项非 direct 且 mode≠atomic：**bonus ≤ direct_frontier − 0.005 − pure**（direct_answer 的名次保护带）

### 6c. 锚奖励（:2358-2414）

- anchor.strength = anchor.score · anchor.reliability（compute_anchors :1865）
- 激活阈 threshold = max(0.05, mean+2.0·std)（anchor_activation_floor/z）；activation = smoothstep((strength−threshold)/(0.2−threshold))
- **anchor_bonus = 0.1 · activation**（anchor_bonus_cap）
- **晋升**：最强锚 strength≥0.1（abs_floor）∧ ≥2.0×次强（contrast）→ 最强者 role 无条件升 direct_answer（:2405-2406）
- **降级**：Ω<0.12（struct_role_min_omega）→ structural_explanation 降 thematic_neighbor（:2407-2411）

### 6d. 终值

graph_gate = Ω^1.0（omega_gamma）；gated_bonus = v2_bonus·graph_gate；
**final_score = clamp01(pure + gated_bonus + anchor_bonus)**。

## 7. 锚接触模型（compute_anchors :1790 / anchor_contacts :1762）

- 接触：精确命中（weight 1.0）或 cos(seed,tag)≥0.8（semantic_anchor_threshold，weight=0.7 discount）
- specificity = max(0.35, 1−√(inbound/max_inbound))（specificity_floor；全库入度稀缺度）
- rarity = max(0.15, 1−接触该 seed 的候选数/候选总数)（rarity_floor；池内稀有度）
- contribution = clamp01(归一 seed 质量 · specificity · chunk_cosine · rarity · match_weight)
- **score = 1 − Π(1−contribution)**（no-contact 概率补）
- reliability = √(mean_closure · min(contacted/2.0, 1))（reliability_seed_saturation）；fallback 锚（无 core/seed 溯源） capped 0.5（fallback_reliability_cap）

## 8. 输出契约（NativeOutput :2466 / 结果项 :2419）

schema `rivermemo-topology-v3-native-result-v1`；algorithm_version `rivermemo.topology-v3.1-rust`。每项：id/chunkId（同值）、rank、score（=final）、baseScore（=pure）、topologyBonus（=gated）、anchorBonus、role、omega、riverRegime、matchedTags（HashSet 去重，序不定）、candidateSources、originalScore（回传候选分）、includeTrace 时附 topology_v3（pureScore/v2Bonus/gatedV2Bonus/anchorStrength/anchorBonus/graphGate/omega 三分量/role）+ relativeTopology（TopologyOutput）+ geometry + observables。

诊断（NativeDiagnostics :2446）：backend `rust-rayon-sqlite`、offered/projected/selected/ranked/returned 五级候选计数、rayon_threads、artifact_nodes/edges、load/compute/total ms、三类 SQL 批数。

## 9. 参数总表（NativeConfig :195-299，48 项默认值）

query_k 100 · denoised_k 100 · local_field_k 100 · transfer_field_k 100 · bm25_k 50 · anchor_k 50 · max_union_candidates 300 · local_weight 0.6 · transfer_weight 0.4 · direction_floor 0.05 · closure_floor 0.0 · semantic_node_threshold 0.48 · relative_distance_temperature 0.35 · reverse_direction_credit 0.25 · minimum_river_edge_flow 0.015 · maximum_river_edges 96 · node_only_reliability_cap 0.2 · kappa_edge 0.5 · kappa_ratio 0.3 · omega_epsilon 0.02 · collapsed_threshold 0.12 · sparse_threshold 0.45 · semantic_anchor_threshold 0.8 · semantic_anchor_discount 0.7 · specificity_floor 0.35 · rarity_floor 0.15 · reliability_seed_saturation 2.0 · fallback_reliability_cap 0.5 · pure_query_weight 0.25 · pure_local_weight 0.2 · pure_transfer_weight 0.15 · topology_bonus_cap 0.08 · topology_path_saturation 0.15 · conditional_bandwidth 0.04 · conditional_closure_bandwidth 0.1 · conditional_direct_bandwidth 0.12 · minimum_peers 3 · minimum_effective_peers 2.5 · innovation_confidence_z 1.0 · innovation_scale 0.5 · omega_gamma 1.0 · struct_role_min_omega 0.12 · anchor_bonus_cap 0.1 · anchor_activation_z 2.0 · anchor_activation_floor 0.05 · anchor_saturation 0.2 · anchor_frontier_contrast 2.0 · anchor_frontier_abs_floor 0.1

## 10. 已知行为特征（复刻注意）

1. **rayon 并行不改数值但改进程间一致性边界**：逐候选评估各自独立（无跨候选共享累加），但 assign_v3_scores 的 peer 核是串行全对全——同输入下角色/分数确定；selfcheck 观察到的 1.11e-16 级差异来自 rerank 前置阶段的浮点和（见票 09 差分容差）。
2. matched_tags 经 HashSet，输出顺序不定——差分比较必须集合化。
3. 观察缓存与 artifact 代际绑定：publish 切换代际时清 query cache（MemoRuntime::publish :445-447），同签名幂等不递增代际。
4. 查询向量长度校验在 handle 恢复之后（:2536）——handle 路径的 vector 以缓存为准（JS 侧传空数组的既有约定，D144 已证非 bug）。
5. **model_sig 是图形状的隐藏输入**：builder 的 `load_pairwise` 按 `WHERE model_sig = ?1` 过滤（memo_artifact_builder.rs:172）——sig 对不上 pairwise 表时 semantic_gain 全程走 low_fallback，图退化为无语义增益形态（实测：钉假 sig 的 classroom Ω=0.01 退化系；真 sig `gemini-embedding-2-preview@relayrouter` 有 39 行 pairwise，Ω 回到 0.60/0.78/0.57）。差分驱动器必须钉语料真实 sig。
6. **复放驱动必须先 recoverFromSqlite**：查询河网来自管线感知、感知依赖 tag 索引；漏掉它河网为空 → Ω 退 0.01 collapsed、形态权重退均匀先验（1/3,1/3,1/3）——输出「合法但全退化」，肉眼难察（replay-validate-topology.mjs 的实测教训）。
