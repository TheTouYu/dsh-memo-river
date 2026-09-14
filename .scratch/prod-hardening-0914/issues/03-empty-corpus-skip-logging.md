# 03 — 空桶 inject-skip 记录回归排查

**What to build:** 空语料桶的会话在注入评估时留下可追溯的 skip 记录。09-14 实测：桶 `h`（f23d80…，cwd=/home/h）三次挂载（09-13 13:16/13:53、09-14 02:46）后日志零 inject-skip 行——旧代曾有 `inject-skip reason=empty-corpus`（genshin-ts 桶 09-13 02:40 有记录），疑似新代（刀一重构后）该路径不再落日志。排查 injector 的空语料短路路径，恢复记录（含 session id）。

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] 复现：空桶 + 新会话跑若干步，日志出现 `inject-skip reason=empty-corpus`
- [ ] 回归行带 session id（与 02 号票同构，可合并实现）
