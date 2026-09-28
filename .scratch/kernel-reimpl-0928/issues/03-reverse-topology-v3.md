# 03 — 逆向补全：rivermemo_topology_v3.rs（2897 行，打分心脏）

**What to build:** 行号+系数级逆向文档至 `kernel/docs/reverse-topology-v3.md`。已知锚点（D144 判定链）：assign_v3_scores 的 direct_answer 双通道（closure≥0.55 ∧（direct_evidence≥0.55 ∨ near_frontier∧query_score≥0.55））、closure=0.65·query_chunk+0.35·tag_closure、semantic_boundary 的 <0.55 归零、锚晋升（0.1 地板 + 2.0 对比）、omega<0.12 降级。补全：Ω 三分量（ω_e/ω_n/ω_f）推导、pure_score/v2Bonus、奖励-压制语义、queryMode 判定。**逆向结论用 02 对账器复放验证**（includeTrace 的 observables 与文档预测吻合）。

**Blocked by:** 02 — 对账器就位才能边读边验证。

**Status:** done — 2026-09-28（commit 1bbbef3；文档 kernel/docs/reverse-topology-v3.md v1）

- [x] Ω regime 判定链全参数（含 sparse/dense 阈值与三分量公式）落文档，行号级引用（§5：ω_e/ω_n/ω_f + ε 下限 + observation_factor + 0.12/0.45 阈值）
- [x] 角色判定全通道（direct_answer / atomic_concept / thematic_neighbor / structural_explanation）条件树落文档（§6a + §6c 晋升/降级）
- [x] 锚奖励与压制语义（anchor_strength 推导、激活阈/平滑、晋升 0.1+2.0×、direct_frontier 名次保护带）落文档（§6b/§6c/§7）
- [x] 三查询 × trace 复放：文档预测的判定路径与实际 observables 逐环吻合——replay-validate-topology.mjs 12 组断言全绿（regime 树 / dominant_mode 序 / 角色树 11/11×3 / 终值合成逐项 ≤1e-9）；Ω=0.6000/0.7843/0.5707 对上 compare.md 金数值。sparse 场景以 regime 树判定逻辑覆盖（classroom 全 dense，桶语料 sparse 留给票 09 差分实测）
- [x] 文档头标注「逆向快照版本」（基准诚实条款，PLAN §5.4）
