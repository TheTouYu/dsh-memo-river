# 08 — gate 锚拼接实施：max(gU, gA)@0.55（票04 校准判决 A 方案）

**What to build:** 注入门控的判据向量从「最后一条用户消息」升级为「最后用户消息与最近助手实质正文取 max」，消除短指令回合整回合零注入的死区。

**校准依据（票04，scripts/probe-gate-calibration.mjs，2026-09-14）**：
- 现状 gU@0.55：17/17 生产 gate-skip 全是误杀（composer 桶内 gate 从未正确压制过任何东西）；误杀集 gA=0.709-0.881。
- 纯阈值方案死刑：正样本带（0.44-0.55）与任务外负样本带（0.468-0.536）重叠，任何阈值都分不开。
- A 方案实测：误杀 0/17、误放 0/8；C（分歧旁路）漏 5/17，被 A 涵盖，不单独实施。

**实施口径**：
- gA = 最后一条 ≥150 字助手正文的 embedding 与语料 chunk 的 maxKnn（与会话观测循环里的 lastAssistantDigest 同源阈值）。
- 门控分数 = max(gU, gA)；阈值维持 0.55 不动。会话尚无 ≥150 字助手正文时退回纯 gU。
- 日志 gateVector 记 `spliced`（并带 gU/gA 两个分项——票02 的日志块扩两字段）。
- gateText==queryText 的 window 回退路径保留（混沌行为由锚拼接自然缓解：助手锚常在）。
- 验收：复跑 probe-gate-calibration.mjs 生产标注集 → 误杀 0/17 且误放 0/8；新增离线验收线（短指令 + 在题助手正文 → 注入放行；任务外问答双锚 → 压制）。

**Blocked by:** 02（日志块扩 gU/gA 字段——先落地可归因，再动判据）。

**Status:** ready-for-agent

- [ ] 生产标注集复跑：误杀 0/17、误放 0/8（探针直接出数）
- [ ] 离线验收线：短指令回合（用户 7 字 + 助手在题正文）注入放行；任务外双锚压制
- [ ] 日志 gateVector=spliced + gU/gA 分项可见（抽一个真实会话验证）

---

**Status: done (2026-09-14，commit 待填)。实施修订两处（相对本票原案）：**
1. **分锚阈值取代统一 0.55**：落地时实测发现离题 150+ 字助手陈述的 gA 负例带 0.5384-0.5810（做饭/天气/英文/数学四样本，教室语料）落在 0.55 之上——纯 max@0.55 会整带误放。改为 `gU@0.55 ∨ gA@0.62`（`GATE_ASSISTANT_MARGIN=0.07`，src/recall.ts；0.62 落负例带上界 0.5810 与在题带下界 0.709 之间）。探针新增「生产」行复核：误杀 0/17、误放 0/8 不变。
2. **gateVector 记 `assistant` 而非 `spliced`**：按胜选锚报（current/assistant/window），败选锚分值进 diagnostics（gateUserKnn/gateAssistantKnn/gateAssistantThreshold）——比 spliced 单值更可归因。

开关：`inject.gateAssistantAnchor`（默认 true，false 回滚用户锚单选）。验收 #32 四腿：handler 放行 / 数学口径 / 回滚压制 / 离题长文仍压制。主套件 32/32。

- [x] 生产标注集复跑：误杀 0/17、误放 0/8（探针「生产 gU@0.55 ∨ gA@0.62」行）
- [x] 离线验收线：#32（短指令+在题助手正文放行；离题长助手陈述压制）
- [x] 日志 gateVector=assistant + 败选锚 diagnostics（#32 断言 log 行；真实会话抽查待下次重启后自然积累）
