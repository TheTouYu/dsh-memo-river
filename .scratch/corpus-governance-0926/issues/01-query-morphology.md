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

**Status:** done — 2026-09-26，commit `3ba1ba9`（选定 (i)：诊断透出 + DESIGN §6.1.1 判据说明，契约未动；形态表 10/10 atomic，探针 `scripts/probe-query-morphology.mjs`）

- [x] 探针建成并跑出形态表（10 形态 / 10 atomic / effectiveDepth 0.02–0.04）
- [x] 定因证据落票面（图拓扑派生；「低置信度默认档」只对一半）
- [x] (i) 落地：`src/recall.ts` diagnostics 透出 queryMode+queryMorphology；DESIGN §6.1.1；hub-gate 8/8 + folder-route 8/8

---

## 执行记录 — 2026-09-26（本代理）

**选定 (i)：能透出 ⇒ 加诊断字段 + 判据说明，契约不动。** 依据：Rust `NativeOutput.query_morphology`
一直随结果序列化（`rivermemo_topology_v3.rs:2835`，字段见表 `:2122-2138`：atomic/propositional/narrative_weight、
confidence、effective_depth、depth_variance、energy_concentration、shallow_energy_ratio、forward_flow_ratio、
same_level_flow_ratio、chainness、branching、merging、growth_persistence、dominant_mode），TS 侧此前只消费了
`queryMode` 字符串（`src/recall.ts`）。**无需重建 vexus-lite ⇒ 契约文本与 sha256 均未动。**

**定因（比票面假设更准）**：`queryMode` 不是「查询文本措辞」的函数，而是**观测图拓扑**的函数——
logits 由 `shallow_energy_ratio / energy_concentration / effective_depth / chainness / branching /
growth_persistence / relational_complexity / middle_depth / depth_variance / forward_flow_ratio` 算出
（`:2088-2100`）；`confidence = clamp01(sqrt((1-e^{-nodes/8})(1-e^{-edges/8})) × completeness)`（`:2077-2086`）；
`weights = confidence·softmax(logits) + (1-confidence)·[⅓,⅓,⅓]`（`:2109-2113`）；平局归 atomic（`:2114`）。
票面写的「低置信度 ⇒ 均匀先验 ⇒ 默认 atomic」**只对了一半**：实测 confidence 常在 0.7–0.87（不低），
真正让 atomic 恒胜的是 **`effectiveDepth` 恒 0.02–0.04 的浅星形观测图**。

**实测表**（`scripts/probe-query-morphology.mjs`，桶 `50d29236c1297d2c`，artifact 29 节点 / 202 边，
10 种形态含 3 种 ≥40 字长句）：**10/10 `queryMode=atomic`**；atomicW 0.4527–0.5752、propW 0.2049–0.2614、
narrW 0.2137–0.3315、confidence 0.4834–0.8736、effectiveDepth 0.0209–0.0429、Ω 0.5743–0.9532（全 dense）。
全表落 `.scratch/corpus-governance-0926/01-morphology.md`，原始 JSON `.scratch/morph-probe/morphology.json`。

**结论**：当前语料规模下 role 实际只有 `atomic_concept` 与 `direct_answer` 两级；
`structural_explanation`（需 `mode != "atomic"`，`:2231/:2238`）与 `thematic_neighbor`（structural 的低 Ω 降级）
**结构性不可达**。这不是 bug，是形态闸门的语义 ⇒ 记入 `DESIGN.md` §6.1.1（判据说明），契约文本保持原样
（契约是否要如实改为两级 ⇒ 移交票 03 与票 08 一并决定，避免两次改 sha、两次破前缀缓存）。

**回归**：`acceptance-hub-gate` 8/8 ✅、`acceptance-folder-route` 8/8 ✅（两者原本在沙箱里跑不起来，
见下）；主套件读数见 `.scratch/corpus-governance-0926/01-regression.log`。

**顺带发现（已开票 08）**：本次为核对 sha256 而运行 `scripts/gen-prompt.mjs`（**它没有 `--dry`，直接覆写了
`src/prompt.ts`**，已 `git checkout` 还原）时暴露——`DESIGN.md` §6.1 围栏文本（1597B，规范 ①–⑦，sha `b08590b5…`）
与上线 `FIXED_CONTRACT_TEXT`（2025B，四 role 完整描述 + 规范 ⑧，sha `b5260237…`）**已分叉**，
而常量 `FIXED_CONTRACT_SHA256` 记的是 **DESIGN 侧**的哈希 ⇒ `acceptance.mjs` #2 的两条断言算术上必红。
详见 `.scratch/corpus-governance-0926/issues/08-contract-source-divergence.md`。

### 回归归因（双盲：stash 对照 + 同刻复跑）

| 套件 | 带本次改动 | 干净 HEAD（`git stash -- src/recall.ts`） |
|---|---|---|
| `acceptance-hub-gate` | **8/8 PASS** | —— |
| `acceptance-folder-route` | **8/8 PASS** | —— |
| `acceptance.mjs`（主套件） | 14 项后崩（`ENOTEMPTY` at `acceptance.mjs:830`） | 20 项后崩（**Bus error, exit 135**） |

主套件失败集**两侧完全相同**：#1 / #2 / #4 / #5 / #8 / #10 / #13（HEAD 侧另多 #15–#19，崩得更晚）。
⇒ 与本次改动**无关**：`#2` 是票 08 的真实既有缺陷（`registered(2025B) ≠ designText(1597B)`、
常量 sha 对应 DESIGN 侧），其余属本机环境族（SIGBUS + 自净桶清理崩溃 + 端点时延），
与本仓既有记录同款（`scripts/README.md` 状态纪律：SIGBUS 环境症、#31 端点敏感、疑似回归先干净 HEAD 同刻复现）。

证据文件：`.scratch/corpus-governance-0926/01-regression-WITH-change.log`（本次）、
`.scratch/corpus-governance-0926/01-regression-HEAD.log`（对照）。
**跑法**（沙箱会话必须两条都设，否则假红）：
`TMPDIR=$PWD/.scratch/tmp DSH_HOME=$PWD/.selftest/dsh-home node scripts/acceptance.mjs`
