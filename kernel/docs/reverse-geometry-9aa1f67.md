# 逆向笔记：memo_geometry.rs 174a5e1 → 9aa1f67（P3 geometry 腿）

> 上游真源：`/home/h/app/VCPToolBox-2.0/rust-vexus-lite/src/memo_geometry.rs`（HEAD 9aa1f67，1346 行；
> 174a5e1 为 972 行）。上游 4 个 commit：`744a698`/`b81d2e6`（算子迭代）、`08c155d`（构图每 Tag 向量只读一次）、
> `45c9c3a`（几何与建图共用同快照向量工作区）。
> ⚠️ 官方 linux `.node`（12.8MB，git 内最后提交 = 3b227ad 10-23）**不含 9aa1f67 全部语义**：
> 无 `computeMemoGeometry` 入口（方法面 60 个，无 geometry）——它与源码 HEAD 有版本缝隙（见 D404/D405/D406）。

## 1. 算法核换血（数学语义不变，数值内核换代）

| 174a5e1（P0 已复刻） | 9aa1f67（本次移植） |
|---|---|
| `gram_gs`：Gram 空间系数法（basis=候选系数向量） | `direct_axes_core`：原空间直接选轴（basis=原空间正交轴） |
| `select_axes_lazy`（懒列+位级等价论证） | 删除；`LAZY_GRAM_DIAGONAL_LIMIT` 一并退役 |
| `select_axes_full`（全 Gram 兜底） | 删除 |
| `select_axes`（lazy→full） | `direct_axes(keep_basis=false)` 的薄壳（仅测试用，`#[allow(dead_code)]`） |
| `anchored_gs`（系数重建原空间轴） | `direct_axes(keep_basis=true)` |

`direct_axes_core` 三层结构（README §4.3 与源码 :163-326 双参照）：

1. **投影缓存**：`proj_history[j*limit+k]`（按候选连续存放）、增量标量 `proj_sq_sum[j]`/`proj_target_sum[j]`
   （IEEE-754 left-fold 位序）；首遍消元直接读缓存（`orthogonal_residual_with_projections` pass 1 零点积）。
2. **四轴分块**：`dot_four`（4 独立累加器共趟向量，每路坐标序累加——单个点积加法树不变，位级同 `dot`，
   测试 `reduction_lengths_and_cancellation` 钉死）；`sub_four` 同型。
3. **选择性重正交**：估计剩余 ≤1e-3·原能量或缓存不可用 → 两遍逐轴 MGS2（`orthogonal_residual`，`dot_exact`）；
   候选评分阶段剩余 ≤1e-8·原能量 → 直接重算原空间残差；非有限或 orth ≤1e-6 不入基；目标残差 <1e-14·原能量报零。
4. active 压缩遍历（write_pos 交换删除）+ Tag ID 升序决胜（score 严格相等时）。

## 2. 工作区（本次发现的 P0 装载缺口）

上游 `read_unit_vectors` + `UnitVectorWorkspace::build`：f32→f64 **normalize 后入区**；
norm 非有限或 ≤1e-12 整行缺席；slot 按去重升序 id 分配（`unique.sort_unstable().dedup()` 后 chunks(128)）；
`norms[slot] = dot(v,v)`（build 期）；mean 按 slot 序（=升序 id 序）累加。

**P0 版缺口**：我方 `load_tag_vectors` 存原始未归一向量、缺席判据 `sum < 1e-12`（= norm ≤1e-6，口径不同）。
P0 五腿零漂移当时成立仅因「rebuild 不调 geometry」，其输出不在差分视野——P3 接线后即为分叉源。
本次以 `UnitVectorWorkspace`（内存 `Vec<f64>`，免 memmap2/bytemuck）对齐全部语义。

## 3. CSR 与局部/星团相位（08c155d）

- `edges: Vec<(i64, usize, f64)>`（id, slot, w）构建期一次完成：过滤无效 slot →
  `select_nth_unstable_by(max_keep-1)` + truncate + `sort_unstable_by`（比较器 `b.2.total_cmp(&a.2).then(a.0.cmp(&b.0))`，
  id 唯一 ⇒ 全序，stable 与 unstable 无别）；`max_keep = max_neighbors.max(star_neighbors)`。
- support 仍对完整共现邻居求和（截断前）。
- 局部相位：CSR 前 `max_neighbors` 条 + `dot_neighbors` 一次算 raw_dots → semantic>0 时
  push candidates/refs/diagonal(`norm_by_slot`)/correlations(raw_dot) → `direct_axes_core(Explain, keep_basis=false)`。
- 星团相位：CSR 前 `star_neighbors` 条 + 同上 raw_dots → `star_direction`。
- `star_neighbors` 的读取位置从 pool 构建后**提前到 CSR 构建前**（截断需要）。

## 4. coverage 分块归约（位级陷阱）

上游 `ids.par_chunks(128).map(...).collect()` + 跨块串行 `for (energy,values) in partial { total+=energy; ... }`。
f64 分块部分和再合并与全串行累加**位级不同**——我方无 rayon，用 `ids.chunks(128)` 复刻同一分块边界与合并顺序。
每块内复用一个中心化缓冲 `x`（`out = val - m` 原地写）+ `accumulate_captured_energy`（4 路分块位保序）。
P0 注释「串行同序位级等价」的说法是错的，已在本仓实现中纠正。

## 5. 常量与标识

- `ALGORITHM = "unified_geometry_ags_t4_cached_reorth"`（源码 :383；README §4.3 写 v4 是文档措辞——**以源码为准**，
  artifactSig 把它纳入哈希，拷错必异串）。
- `epaAlgorithm = "ags-global-star-t4-cached-reorth"`（epa_basis_cache JSON 内，:899）。

## 6. 不随移植（我方本地约定）

- workspace handoff（`storage::memo_workspace_slot` / `workspace::SnapshotKey` / `handoff.offer`）：上游供建图
  （memo_artifact_builder）复用同一 mmap 快照；我方无 storage.rs、builder 为独立实现无接收端——
  workspace 生命周期保持到函数尾自然释放，无数值影响。
- `publication_gate` / `content_revision` / `with_registered_*`：写路径走我方 `open_readwrite` 单事务（BUG-0930 keepalive）。
- rayon：局部/星团相位每 id 独立闭包（无跨 id 归约）⇒ 串行 map 位级等价；coverage 见 §4。

## 7. 差分口径备忘（P3 全腿）

- 官方 `.node` 无 geometry 入口 ⇒ 差分里 oracle 侧恒「无几何背景」（rebuild 清 stale 资产后空跑）。
  geometry 端到端位级对照需真 oracle（`/tmp/vcp20-9aa1f67` cargo 自建），入口：
  oracle `runtime.computeMemoGeometry(db, modelSig, config)`（napi camelCase）vs 我方顶层 `runMemoGeometry(db, modelSig, config, dim)`。
- oracle rebuild 会**清空** stale 几何资产（`tag_intrinsic_residuals` 全删、`tagmemo_artifacts` 清空、
  `epa_basis_cache` 删除）——复现脚本 `/tmp/geo-verify/repro-oracle.mjs`，artifactSig 047e31dd5ac4… 可逐位复现。
  我方 builder 未对齐此行为（builder 腿 scope）。
- 金字塔 similarity：上游硬编码 cosine（`memo_pipeline.rs:699`），无 similarityMode 开关；
  legacy=1/(1+L2²) 与 cos 恒等换算 `legacy = 1/(1+2−2cos)`（判别式，逐位验证过）。
