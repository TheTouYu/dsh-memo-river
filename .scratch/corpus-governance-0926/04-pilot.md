# 04 试跑读数 —— 15 篇（副本）· 三项读数 + 探针 before/after

**纪律**：全程在**工作区副本**上跑，生产桶一字未碰（跑后核对：生产桶内无 2026-09-26 10:00 之后被改的文件，
最新 `.md` mtime 仍是 2026-09-16 17:23）。`TMPDIR=$PWD/.scratch/tmp`。

## 〇、结论先行

| 读数 | 结果 |
|---|---|
| 改写成功率 | **15/15 成功，0 拒绝**（走真实 `memo_update` → `writeDiaryCore` 全套闸门） |
| 正文逐字节一致 | **81/81 篇**（DB 侧，剔 Tag 行；含 66 篇未动的）；另有 3 篇在「路径在桶内」副本上验**磁盘 .md 81/81 一致** |
| `acceptance-corpus` | **4/5 PASS；腿② FAIL**（最大频次 29/81 = 0.358）——**这是试跑规模的必然**，见 §三 |
| 连通分量 / 孤儿 | **1 / 0** ✓（Tag 从 19 → 44，19 个旧词一个没掉） |
| 探针 4 查询 | Ω 全部上升、超阈候选数上升（0/0/2/2 → 2/1/4/4），`promoted` 仍全 false（形态学 atomic 门是主闸，票 07 已定论） |

---

## 一、怎么跑的（可复现）

```bash
# ① 两份副本（都在 .scratch 内，已 gitignore）
cp -a /home/h/.dsh/memo-river/6c8bcf85fe1b56e1 .scratch/plan-design/DSH_HOME/memo-river/
cp -a /home/h/.dsh/memo-river/6c8bcf85fe1b56e1 .scratch/plan-design/before/      # 纯净基线（探针 before / 腿④ baseline）

# ② 试跑（票面命令；`--folder` 由 PLAN 的 `_folder` 元数据键兜住）
TMPDIR=$PWD/.scratch/tmp DSH_HOME=$PWD/.scratch/plan-design/DSH_HOME \
  node scripts/retag-content-tags.mjs --apply \
  --plan .scratch/corpus-governance-0926/plan-dsh-memo-river.json \
  --only 1,4,5,9,10,12,13,21,24,31,37,40,45,65,83

# ③ 前后读数
DSH_HOME=…/DSH_HOME node scripts/acceptance-corpus.mjs --bucket dsh-memo-river \
  --baseline .scratch/plan-design/before/6c8bcf85fe1b56e1 --readings …/acceptance-after.json
PROBE_SRC=…/<桶目录> node scripts/probe-anchor-trace.mjs '<查询>' 6c8bcf85fe1b56e1
```

**为什么是这 15 篇**：13 篇是 §五 里 19 个旧词的**保留篇**（D1/D4/D5/D9/D10/D12/D21/D24/D31/D37/D40/D45/D65）
——试跑必须证明「旧词保留 + 新词接入」这条最脆的路径真的走得通；
另加 **D13**（全表最短的 3 Tag 篇，验下限）与 **D83**（末篇 + 跨桶作用域/验收套件，验末页与高频词）。
覆盖了 13/19 个旧词的改写路径。

---

## 二、逐篇结果（全部 ✅，无一条闸门拒绝）

```
D1 ✅ 6.5s   D4 ✅ 7.2s   D5 ✅ 2.4s   D9 ✅ 4.1s   D10 ✅ 3.7s
D12 ✅ 2.8s  D13 ✅ 4.8s  D21 ✅ 3.3s  D24 ✅ 5.0s  D31 ✅ 3.2s
D37 ✅ 3.1s  D40 ✅ 5.8s  D45 ✅ 3.1s  D65 ✅ 2.9s  D83 ✅ 4.0s
```
（首轮 2.4–7.2s/篇；重跑命中 emb-cache 后 ~0.1s/篇。**0 条** `synonym-of-existing-tag` /
`near-duplicate-diary` / `hub-tag-scoped` / `missing-title` / `too-few-tags` 拒绝——
同义余弦预检（设计说明 §四②）与「旧词各留 1 篇」是这条读数的前置条件。）

**改写形态**（以 D4 为例，磁盘实测）：
```
旧：插件拆线, 技能软链泛滥, 会话预设, 归因错误
新：技能发现根, 插件装配面, 预设作用域, 插件拆线
```
标题行、正文、文件路径、文件名全部不动；只有末尾 Tag 行被替换。

---

## 三、`acceptance-corpus.mjs` 五腿（before → after，同一副本）

| 腿 | before | after | 判 |
|---|---|---|---|
| ① 连通分量 = 1 | 1（规模 19） | **1（规模 44）** | ✅ → ✅ |
| ② 最大 Tag 频次 < 1/3 | 归因错误 29/81 = 0.358 | **写入去重 29/81 = 0.358** | ❌ → ❌ |
| ③ 孤儿 Tag = 0 | 0 | **0** | ✅ → ✅ |
| ④ 正文完整性（vs 基线） | 81/81 | **81/81 逐字节一致** | ✅ → ✅ |
| ⑤ 闸门口径一致 | 归因错误 29/81 | 写入去重 29/81 | ✅ → ✅ |
| **合计** | **4/5 PASS** | **4/5 PASS** | — |

**腿② 在 15 篇试跑后必红——这不是回归，是算术**：15/81 篇改写只能清掉**这 15 篇持有的**旧词计数
（归因错误 29→25、被动召回 27→22、门控校准 26→23…），而 66 篇未动的篇仍在挂旧枢纽
（`写入去重` 恰是 D10 的**保留词**，所以它仍是 29）。判据线只能由**票 05 全量**跨过：
静态模拟器对**全 81 篇**套用同一 PLAN 的读数是 **最大跨篇 22/81 = 0.272 < 1/3、分量 = 1**——
即票 05 跑完这条腿应从 ❌ 转 ✅（与票 06 的「目标桶绿」判据对齐）。

---

## 四、探针 before/after（同 4 查询，同副本口径）

`scripts/probe-anchor-trace.mjs`（`PROBE_SRC=` 指副本；探针自己再 `cp -a` 到 `.scratch/anchor-probe/`）。
四个查询：三个流程词（本桶旧枢纽 + 邻桶旧词）+ 一个内容式长句。

| 查询 | Ω before → after | regime | anchor **max**（strength） | 超阈候选（z=2, floor=0.05） | **promoted** |
|---|---|---|---|---|---|
| `干跑验证` | 0.7330 → **0.9805** | dense → dense | 0.2570 → 0.1556 | 2/81 → **2/81** | false → false |
| `写入去重` | 0.8508 → **0.9950** | dense → dense | 0.1165 → 0.1069 | **0/81 → 1/81** | false → false |
| `上游同步` | 0.5951 → **0.8950** | dense → dense | 0.1022 → 0.1036 | **0/81 → 4/81** | false → false |
| `内容词 Tag 重挂之后，被动注入的锚激活闸门能不能重新张开` | 0.5739 → **0.9868** | dense → dense | 0.1613 → 0.1590 | 2/81 → **4/81** | false → false |

附（同一次运行里的旁证）：artifact 的 Tag 节点 **19 → 44**，`contactedSeeds` 求和
222/161/212/248 → 157/102/146/101（接触面更集中）；`queryMode` 8/8 仍是 `atomic`。

**怎么读这四行**：
1. **Ω 四处全涨、且三处逼近 1.0**——`Ω` 是观测图上的稠密度量，15 篇换词就能把它从 0.57–0.85 推到 0.90–1.00。
   方向与 README §一（流程词 → 内容词后 sparse → dense）一致，**但幅度被试跑规模限制**（81 篇里只动了 15）。
2. **超阈候选数从 0/0/2/2 变 2/1/4/4**——锚激活闸门 `threshold = max(floor, mean+z·σ)` 是相对量：
   池内不再同质，`max` 才终于能压过 `mean+2σ`。这正是「换词汇表让闸门活过来」的最小可判别信号。
3. **`promoted` 全 false 不是本票的失败**：票 07（`docs/EVAL-诊断-direct-answer.md`，commit 025e06e）
   已把 `direct_answer=0` 定因为**形态学 `atomic` 门**（`mode != "atomic"` 才允许初判），
   阈值从 0.55 调到 0.45 通过率零变化。**4/4 查询仍 `queryMode=atomic`** ⇒ 晋升旁路不动，
   本票（数据手术）不该、也不可能在 15 篇规模上翻这个闸。

---

## 五、过程中的两个发现（票 05 必须知道）

### 发现 1：**副本试跑默认只走「库内更新」分支**，不是磁盘分支

`writeDiaryCore` 的改写护栏（`src/tools.ts:613-622`）：

```ts
const dir = join(workspace.paths.root, 'dailynote', slugify(bucket))
let filePath = input.updateOf ? input.updateOf.path : join(dir, …)
if (input.updateOf && !filePath.startsWith(workspace.paths.root)) {
  healthLines.push(`· 改写目标路径在工作区根之外，只更新库不落盘：${filePath}`)   // ← 只写库
} else { writeFileSync(filePath, full) }                                      // ← 写库 + 落盘
```

本桶 `files.path` 存的是**绝对路径**（`/home/h/.dsh/memo-river/6c8bcf85fe1b56e1/dailynote/...`），
副本的 `workspace.paths.root` 却是 `<workspace>/.scratch/plan-design/DSH_HOME/memo-river/6c8bcf85fe1b56e1`
⇒ 15 篇试跑**全部走「只更新库」分支**（`grep 工作区根之外` 命中 15 行）。

**为了补上磁盘分支的读数**，另建一份副本 `disk-home`（`UPDATE files SET path = replace(path, '<生产前缀>', '<副本前缀>')`），
在其上跑 3 篇（D4/D9/D40）：**逐篇磁盘 .md 正文逐字节一致、Tag 行 3/3 按 PLAN 替换、无「工作区根之外」行**。
⇒ 票 05 在生产根上（路径在根内）会走**磁盘 + 库双写**分支；这两条分支都已被试跑覆盖。

**D1 是唯一例外**：`files.path = /tmp/mr-diary-20260912/2026-09-12-memo-river-四个真bug.txt`（桶外）
⇒ 无论生产还是副本，D1 永远只更新库、不落盘。**这是设计意图（票②的工作区外路径护栏），不是失败**。

### 发现 2：环境性 **SIGBUS**（一次）与它对票 05 的处置要求

首轮一次跑 15 篇时，D1 写成功后进程立刻 `Bus error`（core dumped，exit 135），日志尾巴是
`[Vexus] 🛡️ SQLite keepalive retained for …`。这与语料里既有的环境性 SIGBUS 同族
（D3 验收首跑、D46/D48 隔离归因、D78 结案：重启后主套件 37/37 全绿）。

对策（已实践）：**分批 + 重跑**。改成 5 批 ×3 篇后，**连续 20 次进程全部 exit 0**（SIGBUS 未再现）。
`--only` 分批是安全的——脚本的 D 编号定位有 `file-map-<folder>.json` 兜底
（`memo_update` 会换 chunk id，fileId 不变；重跑实测命中兜底、幂等：同一 PLAN 重写同一 Tag 行）。

> 顺带一条日志噪音（非功能问题）：原生模块打印的 keepalive 路径是**小写化**的
> （`…/plan-design/dsh_home/…`），而同一份日志里 `[Vexus-Lite][EPA]` 打印的是**正确的大写路径**，
> 且磁盘上从未出现小写目录。⇒ 只是日志字符串规范化，实际打开的是正确库。

---

## 六、读数落盘位置

| 文件 | 内容 |
|---|---|
| `.scratch/plan-design/probe/before-q{1..4}.log` / `after-q{1..4}.log` | 探针全量输出（§四表格的原始行） |
| `.scratch/plan-design/readings/acceptance-before.json` / `acceptance-after.json` | 五腿结构化读数 |
| `.scratch/plan-design/pilot-apply.log` | 15 篇试跑全量日志（含每篇闸门报告与收尾自证） |
| `.scratch/plan-design/disk-branch.log` | 磁盘分支 3 篇试跑 |
| `.scratch/retag/readings-*.json` | 脚本自身落盘的读数组（含 planSource / planCap / only / bodyDrift） |
