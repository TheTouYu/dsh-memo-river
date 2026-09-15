# 04 — memo_approve 并行批处理

**What to build:** `memo_approve` 批量批准草稿时，逐篇串行的嵌入+入库改为按既有并发上限并行执行，并汇报总进度；单篇失败不影响其余（部分成功语义 + 明细回报）。用户视角：批准 10 篇草稿的等待从 ~25s×N 量级降到接近最慢单篇的耗时。

**Blocked by:** None — can start immediately.

**Status:** done — 2026-09-15（worker-pool 并行落地：探针实测串行 7497ms vs 并行 2523ms=2.97x、峰值并发 5、混合批次部分成功 + 无半写；acceptance 35/35）

- [x] 批准 N 篇耗时 ≈ 最慢单篇耗时（N≥5 实测对比串行基线）
- [x] 构造一篇必然失败（如 Tag 不足）的混合批次：其余成功、失败篇在结果中逐条说明，不入库不半途崩溃
- [x] Tag 闸门对每篇的判定与逐篇串行版一致（闸门语义不变）
- [x] approved/ 目录与库内 files/chunks 状态一致（无半写）

## Notes（实现与证据）

**实现落点（src/tools.ts，memo_approve execute）**
- `APPROVE_CONCURRENCY = Number(process.env.MEMO_APPROVE_CONCURRENCY) || 5`（模块级，模式逐字复刻 embed.ts 的 `TAG_VECTORIZE_CONCURRENCY`；=1 即精确退回串行）。
- 逐篇闸门链原封搬进 `approveOne(record)`：`workspaceFor → curateTags（∩ 词汇表）→ TAG_MIN 跳过 → writeDiaryCore → resolveDraft`——**代码零复制零改动**，Tag 闸门语义与串行版是同一份。
- worker-pool：`Array.from({length: min(C, N)})` 个 worker 抢 `cursor++`（同 embed.ts 批调度形状）；`outcomes[idx]` 按原下标落位——完成序乱、汇报序不乱（与串行输出序一致）。
- 部分成功：单篇被拒=该篇 ❌/⏭ 行（原语义）；**意外异常**新增 try/catch 兜底折算该篇失败行（留 pending/ 可重试），整批绝不半途崩溃。
- 进度汇报：每篇完成经 `deps.log` 落中央日志 `memo_approve progress=i/N file=…`；小计行新增「耗时 Xs（并行度 N）」。
- 并发安全依据：同桶共享同一 WorkspaceRuntime（acquireWorkspace 按 cwd 哈希缓存）——better-sqlite3 全同步调用天然串行、`ensureLoaded` 单飞、`engine.ensureArtifact` runExclusive 串行化资产重建；approve 路 newTags 恒空（curateTags 只复用既有词），无新 Tag 向量竞态；`reloadDiaryIndex` 函数体全同步无 await，天然原子。

**实测（.scratch/perf-funnel-0915/probe-approve-parallel.mjs，模拟 relay RTT 1200ms=实测 1.19–1.45s 代表值，混合批次=6 可批 + 1 必失败[建议 Tag 全新⇒策展 0<3]）**
- 串行基线 C=1：wall=7497ms、嵌入请求 6 次逐一发出（服务端峰值并发=1）。
- 并行 C=5：wall=2523ms（≈⌈6/5⌉×RTT）、峰值并发=5、请求恰 6 次（不重复不多发）→ **2.97x**；外推真实 RTT：33 篇草稿 ~25s/篇量级 → ⌈33/5⌉×~1.4s ≈ 10s 级。
- 部分成功：6 ✅（各 → D-id「标题」（Tag：…）→ approved/）+ 1 ⏭「可复用 Tag 仅 0 个（无）< 3，待人工 memo_write…」；小计「批准 6 / 跳过 1」。
- 无半写：库内 files +6 == approved/ 6 文件；必失败篇留在 pending/；并行轮 chunk-id 乱序（d3→D6、d5→D4）证明真交错而输出行序不变。
- 探针工程：并行度是模块加载期常量 ⇒ 父进程两次自再入（C=1/C=5）子进程对比；子进程自净 memo-river 根 + 临时 cwd，并先清理「桶=探针桶且 cwd 已消失」的孤儿根（首跑实测孤儿 pending 会经 all=true+bucket 过滤混入本批）。

**验证**：npm run typecheck 干净；npm run build 成功；node scripts/acceptance.mjs **35/35**（#14 草稿消费通道走新实现全绿）。

**语义边界（记录，不处理）**：① 并行批内 B 篇的内容去重闸门可能读到 A 篇落库前的语料快照——同批两篇互为近重复的极端场景，串行版会拒第二篇而并行版可能双写；回合草稿正文互异，不受影响。② 新文件名 `${date}-${ms36}-${slug}` 的同毫秒+同 slug 碰撞需同批两篇标题前 24 字全同——工程上不可达，且该边界与并发的 memo_write（跨会话）本来就共享。
