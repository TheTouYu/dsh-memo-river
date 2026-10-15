# 嵌入端点延时核验（2026-10-14 首测 → **2026-10-15 换链路后重测，本文件以第一节为准**）

**探针**（都可复跑，已按"读真实配置"改写）：
- `scripts/probe-embed-latency.mjs` — 分相位延时分布（P1 冷启动 / P2 单文本 / P3 批 32 / P4 并发 5×批 8 / P5 长文本+写侧批 / P6 经 EmbedClient 注入形态+命中缓存 / P7 持续观测 5min / P8 直连 vs 代理）
- `scripts/probe-embed-reliability.mjs` — 逐次记录结果/错误类/延时（**跳闸关**，看端点真面目）

---

## 一、当前链路（2026-10-15 03:26 编译 / 13:05:21 重启，PID 87658）

**端点** `https://openrouter.ai/api` ｜ **模型** `baai/bge-m3` ｜ **维度 1024** ｜ **provider 钉 `Parasail`**（`embed.providerOrder`）
**注入预算 8000ms**（`src/config.ts:275`）｜ 写侧 15s×(1+1 重试) = 30s 硬顶

### 延时（ms，成功样本；预算 8000ms）

| 形态 | n | p50 | p90 | p95 | p99 | max | 超预算 |
|---|---|---|---|---|---|---|---|
| **单文本**（注入 query） | 40 | 2102 | 4767 | 6423 | 7533 | 7533 | **0** |
| **单文本**（持续观测 5min） | 60 | 1902 | 2776 | 3086 | 3702 | 3702 | **0** |
| 单文本合计 | 100 | 1949 | 3189 | — | 7533 | 7533 | **0** |
| **注入形态**（query+3 门控锚，1 批） | 10 | **2481** | 5770 | — | — | 5770 | **0** |
| 批 32（批量导入） | 8 | 4456 | 6266 | — | — | 6266 | 0（<15s 写预算） |
| 并发 5×批 8 | 3 轮 | 4047 | 6759 | — | — | 6759 | 0 |
| 长文本单条（~1900 字） | 6 | 1934 | 2177 | — | — | 2177 | 0 |
| 写侧 5 文本批 | 3 | 2253 | 2499 | — | — | 2499 | 0 |
| **命中缓存** | — | **0.02ms** | — | — | — | — | 冷往返的 1/101687 |

**可靠性专项（120 次单文本，跳闸关）：120/120 成功（100%），零 timeout、零 4xx/5xx，无连续失败段**；p50 1749ms、p90 3071、p99 5846、max 6578。

### 判读

1. **注入 skip 归零的机制 = 预算 8000ms + 尾延迟更稳**：旧链路（3s 预算）超顶率 13.5%、单窗口最高 23%；新链路 **0/100 超 8s**。注意尾部余量并不宽——单文本 max 7533ms 距 8s 只剩 6%，`p99` 一档仍可能偶发触顶（届时表现就是一次 inject-skip）。
2. **中位往返与旧链路同量级（~1.75-2.1s）**：瓶颈是**本机→中转链路底噪**，不是模型与输入长度（D219 实测 OpenRouter 服务端 p50 仅 344ms，本机底噪 1.5-2.5s）。
3. **批 32 不再危险**：max 6266ms < 15s 写预算（旧链路 19523ms 会撞穿）→ 「批 32 降到 8~16」这条建议在新链路**不再必要**（P4 显示并发 5×批 8 略快，属可选优化）。
4. **可靠性是本次最大的改善**：旧链路有 Gemini 原生 schema 的 `embed-http-400 Unknown name "requests"` **成簇**失败（一次簇 ≈30 次）与 timeout；新链路 120 次零失败。
5. 生产侧对照（今日全库桶日志）：注入 3 次**全部成功**，`elapsedMs` 3735 / 3751 / 5051（含 recall 管线），**0 条 `embed-timeout/failed/unavailable`**——旧链路同期是 47~50% 跳过。
6. 直连可用（1960ms vs 代理 2102ms，n=3），不强制代理。

### 判据与建议（更新版）

| 项 | 值 |
|---|---|
| 劣化判据（建议接哨兵） | **单文本 p50 > 2.5s** 或出现 `embed-timeout` 即判 |
| 注入预算 | 8000ms 合适（实测 max 7533ms）；要更稳可抬到 10s，代价是闸持有更久 |
| 缓存 | 命中 0.02ms → 维持"可缓存文本全部走缓存"，价值 10⁵ 量级 |
| 批大小 | 32 可保留；追求吞吐再考虑 8~16 |
| 监控 | 旧建议「`embed-http-400.*requests` 进哨兵」随旧链路作废；改盯 OpenRouter 侧 4xx/5xx + timeout 计数 |

---

## 二、历史：旧链路（relayrouter + gemini-embedding-2-preview + 3072 维 + 3s 预算）——**已作废，仅留档**

2026-10-14 晚实测（当时 `config.env` 仍是 `API_URL=https://api.relayrouter.ai` / `WhitelistEmbeddingModel=gemini-embedding-2-preview` / `VECTORDB_DIMENSION=3072`）：

- 单文本 289 次样本：p50 **983→2144ms**（会话内劣化，1 小时翻倍），p99 3.2~8.1s，max **12200ms**，**超 3s 硬顶 13.5%**（单窗口最高 23%）；地板 ~0.7-1.0s。
- 批 32：p50 6003ms、max **19523ms**（撞穿写侧 15s 预算）；并发 5×批 8 的 40 文本总耗时 ~3s。
- 可靠性：119/120 成功，但出现**成簇** `embed-http-400: Invalid JSON payload received. Unknown name "requests"`——Gemini 原生 schema 报错，即中转把 OpenAI 形态请求打到另一种 API 形态的上游；代理与直连都遇到；三连败触发跳闸退避 10s→20s。
- 生产对照：10-12~10-14 被动召回约半数回合 `inject-skip reason=embed-timeout`（10-14 达 47~50%）。

**口径教训（同一个坑踩两次）**：`~/app/VCPToolBox/config.env` 里的 `EmbeddingModelSig=gemini-embedding-2-preview` 是 **VCPToolBox TDB 子系统**的键，**不是**插件的回落链——插件读的是 `WhitelistEmbeddingModel` / `VECTORDB_DIMENSION`（`src/config.ts:226-229` 注释明证）。测端点前先确认「端点/模型/维度/预算各自从哪个键来」；预算不要硬编码（探针已改为读 `config.inject.embedTimeoutMs`）。

**原始日志**：`.scratch/whale-fix/embed-lat-bge.log` / `embed-rel-bge.log`（新链路）；`embed-latency.log` / `embed-latency2.log`（旧链路）。
