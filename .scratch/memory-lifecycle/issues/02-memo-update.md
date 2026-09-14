# 02 — memo_update：单篇原地改写

**What to build:** agent 能改写既有日记：按 D-id 或标题子串指定一篇，提交新内容，走与 `memo_write` 完全一致的 Tag 闸门（同义漂移 / 新 Tag 理由 / 枢纽警告）与体检增量；目标文件在磁盘上**原路径重写**、库内按同路径 upsert；改写目标自身豁免去重闸门（自我孪生不算近重复）；写后召回立即返回新内容（沿用「先刷原生日记索引、再重建资产」的既有顺序，防写入后 Ω 塌缩）。这是去重闸门拒绝语「或合并进旧篇」承诺的单篇兑现路径。

**Blocked by:** None — can start immediately.

**Status:** done — 2026-09-14（acceptance-update.mjs 7/7 + 回归：usage 6/6 / 主套件 26/26 / P3 4/4）

- [x] 改写后日记总篇数不变，召回返回新内容而非旧内容（A-1/A-4）
- [x] 与原文近乎相同的自我改写不被 near-duplicate-diary 拒绝（自排除生效）；复读**其他篇**仍被拒（闸门仍活，A-2）
- [x] 违规 Tag 仍被拒，错误信息与 `memo_write` 同一套（A-3，writeDiaryCore 单源）
- [x] 写后原生日记索引先于资产重建生效，不出现 Ω 塌缩回归（A-4：改写后立即召回即命中新内容）
- [x] 日志留 update 审计行（哪篇、checksum 旧→新、新标题；A-5）
- [x] DESIGN.md 写入契约章节更新（§7.1.1，A-6）

**实现附记（超出原判据的实测发现）：**
1. **工作区外路径护栏**：导入语料的 files.path 带源库绝对路径（如 VCP dailynote 参照库）——原路径重写会覆写外部文件（实测覆写了参照语料一个 .txt，已从 refdb 恢复）。护栏：路径在工作区根之外 → 只更库不落盘 + warn 日志。
2. **D 编号双口径**：memo_recall 头行的 D 号是 **chunk id**（改写换 chunk），memo_stats/台账是 **file id**——memo_update 的 id 解析器做 file→chunk 兜底，两个口径都能定位（验收 A-1b 实测）。
3. 身份保持：同路径 upsert → fileId 不变 → 票①台账足迹随篇保留。
