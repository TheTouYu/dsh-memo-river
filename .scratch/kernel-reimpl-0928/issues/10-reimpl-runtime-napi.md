# 10 — 复刻 runtime + NAPI 绑定面（1536 行 + lib 契约）

**What to build:** `kernel/src/knowledge_runtime.rs` + lib 的 N-API 导出面收口：VexusIndex / NativeKnowledgeRuntime / runMemoPipeline / rebuildMemoArtifact / rerank 双出口 / clearMemoRuntime / memoRuntimeStats。契约对齐上游 index.d.ts（JSON 载荷形状逐字段）。usearch 索引层（VexusIndex 的 upsert/search/save/load/recoverFromSqlite）一并复刻。

**Blocked by:** 09 + 06

**Status:** blocked

- [ ] 上游 index.d.ts 契约面全导出（导出清单 diff 为空）
- [ ] native.ts 加载验证：loadVexus 指向 kernel/ 后 VexusIndex/NativeKnowledgeRuntime 实例化成功
- [ ] 双轨全链差分：三桶回放全绿（runMemoPipeline→rerank 端到端）
- [ ] 索引层一致性：同批向量 upsert 后 search top-k 双轨一致（seeded 确定性夹具）
