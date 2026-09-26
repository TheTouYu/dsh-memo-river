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

**Status:** 部分完成 — 2026-09-26（前半 commit `43bc2b4`：nudge 内容词规则 + 反流水账锚 + 套件 5/5；**回注段已落地 `4ead60f`**：`composeReinjection` 增 Tag 自检行 + 套件 T-4/T-5 扩测，实测 5/5、单篇新增行 59+59 ≤300；契约段补丁已拟并干跑 `857cdd6`，**仅剩这一步**，待票 08 裁定 A/B 后与 01 同批落地）

- [x] 三处文案落地（nudge `43bc2b4` / 回注 `4ead60f` / 契约段待票 08）
- [x] 形态快照 + 预算红线读数（套件 5/5；末行 85→215、回注新增 59+59 ≤300）
- [x] sha256 更新（`5a5d65e2…`，与常量自洽）+ 用户裁定票 08 A 后与写回同批落地；主套件 #2 待构建后验

---

## 执行记录 — 2026-09-26

### 前半已落地（commit `43bc2b4`，不涉契约）

- `src/render.ts` `renderWriteNudge` 末行：「Tag 优先复用词汇表：…」→ 内容词规则 + 反流水账锚，**规则内联、行数不增**
  （无 tail 2 行 / 带队列 3 行 / 委托 3 行）。
- `scripts/acceptance-write-prompts.mjs` T-1 原为「文案与票 05 前逐字一致」——文案一改必红，改为**规则级断言**
  （内容词 / 枢纽 / newTagReason / 反流水账四条短语在场 + 旧措辞已除）＋预算基线常量化。
- 读数：**5/5 PASS**；末行 85 → **215 字符（Δ+130）**；行数 2/3 未增。
- 跑法（沙箱）：`TMPDIR=$PWD/.scratch/tmp DSH_HOME=$PWD/.selftest/dsh-home node scripts/acceptance-write-prompts.mjs`
  （T-4/T-5 真写日记，不设 DSH_HOME 会 ENOENT mkdir 在 `.compat/rehearsal/browser` 下）。

### 契约段补丁**已拟好并干跑**（等票 08 裁定 A 后一键落地）

| 改动 | 旧 | 新 |
|---|---|---|
| ② | `② 延续确有同一语义的稳定 Tag；只有概念真正变化时才创建新 Tag；` | `② Tag 是**检索锚**不是工作流标签——写内容词（主题/机制/对象/判据）；只有概念真正变化时才创建新 Tag，跨篇 ≥1/3 的枢纽词不再复用；` |
| ③ | `③ 正文写清"延续、转折、因果、冲突或完成"，让 Tag 共现有叙事依据；` | 同行追加：`旁白不是日记——\`Compressed 1 block(s), ~2130 tokens reclaimed\`、\`All committed, tree clean.\` 这类工具输出与提交状态不写；` |

**预算实测**（`.scratch/genprompt-dry/` 演练，仓库文件未动）：行数 **16 → 16（Δ0，预算 +≤2 ✓）**、
字节 **2025 → 2266（Δ+241）**、新 sha256 = `5a5d65e26d8b592e8e003cf6276142d87b2932415a39decf57ca38a5cfc633f7`；
`scripts/gen-prompt.mjs` 重生成结果与拟改文本逐字相同、常量自洽 ⇒ 落地时 #2 的两条断言同时成立。
**注意**：该补丁以「上线文本（2025B）为基」⇒ 与票 08 的 A 路径天然合批（同一次 gen-prompt、同一次前缀缓存破）。

### 剩余（本票未完成）

- `src/tools.ts` 写前回注段加一行「Tag 自检：跨篇 ≥1/3 的词会被 hub 闸门拦；不确定就写内容词」（≤300 字符预算，
  与票 02 的 tools.ts 改动分属不同区域，等 02 交付后落地，避免互相扫进对方提交）。
- 契约段落地 + `FIXED_CONTRACT_SHA256` 更新 + `contract-registered sha256=` 日志核对 + 主套件 #2 转绿的实证。

### 回注段已落地（commit `4ead60f`）

- `src/tools.ts` `composeReinjection` 增一行（放在枢纽/连通性那行之后）：
  `【写前回注】Tag 自检：跨篇 ≥1/3 的枢纽词会被写侧闸门拦下或警告；不确定就写内容词（主题/机制/对象/判据）。`
  **措辞比票面原话更准**：票面写「会被 hub 闸门拦」，但实况是 enforce 档硬拒 / 交互档软警告（票 06 `hubGateMode`），故写「拦下或警告」；并补上与 nudge 同口径的「内容词（主题/机制/对象/判据）」。
- `scripts/acceptance-write-prompts.mjs`：T-4 增「Tag 自检行在场 + 含『写内容词』」断言（并打印该行），T-5 的预算正则把新行纳入计量（`(质量四要素|最相似|Tag 自检)`）⇒ 预算红线不会因新增行而失真。
- 实测（`TMPDIR=$PWD/.scratch/tmp DSH_HOME=$PWD/.selftest/dsh-home node scripts/acceptance-write-prompts.mjs`）：**5/5 PASS**，
  `单篇新增行字符：59+59 ≤300`（红线 300）。

### 契约段已落地（与票 08 A 路径同批，commit `__C3H__`）

- `DESIGN.md` §6.1 围栏 = 上线文本 + ②③ 补丁（2266B）；`node scripts/gen-prompt.mjs` 重生成 `src/prompt.ts`
  （sha `5a5d65e26d8b592e8e003cf6276142d87b2932415a39decf57ca38a5cfc633f7`，`FIXED_CONTRACT_SHA256` 同步）。
- 行数 **16 → 16（Δ0 ≤2 ✓）**、字节 2025 → 2266（Δ+241）；`git diff src/prompt.ts` 仅 4 行 ⇒ 写回零漂移。
- **预算与断言**：`acceptance.mjs` #2（`registered === designText` 与 `FIXED_CONTRACT_SHA256 === sha(registered)`）
  从「算术必红」转为可绿，待构建后跑主套件取读数（见票据 08 记录）。
