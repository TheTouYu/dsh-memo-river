# schema 对齐核对表（P0.2 · AGS 几何落库）

> 来源：V4.1-Flash 子代理只读核对（2026-10-22 凌晨），三方对照 2.0=`/home/h/app/VCPToolBox-2.0/rust-vexus-lite` vs 我方仓 vs 生产桶对象级复核。
> 消费方：复刻计划 P0.2（AGS 几何落库段）。

## 结论

1. **残差表零缺列、零 ALTER**：`src/schema.ts:21` 的 `tag_intrinsic_residuals` 已含全部 12 列，与 2.0 `schema.rs:123-136` 逐项一致（生产桶 b94d8836d6175817/16fb0bb2a27be04d 对象级复核列序命中）。P0.2 直接抄 2.0 的 11 列显式 INSERT。
2. **真正硬缺口 = `kbm_runtime_meta`**（CREATE 在 2.0 `storage.rs:676-681`，不在 schema.rs）：`read_generation` 取 `key='database_generation'`、`DerivedDependencies::capture` 取 `key='memo_tag_facts'`，均 query_row——**缺行=SQL 报错不是默认值**。必须最先建并 seed：`schema_version='1'`、`database_generation='0'`、`derived_geometry='0'`、`memo_tag_facts='0'`（+ schema 初始化需 `global_chunk_facts`）。
3. **已有且逐字一致**：`tagmemo_artifacts`（schema.ts:24）、`rivermemo_artifacts`（schema.ts:17，19 列全同）；`tag_intrinsic_residual_status` 也在（schema.ts:20），唯一差异=我方多 FK(tag_id)→tags(id) ON DELETE CASCADE（保留登记，不重建；store.ts:69 开着 foreign_keys，并发删 tag 会回滚——2.0 只留悬挂行）。
4. **禁止逐字移植 `migrate_geometry`**（schema.rs:288-320）：它会 DROP 我方 pairwise 触发器、`DROP TABLE tag_pair_similarity{,_status}`、删 kv 代际键、首次切换清空 epa_basis_cache+两残差表。P0.2 只取「建表 + memo_geometry.rs:647-700 写入段」。
5. **epa_basis_cache 换形状读侧安全**：唯一读者 `kernel/src/memo_pipeline.rs:234 analyze_epa` 只取 basis/mean/labels；EpaCache（:179-186）无 deny_unknown_fields → 新键静默忽略。代价：kSem/coverage 不被消费（我方 EPA 仍 v9.2 全 basis 口径，2.0 按 Ksem 截断）。**`artifactSig` 键必须写**（2.0 缓存命中判据 memo_geometry.rs:490-495；缺了不报错只全量重算=隐蔽性能退化）。
6. **我方当前没有活的 EPA 产出方（实测）**：`src/native.ts:404` 调 publishEpaBasisCache，但已构建 .node 的 VexusIndex.prototype 实测只有 7 方法（addBatch/clearMemoRuntime/rebuildMemoArtifact/recoverFromSqlite/rerankMemoDtsc/rerankRivermemoTopologyV3/runMemoPipeline），无 computeEpaBasis/publishEpaBasisCache/computeIntrinsicResiduals → 抛错被 :405-411 catch 吞掉。生产桶只有旧形状缓存（epaAlgorithm='density-residual-sampling'+svdRows/anchorCount 等，全仓 0 消费方）。**P0.2 geometry 成为新产出方**。
7. **新表落 `src/schema-local.ts`，别改 `src/schema.ts`**（gen-schema.mjs 从 classroom-flow 参考库整份再生，改了会丢）。
8. **读侧陈旧校验缺口**：2.0 load_anchor_gains（memo_artifact_builder.rs:135-172）JOIN tagmemo_artifacts(asset_type='unified_geometry') 并校验 graph_generation==`facts:{facts}`，不符抛 KNOWLEDGE_STORE_DERIVED_DEPENDENCY_CONFLICT；我方 :256-260 无此校验 → P0.2 几何写入后，我方 builder 会把陈旧几何 gain 当当前事实用。**建议同批补**。
9. **范围外阻塞**：2.0 写路径依赖 storage.rs/publication_gate.rs（我方 kernel 无），geometry 主体需薄封装（复用 memo_artifact_builder 的 keepalive 事务 + 自写 generation 校验）。

## 最小 DDL 增量（依赖序）

1. `kbm_runtime_meta`（CREATE + seed 四键）——硬阻塞，最先
2. 残差表/状态表/tagmemo_artifacts/kv_store——增量 0
3. 索引——新增 0；可选删 `idx_intrinsic_residual_artifact`（schema.ts:33，2.0 已废弃该索引，整表 DELETE+INSERT 无选择性）
4. `kbm_artifact_dependencies`（schema.rs:179-185）——仅同批移植 builder 依赖记账时必建（排 rivermemo_artifacts 之后）

## 必须逐字一致（否则写入失败/静默退化）

- `kbm_runtime_meta` 键名：database_generation / memo_tag_facts / derived_geometry
- `tagmemo_artifacts.graph_generation` 值格式 `facts:{facts}`（memo_geometry.rs:448）
- `asset_type='unified_geometry'` + `status='ready'` 字面量
- 残差表写入约定：`v9_anchor_gain=同 clamp 增益值`、`v8_3_compat_gain` 写 NULL、status='computed'（memo_geometry.rs:665-667）；真残差只落 raw_residual_ratio
- `epa_basis_cache` JSON 键 camelCase（尤其 artifactSig）；epaAlgorithm='ags-global-star-v2'
- `ALGORITHM='unified_geometry_ags_v2'`（memo_geometry.rs:224）
- 旁支（index lifecycle 才需要）：chunks.vector_version/metadata_version、files.metadata_version 我方 schema 均无
