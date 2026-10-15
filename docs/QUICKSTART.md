# QUICKSTART — 从零把它跑起来

> 读者：拿到这个仓、没读过任何内部文档的人（也包括三个月后的自己）。
> 本文三条路径各自独立可验证：**基础安装（必做）** → **自研内核（可选）** → **本地嵌入 + 远端回退（可选）**。
> 每一步都给了**期望输出**；输出不对就跳到 §5 故障排查表。
> 工程约定与红线见仓根 `AGENTS.md`；设计依据见 `DESIGN.md`。

---

## 0. 前置条件

| 依赖 | 必需？ | 说明 |
|---|---|---|
| **Node.js ≥ 22.5** | 必需 | 知识库用 `node:sqlite` 的 `DatabaseSync`（`src/store.ts:8`）；22.5 起可用、24 起稳定。**本仓在 Node 26.11.1 上验证** |
| **DSH（DeepSeek Harness）** | 必需 | 这是 dsh 插件，不是独立服务。已在跑 `dsh web` 即可（`command -v dsh` 有输出） |
| **一个 OpenAI 兼容嵌入端点** | 建议 | `POST {apiUrl}/v1/embeddings`。**不配也能跑**：写路径拒写、被动注入跳过（有明确通知），其余功能正常 |
| **cargo（Rust 工具链）** | 可选 | 只在要**自研内核**时用（§2） |
| **VCPToolBox** | 可选 | 只在用**上游 rust 内核**（`native.kernel: 'vcp'`）时需要；走自研内核或不用原生读出时不需要 |
| **NVIDIA GPU ≥ 4GB 显存** | 可选 | 只在要**本地嵌入**时用（§3）；bge-m3 fp16 占 ~1.15GB |

---

## 1. 基础安装（必做）

### 1.1 装依赖

```bash
npm install          # 只装 4 个包（undici + typescript + @types/node）
```

> ⚠️ **npm 12 有一个坑会被这个仓的 `peerDependencies` 触发**：`@deepseek-ai/dsh-llm` / `dsh-tools` /
> `cordis` / `schemastery` 是**宿主 DSH 提供的包**（不在 npm 上），npm 解析它们时不是报错而是
> **空指针崩溃**（`Cannot read properties of null (reading 'children')`）。
> 本仓已内置两种修法：`package.json` 的 `peerDependenciesMeta.*.optional = true` + 仓根 `.npmrc`
> 的 `legacy-peer-deps=true`。**若仍然崩**：`npm install --legacy-peer-deps`。
> 国内网络慢：`npm install --registry=https://registry.npmmirror.com`。

**期望**：`added 4 packages`，退出码 0。

### 1.2 构建

```bash
bash scripts/build.sh
```

它做两件事：① 从**已安装的 dsh**（或 `DSH_CHECKOUT` 指向的 checkout）在插件 `node_modules/` 下建
junction，供 tsc 取类型、也供运行期解析 `schemastery` 这类真依赖；② 用 `node_modules/.bin/tsc`
把 `src/` 编译到 `lib/`（`lib/` 是构建产物、不入库）。

**期望输出**：

```
=== 链接构建依赖 ===
    布局: 已安装 npm 包 (/…/node_modules/@deepseek-ai/dsh)
=== 编译 src → lib（…/node_modules/.bin/tsc） ===
=== 构建完成 ===
```

> ⚠️ **假绿陷阱**：tsc **报类型错时仍然会 emit**，`lib/` 照样“能加载”。所以构建后务必再看一眼错误数——
> `bash scripts/build.sh 2>&1 | grep -c "error TS"` 必须是 **0**（退出码也要 0）。

### 1.3 验证构建产物

```bash
node -e "import('./lib/index.js').then(m=>console.log(Object.keys(m)))"
# 期望：['Config','FIXED_CONTRACT_SHA256','FIXED_CONTRACT_TEXT','apply','inject','messageText',…]
```

### 1.4 挂进 DSH

在**一个 dsh 会话里**让它执行（这三个是 dsh 宿主工具，不是 shell 命令）：

```
dev_build_plugin  <本仓绝对路径>     # 构建并让宿主认识它
dev_inject_plugin <本仓绝对路径>     # 运行时注入（免重启，开发/验证用）
dev_install_package <本仓绝对路径>   # 装进 profile（重启后仍在）
```

仓内 `bundle/cordis.patch.yml` 是**预设声明**（`preset-memo-river`）：以 bundle 形式安装时用它，
里面已经带好插件的生产默认配置（§1.5）。

**期望**：注入后当前会话出现 `memo-river` 的工具（`memo_write` / `memo_recall` / `memo_stats` / `memo_tags`）。

### 1.5 最小配置

配置写在预设的 `agent.cordis.yml` 的 `config:` 段（示例见 `bundle/cordis.patch.yml`）。**新用户至少要动两处**：

| 键 | 缺省 | 新用户怎么办 |
|---|---|---|
| `native.vcpRoot` | `/home/h/app/VCPToolBox`（**作者机器上的绝对路径**） | 改成你自己的 VCPToolBox 目录；**没有就留空并确保不用 `kernel: 'vcp'`**（见 §2.5） |
| `embed.apiUrl` / `apiKey` / `model` / `dimension` | 空 → 回落 `vcpRoot/config.env` | 指向你自己的 OpenAI 兼容端点（如 `http://127.0.0.1:8099`，§3）；**维度必须与你落库时一致**（换维度 = 全库重嵌） |
| `native.kernel` | `vcp`（上游 rust 内核） | 建了自研内核就改 `reimpl`（§2）；非法值会**明确抛错**，不静默回退 |
| `native.configEnv` | 空 → 用 `${vcpRoot}/config.env` | 也可直接指一个独立的 env 文件 |

**不配嵌入**（离线起步）也合法：写路径会明确拒绝（`embed-unavailable`）、被动注入跳过并给一条通知，
`memo_stats` / `memo_tags` / 读取路径照常工作。

### 1.6 首个成功判据（三条，都可观测）

1. **桶出现了**：`ls ~/.dsh/memo-river/`（桶名 = `sha256(cwd)` 前 16 位），里面有 `knowledge_base.sqlite` + `memo-river.log`。
2. **写得进去**：让 agent 跑一次 `memo_write`（内容带 `# 标题` 与 `Tag: …` 行，3–5 个 Tag）。
   期望：返回 `✅ 已写入 D1「…」`，且 `dailynote/<桶名>/` 下出现 `.md`。
3. **召回有效**：再问一句与刚写内容相关的话 → 被动注入出现在该轮上下文末尾（块以 `⟨memo-river⟩` 包裹，带 `role=` / `Ω=` 证据分级）。
   或直接调 `memo_stats` → 期望「四项体检」有数字（连通分量 / 最大 Tag 频次 / Ω 分布 / 未覆盖率）。

**可视化面板**（dsh web 起来后，浏览器打开）：

```
http://127.0.0.1:3080/memo-river/tuning/panel      # 写入节律调参 + 草稿队列 + 嵌入链路
```

---

## 2. 自研内核（可选，推荐）

### 2.1 它是干什么的

上游 VCPToolBox 的原生读出链是 **Rust 编译的 `rust-vexus-lite`**；本仓 `kernel/` 是它的**复刻实现**
（`cdylib` → `memo-kernel.linux-x64-gnu.node`），用途：① 不再依赖 VCPToolBox 目录；② 与上游做**逐位对账**
（差分五腿，判据 ≤1e-6）。

> `kernel/*.node` **不入库**（.gitignore）——干净克隆里没有它，必须自己编，或者走 `kernel: 'vcp'` 用上游。

### 2.2 构建

```bash
cd kernel
cargo build --release
cp target/release/libmemo_kernel.so memo-kernel.linux-x64-gnu.node
```

**期望**：`kernel/memo-kernel.linux-x64-gnu.node` 出现（几十 MB）。首次编译要拉 crates，耗时取决于网络。

### 2.3 切换

```yaml
native:
  kernel: reimpl      # 'vcp'（上游，缺省）| 'reimpl'（本仓复刻）；非法值直接抛错
```
或临时用环境变量（只作缺省种子，显式配置优先）：`MEMO_NATIVE_KERNEL=reimpl`。

### 2.4 验证（改内核必须过这两关）

```bash
node kernel/tools/diff-runner.mjs        # 差分五腿（判据：分数差 ≤1e-6，健康史 1.11e-16）
node scripts/acceptance.mjs              # 主套件 37 项（真嵌入端点）
```

### 2.5 不建内核会怎样

- `kernel: 'vcp'`（缺省）→ 从 `vcpRoot` 加载**上游**的 `rust-vexus-lite`。**没有 VCPToolBox 就会失败**。
- `kernel: 'reimpl'` → 加载 `kernel/memo-kernel.<platform>-<arch>-gnu.node`；文件不在 → **加载期抛错**（不静默回落）。
- 两者都没有 → 原生读出不可用；这是**明确报错**而不是悄悄退化成另一套算法。

---

## 3. 本地嵌入（可选；带远端回退）

### 3.1 为什么值得做

实测（同一探针、同一方法学，见 `docs/local-embed-2026-10-15.md`）：

| 形态 | 远端 OpenRouter(`baai/bge-m3`) | 本地 GPU fp16 |
|---|---|---|
| 单文本 p50 | 1949 ms | **23 ms** |
| 注入形态（query+3 锚）p50 | 2481 ms | **40 ms** |
| 批 32 p50 | 4456 ms | **186 ms** |

模型 = `BAAI/bge-m3`（官方文档 [bge-model.com/bge/bge_m3.html](https://bge-model.com/bge/bge_m3.html)）：
569M / 2.27GB，dense = 归一化 `[CLS]`，**1024 维**（与插件现用维度一致；两端点逐条 cos≈0.99997，**旧语料不用重嵌**）。

### 3.2 装（四个坑都在这里）

```bash
cd <任意工作目录>                       # 生产建议 ~/.local/share/dsh-embed/
uv venv --python 3.12 venv              # 用 uv 拉 3.12（系统 Python 可能太新，无轮子）
env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy -u ALL_PROXY -u all_proxy \
    -u NO_PROXY -u no_proxy VIRTUAL_ENV=$PWD/venv \
  uv pip install --python venv/bin/python \
    --index-url https://mirrors.aliyun.com/pypi/simple/ torch FlagEmbedding

# 模型（完整快照；该仓没有 safetensors，权重是 pytorch_model.bin）
env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy -u ALL_PROXY -u all_proxy \
    -u NO_PROXY -u no_proxy HF_ENDPOINT=https://hf-mirror.com HF_HUB_DISABLE_XET=1 \
  venv/bin/python -c "from huggingface_hub import snapshot_download; snapshot_download('BAAI/bge-m3', ignore_patterns=['onnx/*'])"
```

| 坑 | 症状 | 原因 / 处置 |
|---|---|---|
| ① 镜像限流 | `429 Too Many Requests`（nvidia 大轮子） | uv 的默认索引是某个镜像 → 显式 `--index-url https://mirrors.aliyun.com/pypi/simple/`（实测 4.0MB/s；中科大 0.78、清华 0.36） |
| ② Xet 存储 | `401 Unauthorized … cas-server.xethub.hf.co` | HF 新存储后端，hf-mirror 不代理 → `HF_HUB_DISABLE_XET=1` |
| ③ `NO_PROXY` 方括号 | `httpx.InvalidURL: Invalid port ':1]'` | `NO_PROXY` 里的 `[::1]` 触发 httpx 解析 bug → 写成 `localhost,127.0.0.1,::1`（**大小写两个变量都要**） |
| ④ 只下到几十 MB | 缺权重文件 | 该仓**无 safetensors**，别用 `allow_patterns=['*.safetensors']` 过滤 |

> 大体积下载**一律国内镜像直连**：走代理实测只有 37–96KB/s（2.5GB 的 torch 要 8 小时），
> 国内镜像直连 4.0–5.7MB/s。

### 3.3 起服务

```bash
venv/bin/python scripts/local-embed/server.py --port 8099 --device cuda:0 --model "$SNAP"
# 期望：[local-embed] 模型就绪 … 用时 11.6s  →  [local-embed] 监听 http://127.0.0.1:8099/v1/embeddings
```

生产用 systemd 单元（模板 `scripts/local-embed/dsh-embed.service`，含三个环境坑与 `Restart=always`）：

```bash
sed "s|%h|$HOME|g" scripts/local-embed/dsh-embed.service > ~/.config/systemd/user/dsh-embed.service
systemctl --user daemon-reload && systemctl --user enable --now dsh-embed
curl -s http://127.0.0.1:8099/health     # 期望 200
```
实测：`kill -9` 后 **9s 自愈**；热重启加载 **1.9s**（冷启动 11.6s）。

### 3.4 接到插件（**本地优先 + 远端保底**）

```yaml
embed:
  apiUrl: 'http://127.0.0.1:8099'          # 主端点 = 本地
  apiKey: 'local'
  model: 'baai/bge-m3'
  dimension: 1024
  # ↓ 保底端点：主端点失败（超时/拒连/5xx）时自动改打它，向量入同一缓存
  fallbackApiUrl: 'https://openrouter.ai/api'
  fallbackApiKey: '<你的 key>'
  fallbackModel: 'baai/bge-m3'
  fallbackProviderOrder: 'Parasail'        # OpenRouter 专属：钉住 provider，防负载均衡导致逐位漂移
```

四个 `fallback*` 键**缺省为空 = 不启用回退**（行为与旧版逐字相同）。
代理无需改动：`src/embed.ts:147` 只在 `TAG_EMBED_PROXY` 显式设置时才走代理，本地端点在 `NO_PROXY` 内。

### 3.5 失败你看得见（两条出口，都不挡事、都可复制）

- **对话内通知**：每次 pre-step 播一条 `form:'notice'` 消息（不冒充用户），内容是完整排障文本——
  失败端点 / 错误原文 / 回退到哪 / 影响面 / 处置命令。同一类事件 **5 分钟冷却**。
- **面板卡片**：`/memo-river/tuning/panel` 的「嵌入链路」卡，含三类计数 + 最近事件全文 + 一键复制。
- 设计约定：**同一个失败不报两遍**——`all-failed`（全链失败）已有既有可见路径（注入失败 = 「召回未生效」通知，
  写入失败 = 工具报错），故只进面板与日志，不进对话通道。

### 3.6 验收（照抄即可）

```bash
node scripts/probe-embed-fallback.mjs      # 回退行为专项：期望 18/18
PROBE_EMBED_API_URL=http://127.0.0.1:8099 PROBE_EMBED_DIM=1024 \
  node scripts/probe-embed-latency.mjs     # 延时 A/B（不需要 config.env）
node scripts/probe-embed-local-parity.mjs  # 本地 vs 远端向量一致性：期望 cos ≈ 0.9999+
```

> 详细版（构建/铲坑/服务化/切换验收全记录）见 **`docs/local-embed-2026-10-15.md`**。

---

## 4. 验收与自检

| 命令 | 测什么 | 端点依赖 | 期望 |
|---|---|---|---|
| `node scripts/acceptance-queryfield.mjs` | 注入/查询场/降级路径 | **无** | 6/6 |
| `node scripts/probe-embed-fallback.mjs` | 端点回退行为 | 本地或桩 | 18/18 |
| `node scripts/acceptance.mjs` | 全链路 37 项 | **真嵌入端点** | 34–37；红集说明见下 |
| `node kernel/tools/diff-runner.mjs` | 自研内核 vs 上游逐位对账 | 无 | 五腿 PASS |

**主套件红集的已知抖动**（不是你的环境坏了）：`#8` 名次与归档 baseline 一致（跨模型比对，需重定标）、
`#10` 并发==串行（端点时序敏感）、`#25` 近因保底（硬编码期望）。**单条先复跑再定罪**。
套件默认在隔离柜里跑（自建自净），要复用省钱：`MEMO_ACC_HOME=/var/tmp/memo-acc-home`。

---

## 5. 故障排查表

| 症状 | 根因 | 处置 |
|---|---|---|
| `npm install` → `Cannot read properties of null (reading 'children')` | npm 12 解析**宿主提供的 peerDependencies** 时空指针崩 | 本仓已修（`peerDependenciesMeta.optional` + `.npmrc`）；仍崩就 `npm install --legacy-peer-deps` |
| `npm install` → `EALLOWREMOTE: Refusing to fetch "…"` | npm 12 拒取"外部"tarball：锁文件里 `resolved` 的主机与当前 `--registry` 不一致（例如锁钉 npmmirror、你却用默认 registry） | 本仓锁文件已钉**官方 registry**（官方/镜像两种网络实测都通过）；若你换镜像仍撞：`npm install --no-package-lock`，或在干净目录重生成锁 |
| 全新克隆 `npm install` 说成功，`build.sh` 却报 `Cannot find module 'undici'` | 锁文件是在**已有 `node_modules`（尤其含 build.sh 建的 junction）的目录里**生成的 → 宿主包被记成相对路径条目、真依赖被记成 `link` → 新克隆只建链接、不装包 | 锁文件必须在**干净目录**生成：`rm -rf node_modules package-lock.json && npm install --package-lock-only`，再把 `package-lock.json` 提回仓库（本仓已修） |
| `build: 找不到 tsc（$DSH_CHECKOUT/node_modules/.bin/tsc 或 PATH 上的 tsc）` | 没装依赖（`node_modules` 不存在），而 DSH 安装布局里自带 typescript | 先 `npm install`（本仓 `typescript` 是 devDependency，build.sh 的第二优先级正好用它） |
| 构建报类型错、指向 `cordis`/`schemastery` | junction 没建成功（DSH 没找到） | 确认 `command -v dsh` 有输出；或 `DSH_CHECKOUT=<dsh 源码 checkout> bash scripts/build.sh` |
| 加载期 `native.kernel 未知取值` | `native.kernel` 写了别的值 | 只能是 `vcp` \| `reimpl`（故意不静默回退） |
| 加载期找不到 `.node` | 选了 `reimpl` 但没编译内核 | 按 §2.2 编译（`memo-kernel.linux-x64-gnu.node` 不入库） |
| 写一篇日记报 `embed-unavailable` | 没配嵌入端点（或端点不可达） | 配 `embed.*`（§1.5/§3.4）；或接受离线降级 |
| 被动注入老是跳过（`inject-skip reason=embed-timeout`） | 嵌入端点太慢（> `inject.embedTimeoutMs`，缺省 8000ms） | 换本地嵌入（§3）或换端点；看桶日志 `elapsedMs` 与面板的嵌入链路卡 |
| 文档里 `~/.dsh/memo-river/` 一堆空壳桶 | 在临时目录里起过会话（桶名 = cwd 哈希） | `node scripts/clean-junk-buckets.mjs`（缺省 dry-run，`--apply` 真删） |
| 面板打不开 | 路径或宿主没起 | 先确认 dsh web 在跑，再开 `http://127.0.0.1:3080/memo-river/tuning/panel` |

---

## 6. 目录与读文档顺序

```
src/          → 编译到 lib/（构建产物，不入库）
kernel/       → Rust 复刻内核（cargo build --release → *.node，不入库）
scripts/      → 验收套件 / 探针 / 运维件（清单见 scripts/README.md）
bundle/       → 预设声明（cordis.patch.yml，装进 profile 用）
panel/        → 调参面板前端件
docs/         → 设计与事故记录（按日期；上手请只读本文件 + DESIGN.md）
AGENTS.md     → 仓级工程守则（构建红线、验证闸门、WAL 契约）
DESIGN.md     → 完整设计依据（55KB，唯一真源）
```

**建议顺序**：本文件（跑通）→ `DESIGN.md`（为什么这么设计）→ `AGENTS.md`（改代码前必读）→ `docs/` 里与你问题同名的那篇。
