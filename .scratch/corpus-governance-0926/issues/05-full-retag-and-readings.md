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

**Status:** 待办 — 2026-09-26

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
