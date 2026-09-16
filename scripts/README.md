# scripts/ — 验收套件与测试基建

## 套件一览

| 套件 | 被测对象 | 缺省嵌入 | 快循环成本 |
|---|---|---|---|
| `acceptance.mjs`（主套件，37 项） | 全链路 | 真端点 | ~2min |
| `acceptance-folder-route.mjs` | folder 真路由（recall/write/update/merge/patrol 跨桶） | **本地桩**（`REAL_EMBED=1` 回真端点） | **~1.3s** |
| `acceptance-merge.mjs` | memo_merge 机制 + 去重豁免语义 | 真端点（`EMBED_STUB=1` 进桩，M-3 语义判据在桩空间会假红） | ~1.5min |
| `acceptance-update.mjs` | memo_update 原地改写 + 闸门 | 真端点（`EMBED_STUB=1` 进桩） | ~1.5min |
| `acceptance-title-gate.mjs` / `acceptance-patrol.mjs` / `acceptance-delegation-guidance.mjs` / `acceptance-write-prompts.mjs` | 各票机制 | 离线/桩（各自内建） | 秒级 |
| `acceptance-hub-gate.mjs`、`acceptance-adaptivek.mjs`、`acceptance-selection-weights.mjs`、`acceptance-draft-scope.mjs` | 各票机制 | 各自内建 | 秒级 |

## 嵌入桩（`lib/embed-stub.mjs`）——0916 固化资产

**问题**：走真端点的套件每次嵌入 1.2–1.5s RTT，一个套件十余次 + 失败重试 = 数分钟；
为看一条失败输出整跑 7 分钟，不可持续。

**方案**：本地 HTTP 桩走**真实 EmbedClient 传输**（零猴子补丁——实例替换/原型 getter
两代补丁均失败的教训见 `acceptance-write-prompts.mjs` T-4 注释）。两种向量模式：

- `hash`（通用）：词袋哈希（ascii 词 + CJK 二元组 → 3072 维桶，归一化）。共享词汇 →
  高余弦，异题 → 低余弦；向量随文本变化（配对挑选、主题命中断言都可用）。
- `fixed`：所有文本同向量（knn=1.0）——去重/并入引导类测试专用。

**代价与边界**（为什么 merge/update 缺省仍走真端点）：
1. 桩的余弦**尺度**低于真嵌入——门限类判据（dedup 0.95、gate 0.55）在桩空间会漂。
   folder-route 已在桩模式下同步调低 `inject.gateThreshold`（它测路由不测语义门限）；
   语义门限类断言（M-3 近重复拒写）**不要**迁到桩上跑。
2. **setup-selftest 与套件必须同空间**：桩种的语料配真端点套件 = 向量空间混杂，
   余弦全是垃圾。规则：`REAL_EMBED=1`（或都不加）成对使用；`EMBED_STUB=1` 也成对。
3. 桩在父进程时**子进程请求会死锁**：`execFileSync` 阻塞父进程事件循环 → 桩无法应答
   → 60s 超时。`setup-selftest.mjs` 的 `run()` 已改异步 spawn（`execFile` + promisify）。
   新写「父进程起桩 + fork 子进程」的脚本时记住这条。

**快循环配方**（<5s 全绿三件套）：

```bash
node scripts/setup-selftest.mjs >/dev/null && node scripts/acceptance-folder-route.mjs
node scripts/setup-selftest.mjs >/dev/null && EMBED_STUB=1 node scripts/acceptance-merge.mjs   # 机制面；M-3 留真端点
node scripts/setup-selftest.mjs >/dev/null && EMBED_STUB=1 node scripts/acceptance-update.mjs
```

**真端点全量**（改写侧语义/闸门后必跑一次）：

```bash
REAL_EMBED=1 node scripts/setup-selftest.mjs && REAL_EMBED=1 node scripts/acceptance-merge.mjs && REAL_EMBED=1 node scripts/acceptance-update.mjs
```

## 状态纪律（踩过的坑）

- selftest 工作区是**共享且被套件改写**的：merge/update 两个套件各自跑完会留下残稿
  （合并篇/改写标记/新 Tag），**每个套件跑前必须重跑 `setup-selftest.mjs`**，否则
  配对漂移、词汇表污染会让 A-1/A-3/M-3 假红（2026-09-16 实证）。
- SIGBUS 环境症：主套件偶发 `Bus error (core dumped)`、崩点漂移——先在干净 HEAD
  同刻复现判环境，重启 DSH 后复跑（2026-09-16 结案先例），不要急着改代码。
