# @dsh-external/dsh-memo-river

把 **VCPToolBox 的 TagMemo / RiverMemo 记忆算法**接进 DSH，做成 agent preset `memo-river`：
**被动注入为主干、工具补证、守护维护**。

设计文档（唯一依据）：[`DESIGN.md`](./DESIGN.md)。

---

## 一句话

每轮对话**自动**把相关历史日记片段注入到消息尾部（带 `role` / `Ω` / 奖励等证据分级）；
`memo_write` 写入前**强制**回注旧 Tag 词汇与语义相关旧日记；守护循环定期做**四项语料体检**。

---

## 三通道架构

```
① 主干（被动注入）
   agent/pre-step  ──► recall() ──► 门控 ──► 渲染 ──► 消息尾部追加
   固定的 system 段（零动态，保前缀缓存）

② 工具（主动补证）
   memo_recall / memo_write / memo_tags / memo_stats

③ 守护（后台维护）
   timer ──► 资产重建 + 四项体检 → health.log
         └─► 回合草稿 → pending/（等确认，不自动入库）
```

---

## 安装 / 构建

```bash
bash scripts/build.sh          # 链接构建依赖 + tsc：src/ → lib/
```

依赖解析策略：**优先已安装的 npm 布局**（本插件实际运行的那个 dsh），源码 checkout 仅作兜底。
理由见 `scripts/build.sh` 顶部注释——类型的来源必须与运行期的来源同一份。

## 接入 DSH

```bash
# 方式一：运行时注入（免重启，开发/验证用）
dev_build_plugin  /home/h/app/dsh-memo-river
dev_inject_plugin /home/h/app/dsh-memo-river

# 方式二：装进 profile（重启后仍在）
dev_install_package /home/h/app/dsh-memo-river
```

## 预设

`~/.dsh/.agent-presets/memo-river/`：

| 文件 | 作用 |
|---|---|
| `preset.yml` | 展示元数据（name / description / order） |
| `agent.cordis.yml` | 组装：从 shipped `standard` 复制，只多一行 `memo-river` 私有插件 |
| `memo-river.mjs` | 本地 wrapper：`export { … } from 'file:///home/h/app/dsh-memo-river/lib/index.js'` |

安装后，在 GUI 的新会话里选「**记忆河流（Memo River）**」预设即可。

---

## 配置（`agent.cordis.yml` 里的 `config:`）

| 键 | 默认 | 说明 |
|---|---|---|
| `workspaceScoped` | `true` | 按工作区（cwd hash）分库 |
| `intervalMs` | `900000` | 守护循环周期（15 分钟；下限 10000） |
| `bucket` | `''` | 空 = 取 cwd 的 basename |
| `embed.apiUrl` / `apiKey` / `model` / `dimension` | `''` / `''` / `gemini-embedding-2-preview` / `3072` | 空则回落到 VCPToolBox 的 `config.env` |
| `inject.gate` / `gateThreshold` | `true` / `0.55` | 门控：KNN 最高分低于阈值 → 不注入 |
| `inject.k` / `tokenBudget` / `dynamicK` | `3` / `600` / `1` | 注入条数 / 预算 / 动态 K 倍率 |
| `inject.mode` | `topology_v3` | 读出模式（`topology_v3` / `rivermemo` / `dtsc` / `tagmemo`） |
| `inject.minKnnForReward` | `0.6` | 低基数候选不发结构奖励（§2.2 规则 4） |
| `native.vcpRoot` | `/home/h/app/VCPToolBox` | 原生内核与 `rag_params.json` 的位置 |

### 嵌入传输层（连接保活）

嵌入客户端的 HTTP 传输不用默认 fetch（其 undici 全局 dispatcher `keepAliveTimeout` 仅 4s，轮与轮之间 TLS 连接必被拆掉，每次重付 connect ~0.4s + 握手 ~0.8s），改用**进程级共享 undici Agent**，同端点连续调用复用已建连接。参数走环境变量（进程级，非 `config:` 键）：

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `TAG_EMBED_KEEPALIVE_MS` | `240000`（4 分钟） | 客户端 keepAliveTimeout。有效复用窗口 = min(本值, 服务端 `Keep-Alive` hint − 1s)：上游 relay/CDN hint ~90s 时实际窗口 ~89s，仍远大于 4s 基线；空闲超窗自动重建连接、不报错 |
| `TAG_EMBED_CONNECTIONS` | `16` | 每端点并发连接上限（≥ 写侧并行度 `TAG_VECTORIZE_CONCURRENCY` 即够用） |
| `TAG_EMBED_CONN_LOG` | 关 | `=1` 时经工作区日志输出 `embed-transport connect/disconnect`（连接取证通道：证明连续调用只建一次连接） |

`undici` 以 `package.json` `dependencies` 声明；不可解析的环境回退默认 fetch（warn 一次，插件不崩）。开发树下 `node_modules/undici` 为指向 DSH 安装内副本（8.10.2）的 junction，与 build.sh 对 cordis 的链接策略同构。

---

## 存储

```
~/.dsh/memo-river/
├── plugin.log                     # 插件总日志
└── <sha256(cwd)[:16]>/
    ├── knowledge_base.sqlite      # VCP schema（文件名必须如此，原生内核硬编码）
    ├── emb-cache.json             # 嵌入缓存（省额度、保证可复现）
    ├── memo-river.log             # 本工作区日志
    ├── health.log                 # 四项体检逐轮追加
    ├── dailynote/<bucket>/        # memo_write 落盘的日记（人可读）
    └── pending/                   # 守护循环产出的候选草稿（等确认）
```

---

## 验收（实测，非「看起来对」）

```bash
node scripts/setup-selftest.mjs    # 一次性铺三个工作区（河流 / 孤岛 / 写入测试）
node scripts/acceptance.mjs        # DESIGN §10 的 10 条判据
node scripts/acceptance-p3.mjs     # P3：守护循环 / 体检日志 / 草稿 / 退避
```

当前：**10/10 + 4/4**。逐条实测输出见各脚本 stdout（含名次、hash、fallbackReason、日志行）。

---

## 四条铁律（DESIGN §6/§7）

1. **system 段零动态** — `systemPrompt.section` 只放编译期常量（sha256 校验），一切动态召回只走消息尾注入。
2. **`llm/stream` 必须 `next()` 委托** — 失败降级为「不注入 + 记日志」，绝不阻塞主流程。
3. **门控不过 → 清空不注入并带 `fallbackReason`** — 注入块必带 `role` / `Ω` / 未注入说明。
4. **会话状态按 session id 键** — 禁止全局 `lastXxx`。

---

## 实现记录（踩过的坑）

| 现象 | 根因 | 修法 |
|---|---|---|
| 并发两会话只注入一个 | 一个 Rust memo runtime 只认一个活动代际；A 的 `ensureArtifact` 与 B 的 `runPipeline` 交错，B 的 `artifactSig` 被顶掉（`memo runtime artifact … is not the active generation`） | `MemoEngine.runExclusive` 引擎级串行队列 + `ensureArtifact` 单飞；临界区只覆盖碰原生的部分 |
| 宿主进程里守护循环永不启动 | 探测 `ctx.get('timer')` 在真实 Cordis 上抛 `cannot get property "timer" without inject`（未 inject 的服务属性访问是**抛错**）；被启动自检的 try/catch 吞成一行 `plugin-startup-failed` | 删掉该探测，只做容错的 `ctx.interval` 只读探测；`daemon.start()` 单独 try/catch 并单独报错 |
| 空库报「四项体检全部通过」 | 0 篇时连通分量 = 0，判据形同虚设 | 空库显式报「无从判定」告警（§1 不变量 6：静默即不可接受） |
| 首轮 `file_tags.position` 与原生不一致导致名次翻转 | VCP 的 `position` 是 **1 基**，写入用了 0 基；该列参与原生图的内容/来源代际 hash | `i + 1`；同时 `checksum` = 文件名、`size` = 字符数 |
| `rebuildMemoArtifact` 之后读出仍是降级态 | DESIGN §9 说它一次重建全部派生资产，实测**不含** EPA 基底 / 内在残差 / 成对相似度 | 补齐三个 builder，各自失败隔离进 `assets.*.error` |

---

## 目录

```
src/
  index.ts     插件入口：seam 注册、会话/守护编排、启动自检
  config.ts    schemastery 配置 schema
  runtime.ts   DSH home / 工作区路径 / Logger / 工具函数
  store.ts     node:sqlite KnowledgeStore（VCP schema）
  schema.ts    由 scripts/gen-schema.mjs 从参考库 sqlite_master 生成（53 条 DDL）
  embed.ts     EmbedClient（复用 VCPToolBox/EmbeddingUtils.js 的调用形状）
  native.ts    vexus-lite 原生内核封装（MemoEngine）
  recall.ts    召回编排：KNN → 门控 → 流水线 → 读出 → 打分 → 截断
  render.ts    注入块渲染（格式见 DESIGN §6.2）
  prompt.ts    由 scripts/gen-prompt.mjs 从 DESIGN §6.1 逐字提取并附 sha256
  injector.ts  agent/pre-step（尾注入）+ llm/stream（只读审计）
  tools.ts     memo_recall / memo_write / memo_tags / memo_stats
  health.ts    四项体检
  daemon.ts    守护循环
  session.ts   按 session id 键的会话状态
  workspace.ts 工作区运行时注册表
scripts/
  build.sh              构建
  gen-schema.mjs        生成 src/schema.ts
  gen-prompt.mjs        生成 src/prompt.ts
  import-dailynote.mjs  导入语料（真实嵌入）
  build-island-corpus.mjs  物化孤岛语料
  setup-selftest.mjs    铺验收工作区
  acceptance.mjs        DESIGN §10 十条判据
  acceptance-p3.mjs     P3 守护/草稿/退避
```
