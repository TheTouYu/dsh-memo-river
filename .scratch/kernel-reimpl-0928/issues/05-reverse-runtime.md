# 05 — 逆向补全：knowledge_runtime.rs（1536 行，日记索引注册/river 查询执行）

**What to build:** 行号+系数级逆向文档至 `kernel/docs/reverse-runtime.md`：NativeKnowledgeRuntime 的构造/注册表生命周期（registerDiaryIndex/unregister/state/stats）、executeRiverQuery 与 Hybrid 的执行计划、缓存与代际失效（tagIndexGenerationalBaseline 的上游语义）、watcher 生态。5 个既有 #[test] 逐个解读入文档。

**Blocked by:** 02

**Status:** ready-for-agent

- [ ] 注册表数据结构与并发面（单活动代际）落文档
- [ ] executeRiverQuery / Hybrid 执行计划落文档（与 tests/nativeHybridRiverQueryPlan.test.js 断言对照）
- [ ] 5 个内嵌 #[test] 的意图与覆盖面解读
- [ ] 文档头标注逆向快照版本
