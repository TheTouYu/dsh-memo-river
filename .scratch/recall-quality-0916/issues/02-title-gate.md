# 02 — memo_write/update 标题闸门（消灭「未命名」日记）

**What to build:** 标题派生规则收紧为：显式 `title` 参数 > 正文首个 `# ` 标题行；两者皆无 → **明确拒绝**（错误文案指引补标题），不再落「未命名」。修复正文只含一个 `# ` 标题行时被重复拼接两次的缺陷。`memo_update` 未显式指定且新正文无 `# ` 行时，**保留改写目标原标题**（不降级为「未命名」——库内标题是强检索信号）。

**证据：** genshin-ts 桶存在标题为「2026-09-15 未命名」的合格正文（T03 精读批2，129 条硬规则）；2026-09-16 在 dsh-memo-river 桶 memo_update 活体复现（库内标题受损、文件名保留）。见 D58/D59。

**Blocked by:** None — can start immediately

**Status:** done — 2026-09-16（commit d25a879 + 测试：scripts/acceptance-title-gate.mjs 6/6 PASS；回归 update 7/7、merge 6/6、consolidation 5/5、usage 6/6；主套件 36/37——唯一失败 #32 为 gate 锚拼接，HEAD-only 复跑同样失败，属 03/08 道 gate 侧存量问题，非本票改动；另 #25 fixture 因标题行去重后嵌入语料形态变化做了重校准：短文本同话题两篇相互余弦升高，部署记录加长摊薄 + 会议纪要去「结论：」开头拉开主题距离，与 #19 同策）

- [x] 无 title 且正文无 `# ` 行 → 拒绝 + 指引文案（write/update 两路径）——闸门加在共用写核心 writeDiaryCore（四入口一次覆盖：write/update/merge/approve），派生链=显式 title > 正文 `# ` 行 > fallbackTitle（update=目标原标题 / merge keep=保留篇原标题）；「未命名」残次原标题不算保底（isUntitledArtifact），改写存量条目必须新正文首行给 `# 新标题`
- [x] 单 `# ` 行：标题正确且正文不重复该行——splitHeading 剥掉标题行再拼模板（附带修复：剥行后前导空行压缩，不再出现双空行）
- [x] update 无标题派生源：保留目标原标题——fallbackTitle 通道；fileId/路径不变（acceptance-title-gate T-4）
- [x] 存量「未命名」条目：文档给出一次性修复指引（不强制自动改写）——docs/GUIDE-未命名存量修复.md（排查=只读 sqlite SELECT + 逐篇 memo_update 手动起标题；T-5 是该指引的活体复现）
- [x] acceptance 用例覆盖 write/update/拒绝三条路径——scripts/acceptance-title-gate.mjs（T-1 拒绝、T-2 单标题行只拼一次+库内=写盘、T-3 显式 title、T-4 update 保底原标题、T-5 存量先拒后放、T-6 全库无「未命名」占位标题；自建自净 /tmp 桶、嵌入离线，不依赖 API）
