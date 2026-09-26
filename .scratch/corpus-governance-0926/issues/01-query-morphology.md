# 01 — query morphology 实测与三级证据的如实化

**What to build:** 把「契约承诺三级证据、实现只给两级」这件事**定因并落地一个选择**。

背景实测（勿重查）：判据链上 `assign_v3_scores` 的 role 分支是 `rivermemo_topology_v3.rs:2231`：
`let direct_answer = mode != "atomic" && …`，而 `:2238` `item.role = if mode == "atomic" { "atomic_concept" } …`
——**atomic 模式下 `structural_explanation` 结构性不可达**（后段只可能晋升 `direct_answer` 或把 structural 降级 thematic）。
`mode` 来自 QueryMorphology 分类器（`:2060-2120`）：三 logits（atomic/propositional/narrative）→ softmax →
`weights = confidence·topology_weights + (1-confidence)·[1/3,1/3,1/3]` → `dominant_mode` 的 tie-break 是
`weights[0] >= weights[1] && weights[0] >= weights[2]` ⇒ **置信度低时平局默认归 atomic**。
本机实测 6/6 查询全 `queryMode=atomic`（含 60+ 字命题式与叙事式长句）。

**要做**：
1. `scripts/probe-query-morphology.mjs`（复用 `scripts/probe-anchor-trace.mjs` 的引擎骨架：桶副本 + `MemoEngine` + `runPipeline` + `rerankTopologyV3`，只读）：跑 **≥8 种查询形态**（含 ≥3 种 ≥40 字长句、含纯标签词、纯问题、多跳因果、列表式），逐条打印 `queryMode` / `omega` / `regime` / strength 分布。
2. 若 Rust 已把 morphology 权重序列化进结果（查 `:2472 query_mode` 附近结构体与 `:2834`），把它透出到 TS 诊断（`src/recall.ts` 的 diagnostics 加 `queryMorphology`）；若**没有**序列化，不做 Rust 改动，改走第 3 条。
3. 二选一落地（票据执行时按第 2 条的事实决定，写进票面）：
   - **(i)** 能透出 → 加诊断字段 + 一句判据说明（README/DESIGN），契约不动；
   - **(ii)** 不能透出 → 改 `src/prompt.ts` 的 `FIXED_CONTRACT_TEXT`：把三级证据如实改成**当前可达的两级**（`atomic_concept` / `direct_answer`），并注明 `structural_explanation` 需要非 atomic 查询形态、当前分类器下不可达 ⇒ **契约 sha256 常量同步更新**（`src/prompt.ts:7`，现值 `b08590b5533a8bff6da8530c228fc45377e1f92eb8074448532fc8f5c8213469`）。

**判据（可复现读数）**：
- [ ] 形态表 ≥8 行（查询文本 / `queryMode` / Ω / regime / max-strength），落 `.scratch/corpus-governance-0926/01-morphology.md`
- [ ] 明确写清「atomic 是否为默认档」的定因证据（源码行 + 实测行）
- [ ] 选定 (i) 或 (ii) 并落地：代码 diff（+契约 sha256 更新，若 (ii)）
- [ ] 回归：`acceptance-write-prompts.mjs` + 主套件（或按 05 先例给出环境性阻断的双盲归因）

**预算红线**：契约段改动 ≤2 行（(ii) 时），且与票 03 同批（同一个 sha256、同一次重启窗口）。

**Blocked by:** None — 可立即开工。

**Status:** 待办 — 2026-09-26

- [ ] 探针建成并跑出形态表
- [ ] 定因（tie-break 默认档）证据落票面
- [ ] (i)/(ii) 落地 + 回归绿
