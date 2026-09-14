# 01 — 使用台账：让「被用」可观测（不动打分）

**What to build:** 系统开始记账：每当一篇日记被被动注入、或被 `memo_recall` 主动补证命中，它的使用台账 +1（主动/被动分开累计、记最近使用时间）。台账只写 kv_store，不进内容表、不扰动图资产代际（artifactSig 内容寻址，学习态必须与其隔离）。`memo_stats` 新增使用视图：最常被召回 / 从未被召回 / 陈旧度；体检日志带一行使用摘要。本票明确**不改任何打分逻辑**——先跑两周数据，回答「被召回最多的，是不是真重要的」，再谈转向。

**Blocked by:** None — can start immediately.

**Status:** done — 2026-09-14（acceptance-usage.mjs 6/6 + 主套件 24/24 + P3 4/4 回归全绿）

- [x] 同一篇经两次被动注入后，`memo_stats` 显示计数=2、被动=2、最近时间已更新（Δ 断言，台账跨运行累积）
- [x] `memo_recall` 命中该篇后，主动计数=1，与被动分开累计（selected 口径，k 条）
- [x] 记账前后资产签名不变 → 实测改证：**tagmemo_artifacts 行逐字节不变**（kv_store 不是内容摘要输入，lib.rs 只吃 tags 向量）；引擎级 sig 漂移为 EPA 每轮重算的既有行为（对照实验：无记账同样漂移，已记 DESIGN §7.3 附注）
- [x] 空桶时使用视图诚实报「无从判定（空库）」，不显示全零的假通过
- [x] 台账数据落 kv_store，内容表（files/chunks/tags/file_tags）无因记账产生的变更；遗留布尔集冻结
- [x] DESIGN.md 体检章节新增该项定义（§7.3 ⑤）
