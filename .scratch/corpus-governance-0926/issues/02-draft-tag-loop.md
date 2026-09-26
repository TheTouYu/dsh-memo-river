# 02 — 草稿三处修：本回合已写不收、建议 Tag 不再来自召回、Tag 内容化

**What to build:** 草稿（`pending/`）这条路上有**两个真·代码缺陷**在冒充「质量不高」——修掉它们，
让「一键批」重新只代表「这篇确实可以入库」。

背景实测（勿重查）：
- 草稿正文是**守护循环机械拼装**的回合原文：`src/daemon.ts:244-262` 用 `draft.userText` 摘 600 字 +
  `draft.assistantText` 摘 900 字 + 建议 Tag + 关联 D 编号写 `pending/<date>-<slug>-t<turn>.md`
  ——**这条路上没有模型参与**，提示词写得再好也改变不了产出。
- 建议 Tag 取自**被动召回命中**：`src/index.ts:399-402`
  `for (const candidate of state.lastCandidates) for (const tag of candidate.matchedTags) suggested.add(tag)`。
  于是形成自我强化环：召回枢纽词 → 草稿建议枢纽词 → 一键批写回枢纽词 → 枢纽更强。
  `deepseek-harness` 桶的 `干跑验证 13/20` 与 hub 闸门「每次警告、每次放行」都是这个环的产物。
- turn-stopping 收草稿**无任何守卫**（`src/index.ts:361-421`）：本回合已经 `memo_write` 过，照样收一份。

**要做（三处）**：
1. **本回合已写则不收草稿**：`src/index.ts:361` 的 handler 开头加守卫
   `if (state.lastDiaryWriteTurn === payload.turn) { log('info', 'draft-skip reason=wrote-this-turn …'); return }`
   （`lastDiaryWriteTurn` 见 `src/session.ts:89`，写工具侧在 `src/injector.ts:728-730/754-756` 回填）。
2. **建议 Tag 不再来自召回**：`:399-402` 的 `matchedTags` 改名为 `recalledTags`（session 状态与草稿 md 各留一字，
   草稿 md 里标注「被动召回命中（**非**建议 Tag）」），`suggestedTags` **不再**由它填充（置空）。
3. **Tag 内容化**（一步到位，不做中间态）：`src/drafts.ts:245 curateTags` 升级为
   「取草稿 `assistantText`（≤2000 字）→ `workspace.embed.embed()` → 与 `store.tags()` 向量 kNN →
   top 3–5，**剔除跨篇频次 ≥1/3 的枢纽词**（照票 06 的绝对下限规则 `f≥3`）；命中 <3 ⇒ 不产出（落「需人工」）」。
   - 结果按「草稿文件名 + mtime」缓存（`precheckDrafts` 每轮跑全量 pending，不能每轮重复 embed；
     缓存落草稿旁的 `.status.json`，键=文件名+mtime）。
   - `workspace.embed` 未配置或调用失败 ⇒ 不回落召回词，直接判「需人工」（诚实优先）。
   - `memo_approve` 与 `precheckDrafts` **共用同一份** `curateTags`（现状即共用：`src/drafts.ts:410` 与
     `src/tools.ts:1360`）——这是本票不复制闸门链的前提。

**行为变更（有意，票据明写）**：内容化命中 <3 的草稿会从「可一键批」转「需人工」——现有 7 篇待批草稿里多数会转。
理由：在建议 Tag 不来自内容之前，「一键批」是橡皮章（D10 样本一：13 篇草稿一键批污染过召回）。

**判据（可复现读数）**：
- [ ] 新套件 `scripts/acceptance-draft-tags.mjs`（用 `scripts/embed-stub.mjs` 的 `hash` 模式）：
      ①「枢纽词占优」样本必须落**需人工**；②「内容词占优」样本必须**可一键批**；③ 本回合已 `memo_write` 的回合
      **不产生**草稿文件（对照：未写的回合产生）；④ 缓存腿：同一草稿预审两次只 embed 一次。
- [ ] 回归：`acceptance-draft-scope.mjs` + 守护预审三态（`acceptance.mjs` 内既有线）绿。
- [ ] 生产观察（重启后）：新草稿的建议 Tag ≠ 上一轮召回命中词；`draft-skip reason=wrote-this-turn` 在桶日志出现。

**Blocked by:** 01（改 `src/` 的三张票同批 build + 同一次重启窗口）。

**Status:** done — 2026-09-26（子代理实现 + 主代理独立验证；见 `verify/02-static-review.md`：静态 5/5、动态 draft-tags 5/5、回归 draft-scope 4/4 + hub-gate 8/8 + folder-route 8/8；H-7 重写经复核接受，理由与保留意见在该文件）

- [ ] 守卫 + recalledTags 改名 + suggestedTags 置空
- [ ] curateTags 内容化（kNN + 枢纽剔除 + mtime 缓存 + 无兜底）
- [ ] acceptance-draft-tags 4 腿绿 + 既有套件回归绿
