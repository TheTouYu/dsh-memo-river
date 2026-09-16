# 10 — 语料质量巡检与自愈（已写入质量的修正闭环）

**What to build:** 打通「已写入日记存在质量问题 → 提示大模型修正」的闭环：巡检器（可挂在 memo_stats/守护循环）检出三类质量问题——hub Tag 超限、占位/未命名标题、复读机近重复（同轴批次稿）——生成**具体修正建议**（哪篇、什么问题、建议动作：memo_update 改写 / memo_merge 合并 / 换 Tag），经主代理（或用户）确认执行。修正不是自动改写：建议+确认，红线是不代批、不静默手术。

**动机：** 用户核心命题之一「写入的日记已经存在质量问题的时候，如何提示大模型去修正」。现有件：memo_stats 告警（hub/未覆盖）、memo_update/memo_merge（执行通道）、守护预审三态（草稿侧）；缺的是把三者连成「检出→建议→修正」闭环。

**Blocked by:** None — can start immediately（建议 DSH 重启激活票 06 hub-gate 后做，防边修边漏）

**Status:** done — 2026-09-16（证据：src/patrol.ts + memo_patrol 工具注册 src/tools.ts；scripts/acceptance-patrol.mjs 6/6（hub/未命名/近重复三病例 + 只读红线 + 空桶不误报 + folder 负例）；两处实现期真 bug 被测试逼出并修复——①维度钳制（opts.dimension 大于库存向量实际长度时质心 NaN、近重复簇静默漏检）②单链→完备链（composer 真实桶单链把 114/123 篇链成一簇，完备链后 32 簇全部语义 sane：烧满一核六部曲/会话级热载六部曲/「Everything is done」机械批准残渣均现身）；生产只读巡检两桶完成（.scratch/recall-quality-0916/10-patrol-reports.md：composer 3 hub/0 未命名/32 簇；本桶 4 hub/1 未命名存量 D62/14 簇）；主套件回归当日一次完整跑 36/37、其余复跑被环境性 SIGBUS 中断（同晨先例：干净 HEAD 同刻复现、重启后 37/37，非本票代码）；执行待用户批）

- [x] 巡检检出三类质量问题并输出结构化建议（篇目/问题/建议动作）
- [x] 建议经确认后走 memo_update/memo_merge 执行，全程不静默改写（P-4 只读红线：库计数/mtime/目录零变化）
- [x] 在 /tmp 副本桶上演练：构造 hub+未命名+批次近重复三病例，全链走通（P-1/P-2/P-3/P-5）
- [x] 生产桶只读巡检；对 dsh-memo-river「记忆自驱」hub 出一份真实建议清单（执行仍待用户批）——本桶 4 枢纽全列 + composer 同扫，报告固化 10-patrol-reports.md
