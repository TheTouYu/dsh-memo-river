# 02 — memo_write/update 标题闸门（消灭「未命名」日记）

**What to build:** 标题派生规则收紧为：显式 `title` 参数 > 正文首个 `# ` 标题行；两者皆无 → **明确拒绝**（错误文案指引补标题），不再落「未命名」。修复正文只含一个 `# ` 标题行时被重复拼接两次的缺陷。`memo_update` 未显式指定且新正文无 `# ` 行时，**保留改写目标原标题**（不降级为「未命名」——库内标题是强检索信号）。

**证据：** genshin-ts 桶存在标题为「2026-09-15 未命名」的合格正文（T03 精读批2，129 条硬规则）；2026-09-16 在 dsh-memo-river 桶 memo_update 活体复现（库内标题受损、文件名保留）。见 D58/D59。

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

- [ ] 无 title 且正文无 `# ` 行 → 拒绝 + 指引文案（write/update 两路径）
- [ ] 单 `# ` 行：标题正确且正文不重复该行
- [ ] update 无标题派生源：保留目标原标题
- [ ] 存量「未命名」条目：文档给出一次性修复指引（不强制自动改写）
- [ ] acceptance 用例覆盖 write/update/拒绝三条路径
