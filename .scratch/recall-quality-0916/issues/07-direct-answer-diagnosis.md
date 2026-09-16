# 07 — direct_answer 零命中诊断（诊断票，不强行改码）

**What to build:** 用 genshin-ts 桶离线复放 c9f838ba 的 37 次注入（或等价查询集），量化 role 判定链路（knn/maxKnn/锚加成/角色阈值），回答核心问题：**高相关新语料下为什么 direct_answer=0**（37 次注入全是 structural/thematic）？是阈值过严、打分公式问题、还是「结构性邻居」语料形态使然？产出根因报告；若需校准给出参数/公式 diff 建议（落地另起实现票），若判据合理则明确「无需改」结论入 docs。

**Blocked by:** None — can start immediately

**Status:** done — 2026-09-16（证据：scripts/replay-direct-answer.mjs 离线复放器 + docs/EVAL-诊断-direct-answer.md；语料重建 27/27 逐字节命中、36 注入+4 主动复放全链量化；build ✅ + 主 acceptance 36/36 全绿；commit 见 git log「票07」）

- [x] 复放报告：37 次注入的 role 分布 + 每次最近邻分数与阈值距离
- [x] 明确根因结论（改/不改 + 依据）
- [x] 若改：diff 建议附前后模拟对比；不改：结论落 docs（runbook 附录或独立文档）
- [x] 全程只读生产桶，复放用离线副本

> 口径订正：会话夜真窗口内 inject 行 = 36（非 37——深评报告时区滑窗多算 1 条晨间续跑注入）；本票按 36 全量复放，主动 memo_recall 4 条作对照。
