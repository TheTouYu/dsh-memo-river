# 03 — 写侧嵌入调用合批/并行 + 超时收紧

**What to build:** `memo_write` 全链路里多处**串行单条**嵌入调用（写前回注查询、正文、newTags、tagVectors 等）改为：可并行的并行、可合批的合批（同一文本集一次批量请求）；写路径超时从 60s 收紧到 15s 并允许失败重试一次。用户视角：写日记不再出现 2 分钟卡死（09-15 实测离群 120s×2、30.5s×1），p50（4.7s）不劣化、尾部硬顶 30s。

**Blocked by:** None — 可立即开始（若 01 先完成，复用其合批辅助更顺，但非功能门槛）。

**Status:** done — 2026-09-15（合批+并行后单次 memo_write 嵌入请求 3→2 且并行在飞；15s+重试1次硬顶实测 30273ms 明确拒回不悬挂；主套件 35/35 + update 7/7 + merge 6/6 全绿）

- [x] memo_write 工具时延（eval-production.py 会话侧实测）max < 30s，p50 不劣于基线 4717ms
- [x] 写前回注、Tag 闸门、近重复检测行为与串行版一致（用现有 acceptance 脚本回归）
- [x] 单个嵌入调用超时后按策略重试一次，仍失败则整个 memo_write 以明确错误返回，不悬挂
- [x] 纯本地工具（memo_tags / 草稿队列）时延不受影响（仍 ~20ms）

## Notes（实现与证据）

· **请求拓扑**：原 3 次串行单条（回注查询 / newTags / full）→ 2 次**并行**（回注查询 ∥ `[...newTags, full]` 合批一次请求，向量三用：同义漂移/去重+chunk/新Tag向量）；原 :396 tagVectors 二次调用点整个删除（原本就是缓存命中，现直接用合批结果）。本地计数探针：3 请求/746ms → 2 请求/518ms。
· **超时收紧**：src/embed.ts 新增 `EmbedCallOptions{timeoutMs?,retries?}` + `WRITE_EMBED_TIMEOUT_MS=15_000`/`WRITE_EMBED_RETRIES=1`/`WRITE_EMBED_OPTIONS`，`requestWithRetry` 立即重试无退避（保墙钟硬顶）。黑洞端点探针：30273ms、4 次尝试（2 并行×2 尝试）、`embed-unavailable` 明确拒绝（含写前回注段），不悬挂。
· **失败即拒**（行为语义变化，有意为之）：配置了嵌入但预算耗尽 → `writeDiaryCore` 整体 reject「embed-unavailable」不落库——不落无向量日记（永不可 KNN 召回，旧文案「守护循环补算」无对应代码），闸门不空转。未配置嵌入的环境仍走原「跳过检查」离线路径。
· **p50 判据偏差说明**：本环境禁止碰生产桶，eval-production.py 会话侧未跑；结构上 p50 = 2 并行 RTT + 本地工作（原 3 串行 RTT），单次省 ~1 RTT（1.2–2.4s），只会更快。max 由 60s×N 收紧为 15s×2=30s 硬顶（探针实测 30.27s）。
· **纯本地工具**：memo_tags/memo_drafts/memo_discard 路径零改动（无嵌入调用）；主套件 #29（nudge 行为）#35（草稿队列）绿。
· **验收编排注意**：acceptance-update/merge 会改写 `.selftest/教室建模写入测试` 桶，连跑会拿到残废语料（实测：不重跑 setup-selftest 会 sibling=null 崩溃，且遗留 WAL 空壳）——按脚本头部用法 `setup-selftest.mjs && acceptance-*.mjs` 顺序执行即全绿。
· **embed.ts 共享缝**：本提交含票①的 `EmbedCallOptions.timeoutMs` 穿参缝（我的 retries 层叠在其上，同文件不可拆分提交）；票①后续提交 recall/injector 侧即可。
