# 本地 bge-m3 嵌入服务部署手册

> 面向对象：要在一台新机器上重建「本地 bge-m3 主端点 + 远端保底」这套嵌入链路的人。
> 本文是**部署与运维**口径（选型理由、装机四坑、systemd、四级验证、故障表）；
> 选型的原始实验报告在 [`local-embed-2026-10-15.md`](./local-embed-2026-10-15.md)，
> 精简跑通路径在 [`QUICKSTART.md`](./QUICKSTART.md) §3。
> 最近一次核对：**2026-11-26**（本仓 `kernel-reimpl` 分支，生产机）。

---

## 0. 一页速览

| 项 | 值 |
|---|---|
| 模型 | **`BAAI/bge-m3`**，568M 参数，dense 1024 维，8192 token 上下文，MIT 许可 |
| 服务 | `scripts/local-embed/server.py`（Python + torch），OpenAI 兼容 `POST /v1/embeddings` |
| 端点 | 主 `http://127.0.0.1:8099`；保底 `https://openrouter.ai/api` 的 `baai/bge-m3`（钉 `Parasail`） |
| 进程托管 | 用户级 systemd `dsh-embed.service`（`Restart=always`），venv 在 `~/.local/share/dsh-embed/venv` |
| 权重 | HF 快照 `~/.cache/huggingface/hub/models--BAAI--bge-m3/snapshots/5617a9f…`（完整快照，权重是 `pytorch_model.bin`） |
| 资源 | 显存 ~1.3GB（fp16，2026-11-26 实测进程 1304MiB）；冷启动 ~12s，热重启 ~1.9s |
| 部署位置 | 仓库 `scripts/local-embed/`（`server.py` + `dsh-embed.service` 模板） |

最小验证（三条都要过）：

```bash
curl -s http://127.0.0.1:8099/v1/models            # 返回快照路径
curl -s http://127.0.0.1:8099/health | head -c 200  # {"object":"list","stats":{...}}
ss -tnp | grep 8099                                # 有 ESTAB（dsh-web ↔ 本服务 keep-alive）
```

---

## 1. 为什么选它（原来的决策依据，保留可复核）

这一节回答「为什么不是别的模型」。**每条都有一手读数或官方 model card 出处**，不是印象。

### 1.1 硬件约束先卡死大模型

2026-10-14 实测本机是 **RTX 3060 Laptop（6GB，Max-Q）**：Qwen3-Embedding-8B 要 FP16 约 16GB /
INT8 约 8GB，6GB 显存跑不动，系统内存也只有 15GB（CPU 卸载不现实）。能跑的是
**bge-m3（568M，fp16 ~1.15GB）** 或 Qwen3-Embedding-0.6B。
> 2026-11-26 复核：当前生产机是 **RTX 3060 12288MiB（12GB）**，驱动 615.78.08——显存不再是最紧约束，
> 但「已经在跑、向量已落库」本身就是迁移成本，见 §1.2。

### 1.2 1024 维与存量库一致 ⇒ 切换不用重嵌

bge-m3 的 dense 向量是**归一化的 `[CLS]` 隐状态，1024 维**（BAAI 官方文档），与本插件落库维度一致。
10 条真实语料逐条对比本地 vs 远端（`scripts/probe-embed-local-parity.mjs`）：

- **余弦：均值 0.999965，最小 0.999799**；最大逐元素偏差 2.35e-3（与 OpenRouter 跨 provider 漂移 3.8e-4~7.3e-4 同量级）
- 两边各自自身重现性 cos = 1.000000000（都是确定性的）
- **判据：可直接切，旧向量继续用**——省掉一次全库重嵌（650 篇 ≈ 1.07M token）

### 1.3 延迟：本地 GPU 比远端链路快一个数量级

同一探针 `scripts/probe-embed-latency.mjs`，逐项可比：

| 形态 | 远端 OpenRouter（bge-m3@Parasail） | 本地 GPU fp16 | 倍数 |
|---|---|---|---|
| 单文本 p50 / p99 | 1949 / 7533 ms | **23 / 71 ms** | ~85× |
| 注入形态（query + 3 门控锚）p50 | 2481 ms | **40 ms** | 62× |
| 批 32 p50 | 4456 ms | **186 ms** | 24× |
| 长文本（~1900 字） | 1934 ms | **198 ms** | 10× |
| 持续观测 5 min p50 / stall | 1902 ms / 多次 | **20 ms / 0 次** | 95× |

2026-11-26 现场复核（`/health` 45 次请求，0 错误）：单条 40 字 total **19.1ms**；
4000 字 total **278–523ms**（排队与编码各占一半，单锁串行）。

关键不是平均快，而是**去掉了 1.5–2.5s 的链路底噪**：远端 p50 里绝大部分是「本机→中转→provider」的
排队与往返（中转站自报服务端 p50 仅 ~300ms），本地这条路直接归零。

### 1.4 只用了 dense，但保留了升级空间

bge-m3 官方支持 dense / sparse / ColBERT 三路；**OpenRouter 一类的 API 只给 dense**，
所以模型的多路能力只有自托管才拿得到。当前插件只用 dense（`src/embed.ts` 只发 `{model, input}`），
要不要启用 sparse（对专名/数字召回有增益）是另一个独立决策，未做。

### 1.5 与 Qwen3-Embedding-8B 的对照（当时留档的取舍）

| 指标（官方 model card） | Qwen3-Embedding-8B | BGE-M3 |
|---|---|---|
| C-MTEB 中文 Retrieval | 78.21 | ≈73.9（+4.3） |
| MTEB 多语言 Retrieval | 70.88 | 54.60 |
| 规格 | 8B / 32K / 4096 维 | 568M / 8K / 1024 维 |
| OpenRouter 单价 | $0.01/M | $0.01/M |

取舍判据（当时的决策规则）：**瓶颈在通道可靠性 → bge-m3**（尾延迟稳、维度小、能自托管）；
**瓶颈在召回质量 → Qwen3-8B**（+4.3 中文检索分是真的）。
当时实际瓶颈是 45% 注入被跳过、p50 3154ms 超预算 ⇒ 选 bge-m3。若将来质量成为瓶颈，
换模型的代价 = 全库重嵌（维度不同会自动全 miss，不会串味）。

### 1.6 成本

本地推理电费级；对照远端 $0.01/M token ≈ 日均 ¥0.16。真正的收益是**不再依赖第三方余额**——
2026-11-18 的 402 事故就是余额耗尽导致召回全断（见 §2.2）。

---

## 2. 拓扑与配置面

### 2.1 两条泳道（`src/embed.ts` 的 lanes）

```
primary  → http://127.0.0.1:8099            (baai/bge-m3, 1024)     ← 平常全部走这条
fallback → https://openrouter.ai/api        (baai/bge-m3, Parasail) ← 主端点超时/拒绝/5xx 才打
```

- 每泳道**独立跳闸**（连败退避），主端点死不会连坐保底；
- 回退成功的向量入**同一缓存**（两端点 cos ≈ 0.99997，排序不受影响）;
- 失败可见化：`src/embed-health.ts` 台账 + 对话内通知（`failover` / `recovered`，5 分钟冷却）
  + 面板 `/memo-river/tuning/panel` 的「嵌入链路」卡（含错误全文与一键复制）；
- `all-failed` 不进对话通道（同一件事不报两遍：注入失败已有「召回未生效」通知，写入失败有工具报错）。

### 2.2 ⚠️ 配置面有 N 份，改之前先答「这条会话用哪个预设」

`- id: memo-river-plugin` 在 **每个预设 bundle 里各有一份** `embed:` 段
（`~/.dsh/preset-bundles/<preset>/cordis.patch.yml`），另外仓内
`bundle/cordis.patch.yml` 是 `memo-river` 预设那份（唯一入库的）。

实际挂载哪份由 `~/.dsh/profiles/web/cordis.patch.yml` 的
`agent-preset-registry.selectedDefault` 决定（2026-11-26 实测 = **`river-acp`**；
2026-11-18 记录是 `river-acp-guard` —— **这个值会变，查最新值，别信旧记载**）。

**血案（2026-11-18）**：preset-composer 生成的 `river-acp` 系 bundle **不带 embed 段** ⇒ 插件回落
VCP `config.env` 的 `API_URL`（OpenRouter）⇒ 余额耗尽 402 ⇒ 召回全断且熔断不自愈，
而本地 8099 **完全空转**（`ss` 里没有到 8099 的连接）。
修法：给每个 bundle 的 `memo-river-plugin.config` 补 embed 段（照抄仓内 bundle），重启 dsh-web。

**验证「生产真在用本地端点」的判据（按可靠性排序）**：

1. `ss -tnp | grep 8099` 有 `ESTAB`（keep-alive 常挂 240s；没有就是没在用）；
2. `systemctl --user show dsh-embed -p CPUUsageNSec` 在几次 recall 后毫秒级增长；
3. 桶日志 `inject ... elapsedMs` 从 ~4000ms 掉到几百 ms；
4. 停服务后主动 recall → 出现 `failover` 事件与对话通知（演练 §6.3）。

> **modelSig 陷阱**：原生 artifact 的 `modelSig = ${model}@relayrouter`（`src/config.ts` 的
> `modelSigSuffix`，VCP 约定后缀），**与端点地址无关**。换端点不会触发重嵌，
> 也就不会自动发现「你其实打的是另一个服务」——只能靠上面第 1/2 条判据。

---

## 3. 安装（venv + torch + 模型快照）

生产建议 venv 放在构建产物区之外（`.scratch/` 会被清）：

```bash
mkdir -p ~/.local/share/dsh-embed && cd ~/.local/share/dsh-embed
uv venv --python 3.12 venv

# 装依赖：一律直连国内镜像（走代理只有 ~0.1MB/s，2.5GB 的 torch 要 8 小时）
env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy -u ALL_PROXY -u all_proxy \
    -u NO_PROXY -u no_proxy VIRTUAL_ENV=$PWD/venv \
  uv pip install --python venv/bin/python \
    --index-url https://mirrors.aliyun.com/pypi/simple/ torch FlagEmbedding

# 拉权重：必须完整快照（该仓没有 safetensors，权重是 pytorch_model.bin）
env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy -u ALL_PROXY -u all_proxy \
    -u NO_PROXY -u no_proxy HF_ENDPOINT=https://hf-mirror.com HF_HUB_DISABLE_XET=1 \
  venv/bin/python -c "from huggingface_hub import snapshot_download; snapshot_download('BAAI/bge-m3', ignore_patterns=['onnx/*'])"
```

### 3.1 装机四坑（都是实测撞出来的，缺一条就起不来/下不对）

| # | 症状 | 根因 | 解法 |
|---|---|---|---|
| 1 | `429 Too Many Requests`（nvidia_curand 等大轮子） | `~/.config/uv/uv.toml` 把中科大设为默认 index | `--index-url https://mirrors.aliyun.com/pypi/simple/`（实测 4.0MB/s；清华 0.36） |
| 2 | `401 Unauthorized ... cas-server.xethub.hf.co` | HF 新的 Xet 存储，hf-mirror 不代理 | `HF_HUB_DISABLE_XET=1` |
| 3 | `httpx.InvalidURL: Invalid port: ':1]'` | 环境里 `NO_PROXY` 含 `[::1]`（方括号触发 httpx 解析 bug） | 两个大小写变量都设成 `localhost,127.0.0.1,::1`（无方括号），或 `-u` 掉 |
| 4 | 下完只有 38MB | 该仓**没有 safetensors**，用 `allow_patterns=['*.safetensors']` 过滤只剩配置 | 完整快照，只忽略 `onnx/*` |

---

## 4. 服务化（systemd）

模板在仓内 `scripts/local-embed/dsh-embed.service`（用 `%h` 占位 home，装的时候展开）：

```bash
sed "s|%h|$HOME|g" scripts/local-embed/dsh-embed.service > ~/.config/systemd/user/dsh-embed.service
systemctl --user daemon-reload && systemctl --user enable --now dsh-embed
systemctl --user status dsh-embed --no-pager | head -8
```

单元里已经焊死的东西（**不要随手删**）：

- **三个环境坑**：`NO_PROXY`/`no_proxy` 去掉 `[::1]`（坑 3）；`HF_HUB_OFFLINE=1` 要求快照完整（坑 4）；
  `PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True`（抑制 caching allocator 碎片）。
- `Restart=always` + `RestartSec=3` + `TimeoutStartSec=180`（冷启动含 CUDA 初始化 ~12s，给足窗口）。
- `ExecStart` 的参数：`--port 8099 --device cuda:0 --batch-size 8 --max-length 4096 --model "$LOCAL_EMBED_SNAPSHOT"`。
  代码缺省是 `--batch-size 32 --max-length 8192`，unit 收紧是为了守住 6GB 时代的显存与长文本抖动。

### 4.1 限额 drop-in（2026-10-16 卡顿治理）

`~/.config/systemd/user/dsh-embed.service.d/limits.conf`：

```ini
[Service]
MemoryHigh=2560M
MemoryMax=3584M
CPUQuota=200%
TasksMax=128
Environment=MALLOC_ARENA_MAX=2
```

- 由来：2026-10-15 病态段 5.4G 内存峰值挤兑全场 → embed-timeout 三连重启；
- `MALLOC_ARENA_MAX=2` 抑制 ThreadingHTTPServer 的 glibc arena 碎片（内存收益主项）；
- ⚠️ **不要**照搬 `OMP_NUM_THREADS=1`：实测会把模型加载从 21.6s 拖到 >135s（CPU 侧权重转换单线程化）；
- 超限被杀有 `Restart=always` 兜底，端点级故障有远端保底链兜底，所以限额是安全的。

---

## 5. 验证（四级判据，逐级可证伪）

### L1 服务活着 + 模型对、维度对

```bash
curl -s http://127.0.0.1:8099/health     # stats.requests/errors/uptime_s/device + 最近 64 条请求明细
curl -s http://127.0.0.1:8099/v1/models  # data[0].id = 快照绝对路径
curl -s -m 20 http://127.0.0.1:8099/v1/embeddings -H 'Content-Type: application/json' \
     -d '{"model":"baai/bge-m3","input":"dim probe"}' \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log("dims=",j.data[0].embedding.length)})'
# 期望 dims= 1024
```

### L2 插件真的在用它（不是「配置写了」）

```bash
ss -tnp | grep 8099                          # 期望多条 ESTAB：node(dsh-web) ↔ python(本服务)
journalctl --user -u dsh-embed --since '10 min ago' | grep '\[req\]' | tail -5
# 期望形如：[req] 20:28:28.176 from=33664 n=1 chars=14 hit=miss total=29.7
```

### L3 端到端：注入时延与失败计数

- 桶日志：`inject-skip` 里不应有 `reason=embed-*`；`inject ... elapsedMs` 应在几百 ms；
- 面板 `/memo-river/tuning/panel` → 「嵌入链路」卡：failover 计数、最近错误全文；
- 写入一次 `memo_write` 应成功（日志 `memo_write artifact-rebuilt`），且 `openrouter-usage` 无新增（说明没走保底）。

### L4 回归套件（改过代码才需要）

```bash
node scripts/acceptance.mjs                 # 主套件（真嵌入端点）
node scripts/probe-embed-fallback.mjs       # 回退行为专项 18/18
node scripts/probe-embed-latency.mjs        # 延时 A/B
node scripts/probe-embed-local-parity.mjs   # 本地 vs 远端向量一致性（换模型/换机器必跑）
```

> 注意：主套件跑真端点，**端点劣化时整套会随机红 6-8 条**；红一条先复跑，再看桶日志
> `inject-skip reason=embed-*` 占比，别急着归因代码。

---

## 6. 运维

### 6.1 重启与自愈

| 动作 | 实测 |
|---|---|
| `systemctl --user restart dsh-embed`（热，权重在页缓存） | ~1.9s 就绪 |
| 冷启动（进程 + CUDA 初始化） | ~12s（`TimeoutStartSec=180` 覆盖） |
| `kill -9` 后 systemd 拉起 | 9s 内，`/health` 回 200 |
| 显存 | ~1.3GB（fp16）；2026-11-26 实测进程 1304MiB、RSS 2.2GB |

### 6.2 换端口 / 换设备

改 unit 的 `--port` / `--device` **同时**改所有预设 bundle 的 `embed.apiUrl`（§2.2），
否则插件仍打旧地址——判据用 §5 L2。

### 6.3 演练回退（不需要重启，随时可做）

```bash
systemctl --user stop dsh-embed
# 主动一次 memo_recall / memo_write：应看到对话内 failover 通知 + 面板卡片事件，且操作照常成功
systemctl --user start dsh-embed
```

前提：保底端点的 key 有效（`TAG_EMBED_KEY`，OpenRouter 余额足够）。**若余额为 0，回退链等于不存在**
（2026-11-18/19 的 402 就是这种状态），此时唯一出路是本地服务必须活着。

### 6.4 换模型 / 换维度

- 维度不同：`src/embed.ts` 的缓存带维度校验，全 miss 自动重嵌，**不会串味**，但要跑
  `node scripts/reembed-all.mjs`（先 dry-run）把库内向量补齐；
- 维度相同（如 bge-m3 → 另一个 1024 维模型）：缓存**不会**自动失效，必须手动清 `emb-cache.bin`
  或按维度/模型改缓存键再重嵌，否则新旧向量混用；
- `modelSig` 后缀（`@relayrouter`）与端点无关，换端点不触发重嵌——别指望它帮你发现配置错。

### 6.5 已知边界（截至 2026-11-26）

- **单点**：本地服务是主端点。`Restart=always` + 保底链是现有缓解；更强的是多副本/多设备，未做。
- **GPU 共享**：本服务常驻 ~1.3GB；同机还有其它 GPU 进程时要先看 `nvidia-smi`，
  别在显存紧张时并发大编译（见全局守则 9）。
- **冷启动窗口**：dsh-web 先起、本服务后起时，头十几秒嵌入会失败 → 注入跳过（有通知）。
  建议 unit 加 `Before=dsh-web.service` 或由插件侧重试兜底（未做）。
- **sparse / ColBERT 未启用**：只跑 dense，多路检索是未兑现的升级空间。
- **CPU 侧加载内存峰值**：fp32 checkpoint → fp16 转换期峰值可达 3.2G，故 `MemoryMax` 设在 3.5G；
  内存紧张机器上首次加载可能被限流，必要时临时放宽 `MemoryMax` 再收紧。

---

## 7. 故障排查表

| 症状 | 先查 | 常见真因 |
|---|---|---|
| 注入被跳过，日志 `inject-skip reason=embed-failed: ...402` | `ss -tnp \| grep 8099`；bundle 是否带 embed 段 | 预设缺 embed 段 → 回落 VCP `config.env` 的 OpenRouter → 余额耗尽 |
| `memo_recall` 报 `native-failed: ...geometry facts are stale` | 见下条 | 与嵌入无关：原生几何资产代际与 `memo_tag_facts` 不一致（2026-11-18 起的已知死锁，`kernel/src/memo_artifact_builder.rs:171`） |
| `ss` 里没有到 8099 的连接 | `systemctl --user status dsh-embed`；`/health` | 服务没起、端口被占、或配置指向别处 |
| `/health` 200 但请求耗时 >1s | `/health` 的 `wait_ms_p95` vs `encode_ms_p95` | 排队（单锁串行，并发打满）而非编码慢；减少并发或拆批 |
| 服务反复重启 | `journalctl --user -u dsh-embed -n 50` | 显存不足（OOM）、快照不完整（`HF_HUB_OFFLINE=1` 拒绝加载）、`[::1]` 代理坑 |
| 写入报 `embed-unavailable` | 同上 | 主端点与保底端点同时不可用 |
| 换机器后向量「看起来能算但结果怪」 | `probe-embed-local-parity.mjs` | 换了模型/精度/版本导致向量分布变了，缓存未失效 |

---

## 8. 相关文档

| 文档 | 内容 |
|---|---|
| [`local-embed-2026-10-15.md`](./local-embed-2026-10-15.md) | 选型实验原始报告：官方依据、四坑、延时/一致性实测、服务化与回退实现、生产配置面陷阱 |
| [`QUICKSTART.md`](./QUICKSTART.md) §3 | 精简跑通路径（三条独立可验证路径之一） |
| [`embed-latency-2026-10-14.md`](./embed-latency-2026-10-14.md) | 远端链路延时基线（已被本地取代，保留作劣化对照：p50 > 2.5s 即判劣化） |
| `README.md` §「嵌入服务（本地 bge-m3）」 | 一句话入口与关键判据 |
