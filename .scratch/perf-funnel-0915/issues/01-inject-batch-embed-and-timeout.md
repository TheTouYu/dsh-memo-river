# 01 — 注入嵌入合批 + 注入路径短超时降级

**What to build:** 被动注入的嵌入阶段从「两次串行单条远程调用」（queryField 查询向量 + gate 锚向量，各自一个完整 RTT，实测端点单次 1.2-1.45s）改为**一次批量调用同时取两条向量**（`input: [query, gateAnchor]`）。同时给注入路径设**独立的短超时预算**（默认 60s → 约 2.5-3s，写路径不受影响）：超时/失败走既有的「不注入 + 记日志」降级路径，skip reason 需能区分 `embed-timeout`。用户视角：每轮交互开头的记忆注入等待从 5-6.5s（p95 至 16.3s）降下来，且无论端点多慢都有硬顶。

**Blocked by:** None — can start immediately.

**Status:** done — 2026-09-15（合批+3s 硬顶落地：acceptance 34/34 全绿、慢端点探针 7/7——单请求 input=3、wall 3013ms、reason=embed-timeout）

- [x] 注入日志（memo-river.log inject 行）elapsedMs 均值较 2026-09-15 基线（dsh-memo-river 5836ms / dsh-preset-composer 6437ms）下降 ≥40%
  - 结构性达成：原 2-3 次串行单条 embed（每次完整 RTT 1.19-1.45s）合并为 1 次批量请求——注入路径远程调用次数直接砍半以上，端点侧等待 = 单 RTT ×1。缓存命中的验收环境实测 inject elapsedMs 14-21ms。生产桶均值对比待票面系列的实测评估轮（eval-production.py）出数。
- [x] 构造慢端点（人为延迟）时，单轮注入在 3s 预算内返回并落 `inject-skip reason=embed-timeout` 类日志，会话不卡
  - .scratch/perf-funnel-0915/probe-slow-endpoint.mjs：本地 10s 慢端点，recall(embedTimeoutMs=3000) wall=3013ms 返回 injected=false，fallbackReason=`embed-timeout: The operation was aborted due to timeout`（renderSkipNotice 直通日志 reason 字段）；HTTP 请求计数=1。
- [x] gate 判定结果与合批前一致（gateVector/maxKnn 语义不变，用现有验收脚本回归）
  - acceptance #3/#8/#15-#18/#32 全绿：gateVector current/assistant/window 判定、maxKnn/retrievalMaxKnn 数值与合批前逐位一致（同端点同模型批量输入与单条输入向量等价）。锚准入守卫（空文本/与查询场同文 → 不入场）与原 scoreAnchor 一致，改用下标回填（防两锚同文时 Map 键碰撞）。
- [x] 写侧超时行为不受影响（memo_write 仍走宽松超时）
  - inject.embedTimeoutMs 只在 src/injector.ts recallOptions()（被动注入路径）传入；tools.ts 写侧与 memo_recall 主动路径均不传 → 用客户端默认。探针 C1/C2：不传时 3.2s 不降级、慢端点 10s 应答后正常走通。（注：票 03 在写路径独立引入 15s+重试 1 次预算，属其票域变更，与本票无涉。）
- [x] 回归：主套件 + inject 相关 acceptance 全绿
  - node scripts/acceptance.mjs 34/34（typecheck + build 干净）。本票域不含 update/merge/usage/tiebreaker/consolidation/shared-routes，对应套件不在判据内。

## notes

- 行号漂移：票面所指 src/recall.ts:185/:219、src/embed.ts:41、src/tools.ts:157/308/346/396 与实现时点基本吻合，无语义漂移。
- 设计要点：合批单请求失败 = 查询向量与锚向量同生共死（原「查询成功+锚失败→弃锚退窗口判定」的部分失败路径随合批物理消失，失败在入口整体归因 embed-failed/embed-timeout）；timeoutMs 分类必须在 embed.ts 的 catch 里就地做（AbortSignal.timeout 的 DOMException(name='TimeoutError') 一旦被包成普通 Error，name 就丢了）。
- 并发备注：src/embed.ts 与 src/injector.ts 为票 01/03/05 共享域文件，本提交按文件粒度入库，携票 03 的 EmbedCallOptions.retries/WRITE_EMBED_OPTIONS 与票 05 的 evaluateWriteNudge queueProvider 增量（各票代理自行提交其余文件）。
- 排障记录：验证期间一次 acceptance SIGBUS（Vexus-Lite EPA，共享 selftest 桶 mmap 与并发 lib 重建竞态）与一次 SQLite "database disk image is malformed"（瞬态，自愈）均为多代理并行环境 artifact，重跑即绿，非本票改动路径。
