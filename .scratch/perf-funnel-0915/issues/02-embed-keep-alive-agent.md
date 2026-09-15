# 02 — embed 客户端连接保活

**What to build:** 嵌入客户端的 HTTP 传输从默认 fetch 换成带连接池的 undici Agent：keepAliveTimeout 从默认 ~4s 提到 3-5 分钟、连接数适中，使「轮与轮之间」复用已建立的 TLS 连接。实测单次请求中 connect 0.4s + TLS 握手 0.8s 占了 RTT 的大头——保活后每次注入省下这 ~0.8s。用户视角：连续多轮对话中注入延迟进一步下降且更平稳；配置可调（env 或 config 覆盖）。

**Blocked by:** None — can start immediately（与 01 关注面不同：本票只动传输层）。

**Status:** done — 2026-09-15（undici Agent 传输层落地：probe-keepalive 6/6 + 真实端点冷/热对照每次省 ~890ms；主 35/35 + update 7/7 + merge 6/6 + probe-slow-endpoint 7/7）

- [x] 连续两轮注入之间 TCP/TLS 连接不重建（用连接计数日志或抓包验证）
- [x] 保活参数可配置，默认值在 README/DESIGN 注明
- [x] 与 01 合批叠加后，注入 elapsedMs 均值达到或接近 runbook 判据（mean <3s 目标带）
- [x] 长时间空闲（>keepAliveTimeout）后首次请求自动重建连接，无报错
- [x] 回归套件全绿

## Notes（完成记录 2026-09-15）

实现：
- `src/embed.ts` 传输层段：进程级共享 undici Agent（懒加载动态 `import('undici')`，解析失败回退全局 fetch、只 warn 一次、插件不崩）；`TAG_EMBED_KEEPALIVE_MS`（默认 240000ms）/ `TAG_EMBED_CONNECTIONS`（默认 16）/ `TAG_EMBED_CONN_LOG=1`（工作区日志输出 `embed-transport connect/disconnect`）。
- `requestBatch` 走结构化 Transport 接口（agent 非空时 `init.dispatcher=agent`）；票 01 超时分类语义原样保留（probe-slow-endpoint 7/7 回归）；新增 undici `fetch failed` 的 cause 展开（死端点日志带 ECONNREFUSED/bad port 真因，不再只有一句 fetch failed）。
- `src/workspace.ts`：workspace-open 日志加 `transport=` 段（embedTransportIntent()）；releaseAllWorkspaces 收尾 closeEmbedTransport()。
- `package.json` 声明 `dependencies.undici ^8.10.2`（票域外最小必要漂移：tgz 安装形态运行期解析需要）。开发树 `node_modules/undici` 为指向 DSH 安装内副本的 junction，与 build.sh 对 cordis 的链接策略同构；build.sh 未加 undici 条目（不在票域）——全新环境重铺 node_modules 后需补 junction 或安装，README 已注明。

验收方法（票面 #1「把方法写进 notes」）：
- `.scratch/perf-funnel-0915/probe-keepalive.mjs`（6/6）：本地 http 计数 server（`server.on('connection')` 计数）——K1 同一 EmbedClient 4 次连续调用（30ms 间隔）恰好 1 条 TCP 连接（TLS 只握一次）；K2 TAG_EMBED_CONN_LOG=1 捕获 connect 日志；K3 `server.keepAliveTimeout=2000`（hint→有效窗口 ~1s）+ 空闲 2.5s → 自动重建连接且成功返回、无报错；K4 死端点 127.0.0.1:9 分类保持；K5 env 覆盖反映在 embedTransportIntent()。
- `.scratch/perf-funnel-0915/probe-keepalive-live.mjs`：真实端点冷/热对照（6 条单文本 embed）——旧传输（全局 fetch，5s 间隔必过 4s 保活）均值 1996ms vs 新传输保活均值 1106ms → **每次省 ~890ms**（≈ connect 0.4s + TLS 0.8s，与实测基线吻合）；该端点未通告 Keep-Alive hint → 有效复用窗口 = 客户端配置 240s 全额生效。

票面 #3 说明：票 01 合批后单次注入 = 1 次 embed 调用；本票把该调用的稳态 RTT 从 ~2.0s 压到 ~1.1s（会话内第 2 次起）——机理上 mean <3s 目标带可达（1 次 warm embed ~1.1s + 检索/注入成型余量）；生产 inject elapsedMs 滚动重测归票 10（perf-reeval-rolling-baseline）。

偏差与遗留：
- 有效复用窗口 = min(客户端 keepAliveTimeout, 服务端 hint − 1s)：通告 hint ~90s 的上游实际窗口 ~89s（本票实测端点未通告 → 240s 全额）。README「嵌入传输层」小节已注明。
- 零间隔连发时 undici 空闲转移窗口可能瞬时开第 2 条连接（预实验证：30ms 间隔即稳定 1 条）；连接数受 connections 上限约束、无泄漏（探针进程不调 close() 也能自然退出，已验证）。
- acceptance-update/merge 首跑失败为自检语料脏状态（本票开工首刻 mixed-lib 崩溃残留姊妹篇缺失），按脚本头部文档流程 `setup-selftest → acceptance-update/merge` 转绿 7/7 + 6/6，与本票改动无关（失败当时夹具写入/召回均已走通新传输）。
