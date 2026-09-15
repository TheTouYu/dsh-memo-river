# 09 — 暗会话覆盖决策（ADR）

**What to build:** 查清并决策「暗会话」问题：09-15 评估发现 dsh-agi-harness 两个 U=17 会话（preset=standard / cordis）零注入零工具、preset-composer 若干 plugin-dev 会话（含 U=3/A=117 的大体量自主会话）完全不经过记忆系统。先调查根因（预设注册表差异？插件未挂载？产品默认），写一份决策记录（docs/ADR）：**纳入**（轻量模式：仅 write-nudge 不注入，或完整挂载）或**明确排除**（记入 runbook 盲区）。若选纳入，完成配置并验证一个真实暗会话变亮。

**Blocked by:** None — can start immediately.

**Status:** done — 2026-09-15（根因钉死=覆盖随预设作用域父子链，shipped 预设无 memo-river 行 + plugin-dev 行 16:50 才落地；ADR 落 docs/ADR-暗会话记忆覆盖.md；plugin-dev 类复亮实测 23/7/5 次注入）

- [x] 根因调查有据：每类暗会话（agi-harness standard / cordis、plugin-dev）为什么没有记忆，附证据
- [x] ADR 落 docs/：决策 + 理由 + 影响面（哪些项目的会话从此有/无记忆）
- [x] 若选纳入：配置落地后用一个真实会话验证非零注入/nudge
- [ ] 若选排除：runbook 盲区一节同步更新

## notes

- 决策=分层纳入（逐预设 opt-in），未选排除 ⇒ 第 4 项为未走分支，非阻塞项；runbook §四「shipped 预设会话无记忆」口径在 opt-in 架构下仍准确（ADR §5/§7）。
- 第 3 项的「配置落地」非本票所为（本票只读）：plugin-dev 预设的 memo-river 行由 preset-composer 侧 2026-09-15 16:50 落地；本票用其后真实会话 `6f297f13`(23 注入)/`a20e4270`(7)/`0ff8c384`(5) 完成验证。
- 调查中否证两个早期假说并已记录（ADR §2.3）：genshin-ts 单次注入系 resume 换预设（非跨作用域泄漏）；暗 trio 零覆盖无需「挂载死代」假说。
- 行号漂移：无（本票未改代码）。
