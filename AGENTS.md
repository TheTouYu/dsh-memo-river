# dsh-memo-river 仓守则（AGENTS.md · 会话自动加载）

> 定位：VCPToolBox TagMemo/RiverMemo 记忆算法的 dsh 插件化（含 zcode-adapter 侧）。活知识三通道：本文件（仓级工程守则）｜工作区 `~/dsh-plugins/AGENTS.md`（环境硬坑与运维速查）｜记忆河流（教训脉络，被动召回）。

## 布局与产物

- `src/` → 编译 `lib/`（**构建产物，.gitignore 不入库**）；`kernel/` 是 rust 复刻内核（cdylib → `kernel/memo-kernel.linux-x64-gnu.node`，同样不入库，`cargo build --release` 后 cp）；上游对照真件在 `/home/h/app/VCPToolBox/rust-vexus-lite`（有 `ensure_sqlite_keepalive`，行为基准）。
- `zcode-adapter/` 是 ZCode 侧分支形态；`scripts/` 含验收/差分/运维件。

## 构建红线

- **外人路径（新克隆先跑这个）**：`npm install` → `bash scripts/build.sh`（build.sh 自动从已安装的 dsh 建 junction，并用本仓 `node_modules/.bin/tsc` 编译）。`npm install` 若报 `Cannot read properties of null (reading 'children')` 是 npm 12 解析**宿主提供的 peerDependencies** 时空指针崩——本仓已内置 `peerDependenciesMeta.*.optional` + `.npmrc legacy-peer-deps=true`，仍崩就加 `--legacy-peer-deps`。详见 `docs/QUICKSTART.md`。
- **勿信 `.bin/tsc`**（兄弟仓 billion-context-dsh 的是 0 字节坏壳——退出码 0 零输出假成功）。编译：`node ../billion-context-dsh/node_modules/typescript/lib/tsc.js -p .`，编完 `grep -c <新标记> lib/<文件>.js` 必须非零。
- 内核改动：`cd kernel && cargo build --release && cp target/release/libmemo_kernel.so memo-kernel.linux-x64-gnu.node`。

## 验证闸门（改动分级）

- **内核/写路径改动**（kernel/、store.ts、workspace.ts、daemon.ts）：`node kernel/tools/diff-runner.mjs` 五腿 PASS（判据分数差 ≤1e-6，健康史 1.11e-16）+ `node scripts/acceptance.mjs` 37/37（reimpl 轨跑法：`MEMO_NATIVE_KERNEL=reimpl node scripts/acceptance.mjs`）。#8 已改为**读出链名次快照**（2026-10-15 v2 基准，bge-m3@OpenRouter·钉 Parasail、查询向量现场嵌）：换嵌入模型/端点后名次会变属预期——用 `MEMO_ACC_RERECORD_SNAPSHOT=1` 重录、人工核对 generated.json 后贴回 SNAPSHOT 常量，**不许静默自愈**；「与上游一致」由 diff-runner 专责，不再比 native-result.json.bak（跨模型旧档，已死档）。
- **注入/查询场/降级路径改动**（injector.ts、render.ts、session.ts）：`node scripts/acceptance-queryfield.mjs` 6/6（**无端点依赖**，含 source.kind 白名单逐条 + 同日志新旧实现负对照 + 失败通知集成）+ `node scripts/acceptance.mjs`。⚠️ 主套件跑真嵌入端点，**端点劣化时整套会随机红 6-8 条**（2026-10-14 实测：同一份代码两次跑红集不相交 #1/#4/#5/#31 ↔ #17/#32/#37）——红一条先复跑、再看桶日志里的 `inject-skip reason=embed-*` 占比，别急着归因代码。
- 生产内核轨切换：双轨 acceptance 全绿才允许改 `~/.config/systemd/user/dsh-web.service.d/kernel-reimpl.conf` 的 `Environment=MEMO_NATIVE_KERNEL`，改后 daemon-reload + restart dsh-web。

## 测量与断言纪律（2026-10-14/15 复盘提炼，每条都有血）

- **采样器/监控锚定「从此刻起」**：只统计启动之后的行，绝不回填历史。首版注入时延采样器把日志尾部整段回填 → 1193 条换端点前的旧样本混进来，p50 假报 3115ms（`scripts/probe-inject-sampler.mjs` 已修；`--out=` 可隔离多实例）。
- **对照按状态变更点切窗；n≥10 才报分布；报分位数不报单点**。2026-10-15 拆批上线：先用**单个** 457ms 宣布见效、后用旧分布的**低端三例**当基线宣布没改善——全量三段对账（n=48/44/12）才看清真账：服务端 in-flight 去重 **-67%** 是主功、拆批再 **-18%**（p90 未动，尾部成本在流水线别处）。
- **恒等断言先冻结「按设计就带状态」的输入**：provider 负载均衡 → `makeConfig` 钉 `providerOrder`；选择权重读工作区共享曝光台账 → #10 块内冻结三权重 + `try/finally` 还原（三连跑 37/37）。冻结了什么必须写进 `check` 明细（可审计），且被冻结的机制自身要另有用例覆盖（#19/#25/#26/adaptive-k）。
- **部署验证用「新旧代码产出不同的观测量」**：「进程启动晚于 lib 编译」只是必要条件。拆批的判据 = 本地服务请求形状 `n=3`（旧）→ `n=1+n=2`（新）；通知去重的判据 = 直接对**已部署 lib** 调 `record/markAnnounced/pending(t+6min)` 断行为，而不是等 5 分钟看界面。
- **凡「我记得我写过 / 这是唯一一份」必回读真源**：无头 `.bin`（`headerEnsured` 的内存记忆 vs 盘上头）、配置面 4 份预设（`dump-config` 出全部实例）、116MB 缓存全量重写——三处同源事故，见 `docs/retrospective-2026-10-14-15-whale-to-split-batch.md` §三。

## WAL 双库契约（BUG-0930 血案，违者静默丢数据）

同进程内 node:sqlite（store 长连接）与 rusqlite 是**两份独立编译的 sqlite**——任何在活桶上开 readwrite 的代码路径**必须保 keepalive**（对照 `kernel/src/memo_artifact_builder.rs` 的 `ensure_sqlite_keepalive`：static SQLITE_KEEPALIVES 每 dbPath 一条永生连接，禁止每次构建开→commit→close）。close 从第二实例视角会重置 -wal，把 node 侧未 checkpoint 的提交行在进程边界静默回卷（integrity_check 仍是 ok——回卷不是损坏）。健康信号：health.log 出现 `ROLLBACK-TRIPWIRE files=N→M` 行 = 回卷实锤，立即取证（-wal 尺寸、最近重启、journal）。

## 运维件

- `scripts/reimport-orphans.mjs <workspace-cwd>`：桶 dailynote/*.md 与库 files 行比对，孤儿走 writeDiaryCore 全管线重灌。**必须 `env -u MEMO_NATIVE_KERNEL`**（防继承服务 env）；内置 reimpl 旧内核拒跑闸。
- schema 变更：`src/schema.ts` 53 条幂等 DDL，源参考 VCPToolBox classroom-flow；`scripts/gen-schema.mjs` 再生。
- 嵌入：api.relayrouter.ai 需代理（TAG_EMBED_PROXY=7890 三处兜底）；embed 失败写入 NULL 向量+告警（不阻断）。
- **嵌入端点配置面有 N 份（每个预设一份）**：`dsh --profile web --dump-config` 里 `- id: memo-river-plugin` 会出现多次（memo-river / qxqy-river / river-acp / river-acp-dev）；实际挂载哪份由 `agent-preset-registry.selectedDefault` 决定（本机 = `river-acp`）。改端点必须逐份核对，否则会在一个没人在用的预设上改配置（2026-10-15 切换本地嵌入时即因此白重启一次）。判据见 docs/local-embed-2026-10-15.md §8.5。
- **嵌入缓存是 `.bin` 不是 JSON**（2026-10-14 内存鲸鱼修复，定谳见 dsh-plugins 桶 D98）：`emb-cache.bin` = 追加式 Float32 记录日志，内存有预算（`MEMO_EMB_CACHE_MAX_MB`，缺省 48MB 按 LRU 逐出）、落盘去抖 2s + 异步。旧 `emb-cache.json` 会被自动迁走（改名 `.bak`）——**别再写任何回 JSON 的代码**，也没必要备份它。
  - `scripts/compact-emb-cache.mjs`：清淤 + 落二进制。孤儿判据 = 不命中 `chunks.content ∪ tags.name`（一次性 query 键永远不该常驻）。**先跑脚本再重启**，否则大桶首次加载仍要整读一遍旧 JSON；脚本自带 `.precompact-<ts>` 留证、库读不动则跳过该桶。
  - `scripts/probe-emb-cache.mjs`（49 项单测：迁移/追加/逐出/截断自愈/无头自愈/落盘前验头/跳闸/exit 兜底）、`scripts/probe-emb-cache-mem.mjs`（真 `writeDiaryCore` 的内存验收台，`PROBE_LIB` 支持拿修复前的 lib 做负对照）。
- **套件卫生：DSH_HOME 隔离与空壳桶**（2026-10-14 整改）。每个工作目录对应 `$DSH_HOME/memo-river/<sha256(cwd) 前 16 位>/` 一个桶；套件把 cwd 放 tmpdir 却没设 `DSH_HOME` 时，就在**生产柜子**里留下永久空壳桶（无 `knowledge_base.sqlite`、无 `dailynote`）。实测 288 桶里 186 个是空壳，其中 35 个正是最近 2 小时 5 次验收跑出来的——字节只有 0.05MB，但**污染取证现场**（追查无头 `emb-cache.bin` 时最早的 8 个可疑文件全躺在这种假桶里，误导半小时）。
  - **全部测试套件已隔离**（`import './isolated-env.mjs'`，自建自净）：4 个自带夹具的（adaptivek/patrol/selection-weights/write-prompts）+ 既有 6 个（corpus/draft-scope/draft-tags/folder-route/hub-gate/shared-routes）+ **8 个依赖 `.selftest` 夹具的**（`acceptance.mjs`、-consolidation/-merge/-p3/-tiebreaker/-title-gate/-update/-usage）。
  - 那 8 个在主套件体内多一行 **`await ensureSelftestFixtures()`**：在**隔离柜内**用 `scripts/setup-selftest.mjs` 自铺 `.selftest/教室建模{归档,孤岛,写入测试}` 三夹具。⚠️ **每次运行都重铺**（~20s）——这些套件**会消耗共享夹具**：实测一波变体跑完，「写入测试」夹具从 **11 篇掉到 1 篇**（merge 归档源篇、update 改写、consolidation/usage 各写自己的小语料），此时 merge 会因凑不出「最相似的一对」而崩（`pair` 为 null）。它们的文件头写的就是 `setup-selftest && acceptance-X`。要省这 20s：`MEMO_ACC_NO_REFRESH=1`（只在库缺失时铺，⚠️ 夹具不新鲜时会出现「隔离没错却成片红」的假象）。⚠️ **铺台必须真向量**：`setup-selftest.mjs` 缺省用本地 hash 桩，随机向量下 gate 分数无意义，主套件会掉到 25/37——helper 已强制 `REAL_EMBED=1`。
  - 复用隔离柜：`MEMO_ACC_HOME=/var/tmp/memo-acc-home`（持久、退出不删）；`MEMO_ACC_KEEP=1` 留临时根取证；`MEMO_ACC_FIXTURE_MODE=stub` 用桩铺台（仅调试，语义用例会红）。
  - 空壳清理：`node scripts/clean-junk-buckets.mjs`（缺省 dry-run；`--apply` 真删；判据 = 无库 + 无 dailynote + mtime 早于 `--min-age`，缺省 30 分钟）。历史上跑出来的空壳已清（204 个，柜子 321 → 118 桶）。
  - `import-dailynote.mjs` / `reimport-orphans.mjs` 是**故意**对真桶干活的运维件，**不要**给它们加隔离。

