# 06 — 逆向补全：lib.rs（4285 行，N-API 面 / SVD / 运行时）

**What to build:** 行号+系数级逆向文档至 `kernel/docs/reverse-lib.md`。已有基础：逆向文档 §1 的 N-API 导出表（runMemoPipeline lib.rs:850 等）。补全：SVD（nalgebra）的调用形状与数值口径、projectDualWeighted（lib.rs:586）/ fuseMemoContext（lib.rs:697，注意全仓无 JS 调用者）、MemoRuntime 生命周期与 observationHandle 缓存、env 清理路径。**本票在 10（runtime+NAPI 复刻）前完成即可。**

**Blocked by:** 02（建议排 07/08 之后做，届时对内核行为的手感更足）

**Status:** ready-for-agent

- [ ] N-API 导出表复核（与现有逆向文档 §1 对账，标注差异）
- [ ] SVD/projectDualWeighted/fuseMemoContext 数学与调用形状落文档
- [ ] MemoRuntime 缓存与 observationHandle 生命周期落文档（native.ts 依赖面）
- [ ] 文档头标注逆向快照版本
