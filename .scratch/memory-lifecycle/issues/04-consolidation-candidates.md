# 04 — 守护循环合并候选检测（压缩式遗忘的主引擎）

**What to build:** 守护循环每轮产出「合并候选报告」：同时满足三项冗余判定的旧篇被列出——**年龄 ≥ N 天 且 台账召回计数 ≤ M（票 01 的数据）且 与某更新日记的最大余弦 ≥ 阈值**——理由串带三项判定值；报告落 `pending/`，人批准后用 `memo_merge`（票 03）执行，执行后下一轮报告自动收敛。按**冗余**退役而非按时间无差别衰减：老而独特的篇不进候选，天然绕开「永久设定不该被衰减」的分类难题。

**Blocked by:** 01 — 使用台账（判定需要召回计数）；03 — memo_merge（闭环验收需要执行通道）

**Status:** done — 2026-09-14（acceptance-consolidation.mjs 5/5；串行回归 update 7/7 / usage 6/6 / merge 6/6 / 主套件 31/31 / P3 4/4）

- [x] 构造冗余语料（旧篇被新篇语义覆盖、少被召回）→ 出现在候选报告，理由串含年龄/计数/重叠三项值（C-1，正例 overlap=0.9270 命中合并带）
- [x] 用 memo_merge 合并后，下一轮报告不再列它（C-2，覆写式报告自动收敛）
- [x] 老 but 独特（无高重叠）的篇零误报（C-3，最孤立篇 0.7480 < 0.90 回退后不进候选）
- [x] 体检日志新增候选计数行；无候选时显式写「无候选」，空库报「无从判定」（C-4：health.log `mergeCandidates=K/checked`，三态 off/无从判定（空库）/无候选/K）
- [x] 判定参数（N/M/重叠阈值）可配置，默认值与定标依据写进 DESIGN.md（C-5 + §7.1.3 定标表：N=14 对齐陈旧口径 / M=1 近未使用 / T=0.90 合并带=dedup 0.95 之下、续写 ~0.88 之上）

**实现附记：**
1. 报告落 `candidates/merge-candidates.md`（覆写式）而非票面原文的 pending/——drafts 通道是 Tag 闸门日记专属，报告混入会被 memo_approve 误消费；报告头部注明「勿 approve，用 memo_merge 执行」。
2. 检测与守护解耦：src/consolidation.ts 纯函数（验收与 daemon 共用口径），daemon.ts runOnce ② 步接线 + GuardianRound.mergeCandidates（null/-1=关闭/空库）。
3. 验收跑法纪律：本套件每跑前必须 setup-selftest（脏库时上轮合并定稿会让新一轮同文合并被去重闸门正确拦截 → 假红）。
