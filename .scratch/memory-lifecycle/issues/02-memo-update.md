# 02 — memo_update：单篇原地改写

**What to build:** agent 能改写既有日记：按 D-id 或标题子串指定一篇，提交新内容，走与 `memo_write` 完全一致的 Tag 闸门（同义漂移 / 新 Tag 理由 / 枢纽警告）与体检增量；目标文件在磁盘上**原路径重写**、库内按同路径 upsert；改写目标自身豁免去重闸门（自我孪生不算近重复）；写后召回立即返回新内容（沿用「先刷原生日记索引、再重建资产」的既有顺序，防写入后 Ω 塌缩）。这是去重闸门拒绝语「或合并进旧篇」承诺的单篇兑现路径。

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] 改写后日记总篇数不变，召回返回新内容而非旧内容
- [ ] 与原文近乎相同的自我改写不被 near-duplicate-diary 拒绝（自排除生效）
- [ ] 违规 Tag 仍被拒，错误信息与 `memo_write` 同一套
- [ ] 写后原生日记索引先于资产重建生效，不出现 Ω 塌缩回归
- [ ] 日志留 update 审计行（哪篇、改写摘要、时间）
- [ ] DESIGN.md 写入契约章节更新（memo_write / memo_update / memo_approve 三入口共用校验的边界）
