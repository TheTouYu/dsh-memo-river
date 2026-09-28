# 11 — 收口与切换（阶段④）

**What to build:** 全量核验收口 + 生产切换面：`config.native.kernel: 'oracle' | 'reimpl'`（默认 oracle，schema 进 src/config.ts），native.ts loadVexus 按开关选模块。DESIGN/README/看板收口，PLAN 文档升 v2（加复刻记录章节）。

**Blocked by:** 10

**Status:** blocked

- [ ] 全量差分绿（classroom-flow + 三桶回放，票 02 报告全 PASS）
- [ ] 主套件 37 项在 reimpl 轨全绿（或逐项注明与 oracle 无关的既有环境红）
- [ ] 探针族复跑：sig 确定性 12/12、gate-calibration、dedup 在 reimpl 轨全绿
- [ ] 开关切换实测：同会话 oracle→reimpl 双跑 memo_recall 结果一致；默认 oracle 不改变现状
- [ ] 文档三件套更新（DESIGN §3 运行环境事实 / README 架构图 / 本看板收口）+ PLAN v2
