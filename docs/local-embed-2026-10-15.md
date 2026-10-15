# 本地 bge-m3 推理路线（2026-10-15 实测通过）

> 目标：把嵌入从"本机→中转站"的 1.9s 往返换成**本地 GPU 推理**，消掉 OpenRouter 那一跳。
> 结论：**跑通，且可直接切**（向量一致性 cos=0.999965，旧语料不用重嵌）。

## 一、官方依据

- **BGE-M3 官方文档**：[bge-model.com/bge/bge_m3.html](https://bge-model.com/bge/bge_m3.html)（BAAI）——`from FlagEmbedding import BGEM3FlagModel; model = BGEM3FlagModel('BAAI/bge-m3')`；**569M 参数 / 2.27GB**；dense 向量 = **归一化的 [CLS] 隐状态，1024 维**（与插件现用维度一致）；另支持 sparse / ColBERT 多路（本插件只用 dense）。
- 上游仓：[FlagOpen/FlagEmbedding](https://github.com/FlagOpen/FlagEmbedding)（Tutorial `1.2.4_BGE-M3.ipynb`）。

## 二、环境与装法（本机实测，含四个坑）

环境：Python 3.14.8（太新，用 `uv` 拉 3.12）、无 torch/onnx、**GPU 可用**（RTX 3060 Laptop **6GB**，驱动 615.78.08）、无 ollama/llama.cpp、磁盘 426G。

```bash
cd .scratch/embed-local                      # 生产建议改到 ~/.local/share/dsh-embed/
uv venv --python 3.12 venv
env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy -u ALL_PROXY -u all_proxy \
    -u NO_PROXY -u no_proxy VIRTUAL_ENV=$PWD/venv \
  uv pip install --python venv/bin/python \
    --index-url https://mirrors.aliyun.com/pypi/simple/ torch FlagEmbedding
# 模型（完整快照，别只下 safetensors —— 该仓权重是 pytorch_model.bin）
env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy -u ALL_PROXY -u all_proxy \
    -u NO_PROXY -u no_proxy HF_ENDPOINT=https://hf-mirror.com HF_HUB_DISABLE_XET=1 \
  venv/bin/python -c "from huggingface_hub import snapshot_download; snapshot_download('BAAI/bge-m3', ignore_patterns=['onnx/*'])"
```

**四个坑（都是实测撞出来的）**：

| # | 症状 | 根因 | 解法 |
|---|---|---|---|
| 1 | `429 Too Many Requests`（nvidia_curand 等大轮子） | `~/.config/uv/uv.toml` 把中科大设为 default index | `--index-url https://mirrors.aliyun.com/pypi/simple/`（实测 **4.0MB/s**，中科大 0.78、清华 0.36） |
| 2 | `401 Unauthorized ... cas-server.xethub.hf.co` | HF 新的 **Xet** 存储，hf-mirror 不代理 | `HF_HUB_DISABLE_XET=1` |
| 3 | `httpx.InvalidURL: Invalid port: ':1]'` | 环境里 `NO_PROXY`/`no_proxy` 含 `[::1]`（方括号形式触发 httpx 解析 bug） | 跑 Python 时把两个大小写变量都设成 `localhost,127.0.0.1,::1`（无方括号）或 `-u` 掉 |
| 4 | 下完只有 38MB | 该仓**没有 safetensors**，权重是 `pytorch_model.bin` | 别用 `allow_patterns=['*.safetensors']` 过滤 |

**下载速度（判据：一律直连国内镜像，走代理只会更慢）**：aliyun 4.0MB/s、hf-mirror 5.7MB/s（实测拉到 9.6MB/s）；**走代理** pypi 96KB/s、hf-mirror 0.96MB/s → 2.5GB 的 torch 要 8 小时。

## 三、服务形态

`scripts/local-embed/server.py`——OpenAI 兼容 `POST /v1/embeddings`（与插件 `${apiUrl}/v1/embeddings` 的形状一致，**插件零代码改动**）；单卡锁串行；`GET /health`；错误明确回 500 不静默。

```bash
venv/bin/python scripts/local-embed/server.py --port 8099 --device cuda:0 --model "$SNAP"
```

系统化：`scripts/local-embed/dsh-embed.service`（用户级 systemd，`Restart=always`，三个环境坑写进了 unit 注释）。
**生产路径建议**：venv 移出 `.scratch/`（构建产物、可能被清）到 `~/.local/share/dsh-embed/venv`；unit 里用 `LOCAL_EMBED_VENV` / `LOCAL_EMBED_SNAPSHOT` 两个变量指过去。

**资源占用**：显存峰值 **1.15GB / 6.14GB**（fp16）；加载 11.6s（一次性，含 CUDA 初始化）；首次请求含预热 ~700ms。

## 四、实测（同一探针 `scripts/probe-embed-latency.mjs`，远端/本地逐项可比）

| 形态 | 远端 OpenRouter（bge-m3@Parasail） | **本地 GPU fp16** | 倍数 |
|---|---|---|---|
| 单文本 p50 / p99 / max | 1949 / 7533 / 7533 ms | **23 / 71 / 71 ms** | ~85× |
| 注入形态（query+3 门控锚）p50 | 2481 ms | **40 ms** | 62× |
| 批 32 p50 | 4456 ms | **186 ms** | 24× |
| 并发 5×批 8 | 4047 ms | **255 ms** | 16× |
| 长文本（~1900 字） | 1934 ms | **198 ms** | 10× |
| 写侧 5 文本批（4 Tag+正文）| 2253 ms | 1033 ms | 2×（见下） |
| 持续观测 5min：p50 / stall | 1902 ms / 多次 | **20 ms / 0 次** | 95× |
| 命中缓存 | 0.02 ms | 0.04 ms | — |

**为什么写侧 5 文本批特别慢（1033ms）**：同一批里 4 条短 Tag + 1 条 1864 字正文 → **padding 到最长**，等于 5 条长文本的算力（5×198ms≈990ms ✅ 吻合）。可优化项：服务端按长度分桶、或写侧把 Tag 与正文分两次请求。

## 五、能不能直接切？——向量一致性判据（`scripts/probe-embed-local-parity.mjs`）

10 条真实语料样本（本桶 dailynote 正文 8 条 + 2 条查询）逐条对比本地 vs 远端：

- **余弦相似度：均值 0.999965，最小 0.999799**
- 最大逐元素偏差：均值 6.18e-4（最大 2.35e-3）
- 范数：两边都 ≈1.0000；**各自自身重现性 cos=1.000000000 / max|Δ|=0**（两者都确定）
- **判据：✅ 可直接切，旧向量继续用**——偏差量级与既有"OpenRouter 跨 provider 漂移 3.8e-4~7.3e-4"（D222）相当，属产地差异，不动余弦排序。

## 六、切换动作（待用户确认时机）

1. `bundle/cordis.patch.yml:91`（**生产实际生效处**，`embed.apiUrl` 优先于 config.env）：
   `apiUrl: 'https://openrouter.ai/api'` → `apiUrl: 'http://127.0.0.1:8099'`；`apiKey` 可留空；`model`/`dimension` 不变；`providerOrder` 对本地服务无意义（服务忽略该字段）。
2. **代理无需任何改动**：`src/embed.ts:147 resolveProxyUrl()` 只在 `TAG_EMBED_PROXY` 显式设置（或 `TAG_EMBED_PROXY_FROM_ENV=1`）时才启用，当前未设 → 插件本就没走代理；本地端点在 `NO_PROXY` 内。
3. 先 `systemctl --user enable --now dsh-embed.service` 确认 `/health` 通了，**再**重启 dsh-web（重启须先征得用户同意）。
4. 重启后验收：真发一次 `memo_write`（沿鲸鱼修复的 0.5s RSS 采样法）+ 看桶日志 `inject` 的 `elapsedMs`（预期从 ~4000ms 掉到 ~300ms 级），并确认 `embed-timeout/failed` 为 0。

## 七、风险与尚未做的

- **单点**：本地服务挂了 → 写路径拒绝、注入跳过（插件无 fallback 链）。缓解：`Restart=always`；若要更强，给插件加"副端点回退"（需改代码，未做）。
- **GPU 常驻 1.15GB**：本机 6GB 显存，需确认没有别的常驻 GPU 负载（未查）。
- **冷启动 11.6s**：dsh-web 先起、服务后起时，头几十秒的嵌入会失败 → 建议 unit 加 `Before=dsh-web.service` 或由 dsh-web 侧重试兜底。
- **sparse/ColBERT 未启用**：官方模型的三路能力里我们只用了 dense；sparse 对"专名/数字"召回有增益，是否启用是另一个决策（需要改插件检索层，未做）。
- 未做：把 venv 迁到 `~/.local/share/dsh-embed/`、装 unit、跑 acceptance 对本地端点（都留待切换时一起做）。

**原始日志**：`.scratch/whale-fix/embed-lat-*.log`、`.scratch/embed-local/`（venv + 模型缓存）。
