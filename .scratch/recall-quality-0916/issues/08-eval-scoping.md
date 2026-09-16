# 08 — eval-production.py 单会话/单桶作用域

**What to build:** 评估脚本加 `--session <session-id>` 与 `--bucket <桶名>`：`--session` 输出该会话八项指标（含其子代理树聚合：注入数/写入数/引用率/时延/自发性对齐）；`--bucket` 输出桶健康（components/hub/used/pending）。把 2026-09-16 对 c9f838ba 的手工深评流程脚本化，下次深评不再手写取证脚本。

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

- [ ] `--session` 指 c9f838ba 复现本次深评关键数字：30 写入（父5+子25）/37 注入/父引用 7/12=58%/桶 used 22/26
- [ ] `--session` 附写入自发性对齐（write 前最近 nudge 间隔分布，SPONT/NUDGED 标注）
- [ ] `--bucket genshin-ts` 输出 hub 80.8%/pending 7 等体检读数
- [ ] 缺省行为（48h 全扫）不变；只读不写任何库
