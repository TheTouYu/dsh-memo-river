# 08 — 契约源头分叉：DESIGN §6.1 与 src/prompt.ts 不一致 + sha256 常量失效

**发现于**：票 01 执行途中（2026-09-26）。**不是本轮引入的**——`git show HEAD:DESIGN.md` 与 `HEAD:src/prompt.ts` 已各自如此。

**事实（可复算，无需跑套件）**：

| 位置 | 文本 | bytes | sha256 |
|---|---|---|---|
| `DESIGN.md` §6.1 围栏块（声明的唯一源头） | 「…片段带**证据等级**：role=direct_answer 可直接采信 / structural_explanation 是结构推理 / thematic_neighbor 仅主题邻近」，写日记规范 ①–**⑦** | 1597 | `b08590b5…` |
| `src/prompt.ts` 的 `FIXED_CONTRACT_TEXT`（**实际上线的**） | 「…片段带 **role 字段**：atomic_concept 是块的固有分类（默认档…）/ structural_explanation / thematic_neighbor（omega 偏低时由结构档降级而来）/ direct_answer 是锚强度过 frontier 后提升的最高档」，规范 ①–**⑧**（含「决定性事实放正文开头」） | 2025 | `b5260237…` |
| `src/prompt.ts` 的 `FIXED_CONTRACT_SHA256` | —— | —— | `b08590b5…`＝**DESIGN 文本**的哈希 |

**后果**：`scripts/acceptance.mjs` #2（前缀缓存不破）三条断言里两条必红：
`registered === designText`（2025B ≠ 1597B）、`FIXED_CONTRACT_SHA256 === sha(registered)`（b08590b5 ≠ b5260237）。
`contract-registered sha256=…` 日志行报的也是**别人文本**的哈希 ⇒ 这个判据当下是**失效的**（不再是前缀缓存的回归线）。
`scripts/gen-prompt.mjs` 的注释写着「不接受任何手抄」，而事实上现网文本只能来自手抄（DESIGN 里没这段）。

**定因待查（执行时按序做）**：
1. `git log -p --follow src/prompt.ts` 与 `git log -p DESIGN.md` 找分叉点：是**直接改了 prompt.ts**（跳过 gen-prompt），还是**改过 DESIGN 后被回退**。
2. 判定哪一侧是**真意图**：role 字段那句（atomic_concept/structure/thematic/direct_answer 的完整描述）与规范 ⑧（决定性事实放开头）在功能上都是**后加的、且已被生产使用**（本会话 system 段即 2025B 版）⇒ 判 `src/prompt.ts` 侧为真意图的概率高，`DESIGN.md` §6.1 需要补回这两处。
3. 与用户确认后：把**权威文本写回 DESIGN.md §6.1 围栏**（唯一改动点）→ `node scripts/gen-prompt.mjs` 重生成 `src/prompt.ts`（sha 常量随之更新）→ 断言 #2 转绿。

**判据（可复现读数）**：
- [ ] 分叉点 commit 号 + 定性（手抄 / 回退），写进票面
- [ ] DESIGN §6.1 与 `FIXED_CONTRACT_TEXT` **逐字节一致**（`registered === designText` 打印 true）
- [ ] `FIXED_CONTRACT_SHA256 === sha(FIXED_CONTRACT_TEXT)` 打印 true（不再「常量对应别人」）
- [ ] `acceptance.mjs` #2 绿；`contract-registered sha256=` 与该常量一致
- [ ] 若权威文本最终选择与当前上线文本不同 ⇒ **必须与票 03 同批**（一次重启窗口、一次前缀缓存失效），且在票面记录「前缀缓存会破一次」的代价

**Blocked by:** 无（但**必须先于票 03 完成**：票 03 要改契约，改之前得先让源头自洽，否则会把手抄差异一起带进新版本）。

**Status:** done（用户裁定 **A**）— commit `26dd770`：DESIGN §6.1 写回上线文本 + 票 03 的 ②③ 补丁同批落地，gen-prompt 重生成，sha256 `5a5d65e2…`（2266B）

- [ ] 分叉点定位（git log）
- [ ] 权威侧判定 + 用户确认
- [ ] DESIGN → gen-prompt → sha 对齐 + #2 转绿

---

## 定因 — 2026-09-26（主代理，git 取证）

**分叉点 = commit `94ed004`（2026-09-25，「fix: 交付窗口 240→800、修正两处『契约与实现不符』」）。**

`git show --stat 94ed004` 只动三个文件：`src/prompt.ts`、`src/render.ts`、`src/tools.ts`——
**没有 `DESIGN.md`**，也**没有 `scripts/gen-prompt.mjs`**。具体：

| 检查 | 结果 |
|---|---|
| `git show 94ed004 -- src/prompt.ts \| grep '^[-+]export const FIXED_CONTRACT_TEXT'` | 该行**被改**（就是这次把「证据等级」改成「role 字段」四 role 描述、补上规范 ⑧、并写入真实日志行格式） |
| `git show 94ed004 -- src/prompt.ts \| grep '^[-+]export const FIXED_CONTRACT_SHA256'` | **空** ⇒ sha 常量**没跟着重算** |
| `git show 94ed004 -- DESIGN.md \| grep -E '[-+].*(证据等级\|role 字段\|决定性事实)'` | **空**（DESIGN.md 根本不在该提交里） |
| `git log -S'决定性事实'` / `-S'片段带 role 字段'` | 都只命中 `94ed004` ⇒ 规范 ⑧ 与四 role 描述**都诞生于这次手改** |

**定性 = 直接手改生成物**（`scripts/gen-prompt.mjs` 顶部注释明确写着「**自动生成，请勿手改**」、
「不接受任何手抄——手抄会引入不可见的全角/半角与引号差异」）。当时的意图是**修契约与实现不符**
（提交信息自述：`fallbackUsed` 在 diagnostics 里根本不存在、role 词汇与实现不符），方向正确但**路径违规**：
源头（DESIGN §6.1）与派生（sha 常量）双双落空 ⇒ 自 09-25 起 `acceptance.mjs` #2 必红、且
`contract-registered sha256=` 报的是「另一份文本」的哈希，前缀缓存回归线**形同失效**。

**待用户裁定**（A / B）：
- **(A) 以上线文本为准**（推荐）：`src/prompt.ts` 的 2025B 文本是在生产上真跑、且比 DESIGN 版**多**两条信息
  （`atomic_concept` 的完整描述＋规范 ⑧「决定性事实放正文开头」）⇒ 把它**逐字写回 `DESIGN.md` §6.1 围栏**，
  再跑 `node scripts/gen-prompt.mjs` 重生成 ⇒ `#2` 转绿、常量与文本自洽。代价：前缀缓存破**一次**
  （与票 03 的契约改动合批，只破一次）。
- **(B) 以 DESIGN 为准**：回退上线文本，丢掉 ⑧ 与四 role 描述 —— 等于撤掉已生效的改进，不推荐。

---

## 路径 A 干跑（scratch 演练，2026-09-26 —— 仓库文件一字未动）

在 `.scratch/genprompt-dry/` 复刻 `DESIGN.md` + `scripts/gen-prompt.mjs` + `src/` 的最小布局，
把 **上线文本**（2025B）逐字填进 §6.1 围栏，跑 `node .scratch/genprompt-dry/scripts/gen-prompt.mjs`：

```
旧围栏 : 1597 bytes sha b08590b5533a
上线文本: 2025 bytes sha b52602374b1f
wrote src/prompt.ts — 2025 bytes, sha256=b52602374b1f1cb8b59943e9aefe2b32cc2b11b84e6f903b9674a847d707e282
重生成文本 === 上线 FIXED_CONTRACT_TEXT : true
重生成常量 === sha(重生成文本)          : true
```

⇒ **A 路径可一键落地**：把上线文本写回 `DESIGN.md` §6.1 围栏（唯一改动点）→ 跑 `node scripts/gen-prompt.mjs`
→ `src/prompt.ts` 与常量自洽、`acceptance.mjs` #2 的两条断言（`registered === designText`、
`FIXED_CONTRACT_SHA256 === sha(registered)`）**同时转绿**，文本本身与当前上线文本**逐字节相同**
（⇒ 若与票 03 合批，前缀缓存只因票 03 的契约改动破一次，不因这次对齐破）。

---

## A 路径落地记录（2026-09-26，用户裁定 A：以上线文本为准）

1. **写回逐字**：把 `DESIGN.md` §6.1 围栏（原 1597B / sha `b08590b5…`）替换为**上线文本 + 票 03 的 ②③ 补丁**
   （干跑产物 `.scratch/genprompt-dry/DESIGN.md` 的围栏，2266B / sha `5a5d65e26d8b592e8e003cf6276142d87b2932415a39decf57ca38a5cfc633f7`）。
2. **重生成**：`node scripts/gen-prompt.mjs` → `wrote src/prompt.ts — 2266 bytes, sha256=5a5d65e2…`；
   `FIXED_CONTRACT_SHA256` 同步为 `5a5d65e2…`（常量与文本自洽）。
3. **零漂移证据（关键）**：`git diff src/prompt.ts` **只有 4 行**（+/- 各 2：sha 与 bytes 注释、常量行），
   正文里**只改了 ②③ 两条**——若写回有任何一个字节的偏差，整行 `FIXED_CONTRACT_TEXT` 都会重写。
   ⇒ 「以上线文本为准」是**逐字**做到位的，不是近似对齐。
4. **前缀缓存**：这一次 gen-prompt 与票 03 的契约补丁是**同一次**（DESIGN 先写回、补丁再叠加、只生成一次）⇒ 缓存只破一次。
   生效需**重启 DSH**（运行中的插件内存里还是旧契约）。
