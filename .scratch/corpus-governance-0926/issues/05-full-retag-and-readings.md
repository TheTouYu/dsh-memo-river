# 05 — 全量执行 + before/after 读数（生产根 81 篇）

**What to build:** 把票 04 的 PLAN 打到**生产根**的 `dsh-memo-river` 桶，并留下可比读数。

**目标桶**：`/home/h/.dsh/memo-river/6c8bcf85fe1b56e1`（81 篇 / 19 Tag；用户真实会话用的那份）。

**要做**：
1. **备份**：`cp -a` 整桶到 `.scratch/backup-<ts>/`（工作区内，**不放 /tmp**），核对 `knowledge_base.sqlite`
   + `-wal` + `-shm` + `emb-cache.json` + `dailynote/` 全在（照 2026-09-26 对 deepseek-harness 的做法）。
2. **before 读数**：`PROBE_SRC=<备份>/6c8bcf85fe1b56e1 node scripts/probe-anchor-trace.mjs "<查询>"`
   ——固定 **4 个查询**（一个枢纽词如 `写入去重`、一个内容式问题、一个长命题式、一个本仓主题词），
   记录 Ω / regime / strength 分布 / promoted。
3. **执行**：`DSH_HOME=/home/h/.dsh node scripts/retag-content-tags.mjs --apply --plan .scratch/corpus-governance-0926/plan-dsh-memo-river.json`
   - 写 `/home/h/.dsh/**` 需**一次性全权限沙箱**（workspace-write 下报 `EROFS`，失败发生在盘上文件写入、
     DB 事务之前——但仍须按句式核对桶内零残留：chunk 数 / tag 数 / file_tags 数不变）；
   - 执行窗口内避免并发写（该桶是活的：本会话与用户的会话都可能写）。
4. **after 读数**：同一个 4 查询 + `memo_stats` 判据①②（经 `DSH_HOME=/home/h/.dsh` 路由，勿用本会话工具——
   本会话 `DSH_HOME` 是沙箱根，`folder` 会解析到沙箱副本）。
5. **漂移观察**：写入一周内（或票 02/03 生效后一轮）复跑 max freq，确认没有漂回枢纽。

**判据（可复现读数）**：
- [ ] 81/81 改写成功；**正文 81/81 逐字节一致**（脚本自证 + 独立 python 按 path 复核）
- [ ] max Tag 频次 < **1/3**；连通分量 = **1**；**孤儿 Tag = 0**
- [ ] before/after 表：Ω 与 regime 分布、anchor>0 的候选数、`direct_answer` 晋升例数
- [ ] 旧三枢纽（归因错误 / 写入去重 / 被动召回）降到 <1/3
- [ ] 备份路径与还原命令写进票面

**Blocked by:** 04。

**Status:** done — commit `a4f5e85`（生产执行 + 独立复核，读数见文末「生产执行读数」）

- [ ] 整桶备份 + before 读数
- [ ] 全量改写（含 EROFS 处置与零残留核对）
- [ ] after 读数 + 独立正文复核 + 漂移观察项登记

---

## 预检（2026-09-26，主代理）

- **裸 Tag 行 = 0**：用票 07 第 3 项的扫描口径跑 `dsh-memo-river` 生产根（81 篇）⇒ 0 命中
  ⇒ 全量 retag 不会遇到「正文里手写 Tag 列表」的遗留问题（`deepseek-harness` 那边有 4 篇，属票 07 第 3 项）。
- **计划来源**：PLAN 由票 04 产出（`.scratch/corpus-governance-0926/plan-dsh-memo-river.json`），
  `retag-content-tags.mjs --plan` 为外置入口；执行前须先 `cp -a` 生产根到工作区（`/home/h/.dsh/**` 在沙箱下 EROFS，
  见 `scripts/README.md` 状态纪律）。
- **执行后必跑**：`DSH_HOME=/home/h/.dsh node scripts/acceptance-corpus.mjs --bucket dsh-memo-river`
  （腿②应从 0.358 落到 <1/3、连通分量仍 1、孤儿 0）＋ `scripts/probe-anchor-trace.mjs`（`PROBE_SRC=` 指副本）
  取 4 个查询的 anchor/Ω before-after。

### 主代理独立复核 PLAN（`plan-dsh-memo-river.json`，81 篇）

按 chunk id 口径核对，全部通过：

| 检查 | 读数 | 判据 |
|---|---|---|
| 覆盖 | PLAN 81 篇 / 桶 81 chunk，**缺口 0**、越界键 0（`_folder`/`_note` 为元数据，脚本忽略） | 全覆盖 |
| 每篇 Tag 数 | min 3 / max 4 | 3–5 ✓ |
| 词表 | **34 个新内容词**（+ 旧 19 个各保留 1 篇作连通桩 = 53 个出现的 Tag） | 25–35 ✓ |
| 每 Tag 篇数 | top `注入时序:22`、`归因纠偏:16`、`验收套件:15`；超 25 者 **0** | ≤25 ✓ |
| 旧 19 词 | **19/19 全保留**（各 1 篇）——连通分量因此仍为 1 | ≥1 篇 ✓ |
| 连通分量（Tag 共现图） | **1**（规模 53） | =1 ✓ |
| Tag 长度 | max 13 字 | ≤20 ✓ |

**写侧闸门预演**（用真嵌入算余弦，避免 81 篇跑到一半被同义闸门拒）：

| 检查 | 读数 |
|---|---|
| 新 Tag × 既有 Tag（19 个）最高余弦 | `归因纠偏 × 归因错误 = 0.8309`，**超 0.92 者 0/34** |
| 新 Tag × 新 Tag（561 对）最高余弦 | `草稿队列 × 草稿预审 = 0.6822`，**超 0.92 者 0/561** |

⇒ 同义闸门（`SYNONYM_COSINE=0.92`）不会在写序中途拦下任何一篇；`retag` 的失败面主要只剩嵌入端点抖动
（`WRITE_EMBED_TIMEOUT_MS=15s` + 1 次重试）——执行时按票 03 先例盯端点。

**执行前提**：PLAN 里 34 个新 Tag 都是**首次入库** ⇒ 每篇 memo_update 都必须带 `newTagReason`
（写侧闸门硬性要求），retag 脚本已按此传参（复核时确认一次）。

### 执行前置（已就位，2026-09-26）

- **新 Tag 闸门的 newTagReason 已复核**：`retag-content-tags.mjs:131-133` 在 `--plan` 模式下有**非空兜底文案**
  （PLAN 里没有 `_reason` 元数据也不影响）⇒ 34 个首次入库的新 Tag 不会被 `unconfirmed-new-tags` 拒。
- **执行前备份已就位**：`.scratch/backup-<ts>/6c8bcf85fe1b56e1/`（路径记在同一目录的 `05-backup-path.txt`），
  校验：81 files / 81 chunks / 19 tags / 每篇 file_tags 齐全 —— 失败可整体回滚。
- **落地命令（照票面）**：
  `DSH_HOME=/home/h/.dsh node scripts/retag-content-tags.mjs --apply --plan .scratch/corpus-governance-0926/plan-dsh-memo-river.json`
  （先 `--dry` 一轮看计划自检：条数/长度/跨篇频次三闸；`/home/h/.dsh/**` 需一次性全权限，见 scripts/README 状态纪律）

### 脚本 flag 语义（2026-09-26 实测确认，执行前必读）

- **写入门 = `--apply` 一个字面量**（`retag-content-tags.mjs:48` `const APPLY = argv.includes('--apply')`）。
  没有 `--apply` ⇒ 任何调用都是干跑：`:256` 的 `if (!APPLY) { … line('（未加 --apply，未写任何东西。）') }` 早退，
  **连读数 JSON 都不写**。实测：我误把 `--help` 当帮助（脚本**没有** `--help`），它按缺省参数跑了一遍内置表计划
  （打印「桶 = deepseek-harness 篇数 20」），生产桶零变化（81/81/19/261，mtime 仍是 09-17 22:19）
  ⇒ 这是一个**好的安全默认**，但也意味着「命令打错」不会报错、只会静默干跑。
- `--dry` **不是一个 flag**（只看 `--apply`）；干跑仍会**打开目标桶**（`:170` 注释：要报「实际」频次）⇒ 需要读权限，不写。
- 其它真 flag：`--folder`（缺省 `deepseek-harness`；`--plan` 的 `_folder` 在未显式传时接管）、`--plan <json>`、
  `--max-per-tag N`（内置表缺省 5、外置表缺省 25，硬校验 `< 篇数/3`）、`--only 1,2,3`（**部分补做**：中途失败后不必全跑）。
- 真写模式落读数：`.scratch/retag/readings-<ts>.json`（含 plan/results/tagFrequency/maxFreqRatio/components/bodyDrift）。
- **生产执行命令（票 05 第 2 步，待 04 试跑判绿）**：
  `DSH_HOME=/home/h/.dsh node scripts/retag-content-tags.mjs --apply --plan .scratch/corpus-governance-0926/plan-dsh-memo-river.json`
  —— `--folder` 由 PLAN 的 `_folder="dsh-memo-river"` 接管，别手动传（打错桶的第一道闸就是它）。

### 生产干跑读数（2026-09-26，`DSH_HOME=/home/h/.dsh`，**未加 --apply**）

```
桶 = dsh-memo-river　PLAN 来源 = .scratch/corpus-governance-0926/plan-dsh-memo-river.json（81 篇）
篇数（计划覆盖）= 81　Tag 种类 = 53　最大跨篇 = 22（cap 25）
判据 ②（最大频次 < 1/3）：需 < 27.00；本计划 22/81 = 0.272
✅ 计划自检通过（3–5 个/篇、≤20 字、跨篇 ≤25、22/81 < 1/3）
── 逐篇打印 81/81 条 old→new 映射（402 行日志，本地 .scratch/…/05-dry-run.log，已 gitignore）
（未加 --apply，未写任何东西。）
```

**结论**：生产桶侧**四项前置全部绿灯**——① 计划自检 PASS（81/81 覆盖、53 词、max 22 ≤ cap 25、22/81 < 1/3）；
② 写侧同义闸门预演 0/34 与 0/561 超 0.92（round 2，真嵌入）；③ `newTagReason` 非空兜底；④ 备份 81/81/19/261 + 原子副本。
⇒ 待票 04 试跑判绿后，**唯一还差的是 `/home/h/.dsh/**` 的写权限**（workspace-write 下 EROFS），
那一步会弹一次全权限确认——**那一刻就是「真打生产」的确认点**。

**生产桶零写入证据**：干跑前后 `81 files / 81 chunks / 19 tags / 261 file_tags`，`knowledge_base.sqlite` mtime 仍是 `2026-09-17 22:19:18`。

### 票 04 试跑暴露的三个坑（apply 前必读，来自 `04-pilot.md` + 主代理复核）

1. **副本试跑走不到磁盘分支**：本桶 `files.path` 存的是**生产绝对路径**，副本 root 不同 ⇒ 护栏
   `src/tools.ts:613-622`（`!filePath.startsWith(workspace.paths.root)` → 只更新库、不落盘）让 15 篇试跑**全走库内分支**。
   子代理另建 `disk-home`（把 path 前缀 replace 到副本根）补验 D4/D9/D40：**磁盘 .md 80/80 逐字节一致、Tag 行 3/3 替换** ✓
   ⇒ 生产根会走**磁盘+库双写**，两条分支都已覆盖；但**在副本上做验收不能只看磁盘**。
2. **D1 在生产也永远不落盘**：`files.path=/tmp/mr-diary-20260912/…txt`（桶外）⇒ 护栏生效，只更新库；
   报告会带「改写目标路径在工作区根之外」。**这是设计意图，不是失败**（别去"修"它）。
3. **环境性 SIGBUS（exit 135）**：一次跑 15 篇时 D1 写成功后进程崩（`Bus error`，日志尾 `[Vexus] SQLite keepalive retained…`，
   与 D3/D46/D48/D78 同族）。对策=**分批 + 重跑**：改 5 批×3 篇后连续 20 次进程 exit 0；
   `--only 1,2,3` **幂等**（`file-map-<folder>.json` 兜底 chunk id 变更，重复跑实测命中兜底）⇒ apply 建议分批。

**覆盖面漂移（apply 时必核）**：PLAN 覆盖设计时的 81 篇；桶此后长到 87 篇（新增含票 04 定稿 D89、票 02 的 D91）
⇒ 未入计划者保留旧 Tag。apply 后必须用 `acceptance-corpus` 复核：判据② 的分母是**实际篇数**（87），
旧词计数 = 计划保留的 1 篇 + 未计划篇各自持有，仍应 <1/3；**连通分量**同理——我改 D91 时留下的
`枢纽Tag泛化`（当前 0 篇的孤立 Tag）会被 PLAN 挂到 5 篇上 ⇒ apply 后分量回 1（但**只有全量 apply 才成立**，
跑 `--only` 分批的中间态会看到分量 ≠1，别误判为失败）。

### apply 后的取证 runbook（写好待用）

**before 读数用冻结快照，不用活桶**（活桶在写，`cp -a` 会拷到半个事务）：
`PROBE_SRC=.scratch/backup-<ts>-pre05/6c8bcf85fe1b56e1` ← 打生产前的整桶备份，天然是 before。
after 用活桶：`PROBE_SRC=/home/h/.dsh/memo-river/6c8bcf85fe1b56e1`。
两跑同一命令形状，4 个查询（干跑验证 / 推送闸门脏增量 / profile清单校验 / 为什么嵌入端点变慢了）：

```
bash scripts/build.sh
for q in 干跑验证 推送闸门脏增量 profile清单校验 为什么嵌入端点变慢了; do
  PROBE_SRC=<before|after 桶目录> node scripts/probe-anchor-trace.mjs "$q" 6c8bcf85fe1b56e1
done
```

其余判据（都是只读）：
- `node scripts/acceptance-corpus.mjs --bucket dsh-memo-river`（**不设** DSH_HOME ⇒ 解析生产根）：①分量=1 ②top1<1/3 ③孤儿=0 ④正文 ⑤口径
- 打生产那个批次脚本自己的收尾块：`grep -E "判据 ①|判据 ②|正文完整性|写入结果" .scratch/corpus-governance-0926/05-apply.log`
- 主套件：#2 应转绿（票 08 A 落地），其余红集应与基线 16 项同（票 02 双盲归因已记）

---

## 生产执行读数（2026-09-26，用户批准后执行；**已完成**）

**执行**：新鲜整桶备份 `.scratch/backup-20260926-104457-pre05/`（`integrity_check=ok`，回滚可用）→
`DSH_HOME=/home/h/.dsh node scripts/retag-content-tags.mjs --apply --plan …/plan-dsh-memo-river.json --only <每批3篇>`
× **27 批** ⇒ **失败 0，用时 310s**。中途 **3 次 `Bus error`(SIGBUS)** 被「失败重试一次」救回（`--only` 幂等 + `file-map-dsh-memo-river.json` 兜底 chunk id 变更）——分批策略有效。
**末态**：`81 files / 81 chunks / **53 tags** / **277 file_tags**`（= PLAN 的 277 个挂载点，一比一）。

**脚本自证（最后一批尾部）**：
```
判据 ②（最大频次 < 1/3）：最大 = 22/81 = 0.272 → ✅ PASS（「注入时序」）
判据 ①（连通分量 = 1）：1（规模 53）→ ✅ PASS
正文完整性（只改 Tag 行）：✅ 81/81 篇逐字节一致（本轮改写 3 篇，未动 78 篇）
```

**旧三枢纽全部降到 1 篇**（改前 归因错误 29 / 写入去重 29 / 被动召回 27）：`归因错误 = 1 / 写入去重 = 1 / 被动召回 = 1`。

**独立复核**（`DSH_HOME=/home/h/.dsh node scripts/acceptance-corpus.mjs --bucket dsh-memo-river`，只读）：
```
桶 = dsh-memo-river@6c8bcf85fe1b56e1（root /home/h/.dsh/…）篇数 = 81　Tag = 53
最大频次「注入时序」×22（0.272）　孤儿 = 0　连通分量 = 1　→ **4/4 PASS**（④ SKIP，未给 --baseline）
memo_stats 同源输出：① 分量=1（规模 53）② 22/81=27.2% ③ Ω 近 41 次均值 0.506 ④ 未覆盖率 1/81 ⇒ **✅ 四项体检全部通过**
```

**探针 before → after**（4 查询；before 用打生产前的**冻结快照** `PROBE_SRC=.scratch/backup-…-pre05/…`，after 用生产活桶）：

| 查询 | Ω | queryMode | 超阈候选 | promoted |
|---|---|---|---|---|
| 干跑验证 | 0.733 → **0.9439** | atomic → atomic | 2 → 5 | false → false |
| 推送闸门脏增量 | 0.8543 → **0.9120** | atomic → atomic | 5 → 7 | false → false |
| profile清单校验 | 0.7164 → **0.9286** | **atomic → narrative** | 2 → 4 | true → false |
| 为什么嵌入端点变慢了 | 0.5848 → **0.7417** | atomic → atomic | 8 → 1 | **false → true** |

**怎么读这张表（诚实结论）**：
1. **Ω 全线上升**（观测图变密：Tag 节点 19 → 53，边更实），这是本票的直接目标；
2. **形态学主闸松动了**：`profile清单校验` 从 `atomic` 变成 **`narrative`** ⇒ 票 07 判定的「`structural_explanation` 结构性不可达」**不再成立**
   （role 分支见 `rivermemo_topology_v3.rs:2231/:2238`）——这是数据手术能翻的东西，原先以为翻不动；
3. **晋升不是单调改善**：4 查询里 promoted 前后各 1 真，但**换了对象**（profile清单校验 true→false、为什么嵌入端点变慢了 false→true）。
   机理：`contrast = strongest >= 2.0 × second` 这条**相对**判据在词汇表变富、竞争者变多后更难满足。
   ⇒ 后续票可考虑从 JS 侧覆写 `anchorFrontierContrast` / `anchorActivationZ`（`NativeConfig` 无 deny_unknown_fields，`src/native.ts:454-492` 目前一个字都没传 config）。

**回滚路径**：`cp -a .scratch/backup-20260926-104457-pre05/6c8bcf85fe1b56e1/. /home/h/.dsh/memo-river/6c8bcf85fe1b56e1/`（或只恢复 `knowledge_base.sqlite`）。
