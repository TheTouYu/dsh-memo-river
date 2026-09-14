# 01 — write-nudge 遥测落盘修复

**What to build:** 调参面板与日志里能完整追溯每次写入节律提醒的触发。当前 `evaluateWriteNudge` 触发后走 `deps.log('info', 'write-nudge session=… turn=…')`，该行既不落桶日志 `memo-river.log` 也不落 journal——生产投递只能靠会话事件流反证（09-14 评估实测：composer 会话 11 次投递、bucket 日志 0 行）。修复为与 `memo_write`/`inject` 同源的 workspace logger，并带上触发锚（time/turns/steps/growth）与 session id。

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] write-nudge 触发行落 `memo-river.log`，含 session id、turn、触发锚类型
- [ ] 与会话事件流（form:notice 投递）可一对一对照（抽一个真实会话验证）
