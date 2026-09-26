# 06 — `scripts/acceptance-corpus.mjs`：语料治理判据自动化

**What to build:** 本轮的四条治理判据目前只活在 `scripts/retag-content-tags.mjs` 的收尾自证里
（一次性、只对刚改的桶、不能对任意桶复跑）。把它们抽成常驻验收套件，让「语料退化」可被**例行检出**。

**要做**：新建 `scripts/acceptance-corpus.mjs`，五条腿（全部只读，除负样本腿在 `/tmp` 或 `.selftest` 内造样本）：

1. **① 连通分量 = 1**：直接调 `src/health.ts` 的 `connectedComponents(store)`；规模 ≥2 即红。
2. **② 最大 Tag 频次 < 1/3**：`store.tagFrequency()` 取 top1；同时校验 `freq/总数 < 1/3`。
   **注**：小桶要用票 11 先例的绝对下限语义（`f≥3 且 f≥files/3` 才判枢纽）——`nudge-guide.ts` 已有该修法，
   本套件须与之**同口径**，否则「年轻桶」会被误判成污染（D82 教训）。
3. **③ 孤儿 Tag = 0**：`tags` 表里没有任何 `file_tags` 行的行数（它是判据①失败的最常见前因：
   换词时漏留旧词 ⇒ 孤儿自带一个分量）。
4. **④ 正文完整性**：`--baseline <备份目录>` 时，按 **file.path** 对齐（**不要**用 chunk id——改写会换 chunk id），
   两侧都去掉 `Tag:` 行后逐字节比对；不一致逐篇列出。
5. **⑤ 闸门口径一致**：`store.tagFrequency()` 的 top1 与 `memo_stats` 报告的「枢纽 Tag 告警」必须点名同一词
   （防两处判据漂移）。

用法：`node scripts/acceptance-corpus.mjs --bucket deepseek-harness [--baseline .scratch/backup-…/50d29236c1297d2c]`
（桶根同样受 `DSH_HOME` 支配，套件须打印 `resolveBucket()` 的 root）；`--hash <16hex>` 消歧。

**判据（可复现读数）**：
- [ ] 对 `deepseek-harness@50d29236c1297d2c` 与 `dsh-memo-river@6c8bcf85fe1b56e1` 各跑一次：五腿全绿
- [ ] **负样本腿**：在副本里手插一条孤儿 Tag（或把某 Tag 灌到 ≥1/3 篇）⇒ 套件必须变红且点名
- [ ] `scripts/README.md` 套件一览加一行（覆盖 / 嵌入 / 耗时）
- [ ] 与 `memo_stats` 的告警口径对照记录在票面（相同输入下两处结果一致）

**Blocked by:** None — 可与票 01 并行开工。

**Status:** done — 2026-09-26（子代理实现，主代理复核；负样本两例变红、目标桶 4/4 绿、`dsh-memo-river` 腿②红属票 04/05 待治）

- [x] 五条腿实现 + `--help` + root/DSH_HOME 打印
- [x] 负样本变红（孤儿⇒①③、枢纽⇒②）；目标桶 4/4 绿；dsh-memo-river 腿②红=待票 05（判据已修正）
- [x] README 一览补行（`acceptance-corpus.mjs`）

---

## 执行读数（2026-09-26，`scripts/acceptance-corpus.mjs` 已落地；Status 待主代理复核后回填）

**交付**：`scripts/acceptance-corpus.mjs`（只读五腿 + `--bucket/--hash/--baseline/--readings`）；
`scripts/README.md` 套件一览 +1 行。用法自解释：`node scripts/acceptance-corpus.mjs --help`。

**① 生产根 `deepseek-harness@50d29236c1297d2c`（22 篇 / 29 Tag）——五腿全绿**
```
DSH_HOME=/home/h/.dsh node scripts/acceptance-corpus.mjs --bucket deepseek-harness \
  --baseline .scratch/corpus-governance-0926/snap/50d29236c1297d2c --readings .scratch/…/snap/readings-prod-dsh.json
→ root = /home/h/.dsh/memo-river/50d29236c1297d2c（DSH_HOME 核对行）
① connectedComponents = 1（规模 29）✅　②「上游同步」×7/22 = 0.318 <1/3 ✅（写侧 coldTagSuggest isHub=非枢纽）
③ 孤儿 = 0 ✅　④ 22/22 剔 Tag 行后逐字节一致 ✅　⑤ top1 与 memo_stats 告警同词「上游同步」×7/22 ✅
5/5 PASS（exit 0）
```

**② 同桶对**旧备份**（`.scratch/backup-20260926-071328/50d29236c1297d2c`，改写前 20 篇 / 8 流程词）——腿④ 真检出**
```
逐字节一致 19/20　漂移 1　基线有/现桶无 0　现桶新增 2
✗ …/2026-09-25-muh3q4mj-REQUEST-EXTENSION-真凶-profile-package-jso.md
    @78：基线「…**结论先行**：…」 现桶「…**⚑ 两条前置教训（放在最前…）**…」
```
⇒ 19 篇 Tag 行被**整篇重写**（8 流程词 → 29 内容词）而正文判一致（剔 Tag 行规则按预期工作），
唯一红的那篇是**真被改过正文**（多了一段前置教训）。基线里 2 篇是备份后新写的（仅计数，不判红）。

**③ 生产根 `dsh-memo-river@6c8bcf85fe1b56e1`（81 篇 / 19 Tag）——腿② 红，与 README §二 同数**
```
DSH_HOME=/home/h/.dsh node scripts/acceptance-corpus.mjs --bucket dsh-memo-river
① =1 ✅　②「归因错误」29/81 = 0.358 ≥1/3 → ❌ FAIL　③ 孤儿 0 ✅　④ SKIP（未给 --baseline）　⑤ 同词 ✅
3/4 PASS；FAIL：②
```
⇒ 这不是套件缺陷：README「本项目自己的桶同款病理」一行原文即 `归因错误 29、写入去重 29、被动召回 27`
（超 1/3），治愈归票 04/05（票 05 判据即「旧三枢纽降到 <1/3」）。**票面第 23 行「两桶全绿」在 05 落地前
对 dsh-memo-river 不可达**——套件给出的红恰是退化已被检出的证据；05 之后同一条命令应转绿。

**④ 负样本腿**（`cp -a` 到 `.scratch/corpus-governance-0926/neg/`，生产桶零写入）**
```
DB=$NEG/orphan/memo-river/50d29236c1297d2c/knowledge_base.sqlite
sqlite3 "$DB" "INSERT INTO tags(name,vector) VALUES('测试孤儿词', zeroblob(12288));"
DSH_HOME=$PWD/$NEG/orphan node scripts/acceptance-corpus.mjs --bucket deepseek-harness
→ ③ 孤儿 = 1 个：#30「测试孤儿词」→ ❌ FAIL 点名「测试孤儿词」
→ ① 连通分量 = 2 ❌ FAIL（孤儿自带一个分量——判据①失败的最常见前因，实测复现）
# 再把 top1「上游同步」从 7 篇灌到 8/22 = 0.364 ⇒
→ ② ❌ FAIL 枢纽 Tag「上游同步」已到 8/22 = 0.364（写侧 isHub=枢纽）；⑤ 仍 ✅（memo_stats 告警同词同数）
```

**⑤ 只读取证（受控实验）**：对生产桶先 `stat` 六个文件（库/wal/shm/health.log/memo-river.log/workspace.json）
再整跑一次（t0=t1=1790388975，exit 0）⇒ mtime+size 逐字相同。注意生产根上有个 **daemon 每 15 分钟**
写 `health.log` 一行（`round=33 … components=1 hub=上游同步:7/22 omegaMean=0.449 …`，02:15:52Z），
它顺带 bump `-wal/-shm` mtime——与本套件无关，且它的独立读数与腿①②**逐字一致**（旁证）。

**⑥ 与 `memo_stats` 的口径对照（同源函数）**：套件腿⑤ 走 `healthReport(store, bucket)` +
`formatHealth(report)`（`src/tools.ts` 的 memo_stats 就是这两行 + 原生资产行），逐字对照
`· ② 最大 Tag 频次「X」= f/N` 与告警 `枢纽 Tag「X」出现 f/N 篇（≥1/3）`。三处实测：
- 生产 deepseek-harness：无告警，② 行「上游同步」×7/22 → 同词同数 ✅
- 生产 dsh-memo-river：告警「归因错误」出现 29/81 篇（≥1/3）→ 同词同数 ✅（本腿红只红在②）
- 负样本 hub：告警「上游同步」出现 8/22 → 同词同数 ✅
另记**口径差（非 FAIL，方向无害）**：`nudge-guide.ts` 的 isHub 有绝对下限（f≥3 且 f≥files/3），
`healthReport` 的告警是纯比值（ratio ≥ 1/3）——1–2 篇的年轻桶会 memo_stats 告警而写侧不判枢纽
（D82 误报方向）；反向（真枢纽却不告警）套件判 FAIL 并点名。


---

## 执行记录 — 2026-09-26（子代理实现 + 主代理复核）

**交付**：`scripts/acceptance-corpus.mjs`（只读五腿，`--bucket/--hash/--baseline/--readings/--help`）；
`scripts/README.md` 套件一览 +1 行。开桶走 `resolveBucket()` + `acquireBucketRuntime()`，
**不 apply、不设 `config.bucket`**（否则按 cwd 建的本工作区桶被改名，实测凭空长出同名第二桶）；
套件每次打印 `root` / `DSH_HOME` / `memoRiverRoot()` 并提示「同名同哈希桶可能存在于另一个根」——先核对再读数字。

**复核读数（主代理亲跑，2026-09-26）**：

| 桶 | 命令 | 结果 |
|---|---|---|
| `deepseek-harness@50d29236c1297d2c`（22 篇/29 Tag） | `DSH_HOME=/home/h/.dsh node scripts/acceptance-corpus.mjs --bucket deepseek-harness` | **4/4 PASS**（SKIP ④）：连通分量=1、top1「上游同步」7/22=0.318<1/3、孤儿=0、⑤ 与 `memo_stats` 同词同数 |
| 同上 + 腿④ | 加 `--baseline .scratch/backup-20260926-071328/50d29236c1297d2c` | 4/5：④ **FAIL 1 篇** —— `2026-09-25-muh3q4mj-REQUEST-EXTENSION-真凶-profile-package-jso.md`：基线之后**该桶自己的 agent 改了正文**（新增「⚑ 两条前置教训…让被动召回的 ~800 字窗口一定带得到」）⇒ **检出器工作正常**，但语义要写清：腿④ 是「基线之后的漂移」检测，不是「retag 有没有改坏」的自证（自证在 retag 脚本内，跑在改完的同一秒） |
| `dsh-memo-river@6c8bcf85fe1b56e1`（81 篇/19 Tag） | `DSH_HOME=/home/h/.dsh node scripts/acceptance-corpus.mjs --bucket dsh-memo-river` | **3/4 PASS，FAIL ②**：「归因错误」29/81=0.358 ≥1/3 —— **正是票 04/05 要治的病理**，不是套件缺陷 |
| 负样本·孤儿 | `DSH_HOME=<neg/orphan> …` | 孤儿=1、连通分量=**2** ⇒ **FAIL ①③** ✅（按设计变红） |
| 负样本·枢纽 | `DSH_HOME=<neg/hub> …` | 「上游同步」8/22=**0.364** ⇒ **FAIL ②** ✅ |

**票面判据的诚实修正**：原判据写「两桶各跑一次全绿」——在票 05 落地前，`dsh-memo-river` 的腿②
在数学上**不可能绿**（0.358 ≥ 1/3）。故修正为：**负样本必须变红**（已达成）＋**`deepseek-harness` 全绿**（已达成）
＋**`dsh-memo-river` 现在红、票 05 之后必须转绿**（这条红本身即「退化可被例行检出」的证据）。

**口径三条（接手者只需记这三条）**：① 腿② 不复述公式，直接调 `lib/nudge-guide.js` 的冷门/枢纽判据，
与写侧闸门同口径（`f≥3 且 f≥files/3` 才算枢纽——小桶不误判，D82 教训）；② 腿④ 按 **file.path** 对齐
（改写会换 chunk id，不能按 id）；③ 腿⑤ 保证 `tagFrequency()` 与 `memo_stats` 告警不漂移。
