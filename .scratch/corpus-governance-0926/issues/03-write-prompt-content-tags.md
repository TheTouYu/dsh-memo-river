# 03 — 写侧提示词：内容词 Tag + 反流水账

**What to build:** 用户判断「日记质量有待提高 ⇒ 修复要优化注入的提示词」——本票把这条落到**代码里的三处提示面**。
方向沿用票 12（`.scratch/recall-quality-0916/issues/12-write-prompt-quality.md`）的原则：**把写对所需的材料递到手上，而不是提要求**。

背景：现有 nudge 文案是「用 memo_write 落一篇，**Tag 优先复用词汇表**：${tags}。规范见「写日记规范」段。」
（`src/render.ts` 的 `renderWriteNudge`，形态见 D59 记录的 `:121-129`）——它在**教模型复用**，
而词汇表退化时复用的就是枢纽流程词。契约段（`src/prompt.ts` 的 `FIXED_CONTRACT_TEXT`）的写日记规范同理，
且缺一条「不要复述工具输出」的坏例锚。

**要做**：
1. **`src/render.ts` renderWriteNudge**：把「Tag 优先复用词汇表」换成内容词规则——
   「Tag 用**内容词**（主题 / 机制 / 对象 / 判据）；流程词（干跑验证、版本盘点、上游同步、构建闸门…）不作 Tag；
   跨篇 ≥1/3 的词（枢纽）不再复用；词汇表给的词与本文不符时，宁可自造并给 `newTagReason`」。
   自主态与委托态都加一句反流水账锚：「不复述工具输出 / 提交状态 / 压缩记录——只写决策、数字、判据、教训、悬而未决」。
2. **`src/prompt.ts` 契约段（写日记规范）**：② 续写/新词规则改为「Tag 是**检索锚**，不是工作流标签——写内容词」；
   ③ 加一句坏例锚：`Compressed 1 block(s), ~2130 tokens reclaimed`、`All committed, tree clean.` 这类**旁白不是日记**。
3. **`src/tools.ts` 写前回注段**（`writeDiaryCore` 的 `composeReinjection`，`:432-462` 一带）：加一行
   「Tag 自检：跨篇 ≥1/3 的词会被 hub 闸门拦；不确定就写内容词」。

**预算红线（照票 12 先例，必须实测）**：nudge 普通态 **≤3 行**不变；契约段 **+≤2 行**；
回注段增量 **≤300 字符**。契约改动 ⇒ `FIXED_CONTRACT_SHA256` 同步更新（`src/prompt.ts:7`），**与票 01 同批**（同一个 sha、同一次重启）。

**判据（可复现读数）**：
- [ ] `scripts/acceptance-write-prompts.mjs` 扩测：三态形态快照（普通 / 委托 / 压缩后）+ 新增「内容词 Tag 规则在场」断言
- [ ] 预算红线实测（行数与字符增量打印进套件输出）
- [ ] 契约 sha256 常量已更新且 `contract-registered sha256=…` 日志与之一致
- [ ] 主套件回归（或按先例给出环境性阻断的双盲归因）

**Blocked by:** 01（契约 sha256 与重启窗口同批）。

**Status:** 待办 — 2026-09-26

- [ ] 三处文案落地
- [ ] 形态快照 + 预算红线读数
- [ ] sha256 更新 + 回归绿
