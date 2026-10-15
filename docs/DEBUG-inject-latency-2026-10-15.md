# DEBUG：注入 pre-step 2–4.3s 延迟归因（2026-10-15）

## 0. 结论先行

**主导成本 = 嵌入批的真实编码时长（620–1390ms）× 联邦双请求串行（×2）**。"本地嵌入 40ms"是在短探针文本上测的——真实注入批是 **4200–5400 字符**，单次 encode 就要 620–1390ms；而桶继承联邦让主桶与父桶（常识库）**把同一批文本各打一次端点**，服务端单锁把第二个请求串成 `wait(=第一个的 enc) + 自己的 enc`，inject 行的 `elapsedMs = max(两桶)` 恰好等于**后到者的总时延**。

| 时点 | elapsedMs | 服务端对照（同钟） |
|---|---|---|
| 切换前（远端 OpenRouter） | 3735 / 3751 / 5051 | — |
| 切换后首轮 10:51:50 | **4314** | 冷首前向 ~1542ms + 双请求串行 + native 首载 |
| 稳态 10:54:25 | **2021** | 19:09:06 对：leader enc=1389.3 / follower 1367.0+871.9=**2245.7**（同类） |
| 稳态 11:01:35 | **1016** | 19:10:09 对（chars=4234）：leader 623.8 / follower 622.4+393.4=**1020.4** ✓ |
| 稳态 11:10:15 | **1532** | 19:10:14 对（chars=4746）：leader 750.2 / follower 748.2+767.6=**1524.1** ✓ |

其余全部 <50ms：rust 读出 `totalMs=10.4`、`pipelineElapsedMs=5`、JS 选择/渲染微不足道。**约 2s 的"无人认领"全部认领完毕：~50% 是真 GPU 编码（长文本），~50% 是联邦双请求被单锁串行。**

**已实施修复（服务端，dsh-embed 已重启生效）**：in-flight 去重 + 120s TTL 缓存——联邦成对请求只编一次，后到者等事件即回。预期 inject `elapsedMs` 从 `2×enc` 降到 `1×enc`（≈650–1400ms，随查询场长度）。配套观测：每请求 `[req]` journal 行 + `/health` 计数器/分位数。

## 1. 证据链

### 1.1 elapsedMs 的罩门：全部在 recall() 内部，且 = max(主桶, 父桶)

- `src/injector.ts:643`——inject 行 `elapsedMs=outcome.elapsedMs`；`src/federate.ts:102`——`elapsedMs: Math.max(...runs.map(r => r.elapsedMs))`。父桶慢直接决定数字。
- 桶日志三点同钟（UTC）：
  ```
  11:01:34.277 query-field-excluded session=2cf22394
  11:01:35.342 inject … elapsedMs=1016          ← 间隔 1065ms ≈ 1016 + 49ms
  ```
  ⇒ buildTailInjection 里 recall 之外的装配（含 openInheritedBuckets 的 118 桶目录扫描）<50ms，不背锅。

### 1.2 决定性对照：同一注入的两个 [req]（服务端埋点后）

```
19:05:13.423 [req] n=3 chars=5212 wait=0     enc=668.2 total= 674.1   ← 主桶（先到，拿到锁）
19:05:13.424 [req] n=3 chars=5212 wait=667.9 enc=667.6 total=1340.5   ← 常识库父桶（同一批文本，排队+自己编）
19:05:13.806 inject … inherited=2 elapsedMs=1344                       ← = 父桶 total 1340.5 + ~4ms ✓
```
复现命令：`journalctl --user -u dsh-embed --since "19:05" --no-pager | grep '\[req\]'` 配合
`grep -E "inject |query-field-excluded" ~/.dsh/memo-river/b94d8836d6175817/memo-river.log | tail`。
两请求相差 1ms、内容逐字节相同——来源是 `src/recall.ts:451` 每个桶各自 `embed.embed([queryField, gU, gA])`，而 emb-cache **每桶一份**（`src/workspace.ts:77` `cachePath=paths.embCachePath`），查询场每轮变化 ⇒ 两桶都 miss ⇒ 双请求。

### 1.3 "40ms" 是短文本假象：encode 随字符数线性走

服务端 `[req]` 实测（未改 encode 逻辑前）：
```
n=3 chars=  79 enc=  37ms     （探针短批）
n=1 chars=1864 enc= 199ms     （写侧单长文）
n=2 chars=4234 enc= 624/393ms （注入批 leader/同型重打——同文本 1.6× 时钟抖动）
n=3 chars=4746 enc= 750ms
n=3 chars=5422 enc=1389/872ms
```
任务给的"单条 p50 23–25ms / 注入形态 40ms"来自 `scripts/probe-embed-latency.mjs` 的短样本文本（P2/P6 实测复核：23ms/41ms ✓）——**测的是短文本，不是真注入形态**。注入查询场 = `queryLookback=6` 条消息拼接（`src/config.ts:283`），长会话下 4000+ 字符是常态。

### 1.4 其余分段实测（全部 <50ms，排除）

- rust 读出：`readoutDiagnostics={loadMs:6.5, computeMs:3.8, totalMs:10.4}`，`pipelineElapsedMs=5`（memo_recall diagnostics 实测）。
- 客户端开销：probe-embed-latency P6 经真 EmbedClient 路径注入形态 p50=41ms（干净进程）——undici/缓存/JSON 各环节无罪。
- 父桶本身很小：常识库仅 14 chunks，`native-loaded` +51ms；4 并发会话的 withDb 排队不进 elapsedMs（`started` 在闸内起表，`src/recall.ts:391`）。

### 1.5 首轮 4314 与冷启动

服务重启后**首前向**实测 1542ms（内存宽裕）/ 4403–5769ms（swap 压力下，模型重载 6.9s→49.3s，RAM 9.6G/15.7G + ~1G swap）。首轮 4314 ≈ 冷 encode ×2（双请求）+ native 首载 1.74s 的形状。注入路径 embed 超时仅 3s：**重启后首个真实注入必然超时回退远端**（面板 failover 计数因此 +1/次重启）。

## 2. 已排除的假设（含失败尝试）

| 假设 | 证伪方式 | 结果 |
|---|---|---|
| dbGate/守护循环争用拖慢 inject | 守护轮 15min 一轮；elapsedMs 起表在闸内 | 排除（闸前等待不进 elapsedMs） |
| runExclusive 排队 | 三点同钟：[req] 到达即开始 enc，inject 在 enc 完成后 ~4–30ms 落行 | 排除（无空转间隙） |
| rust 读出慢 | readoutDiagnostics 实测 10.4ms | 排除 |
| undici/emb-cache 客户端开销 | P6 真 EmbedClient 路径 41ms | 排除 |
| 向量缓存未命中（额外往返） | 每轮查询场都变，miss 是设计使然；只造成 1 次必要 encode | 非主因（主因是 miss 后的 encode 太贵） |
| 服务端有排队堆积（wait 大） | [req] wait=0（无并发写时） | 排除——wait 只在联邦对/写并发时出现，且正是 1.2 的机制 |
| **拆单条前向省 padding（我的尝试）** | 实测 3800 字批：拆条 ~700ms vs 整批 623–750ms，同噪声带 | **证伪**——成本是每 token 线性项（分词+CPU 编组，GPU util=0% 佐证），非批内 padding。已回退 |
| 停机窗口无伤害 | — | **我错了**：见 §4 事故记录 |

## 3. 修复建议（按性价比排序）

### 已实施（服务端 `scripts/local-embed/server.py`，重启 dsh-embed 生效）
1. **观测**（任务硬要求）：`[req]` 每请求一行（ts/来源端口/n/chars/hit/body/wait/enc/json/total）+ `/health` 带 counters 与 wait/encode p50/p95/max + 最近 16 条。**排队时延从此可观测**。
2. **in-flight 去重 + 120s TTL 缓存**：同批文本后到者等先到者编完即回（事件语义，失败自愈）。验证：`A(leader)=1.59s / B(joiner)=1.54s 同回 / C(hit)=0.002s`。预期注入对 2×enc → 1×enc。
3. 启动预热（try/except 不挡启动）：就绪前自己吃掉 4–6s 冷前向，防"重启后首注入必然超时回退"。**下次重启时生效**（未现场验证，py_compile 通过，失败路径=行为同今日）。

### 未实施（需要人决策/重启 dsh-web，按收益排序）
1. **插件侧联邦预嵌入**（根治双请求）：`federatedRecall` 先把 `[queryField, gU, gA]` 嵌一次，向量传给两桶的 recall（recall 加可选入参）。改 `src/federate.ts` + `src/recall.ts` ~20 行；验收 `acceptance-queryfield 6/6` + 主套件。收益：双请求从源头消失（与服务端去重二选一即可，都留也无害）。
2. **查询场嵌入前截断**（单项最大杠杆）：嵌入输入截到 ~1200–1500 字（保留全文给 rust 管线）。encode 620–1390ms → ~100–250ms。风险：门控/召回分数漂移，需 A/B 定标（gateThreshold 0.55 系按全长度校准的，截断后 maxKnn 分布会变）。
3. embedTimeoutMs 3s 与冷启动的错配：上面预热已缓解服务端；若仍见 failover，考虑注入路径超时放宽到 5s（改配置面）。

### 性能环境项（非本刀范围，记录在案）
- 内存压力：模型重载 2s→49.3s、冷前向 5.8s、body 读 8KB 要 368ms——都是 swap 抖动。GUI+4 会话+2.2G 模型常驻 15.7G RAM 已接近极限。
- GPU 时钟抖动 1.6×（623.8 vs 393.4 同文本）——3060M 移动档降频。

## 4. 事故记录（我造成的，如实入账）

v1 去重有 joiner 悬挂 bug（leader 完成时换了新 Event，joiner 等的那只永不被 set；异常路径 inflight 条目永不过期）。事故窗口 11:13–11:18（UTC）：
```
11:13:27 inject elapsedMs=11496
11:14:15 inject elapsedMs=10440
11:14:35 inject-skip elapsedMs=10982 (gate-below-threshold)
11:18:25 inject elapsedMs=4587   ← 撞上我第 3 次重启的停机窗，回退远端
```
面板 `embedHealth.counters.failover` 1→4（其中 3 次与我的 dsh-embed 重启相关）。v2 修复：完成/失败都 set **原** Event、失败摘条目、joiner 超时自升级 leader。修复后未再复现。

## 5. 未验证假设（明确标注，不是结论）

1. **33 字符 canary 的来源**：19:05–19:14（CST）每 5.025s 一条 `n=1 chars=33` 经 dsh-web 连接池打端点，19:19 后停止。memo 插件仅 5 个 embed 调用点、无一周期性（`grep -rn "\.embed(\[" src/`）——来源**未识别**（疑似某 GUI 面板页的周期探针或某会话绑定轮询，页面关闭即停）。CPU 代价可忽略（~18ms/5s）。`from=` 端口日志已就位，复现时可 `ss -tnp | grep 8099` 对端口定进程。
2. **"无交互 0.36 核"的完整账**：当前空闲实测 3ms/5s；journal 台账显示重负载时段 burst（实例 3：13.97s CPU/195s）。判读：0.36 核 = 当时 4 个并发代理会话的注入+写批+草稿预审叠加（15:43 旧实例每秒 2 对 blob 日志 = 每请求 tqdm 输出，即 ~2 req/s 真实流量），**非泄漏**。但 5s canary 若长期在，属无害但无主的开销。
3. **encode 成本的构成**（分词 CPU vs GPU 前向）：GPU util=0% + body_ms 异常 + 拆条无收益 ⇒ 疑 CPU 侧（分词/编组）占比高；未做逐相分解（py-spy 未上）。
4. **修复后生产 elapsedMs 的实测样本**：验证了机制（join 同回）但**尚未捕到修复后的真实 inject 行**（事故窗后兄弟会话停了，只剩我的会话且节律未到）。预期 ~1×enc（650–1400ms）；待自然流量验证。

## 6. 我证伪了自己什么

1. **"本地嵌入 40ms"被我自己的探针骗了**——探针样本文本短，真实注入批 5 倍长。教训：测"形态"必须用真实负载体（chars 对齐），p50 好看不等于形态正确。（这也正是记忆河流 D6@常识库「读数来自对象还是对象的一条记录」的同族错误：40ms 是短文本记录，不是注入负载的对象级读数。）
2. **我在生产服务上先写坏了再去验证**：v1 去重的事件 bug 让 3 发注入 10–11s + 触发回退。教训：并发原语（Event/锁）改动必须在旁路验证（起第二端口实例或单测）再上生产，即使"只是观测性改造"。
3. **拆条优化的理论账（padding 9000→3900 位置）没兑现**：实测同噪声带——性能假设必须过实测闸，token 线性成本 ≠ padding 主导。
4. 首轮把"每 5s 一条 [req]"当异常追：它确实无主，但 CPU 代价 ~0.4% 核，不是 0.36 核的答案——量级感先于追查方向。

—— 诊断：dsh-memo-river 延迟归因子代理（session-2cf22394），2026-10-15 19:25 CST 完稿。
