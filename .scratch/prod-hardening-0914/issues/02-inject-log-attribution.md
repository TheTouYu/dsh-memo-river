# 02 — 注入日志可归因性：session id + 成功行 gate 分数

**What to build:** 每条 `inject` / `inject-skip` 日志行都能回答"哪个会话、当时的 gate 判据是什么"。当前缺陷两个：①注入行无 session id——两个会话共享一个桶时无法归属（09-14 实测：我的桶同晨两会话流量混流，靠排除法才分清）；②inject 成功行不记 gate maxKnn/gateVector——只有 skip 行记，导致 gate 校准实验拿不到"通过样本"的分数分布。

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] inject 与 inject-skip 行都带 session=<id>
- [ ] inject 成功行带 gate={maxKnn, threshold, gateVector, retrievalMaxKnn}（与 skip 行同构）
- [ ] 双会话同桶场景抽查：每行可归因
