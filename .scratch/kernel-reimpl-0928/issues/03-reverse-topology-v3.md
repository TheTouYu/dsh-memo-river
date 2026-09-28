# 03 — 逆向补全：rivermemo_topology_v3.rs（2897 行，打分心脏）

**What to build:** 行号+系数级逆向文档至 `kernel/docs/reverse-topology-v3.md`。已知锚点（D144 判定链）：assign_v3_scores 的 direct_answer 双通道（closure≥0.55 ∧（direct_evidence≥0.55 ∨ near_frontier∧query_score≥0.55））、closure=0.65·query_chunk+0.35·tag_closure、semantic_boundary 的 <0.55 归零、锚晋升（0.1 地板 + 2.0 对比）、omega<0.12 降级。补全：Ω 三分量（ω_e/ω_n/ω_f）推导、pure_score/v2Bonus、奖励-压制语义、queryMode 判定。**逆向结论用 02 对账器复放验证**（includeTrace 的 observables 与文档预测吻合）。

**Blocked by:** 02 — 对账器就位才能边读边验证。

**Status:** ready-for-agent

- [ ] Ω regime 判定链全参数（含 sparse/dense 阈值与三分量公式）落文档，行号级引用
- [ ] 角色判定全通道（direct_answer / atomic_concept / thematic_neighbor / structural_explanation）条件树落文档
- [ ] 锚奖励与压制语义（anchor_strength 推导、reward-suppressed 的 knn 门限）落文档
- [ ] 三查询 × trace 复放：文档预测的判定路径与实际 observables 逐环吻合（≥1 个 sparse 场景）
- [ ] 文档头标注「逆向快照版本」（基准诚实条款，PLAN §5.4）
