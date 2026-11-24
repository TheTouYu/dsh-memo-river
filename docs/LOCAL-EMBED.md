# 嵌入端点：任选一条路（LOCAL-EMBED）

插件只要求一个 **OpenAI 兼容** 的 `POST /v1/embeddings`：

```http
POST <url>/v1/embeddings
{ "model": "<model>", "input": ["文本"] }
→ { "data": [ { "embedding": [...] } ] }
```

插件**不发送** `dimensions` 参数，所以配置里的维度必须等于模型真实输出维度
（Qwen3-Embedding-0.6B = 1024，bge-m3 = 1024，gemini-embedding = 3072）。
首次接入先跑 `node scripts/doctor.mjs`，它会真打一次并核对维度。

---

## A. 用外部端点（最快，无需本地算力）

任何 OpenAI 兼容服务都行（OpenRouter / 各家云 / 自建网关）。设四个环境变量即可：

```bash
MEMO_EMBED_URL=https://<host>          # 不带 /v1
MEMO_EMBED_API_KEY=<key>
MEMO_EMBED_MODEL=<模型名>
MEMO_EMBED_DIM=<维度>
```

注意：
- 远端链路 RTT 通常 1–3s，注入预算 `embedTimeoutMs` 默认 15s，够用；
- 需要代理时，插件认 `https_proxy`/`http_proxy`（只支持 http/https 代理，SOCKS 不实现）；
- 端点 key 只从环境变量读，不写进仓库。

## B. 本地 llama.cpp（Windows x64，推荐给本机长期用）

1. 下 llama.cpp 的 CUDA 或 CPU 版（build 里的 `llama-server.exe` 与 dll 放同一目录）。
2. 下 GGUF 模型：`Qwen3-Embedding-0.6B-Q8_0.gguf`（约 609 MB，HF 需要代理）。
3. 起服务（GPU：`-ngl 99`；纯 CPU 去掉它）：

```bat
llama-server.exe -m E:\models\Qwen3-Embedding-0.6B-Q8_0.gguf ^
  --embeddings --pooling last --host 127.0.0.1 --port 8091 ^
  --alias Qwen3-Embedding-0.6B -ngl 99 -c 8192
```

4. 自检：

```powershell
curl.exe -s http://127.0.0.1:8091/health        # {"status":"ok"}
curl.exe -s http://127.0.0.1:8091/v1/models     # 应看到 alias
node scripts/doctor.mjs                          # 维度/耗时一行
```

5. 想开机常驻：用「任务计划程序」跑一个 **守护循环** 的 .cmd（llama-server 退出 3 秒后重拉）。
   只靠计划任务的「失败后重启」不覆盖子进程被杀，实测 200s 不重启；循环体才有效。

> 本机实测（RTX 3060 12G，`-ngl 99`）：warm 单条 40–60ms，显存 ~3.9GB，1024 维、L2=1.0000。

## C. 本地 llama.cpp（Linux / macOS）

```bash
git clone https://github.com/ggml-org/llama.cpp && cd llama.cpp
cmake -B build -DGGML_CUDA=ON   # 无 GPU 去掉这项
cmake --build build -j
./build/bin/llama-server -m /path/Qwen3-Embedding-0.6B-Q8_0.gguf \
  --embeddings --pooling last --host 127.0.0.1 --port 8099 \
  --alias Qwen3-Embedding-0.6B -ngl 99 -c 8192
```

Linux 缺省端口是 **8099**，与 bundle 的缺省一致；想换端口设 `MEMO_EMBED_URL` 即可。

## D. 保底泳道（可选）

主端点失败时改打第二个端点（`MEMO_EMBED_FALLBACK_URL/_KEY/_MODEL/_PROVIDER`）。
Linux 的 bundle 缺省给的是 OpenRouter（需要 `TAG_EMBED_KEY`）；Windows 缺省关闭。
失败会记 `embed-fallback` 日志并在对话里通知一次，不静默。

## 排障速查

| 现象 | 判据 / 修法 |
|---|---|
| `doctor` 报 401/403 | key 不对：`MEMO_EMBED_API_KEY` |
| 报 404 | URL 带没带 `/v1`：**只写根**，插件自己拼 `/v1/embeddings` |
| 维度不匹配 | `MEMO_EMBED_DIM` 与模型真实输出不一致（云上 gemini 系常见 3072） |
| 请求超时 | 本地没起 / 端口不对 / 远端长尾：`embedTimeoutMs` 在 bundle 里 |
| 注入总被跳过 | 桶日志 `inject-skip reason=embed-*`；服务日志看 400/500 |
| 代理不生效 | 只支持 `http_proxy`/`https_proxy`；确认代理是 http 不是 socks |
