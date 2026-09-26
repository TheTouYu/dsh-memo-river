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

**Status:** 待办 — 2026-09-26

- [ ] 五条腿实现 + 用法与 root 打印
- [ ] 两桶全绿 + 负样本变红
- [ ] README 一览补行
