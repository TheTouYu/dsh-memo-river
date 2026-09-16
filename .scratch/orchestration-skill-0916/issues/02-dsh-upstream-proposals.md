# 02 — DSH 侧编排改进提案（上游候选）

**What to build:** 把技能层吃不掉的编排痛点整理成 DSH harness 上游改进提案（issues 草稿/ADR 入 docs/）：①workflow 原生 per-agent worktree 参数（代理运行时自动建/清 worktree）；②短命代理的 write-nudge 豁免配置（delegationDepth>0 或生命周期 <N 分钟不催写）；③依赖图调度原语（ticket 级 blocker 即启，替代波次屏障）；④子代理上下文最小化选项（工具目录按需裁剪）。每项含：问题证据（引用 0916 取证）、提案形态、验收设想。

**Blocked by:** 01 — 先验证技能层能吃掉多少，剩下的才值得上游做

**Status:** ready-for-agent

- [ ] 4 项提案各含证据引用 + 形态 + 验收设想，落 docs/
- [ ] 与 01 的演练结果对照（技能层已解决的不重复提案）
- [ ] 明确哪些可先在本仓 memo-river 插件侧自行缓解（如 nudge 豁免）
