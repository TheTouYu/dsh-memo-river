# 记忆系统升级方案 v2 · 通向 AGI

> 取证日期：2026-10-19 ｜ 基线：`UPGRADE-PLAN.md`（v1，五件事 P0–P4）+ 本仓 `HEAD=07aeda6`
> **证据分级**：L1 = 我读了本仓代码/我跑了读数；L2 = 仓库内已 L1 化的笔记转述（我未回 arXiv 原文）；
> L3 = 推测。**L3 不进结论**，只出现在「失效模式」与「待验证」里。
> **例外声明（重要）**：本文引用的 arXiv 数字（Ratchet / Library Drift / Trace2Skill / SkillsBench）
> 全部来自 `papers/skill-self-evolution.md`（该文件自称 L1）。**在我这里它们是 L2**——我没有重读原文。

---

## 〇、v1 → v2 的差别

**一句话**：v1 补的是**功能缺口**（缺 read、缺画像、缺巡检），v2 判定本仓真正的缺口是**仪器缺口**——
现有那些读数（`ids=`、`passive`、`未覆盖率`、`mergeCandidates`、`D<n>` 本身）里有五处**经不起核对**，
在把仪表修准之前加功能，只是在更高的精度上读错数。

**这五处，用一句话各说一遍**（全部 L1，取证命令在 §七）：
① 台账记的是滤刀**前**的入选集，比真正进上下文的虚高 **1.41×**；
② `D<n>` 在 `memo_stats`/`memo_patrol` 里是 `fileId`、在注入块/`memo_read` 里是 `chunk id`，**39.4% 对不上**；
③ 压缩式遗忘引擎两道阈值在当前规模**恒假**（0/251 候选，两两最大余弦 0.8978 < 阈值 0.90）；
④ `hurt` 的判定信号（用户纠偏）实测 **lift −1.0pp**（注入后 7.7% vs 未注入 8.7%）；
⑤ **画像通道已经通了，但没人用**：现网 7 个 context 已在跑（445 条/189 会话 = 0.016 条/模型步），
   而 `memo-river` 一个 context 都没注册——**基础设施齐备，缺的只是那份画像本身**。

三条差别：

1. **v1 的 P0 判据当时是不可达的**：`hurtTotal` 存在于 `HealthReport`，但 `formatHealth` **一行都没印它**
   （`src/health.ts` 的 `formatHealth` 函数体内无 `hurt`，L1 复核于 `4be2840` 之前）——`memo_stats`
   当时永远显示不出这个数。v1 写「跑一周后 `memo_stats` 的 `hurtTotal > 0`」，**在写的时候这个验收永远红**。
   （**现已修复**：`213ca2b` 印出该行；但 v1 的判据本身仍不足以支撑决策，见 §三 C1。）
2. **v1 说「遗忘弱、只有被动衰减」是错的**：本仓有完整的压缩式遗忘引擎（`src/consolidation.ts`，
   三判定 + 守护轮自动跑），但它在当前规模**可证不工作**（见 §一 G5：0/249 候选，两道阈值各自死锁）。
   「有引擎」和「引擎在动」是两件事，v1 只看了前者。
3. **v1 把 Critic 排第一是排序错误**：Ratchet 的 `ĉ` 依赖「一任务一技能 ⇒ 归因无歧义」，
   而本仓一轮注入 **p50 = 7 条**（648 轮实测，见 §一 G1）。**条目级归因在本仓的结构上不成立**，
   先做传感器会得到一个永远算不出数的统计量。v2 把「粒度」提到传感器之前。

---

## 一、能力缺口诊断（本仓 vs AGI 级记忆）

**判据说清**：AGI 级记忆与「检索插件」的差别不是「能不能想起来」，而是**有没有闭环控制器**——
知道自己给出去的东西有没有用（反馈）、知道自己缺什么（缺口）、知道该让什么退场（控制）。
本仓这三样都缺，且缺的方式各不相同。下面五条，每条都落到具体代码与读数。

### G1 · 台账记的是「入选」，不是「送进上下文的」——仪器失真 1.41×

| 事实 | 读数 | 出处 |
|---|---|---|
| `recordUsage('passive')` 写的是**滤刀之前**的入选集 | `part.injectedFileIds` = `primaryOutcome.selected` | `src/federate.ts:86`、`src/injector.ts:752` |
| 滤刀（回声/过注入/弱信号/去重/取代）全部发生在记账**之后** | 代码顺序 | `src/injector.ts:820-850`（echoOut/overOut/weakOut 在 752 之后）；`renderInjection` 在 `:953` |
| 实际差额 | 648 轮 `inject` 行：列出 `ids=` **4402 席位**，各滤刀合计剔 **1275**（29.0%），实际渲染 ≈ **3127** ⇒ **日志与台账虚高 1.41×** | 本桶 `memo-river.log` 全量解析（L1） |
| 后果 1 | `memo_stats` 的「未覆盖率 0.0%」与「常用 top=D226×106」都是**按虚高席位算的** | 同上 |
| 后果 2 | `selectionExposureCap`（0.08）读的就是这份台账 ⇒ 曝光抑制**罚错了对象**（罚了从没出现过的条目） | `src/recall.ts:304-320`、`src/config.ts` 的 `selectionExposureCap` |
| **后果 3（2026-10-19 15:4x 新增，L1）** | 刚落地的 Critic 接线**复刻了同一个 bug**：`pendingHurt.fileIds` 取的是 `outcome.selected`（滤刀**之前**），不是 `finalOutcome.selected` | `src/injector.ts:980-984` vs `:953` |

> **这是 v1 完全没看见的一层**。它决定了后面每一条判据的可信度，所以排第一。
>
> 后果 3 值得单独说，因为它证明这不是「一次笔误」而是**同一条口径没有单一事实源**：
> 2026-10-19 当天，`recordUsage` 与 `recordHurt` **两个写入者**都从 `outcome.selected` 取值，
> 而真正进上下文的 `finalOutcome.selected` 只存在于 `renderInjection` 的实参里。
> ⇒ D1 的正解不是「把记账点往下挪」，而是**给渲染集一个具名变量，让三处写入者引用同一个值**。

> **〔2026-10-19 15:5x 更新——本项已被并行会话部分修复，且修复引入了新回归〕**
> `9ba290f` 把记账点移到渲染之后、并改记 `finalOutcome.selected`（方向正确，与 D1 §0 一致）。
> 实测 `scripts/probe-critic.mjs` **38/38**（含 C8 五条仪器面断言：记账在滤刀之后、在渲染之后、
> 记的是 `finalOutcome`、旧虚高记账已移除）——**G1 的主症状已闭合**。
>
> **但新回归（L1，我读代码 + 量化确认）**：新的记账集是
> `finalOutcome.selected.filter((c) => c.srcBucket === undefined)`（`src/injector.ts:983`），
> 即**只记本桶条目**。而桶继承的父桶条目（`srcBucket !== undefined`）原本靠
> 逐桶的 `part.injectedFileIds` 各记各的台账（`src/federate.ts:68-92`，那是**按桶分组**的，
> 本来就是对的）——这一段被整段删掉了（`src/injector.ts:749-756` 只剩注释）。
> ⇒ **现在没有任何代码给父桶记 passive**。实测本桶 654 轮日志：
> `inherited=` 合计 **540 条次 / 4463 席位 = 12.1%** 的渲染内容失去了召回足迹。
> 父桶「常识库」的台账现有 14 条、**sumPassive=2123**（历史值），从此**只增不减地冻结**。
> 后果：父桶的「未覆盖率」「常用 top」「陈旧度」全部失真，`selectionExposureCap` 在父桶上失效，
> 而且**没有任何测试守着它**（grep：无 `inherited` 相关断言）。
>
> **这是本方案要反复强调的那件事的第二个实例**：修一个仪器问题，如果不把「谁是这个量的所有者」
> 想清楚，就会在别处造一个新的失真。D1 的 §0（单一事实源）必须扩展到**跨桶**——
> 记账的对象不是「一个集合」，是「(桶, fileId) 的集合」。

### G1b · **两条 D 编号口径并存**：`memo_stats`/`memo_patrol` 印的 D 号，`memo_read` 有 39.4% 找不到

这是我在核对 G1 时撞出来的，**比 G1 更硬**——它是两条独立代码路径在同一个符号 `D<n>` 上给了两个含义。

| 写入者 | 用什么做 `D<n>` | 出处 |
|---|---|---|
| 注入块 / `memo_recall` / `memo_read` | **chunk id** | `src/render.ts:62`（`D${c.id}`，`c.id` = `chunk id`）；`src/tools.ts:1119` 注释明写「展示口径是 chunk id」 |
| `memo_stats` 使用台账 top / `memo_patrol` / `merge-candidates.md` / `health.log` | **fileId** | `src/health.ts:415`（`D${t.fileId}×…`）、`src/patrol.ts:115,139,199`、`src/consolidation.ts:100`、`src/daemon.ts:158` |

**实测（251 篇，L1，含 WAL 的库副本）**：`chunks.id` 是 `AUTOINCREMENT` 且 `memo_write` 走
`DELETE chunks + 重插`（`DESIGN.md §7.1.1`），`files.id` 却是稳定的 ⇒ **两者 39.4% 不重合**：

- 把 `memo_stats` 印的每个 `D<fileId>` 喂给 `memo_read`：**99/251 = 39.4% 直接「找不到」**
  （`memo_read` 先按 chunk id 找，找不到再按 `chunkOwners` 找——而 `chunkOwners` 的键也是 chunk id，
  所以 fileId 若恰好不是任何 chunk id 就彻底解析不到）。
- **真实受害样本（今天 `memo_stats` 的头 5 名，4 个是错的）**：
  `D226`（实为 `D229`）、`D10`（实为 `D93`）、`D2`（实为 `D85`）、`D220`（实为 `D225`），只有 `D288` 对。
  ⇒ 模型读「常用 top=D226」→ `memo_read(226)` → **报「没有 D226」** → 或者退回重写查询再赌一次召回。
  **这正是 v1 P1 想解决的那个洞，在 P1 做完之后仍然存在，只是换了个地方。**
- `memo_patrol` 同病：今天报的 33 个近重复簇里，
  `D42/D44/D47` 实际是 `D127/D129/D132`（L1 逐条换算过）。
- `memo_supersede` **不受影响**：它的 `resolve` 先试 fileId 再试 chunk id
  （`src/tools.ts:1544`），当前库 251 条两种口径**零冲突**（L1 验证）。

**为什么这是「能力缺口」而不是「小 bug」**：AGI 级记忆要求**符号在系统内唯一可寻址**。
一条记忆如果在这一屏叫 D226、在下一屏叫 D229，那么任何跨工具的推理链都会断——
而这个断裂是**静默**的（`memo_read` 只会说「没有 D226」，不会说「你说的可能是 D229」）。

**判据（可执行）**：
1. 全库扫描：对每个 `memo_stats`/`patrol`/`consolidation` 打印的 `D<n>`，断言 `memo_read(n)` 能解析到同一篇。
   当前通过率 **60.6%**（152/251），目标 100%。
2. 回归：`probe-memo-read` 加一例——取 `memo_stats` 输出的 top1 D 号直接 `memo_read`，必须命中同标题。

### G2 · Critic 传感器：调用点与读数都接通了（今天之内），**但取的源仍是错的**

> 时间线要写清（这篇文档与代码在同一个下午演进）：v1 写「`hurt` 字段已建但无调用点」时为真；
> 本会话期间 `4be2840` **接上了调用点**。所以 G2 的表述要更新，但结论**不变**——传感器仍然产不出可读的数。

- ✅ 调用点已在 `src/injector.ts:728-746`（消费）与 `:980-984`（生产），判定纯函数在 `src/hurt.ts`；
  日志新增 `critic-hurt` 行。
- ✅ **`formatHealth` 已印出 hurt**（`213ca2b`；`probe-critic` C7 三条断言守着）。
  ⇒ v1 的验收判据（「跑一周后 `memo_stats` 的 `hurtTotal > 0`」）**从"不可达"变成"可达"**。
  注意：它现在印的是 `hurt 累计 0 次 / 0 篇（尚无观测：需召回后被用户纠偏）`——
  **0 是真实的 0，不是字段缺失**，这两件事必须能区分（`213ca2b` 的注释正是这个意思）。
- ❌ **取的源是错的**：`pendingHurt.fileIds` 用 `outcome.selected`（滤刀前），见 G1 后果 3。
  影响不是「多记几条」——它让 hurt 记到**从未出现在上下文里**的条目上，而
  **这些条目对应的正是被系统判定为"本轮不该给"的那批**（回声/过注入/弱信号）。
  ⇒ 一旦将来用 hurt 做任何决策，被罚的会是系统已经正确压制掉的东西。**这是负向选择。**
- 现状读数：`sumHurt = 0`，`hurt>0 的文件 = 0/251`（L1，含 WAL 的库副本直读）。
  **这个 0 有两个可能的原因，必须分开**：① 接线后还没跑到一次「注入 → 下一轮用户纠偏」；
  ② 信号本身没有判别力（§三 C1 的组内对照：lift −1.0pp，**支持 ②**）。
  在拿到 ≥30 次 `critic-hurt` 触发的样本之前，**不许用它做任何事**——这正是 D4 失效模式那条。

### G3 · 「用了没有」的确定性证据链：**既有实测已经否证了最自然的那条**

本仓自己做过「注入 → 被用上」实验室（`research/recall-effect/adoption-summary.md`，L1 读）：

```
L1（词面复用判据）  注入组 81/258 = 31.4%   对照组 32/108 = 29.6%   lift = 1.8pp
读法：lift≈0 ⇒ 该判据在测「话题重合」而不是「被用上」
```

**这条必须写进结论**：v1 的 P0 与 §C1 里最自然的候选信号（「模型复用了召回内容的词」）
**在本仓自己的数据上已经失败过一次**。v2 不允许再把「词面复用」当新发现重做一遍。

### G4 · 没有「知识缺口」的观测面：被问到但没东西可给，结构上不可见

- `inject-skip` 全部归因到**机制原因**（`gate-below-threshold` 52 / `embed-timeout` 47 /
  `embed-failed` 68 / `identical-selection` 26 / `all-selected-already-in-context` 17 / `empty-corpus` 7，L1），
  **没有一条记录「问的是什么」**——查询文本不进日志（grep `memo-river.log` 无查询原文，L1）。
- `memo_patrol` 三类判据（hub / 未命名 / 近重复，`src/patrol.ts`）全部是**库内自检**，
  没有一类看「外部问句 vs 库」的落差。
- 后果：系统无法回答「我这周有几次真的没东西可给、问的是哪类问题」——**这正是 AGI 记忆最该有的自省面**。

### G5 · 遗忘：引擎存在，但两道阈值在当前规模**各自死锁**

`src/consolidation.ts` 的三判定（`src/config.ts:504-508`）：`minAgeDays=14` ∧ `maxRecalls≤1` ∧ `overlapCosine≥0.90`。

| 判定 | 实测 | 结论 |
|---|---|---|
| ① age ≥ 14d | **251 篇里 0 篇** >14 天未动（距今天数 p50=0.1、p90=1.3、max **4.0**）；连 >7 天也是 **0 篇** | **恒假** |
| ③ overlap ≥ 0.90 | 全库 **31375 对**，**最大 cos = 0.8978**（D176–D178）；≥0.90 **0 对**、≥0.88 **2 对**、≥0.85 **8 对** | **恒假**（阈值按 27 篇语料定的；篇数越多两两最大值越必然下沉） |
| 结果 | 守护轮报告 `本轮检查 249 篇，候选 0 篇`（`candidates/merge-candidates.md`，2026-10-19T07:21:07Z，当时的快照） | 引擎**在跑但永不产出** |

> ⚠️ 这不是「遗忘弱」，是**「遗忘这个功能已经被判定为存在，实际是空转」**。
> `DESIGN.md §7.1.3` 把「压缩式遗忘」写成已落地能力——**这条需要更正**（见 §六）。

### 附：一张缺口总和表

| 缺口 | v1 是否看见 | 本仓落点 | 可观测判据（现在就能测） |
|---|---|---|---|
| G1 记账≠渲染 | ❌ | `injector.ts:752`（旧）→ `:983`（`9ba290f` 后） | `ids=` 席位 vs 渲染席位，**1.41×**（`9ba290f` 已修主症状；父桶与 `pendingHurt`/`audits` 未修） |
| **G1b D 号两条口径** | ❌ | `health.ts:415` / `patrol.ts:115,139,199` / `consolidation.ts:100` vs `render.ts:62` / `tools.ts:1119` | **39.4% 的 `memo_stats` D 号 `memo_read` 找不到**（今天 152/251 对） |
| G2 hurt 调用点已接、读数已印，但取错源 | 半（说有调用点） | `injector.ts:728-746`/`:1003-1007`；`health.ts` 的 `formatHealth` | `sumHurt=0`；`pendingHurt` 仍取滤刀前集合 |
| G3 词面复用已被否证 | ❌ | `research/recall-effect/` | lift 1.8pp |
| G4 缺口不可见 | ❌ | `patrol.ts` 三类 + 日志无查询 | 查询原文 0 行 |
| G5 遗忘引擎空转 | ❌（反向：说「只有被动衰减」） | `consolidation.ts` + `config.ts:504-508` | 0/249 候选、maxCos 0.8978 |

---

## 二、设计

> 每条五段：机制 / 判据 / 前置 / 冲突 / **失效模式**（含 Ratchet A4 式的「做错比不做更糟」）。
> 通篇一条总纪律：**先让读数可信，再让读数驱动动作**。本仓现在连第一层都没过完。

### D1 · 仪器面：把「入选」记账改成「渲染」记账、**按桶**记账，并给回读记账

> **landed 状态（2026-10-19 15:5x 复核，L1）**
> - ✅ 记账点已移到渲染之后、改记 `finalOutcome.selected`（`9ba290f`）；`probe-critic` 38/38，
>   含 C8 五条仪器面断言（在滤刀之后 / 在渲染之后 / 记的是 `finalOutcome` / 旧虚高记账已移除）。
> - ✅ `memo_read` 已记 `active`（`src/tools.ts:1194`）。
> - ❌ **逐桶记账被删掉了**：新记账集是 `finalOutcome.selected.filter(c => c.srcBucket === undefined)`
>   （`src/injector.ts:983`），而父桶条目原本靠 `federate.parts[].injectedFileIds` 各记各的
>   （`src/federate.ts:68-92`）——那段删除后**没有任何代码给父桶记 passive**。
> - ❌ **`pendingHurt` 仍用滤刀前的 `outcome.selected`**（`src/injector.ts:1004`）。

**机制（剩余工作）**
1. **恢复逐桶记账**：`federate` 已经算好 `parts[].injectedFileIds`（按桶分组），把它保留下来，
   在渲染之后**逐桶** `recordUsage`。记账对象是 `(桶, fileId)` 的集合，不是一个扁平集合。
2. **`pendingHurt` 改源**：`outcome.selected` → `finalOutcome.selected`（顺带按桶分组，
   因为跨桶 id 在各自桶的编号空间里指向不同日记——`4be2840` 的注释自己就写了这一点，
   但 `pendingHurt` 里没有桶信息）。
3. ~~`memo_read` 记 active~~（已完成）。
4. **`audits[].selectionKeys` 同样位于滤刀之前**（`src/injector.ts:1043` 附近用 `outcome.selected`）——
   而它喂给 `filterOverInjected` 当计窗数据源。**这是同一个病的第三个位置**，一并改。

**判据**
- ✅ 已有：`rendered=` 日志行 + `probe-critic` C8 五条。
- ⬜ **父桶对账**：跑一轮含继承条目的注入，断言「父桶台账 `passive` 增量 == 该轮渲染的父桶条目数」。
  今天它是 0。**当前没有任何测试守这条**（grep 全部套件：无 `inherited` 相关断言）。
- ⬜ 「入选 7 条、滤后 2 条」→ `pendingHurt.fileIds.length === 2`（今天会是 7）。
- ⬜ `audits` 记的是渲染集：断言「全滤光的一轮 → `audits` 新增记录的 `selectionKeys` 为空」。
- ⬜ 恢复记账后，用 30 天数据重测「同会话重复席位率」（当前口径下 53.5% / 30 分钟窗 40.0%）。

**前置**：无。

**冲突**
- 恢复父桶记账会让 `常识库` 的 `passive` 恢复增长（它现在冻结在 2123，14 条篇目）——
  该桶的「陈旧度」读数会从「全部新鲜」变成真实值，**可能立刻触发告警**。这是正确的，
  但要在切换时说明「这是口径修复，不是语料恶化」。
- 曝光抑制 `selectionExposureCap` 的分母同时变化 → **召回排序会变**（权重上界 0.08，影响有界但非零）。
  照 AGENTS.md #8 纪律：换口径时录一份名次快照，不许静默自愈。

**失效模式**
- **修一处、漏一处 = 造一个新的失真**。这已经发生过一次（G1 的更新块）：`recordUsage` 修对了，
  但同一次提交把父桶记账删掉、`pendingHurt`/`audits` 留着旧源。
  **执行纪律**：这个量有**五个**读取/写入点（`recordUsage` / `pendingHurt` / `audits` / `render` /
  `filterOverInjected`），改之前先把五个列出来，改完用一次全滤光的注入核对五个都归零。
- 若只恢复父桶记账而不恢复**父桶门控的 excludeKeys 语义**，会出现「父桶条目被渲染、但父桶台账
  不知道它被谁复用过」——父桶的 `selectionExposureCap` 会一直不生效。这属于**半修复**，
  比不修更难发现（读数看起来在动）。

### D2 · 画像层：静态画像走 `systemPrompt.context`（它**不是**系统提示词，是尾部一条 user 消息）

**机制**（以下全部是我读 DSH 源码得到的，L1，v1 与 `memory-systems.md` §6.3 把落点说对了但**机制说错了**）

1. `systemPrompt.section()` 注册的文本 → `renderPrompt(assembly)` → **system/message**（进缓存前缀）。
2. `systemPrompt.context()` 注册的文本 → `assembly.contexts` → `renderContextSections` →
   **`agent-loop` 把它拼成一条 `user/message`**（`dsh-agent-loop/lib/index.js:298-350`，
   `RuntimeContextProjection.project`），带固定前缀 `Current runtime context. This snapshot supersedes earlier runtime-context snapshots.`
3. 因此：**画像走 `context()` 永远不会改 system 段**，`scripts/acceptance.mjs:232/245-249` 那三条
   （`===FIXED_CONTRACT_TEXT` / `===designText` / `sha256` / `!dynamic`）**与它无关**——
   而且 #2 只断言 `h.registered.sections[0]?.text`（`:245`），新增一个 context 连断言都不进。
4. `context.text` **可以是函数**（`resolveContext`，`dsh-system-prompt/lib/index.js:184-190`），
   每步以 `{agent, scope, signal}` 求值（`assembleContextFor`，`dsh-agent/lib/index.js:291-297`）⇒
   画像可以在**装配时按 cwd/桶**惰性计算，不需要在 `agent/created` 里预先算。
5. 去重判据是**逐字节文本相等**：`if (this.retained?.text === snapshot) return;`（`dsh-agent-loop/lib/index.js:343`）
   ⇒ 画像只要**不变就不重发**；一旦含时间戳就去重失效、**每步追加一条 user 消息**。

**机制（实现）**：新 `context`，name = `memo-river:profile`，order 取一个有限数
（`CONTEXT_ORDERS` 里没有画像槽位，取 130，落在 `TEAM_IDENTITY=125` 与 `HARNESS_SOURCE=200` 之间；
`getContextOrder` 只对已知名有效，自定义名直接用数字）。内容 = 桶级静态画像：
`桶名 / 篇数 / 连通分量 / 最近 N 篇标题行 / 三条最常被主动回读的 D 号`。
**零日期、零时刻、零计数漂移**——篇数变化时文本才变，重发一次是预期成本。

**判据**（完整版见 §三 C2，含基线读数）
- **`runtime-context` 条数 / 模型步 ≤ 0.05**（当前基线 0.016）——「去重生效」的行为读数。
- 画像文本过 `!dynamic` 正则（复用 `scripts/acceptance.mjs:232` 同一个）。
- 子代理会话能拿到：runtime-context 是每步求值的，第一个请求就会带上——
  **不依赖 `agent/created`**（该事件对子代理同样触发，`dsh-agent/lib/index.js:581`，且子代理
  cwd 继承父会话 `dsh-subagent/lib/index.js:350`，这两条只是备查）。

**前置**：D1（画像里要引「最常被回读的 D 号」，那份数据得先是准的）。

**冲突**
1. **位置冲突（v1 没提，我认为是本条最大风险）**：`step()` 里 runtime-context 消息是
   **在 `decision.messages`（我们的召回块）之后** append 的（`dsh-agent-loop/lib/index.js:1048-1070`）
   ⇒ 画像会成为请求里**最靠后**的内容。长画像 + 短召回 = 近因偏置把任务记忆压过去。
   **缓解**：画像硬上限（建议 ≤ 600 字）、且**只放桶级元信息**，不放任何任务结论。
2. **查询场污染**（可解，但要知道边界）：`DIALOG_SOURCE_KINDS = {'user','model','agent-message'}`
   （`src/injector.ts:166`）⇒ `kind='runtime-context'` **不在白名单**，画像不会进查询场。
   这是既有代码替我们挡掉的坑；**改动白名单会立刻把画像变成查询噪声**（D214 的 99.1% 自污染形态）。
3. `dsh-persona` 在 `includeRuntimeContext:false` 时会调 `suppressRuntimeContext()`
   （`dsh-persona/lib/index.js:47`），**会连画像一起压掉**。逃生口是 `required: true`
   （`dsh-system-prompt/lib/index.js:394`），但那会改变全局语义 ⇒ **先查生产预设再决定**，
   查不到就退回尾注入承载画像（见 §四 的条件项）。

**失效模式**
- 画像含任何逐轮变化量（Ω、计数、时间）→ 每步一条 user 消息 → 上下文被同一段话灌满，
  且**前缀缓存指标完全看不出来**（system 段没变）。这是「不破坏前缀缓存」这句话本身的陷阱：
  **不破缓存 ≠ 不涨成本**。
- 画像写成「项目简介」而不是「可操作的当前状态」→ 变成纯噪声，且因为它在最靠后位置，
  对近因偏置的伤害比一般噪声更大（L3，需实测）。

---

### D3 · 缺口发现：把「空手而归的查询」留痕（只读，不自动写）

**机制**：在**只可能是真缺口**的三类退出点上，把查询场首行（≤80 字）+ 归因写进
`kv_store` 的 `memo_river.gap_log`（有界 ring，≤200 条）：
1. `empty-corpus`（库空/无向量）——真缺口；
2. `maxKnn(检索向量) < 0.62` 且 `gate-below-threshold`——**"在题但库里没有"**（门控用的 0.55 是离题线，0.62 是助手锚线，两者之间的带是灰区）；
3. `all-selected-filtered`（有候选但全被滤刀清空）——真缺口 + 仪器线索。
`memo_stats` 增一行：`⑥ 近 7 天未命中查询 N 条（top 首行词：…）`。

**判据**：一周后 `gap_log` 非空；`memo_stats` 能报出 top-N；且**没有任何代码路径因此自动写日记**
（probe 断言：跑完 `memo_stats` 后 `files` 行数不变）。

**前置**：无（纯读 + 有界 ring）。

**冲突**：查询场含用户原话 → 只存首行 80 字、不存全量；且 `gap_log` 会进 `kv_store`
（与 `omega_samples` 同表），**不得参与 `artifactSig`**（`kv_store` 不是签名输入，`DESIGN.md §7.3` 已证）。

**失效模式**：把「门控拦下」误当「知识缺口」。门控挡的是**离题**（天气/订票），
追着离题查询写日记 = 主动往语料里掺稀释剂（Library Drift 的 `bloat`，L2）。
**故必须只取上述三类，且 `gate-below-threshold` 单独出现时不算缺口**。

---

### D4 · 遗忘：先把空转的引擎变成可见读数，再谈自动化

**机制**（三件，全部不删数据）
1. **引擎自检行**：`memo_stats` 与 `health.log` 里给压缩式遗忘引擎报一条**活性读数**：
   `压缩式遗忘：inert(maxPairCos=0.898 < 0.90；idle≥14d: 0/249；候选 0/249)`。
   引擎空转从「静默」变成「每轮都写着」——这是不变量 6（静默即不可接受）的直接兑现。
2. **阈值复标定留档**：把 `overlapCosine=0.90` 的定标依据（27 篇语料）与当前规模（249 篇，
   两两最大 0.8978）并列写进 `DESIGN.md §7.1.3`，并说明「该阈值在当前规模下不可达」。
   **不改默认值**（见失效模式）。
3. **呈现层遗忘（已有，但被 G1 污染）**：`filterOverInjected`（24h 窗内 ≥2 次且 7d 无主动召回 → 不占席位）
   与 `selectionExposureCap`（0.08）都**已经在跑**。修完 D1 后重测：
   当前同一会话内重复席位 **53.5%**（2353/4402）、30 分钟窗内重复 **40.0%**（1758/4390）。

**判据**
- 引擎自检行在 `health.log` 每轮出现，且 `maxPairCos` 是真实计算值（不是常量）。
- 修完 D1 后 30 天重测：30 分钟窗内重复率从 40.0% 下降（这是**唯一**能证明「遗忘在起作用」
  的读数，且它不需要退役任何篇）。

**前置**：D1（重复率的分母是渲染席位，不是入选席位）。

**冲突**：`filterOverInjected` 目前按 `state.audits[].selectionKeys`（**入选集**）计窗，
同样带 G1 的口径问题——修 D1 时这个计窗也要一起改成渲染集，否则两条口径会打架。

**失效模式（A4 的直接对应物）**
- 为了让「引擎有产出」而把 `overlapCosine` 从 0.90 降到 0.85：候选会从 0 跳到 8 对起步，
  但 `memo_patrol` 现在报的 33 个近重复簇里**大量是同轴递进链**
  （D176/D178/D185 = 同一 SIGBUS 修复的三个阶段，cos 0.898 最高那一对；
  D42/D44/D47 = 同一合批改动的勘察/判定/落地）。**把递进链当冗余合并 = 摧毁时间线**，
  而时间线正是本仓日记里最贵的部分（`DESIGN.md` 说「正文写清延续/转折/因果」）。
  这正是 Ratchet A4 在本仓的形态：**治理做错比不做好**（L2，−0.019）。
- 反过来，若把自检行写成告警（`warn`）而不是读数，会天天报警——告警疲劳后没人再看（L3）。

---

### D5 · 归因粒度：把「一轮一条」写进契约（不动召回，改的是**传感器能不能算**）

**机制**：不是改召回，是**给传感器留一个可归因的锚**。在 `SessionState.audits` 里已经存了
`selectionKeys`（`src/session.ts` `InjectionAudit.selectionKeys`）——现在它只用于去重。
新增：每轮把「渲染集」写进审计（D1 顺路），使任何后来的确定性信号（用户纠偏、回读、推翻）
都能**唯一地**落到那一轮的渲染集上。**这不解决一轮 7 条的歧义**，但让歧义**可度量**
（能算出「一次纠偏要摊到几条上」）。

**判据**：任一 `hurt` 事件都能反查到 `turn/step → renderedKeys`（今天能反查到轮次——`critic-hurt` 行带了
`turn/ofTurn`——但追到的是一份**滤刀前的集合**，与真正渲染的内容对不上）。

**前置**：D1。

**冲突**：`audits` 被 `filterOverInjected` 用作计窗数据源——加字段无害，改语义有害（同 D1 冲突条）。

**失效模式**：若把「摊派」当成「归因」（例如一轮 7 条全 +1 hurt），会把**7 条都记成有害**，
在 `n=12` 的中位召回次数下，几次误判就能把某篇推到 Ratchet 的退役线上——**这是 A4 的入口**。
故 `hurt` 必须**只增不驱动**（`probe-critic` 的 C3 断言已经在守这条，`scripts/probe-critic.mjs:122-130`）。

---

## 三、三个硬问题的答案

### C1 · 除了「用户纠偏」，还有哪些**确定性**信号能判断「召回的这条记忆到底有没有用」？

**先给结构性判定（这是本节最重要的东西，v1 没有）**：
Ratchet 的 `ĉ(s) = (#pass − #fail)/n(s)` 能成立的前提是**归因无歧义**——论文的设计原则是
「Router 每次最多给一个技能，这样每个结果要么记给具名技能，要么记给裸模型」（L2，`papers/skill-self-evolution.md` §3.3）。
**本仓一轮注入 p50 = 7 条**（648 轮实测：min 1 / p50 7 / p90 11 / max 16 / mean 6.8，L1）。
⇒ **条目级的「有用/有害」在本仓是不可识别的**，除非把 k 压到 1（与召回宽度直接冲突）。
所以下面的信号按**可归因性**排序，而不是按「像不像有用」。

| # | 信号 | 确定性判据 | 可归因性 | 实测基率 / 样本 | 误判风险 |
|---|---|---|---|---|---|
| **S1** | **按号回读**：`memo_read(D<n>)` 被调用 | 工具调用参数里的 D 号，纯文本匹配 | ✅ **唯一一条能唯一归因到单条的**（读的是哪条就是哪条） | 该工具今天才落地（`07aeda6`），**尚无数据**；且它**不记账**（`src/tools.ts:1102` 段内无 `recordUsage`，L1） | ① **我们刚刚在注入块的 `[用法]` 行里主动教模型去用 `memo_read`**（`src/render.ts` 未提交改动）⇒ 信号会被我们自己抬高，**不能当自然发生率**；② 读 ≠ 有用（可能是好奇/核对，读完后判定"无关"）；③ 只对有 D 号的条目成立（继承条目带 `@桶名`，也行） |
| **S2** | **被推翻/被合并**：该条成为 `memo_supersede` 的 old、或 `memo_merge` 的 source | DB 事件，`memo_supersessions` 表 + `archive/` | ✅ 单条可归因 | **3 条 supersession / 251 篇 / 全生命周期**（L1）；H7 建议 **15 对，结算 0 对**（日志 15 行 `h7-supersede-suggest`，与 supersessions 表**零交集**，L1 逐条比对） | ① 极稀疏——3 条样本算不出任何统计量；② 它测的是 **hurt（结论错了）**，不是 helped；③ 执行环节在人手上（0/15 是**流程真空**，不是传感器问题）；**④ 15 条建议里 5 条的一方编号今天已解析不到**（`memo_update` 重插换 chunk id）——**连追溯都在衰减** |
| **S3** | **用户纠偏词**（v1 的 P0，现已接线 `4be2840`） | 正则，`src/hurt.ts` 的 `isCorrection`（10 条纠偏 + 3 条反转 + **长度闸 400 字** + 首轮不判） | ⚠️ 只能到**轮级**；一轮 7 条时无法分摊（`hurtTargets` 把整批一起记） | **组内对照（197 会话 / 近 10 天，L1）**：真用户轮 1594、命中 129 = **8.1%**；**紧接注入之后** 1010 轮命中 78 = **7.7%**；**没有注入** 584 轮命中 51 = **8.7%** ⇒ **lift = −1.0pp** | ① **方向是负的**：注入之后被纠偏的概率**不升反微降**——这条信号在总账上等于噪声；② 纠偏常针对**工具输出/代码**而非记忆；③ 一轮多条的摊派会制造假 hurt（见 D5 失效模式）；**④ 当前实现把滤刀前的整批都记上（G1 后果 3），误伤面比①②③加起来都大** |
| **S4** | **词面复用**（最自然的那条） | n-gram ∩ 助手正文 | ⚠️ 轮级 | **已被本仓自己的实验室否证：lift = 1.8pp（31.4% vs 29.6%）** | 它测的是「话题重合」。**不要再造一遍** |
| **S5** | **任务结局的机械读数**：退出码 / 测试通过 / 用户接受后继续（不再纠偏） | 工具结果里的 `[exit code: N]`、测试计数 | ❌ 无法归因到条目 | 语料侧参照：249 篇里含 `[exit code: N]` 的 **0 篇**、含 `路径:行号` 的 63 篇（25.3%）、含数值带单位的 202 篇（81.1%）（L1） | 多因——任务失败可能因为环境、模型、需求变更；只能做**轮级协变量**，做条目级归因必错 |

**结论（可直接执行）**：
1. **本仓能做的 Critic 是轮级的，不是条目级的**。任何「按条计分再淘汰」的设计在本仓
   都是统计学上无效的（一轮 7 条），这是 v1 与 Ratchet 之间没被看见的**结构性断点**。
1b. **而且轮级信号本身也没通过第一道体检**：注入后 7.7% vs 未注入 8.7%，**lift −1.0pp**
   （n=1010 / 584）。这与 G3 里「词面复用 lift 1.8pp」是同一类结果——**两条最自然的传感器
   在本仓自己的数据上都不产生信号**。这不是"再调调阈值"能救的，是**信号源选错了层**：
   用户纠偏是对**模型行为**的反馈，而记忆只是模型行为的众多输入之一（一轮 7 条时更是如此）。
   ⇒ 真正该测的是 **S1（按号回读）**——它是唯一一条"用户/模型主动把某条记忆单独拎出来"的动作，
   与"这一轮整体对不对"解耦。**S1 今天是零数据，它才是下一步该攒的。**
2. 因此 `hurt` 的正确形态是：**（turn, step, 渲染集, 信号来源 S1–S5, 命中词）** 一条观测记录，
   落到 `gap_log` 同级的 ring buffer；`UsageEntry.hurt` 保持只增不驱动（现状正确）。
3. **先修 D1 再谈传感器**：现在连「哪几条真进了上下文」都算不准，任何 hurt 归属都会错配。
4. **明确不要**：LLM 裁判（Ratchet Prop.2：`ρ_F→P ≥ (1−τ)/2` 时任何样本量都退不掉；
   本仓 τ 若取 0.10，则阈值 = 0.45 —— 而论文实测"严格且指令良好"的裁判典型是
   `ρ_F→P≈0.01, ρ_P→F≈0.95`，**从另一侧越界**）。这是 L2 数字，但结论方向明确。

---

### C2 · 不破坏前缀缓存的画像方案

**关键事实先纠正 v1 与 `memory-systems.md` §6.3 的机制描述**（以下全部 L1，读 DSH 0.1.6+ 源码）：

| 通道 | 实际去向 | 是否进缓存前缀 |
|---|---|---|
| `systemPrompt.section()` | `renderPrompt` → **system/message** | ✅ 进（所以画像**不能**放这里） |
| `systemPrompt.context()` | `renderContextSections` → `RuntimeContextProjection.project` → **一条 `user/message`** | ❌ 不进 |

源码位置：`dsh-system-prompt/lib/index.js:184-190`（`resolveContext`）、`:255`（section）、`:281`（context）；
`dsh-agent-loop/lib/index.js:298-350`（`RuntimeContextProjection`，`:343` 逐字节去重）、
`:1048-1070`（`decision.messages` 与 runtime-context 的追加顺序）。

**锁死的三个约束（与 v1 一致，我复核了）**
- `FIXED_CONTRACT_TEXT` 被 `scripts/acceptance.mjs:232`（`/\{\{|20\d\d-\d\d-\d\d|\d{2}:\d{2}/`）
  与 `:245-249`（`===FIXED_CONTRACT_TEXT` / `===designText` / `sha256`）三重钉死，
  sha = `3628e5ac…`，3023 bytes（`src/prompt.ts:7,12`）。
- 但 **`#2` 断言只读 `h.registered.sections[0]?.text`**（`scripts/acceptance.mjs:245`）
  ⇒ **新增一个 context 名字根本进不了这条断言**。这一点 v1 说成"会被 sha 钉死"是不精确的：
  钉死的是**那段文本**，不是「不许有别的通道」。
- `agent/session-start` 已在 0.1.6 删除，`agent/created` 取代（`src/index.ts:338-373`）；
  子代理同样触发（`dsh-agent/lib/index.js:581`）。

**方案（不破缓存的版本）**

1. **画像走新建 `context`**：`name='memo-river:profile'`，`order=130`，`text` 是**函数**
   （`resolveContext` 支持 `typeof entry.text === 'function'`，每步以 `{agent, scope, signal}` 求值）。
2. **求值只做库读，且带指纹缓存**：`text(ctx)` → 从 `ctx.agent.session.header.cwd` 解析桶 →
   读 `files` 计数 + 最近 N 篇标题 + 三条最高 `active` → 拼串。用
   `(bucket, filesCount, maxUpdatedAt)` 做指纹，**指纹不变就返回上一份字符串对象/字面量**——
   因为去重是逐字节比较（`:343`），只要字符串相等就**不重发**。
3. **内容纪律（写进代码而不是文档）**：画像文本禁 `{{`、禁日期、禁时刻、禁 Ω、禁计数以外的浮点。
   一条正则校验，与 `acceptance.mjs:232` 同款——**复用同一个检查函数**，避免两处标准漂移。
4. **长度硬顶 600 字**（理由见下"位置"）。
5. **触发不需要 `agent/created`**：`text` 是每步求值的，第一个请求就会带上。
   这比 v1 的「`agent/created` 或工作区首次写入后」更简单，也自动覆盖子代理。
   ⚠️ 保留 `agent/created` 的日志握手不变（`src/index.ts:372`），只是**画像不再依赖它**。

**基线（我今天量的，这是判据的分母）**：现网已经有 7 个 context 在跑
（`sandbox:policy`/`approval:policy`/`working-directory:current`/`team:identity`/`harness:source`/
`app:web-surface`/`subagent:delegation`），合起来 **445 条 runtime-context 消息 / 189 个会话 = 2.35 条/会话**，
摊到 **27047 个模型步 = 0.016 条/步**（p50=1、p90=5、max=30，L1）。
⇒ 现网的 context 通道**基本不重复发送**，这正是去重逐字节比较在起作用。

**判据（三条，都可从会话 JSONL 直接数）**
- **`runtime-context` 条数 / 模型步 ≤ 0.05**（当前基线 0.016）。加一份稳定画像后应当只轻微上升；
  **失效判据：逼近 1.0**（≈ 每步一条 = 6 倍于基线、60 倍于常态）——这说明画像里混进了逐轮变化量。
  这一条比 v1 的「会话里出现一次」好用得多：它是**相对基线**的，且对长会话敏感。
- `data.source.sections[].name` 里能看到 `memo-river:profile`（现网每条 context 消息都带 sections 列表，L1）。
- 画像文本过 `!dynamic` 正则（复用 `scripts/acceptance.mjs:232` 同一个）。
- 子代理会话（`parentSession` 非空）里同样出现该 context 的快照。

**失效模式**
- **最大的一条（v1 没写）**：runtime-context 消息在 `decision.messages` **之后**追加
  （`dsh-agent-loop/lib/index.js:1048-1070`）⇒ 画像在请求里**最靠后**。长画像会因近因偏置
  压过召回块。所以 600 字硬顶不是审美，是**位置补偿**。
- 第二条：若生产预设的 persona 设了 `includeRuntimeContext:false`，`suppressRuntimeContext()`
  会静默压掉画像（`dsh-persona/lib/index.js:47`）。画像消失**不会有任何报错**——
  必须用 `memo-river.log` 打一行 `profile-registered` 做握手（照 `session-start event=` 的既有做法）。
  逃生口 `required: true`（`dsh-system-prompt/lib/index.js:394`）会改变全局语义，**未经核实不用**。

---

### C3 · 不做自动退役的前提下，遗忘能自动到什么程度？

**先把「能做到什么」用数字框死**。Ratchet 的退役条件是 `n(s) ≥ N_min` 且 `ĉ(s) ≤ −τ`，
Default `N_min=100, τ=0.10`；Hoeffding 精度 `ε = sqrt(ln(2/δ)/(2n))`，
δ=1e-3 时 **n=20 → ε≈0.436、n=100 → ε≈0.195**（这两个值与笔记里 Library Drift §2.4/§2.6
报的 0.44 / 0.20 对得上，可交叉验证，L2 数字 + L1 复算）。

本仓实测（L1，`usage_ledger` 直读 251 篇）：

| 项 | 值 |
|---|---|
| 被动召回总数 | **4649**（均值 18.5/篇） |
| 分布 | p50 **12** / p90 **41** / max **109** |
| 召回 ≥10 的篇 | **155/251（61.8%）** ⇒ v1 的「召回次数 <10 禁止退役」硬闸只排除 38% |
| 召回 ≥100 的篇 | **3/251（1.2%）** ⇒ 只有 1.2% 的语料落在 Ratchet 的 Default 区间 |
| 单篇 ε（n=12） | **0.563** ≫ τ=0.10 ⇒ 地板 `E[p0]−(τ+ε)` 读作 `E[p0]−0.66`，**空界** |
| 要让全库都到 n≥100 | 需 25100 次召回，历史累计 4649 ⇒ **还要 5.4 倍** |

**结论：条目级「按贡献退役」在本仓不是「暂时不该做」，是「在可见的未来算不出来」。**

**那么遗忘能自动到什么程度？——四层，按可自动化程度排序：**

| 层 | 能自动吗 | 现状 | 判据 |
|---|---|---|---|
| **L-a 呈现层遗忘**（同一条不重复占席位） | ✅ **已经自动**，且**已有效** | `filterOverInjected` / `dedupeSelection` / `filterLiveDuplicates` / `selectionExposureCap` 全在跑 | 修完 D1 后重测：同一会话重复席位 **53.5%**、30 分钟窗内 **40.0%**（今天的分母是错的） |
| **L-b 有效性遗忘**（结论过期的不再作为当前事实注入） | ✅ 自动**生效**，但**触发是人**的 | `filterSuperseded` 在注入前剔除被取代条目（`src/injector.ts:278`）——**这是本仓最成功的一层**，只是"谁标记"靠人 | `superseded` 计数（日志字段已有）；但 **H7 建议 15 对 / 结算 0 对** ⇒ 检测有、执行无 |
| **L-c 冗余合并**（压缩式遗忘） | ❌ **当前规模不可自动** | 引擎存在但两阈值死锁（G5） | `mergeCandidates=0/249`、`maxPairCos=0.8978<0.90`、`idle≥14d=0/249` |
| **L-d 按贡献退役** | ❌ **数学上不可达**（见上表） | 无 | 只有 0.8% 语料达到 N_min=100 |

**所以答案是**：
> **本仓的遗忘能自动到「L-a 呈现层 + L-b 淘汰生效」，卡在「L-c 的触发条件」和「L-d 的统计量」。**
> 而 L-c 的**真正瓶颈不是算法，是执行**——H7 已能检测 15 对推翻候选，0 对被执行。
> **下一刀不该加自动化，该把「检测 → 执行」之间的 0/15 结算率打上去。**

具体三件可做（都不删数据）：
1. **让 L-c 的「不可达」变成读数**（D4 第 1 条），而不是让它静默空转。
2. **把 L-b 的执行率变成可判读的量**：`h7-supersede-suggest` 已记 **15 条建议**，
   `memo_supersessions` 表 **3 条**（D248→D262、D309→D310、D313→D315），**两组编号零交集**（L1 逐条比对）。
   ⇒ **H7 建议的结算率 = 0/15**。而且这 15 条里已有 **5 条的一方编号在今天已解析不到**
   （`D328`/`D330`/`D348`/`D355`/`D359` 对应的 chunk 已随 `memo_update` 重插而消失，L1 复现）——
   **连"回头看"所需的寻址都在衰减**。这就是为什么第 0 项（统一 D 号）排在最前。
3. **不碰 L-d**。理由不是保守，是 `n=12 ⇒ ε=0.56`：任何 `ĉ ≤ −0.10` 的判据在这个样本量下
   与噪声不可分，而 Ratchet 的 A4 消融正是「证据下限不足还去退役」= 掉穿地板（L2，−0.019）。

---

## 四、分层实施路线

### 现在做（零新机制、纯仪器与读数）

| 序 | 事 | 依赖 | 验收 | 风险 |
|---|---|---|---|---|
| **0** | **修 G1b：统一 `D<n>` 口径**——`health.ts:415` / `patrol.ts:115,139,199` / `consolidation.ts:100` / `daemon.ts:158` 全部改印 **chunk id**（或明确标注 `D<fileId>` 并在 `memo_read` 里加同款双口径解析） | 无 | 全库断言：每个打印出来的 D 号，`memo_read` 都能解析到同一篇（今天 60.6%，目标 100%） | 极低（只改展示与解析） |
| **1** | **D1 剩余两件**：恢复**逐桶**记账 + `pendingHurt`/`audits` 改源 | 无 | 父桶对账断言；「滤后 2 条 ⇒ pendingHurt 2 条」 | 低 |
| **2** | ~~`memo_read` 记 `active`~~ **已完成**（`src/tools.ts:1194`） | — | — | — |
| **3** | **D4-1 遗忘引擎自检行**（inert 读数） | 无 | `health.log` 每轮有 `maxPairCos` 真实值 | 极低（纯读） |
| **4** | ~~Critic 读数可见化~~ **已完成**（`213ca2b`，C7 三条断言） | — | — | — |
| **5** | **D3 缺口留痕**（三类退出点 + 有界 ring + `memo_stats ⑥`） | 无 | 一周后 `gap_log` 非空且 `files` 行数不变 | 低（隐私：只存首行 80 字） |

> 0/1/3/5 都是「让已有的数变成真的」，不新增任何决策路径。**这是唯一一组我有信心说"做完一定更好"的改动。**

**最该先做的一件事**（如果只能做一件）：**第 0 项（统一 D 号口径）**。理由：
① 它是唯一一条**今天就能量化验收**的（60.6% → 100%）；
② 它直接决定 `memo_read`（`07aeda6` 刚落地）到底有没有用——**现在 39.4% 的 D 号喂进去是「找不到」**；
③ 它没有失效模式（纯展示层 + 解析层），爆炸半径最小；
④ 不修它，后面每一条「按 D 号追踪使用」的设计（C1 的 S1、D1 的 active 记账）都会踩在沙子上。

### 等条件（依赖上面的读数先攒出来）

| 序 | 事 | 等的条件 | 为什么必须等 |
|---|---|---|---|
| 6 | **D2 画像层** | 先确认生产预设 persona 的 `includeRuntimeContext` 不是 false（否则画像会被静默压掉）+ D1 完成 | 画像要引「最常被回读的 D 号」，数据源得先准；且位置风险（最靠后）需先量出召回块的长度分布 |
| 7 | **D5 审计带渲染集** | D1 | 与 6 同源数据 |
| 8 | **H7 结算通道**（不自动执行，只做"回头看"提醒：注入时若本轮条目与某条未结算的 H7 建议同族，带一行） | 15 条建议攒到 ≥30 条 | 现在 15 条样本不足，无法判断建议精度（已知 4 次人工核对全是"延续非推翻"，L2 自 D350） |
| 9 | **D2 的灰区二次判定**（VCP 三档结构，`MAIN.md` #4） | 画像层落地后 | 会改门控行为，需先有可信的缺口读数作对照 |

### 明确不做（连条件都不给）

- 按贡献退役（L-d）：见 C3 的数学。
- LLM 裁判驱动任何淘汰：见 C1 结论 4。
- 把 k 压到 1 换取可归因：与「被动注入给线索」的范式（`DESIGN.md §1` 不变量 2）直接冲突，
  且实测 p50=7 是**用户认可的生产形态**（`tokenBudget=3500`、`adaptiveKMax=16` 都是按这个形态定的）。

---

## 五、明确不做的事 + 理由

| 不做 | 理由（带出处） |
|---|---|
| 用 VCP 的 0.3/0.5 校准 Ω | 欧式 vs 余弦差一个量级（0.3 欧式 = **cos 0.9550**；本仓 0.55 余弦 = 欧式 0.9487）。v1 已划掉，v2 维持 |
| 用 LLM 裁判驱动淘汰 | Ratchet Prop.2：`ρ_F→P ≥ (1−τ)/2` 则任何样本量退不掉（L2）；且本仓 τ 若取 0.10，阈值 0.45 |
| 库侧篇数硬上限（照抄 C=50） | 我们是历史事实库；宽度治理应在**检索侧**（k/预算），已满足 |
| 拆 RiverMemo 换静态技能 | Trace2Skill 的 +13.8pp 对照**明确排除 OOD**，而跨任务事实正是语义距离大的区域（L2，`papers/skill-self-evolution.md` §5.4） |
| 自动批准草稿 | 全局守则第 7 条 + 已两次踩坑（D204 的 26/28 噪声） |
| **把 `overlapCosine` 降到 0.85「让引擎有产出」** | 见 D4 失效模式：patrol 报的 33 簇里大量是同轴递进链（D176/178/185 cos 0.898），合并会摧毁时间线 |
| **在画像里放任何逐轮变化量** | 去重是逐字节比较（`dsh-agent-loop/lib/index.js:343`）⇒ 每步重发一条 user 消息，且**前缀缓存指标看不出来** |
| **把 `memo_read` 的引导行当成"自然发生率"来解释 S1 信号** | 我们自己刚在 `[用法]` 行里教模型去 read（`src/render.ts` 未提交改动）⇒ 自污染 |

---

## 六、v2 相比 v1 的取舍说明

| v1 项 | v2 处置 | 为什么 |
|---|---|---|
| **P0 接 `recordHurt` 调用点** | **已完成（`4be2840`）+ 降级**：从"排第一"降为**第 4 项（先印出来、先修源）+ C1 的 S3 之一** | ① v1 的验收判据不可达（`formatHealth` 不印 hurt，L1）；② 即使印了，58 会话实测的注入后样本只有 66 轮（10.1% 基率下**功效不足**）；③ 它假设的"唯一一件写好 80%"在结构上不成立——**条目级归因在 k=7 时不成立**（C1） |
| **P1 `memo_read`** | **升级为已完成 + 补一刀**：本会话中已由 `07aeda6` 落地；v2 追加**记账**（D1-2）与**自污染标记**（C1 S1 风险①） | v1 说"13 个工具里唯一收 id 的是 memo_update"——**当时为真**（L1 复核过 v1 编写时的 HEAD）；现在 14 个工具。功能对了，但读全文不记账 ⇒ 最强的确定性使用信号躺在那里没接线 |
| **P2 索引层/正文层分离** | **删除** | ① `6a02686` 已把记账口径对齐渲染（`excerpt` 800 字），v1 假设的「53%→100%」问题已修；② SkillsBench v4 + SkillGranularity：**粒度对比小且不确定**（+0.7pp / −6.7pp），而"给什么"才是清晰信号（+26.7~+36.0pp）——**粒度轴不值得排进 P2**（L2，`papers/skill-self-evolution.md` §5.2④） |
| **P3 画像层** | **保留，但机制重写** | v1 说"正确落点是 `systemPrompt.context`"——**结论对，理由错**：context 不是"另一条 system 通道"，它**落在尾部一条 user message**（`dsh-agent-loop/lib/index.js:298-350`）。这个差别决定了三件事：① 去重靠逐字节文本（含动态量 = 每步重发）；② 位置在最靠后（近因偏置风险）；③ 它天然不进查询场（`DIALOG_SOURCE_KINDS` 白名单）。**不写清这三点，实现一定踩坑** |
| **P4 patrol 只做巡检** | **保留但换理由，并加一条硬读数** | v1 的理由是"我们语料百级、召回个位数，按贡献退役必然是 A4"——方向对。v2 给出**可计算的形式**：n=12 ⇒ ε=0.56，地板空界；且**只有 0.8% 语料达到 N_min=100**。并追加：**现有的自动遗忘引擎已可证空转**（0/249，maxCos 0.8978 < 0.90）——这比"不做退役"更严重，是"以为有其实没有" |
| **（v1 没有）D1 仪器失真** | **新增** | 1.41× 的虚高、53.5% 的同会话重复、曝光抑制罚错对象——这些是所有下游判据的地基。**已被并行会话修了主症状（`9ba290f`），但留下按桶记账与 `pendingHurt`/`audits` 两处同源问题** |
| **（v1 没有）G1b 两条 D 号口径** | **新增，排第一** | `memo_stats`/`patrol`/`merge-candidates` 印 `fileId`，注入块/`memo_read` 用 chunk id，**39.4% 对不上**。v1 的 P1（`memo_read`）做完之后，这个洞仍然在，只是换了位置 |
| **（v1 没有）D3 缺口观测** | **新增** | 「主动发现自己的知识缺口」是 AGI 记忆的四项之一，本仓连"被问到但没东西"这件事都不记录（日志无查询原文） |
| **（v1 没有）D5 归因粒度** | **新增** | 它解释了为什么 P0 不该排第一，也是 v2 与 Ratchet 之间唯一的结构性断点 |

### 一句话总结取舍

> v1 修了三个**功能洞**（read / 画像 / 巡检），v2 认为先要修的是**仪表洞**：
> 台账在数错的东西、遗忘引擎在空转而没人知道、同一个 `D<n>` 在两屏上是两条不同的记忆。
> **功能补得越多，错的仪表就越多地误导下一个决定。**
>
> 这篇文档写完的过程中，其中两个洞被并行会话修掉了（`213ca2b` 印出 hurt、`9ba290f` 改记账点），
> 而 `9ba290f` **自己又造了一个新洞**（父桶 12.1% 的渲染内容不再记账）。
> 这不是巧合，是本文档最想说的那件事的现场演示：
> **当一个量的所有权没有单一事实源时，「修」和「坏」是同一个动作的两面。**

---

## 七、本文档的自证清单（可复跑）

```bash
# G1：台账 1.41× 虚高（648 轮）
node -e 'const fs=require("fs");const L=fs.readFileSync(process.env.HOME+"/.dsh/memo-river/b94d8836d6175817/memo-river.log","utf8").split("\n").filter(l=>/\] inject bucket=/.test(l));let s=0,r=0;for(const l of L){s+=((/ids=(\S+)/.exec(l)||[])[1]||"").split(",").filter(Boolean).length;const g=k=>+((new RegExp(k+"=(\\d+)").exec(l)||[])[1]||0);r+=g("deduped")+g("superseded")+g("echoed")+g("overInjected")+g("weak")}console.log("slots",s,"filtered",r,"inflation",(s/(s-r)).toFixed(2))'

# G5：两道阈值死锁（249 篇 / 30876 对 / maxCos 0.8978 / idle>14d 0 篇）
node scripts/probe-patrol.mjs 2>/dev/null || node scripts/acceptance-patrol.mjs
cat ~/.dsh/memo-river/b94d8836d6175817/candidates/merge-candidates.md

# G1b：D 号口径分裂（今天 39.4% 对不上；每改一次代码都要重跑）
node -e '
const {DatabaseSync}=require("node:sqlite");
const db=new DatabaseSync(process.env.HOME+"/.dsh/memo-river/b94d8836d6175817/knowledge_base.sqlite",{readOnly:true});
const cs=new Set(db.prepare("SELECT id FROM chunks").all().map(r=>r.id));
const fs=db.prepare("SELECT id FROM files").all().map(r=>r.id);
const dead=fs.filter(f=>!cs.has(f));
console.log("memo_stats/patrol 印 D<fileId> 但 memo_read 找不到:",dead.length,"/",fs.length)' 

# G1 剩余两处（修完 9ba290f 之后仍存在）
grep -n "pendingHurt = {" -A 3 src/injector.ts          # 仍用 outcome.selected（滤刀前）
grep -n "renderedIds = finalOutcome.selected.filter" src/injector.ts   # 只记本桶，父桶无人记账
grep -n "selectionKeys: outcome.selected" src/injector.ts              # audits 也还是滤刀前

# C2：context 落在尾部 user message（不是 system 段）
grep -n "RuntimeContextProjection\|retained?.text === snapshot" \
  ~/.local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js
```

---

## 八、诚实记账

- **本文的 arXiv 数字全部是 L2**（来自 `papers/skill-self-evolution.md` 的转述，我未回原文）。
  我**只对其中两处做了复算**：Hoeffding ε 在 n=20/100 处的值与该笔记报的 0.44/0.20 一致（L1 复算）。
- **本仓读数全部是我今天在本机跑的**（L1）：`memo-river.log` 654 轮、`knowledge_base.sqlite` **251 篇**
  （含 WAL 的副本）。⚠️ **语料在写作期间仍在增长**——收尾复测已是 252 篇 / sumPassive 4685 /
  D 号对不上 99/252 = 39.3%，所以文中计数都是**某一时刻的快照**，判据要以**比例**读
  （39.3–39.4% / 61.8% / 0.8–1.2%），不要以绝对值读；早期几个数字用 249 篇的旧副本算，
  与最终值差异不影响结论方向。另有：
  **197 个会话 JSONL**（445 条 runtime-context / 27047 模型步 / 1594 个真实用户轮）、
  `candidates/merge-candidates.md`、`memo_supersessions` 表 3 行、`常识库` 父桶 14 篇。
- **本文在写作过程中被并行会话改变过三次事实基础**（都是我自己去复核发现的）：
  `4be2840` 接上 hurt 调用点、`213ca2b` 印出 hurt、`9ba290f` 改记账点。文档里凡是标了
  「landed 状态」的块，都是我读代码/跑探针复核后的当前值，不是写作时的初值。
- **未验证但影响结论的**：
  ① 生产预设的 `includeRuntimeContext` 取值（`~/.dsh/.agent-presets/memo-river/` 下只有 `tuning.json`，
  没有活跃 `agent.cordis.yml`；实际装配来自 bundle `bundle/cordis.patch.yml` + 已安装包）——
  若被设为 false，`suppressRuntimeContext()` 会静默压掉 D2 的画像，需改走尾注入。
  **但反证很强**：现网 445 条 runtime-context 消息说明该抑制**没有全局生效**（L1）。
  ② S1（按号回读）的信号强度**完全没有数据**，它今天才落地；
  ③ `memo_patrol` 的 33 个近重复簇里有多少是**真冗余**（可合并）而非**同轴递进链**——
  我只逐条看了 3 簇（都是递进链），剩余 30 簇未判，**不能拿 33 当"该合并的篇数"**。
- **本文没有一项是"已被证明能提升召回质量"的**。D1/D3/D4-1 提升的是**读数的可信度**，
  这是**必要但不充分**条件。真正会改变行为的（D2、H8 结算通道）都在"等条件"里。
