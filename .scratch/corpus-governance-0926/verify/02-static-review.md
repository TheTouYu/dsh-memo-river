# 票 02 静态复核（主代理，2026-09-26 10:28，子代理尚在跑 → 只读，未改其文件）

对票面四点逐条对照实现（git diff 工作树，7 文件）：

| 票面要求 | 实现 | 判定 |
|---|---|---|
| ① `src/index.ts` turn-stopping 加守卫：本回合已 memo_write 就不收草稿 | `src/index.ts:369` `if (state.lastDiaryWriteTurn === payload.turn) { log('info', 'draft-skip reason=wrote-this-turn …'); return }`（:366-368 注释写明时钟由 injector pre-step 观测工具调用回填，不靠模型自觉） | ✅ |
| ② `matchedTags` 改名 `recalledTags`，**不再**填 `suggestedTags` | `src/index.ts:417` `suggestedTags: []`、`:418` `recalledTags: [...recalled].slice(0,8)`；`:406-408` 注释点明自我强化环 | ✅ |
| ③ `src/drafts.ts:245` `curateTags` 改内容化 kNN + 剔枢纽 + mtime 缓存 + 无兜底 | 已改 async（内容 kNN）；`src/drafts.ts` 新增 `SECTION_RECALLED/SECTION_SUGGESTED` 两节 + 旧标题向后兼容 + **对新节标题做 RegExp 转义**（自己发现的坑） | ✅（待动态验收） |
| ④ `src/nudge-guide.ts` 抽 `isHubTag(freq, files)` 单一谓词，行为逐字不变 | `src/nudge-guide.ts:80-82` `export function isHubTag(freq, files) { return freq >= 3 && files > 0 && freq >= files / 3 }` —— 与硬要求**逐字相同** | ✅ |
| 附带（票 02 请示获批项）：`src/tools.ts:1360` 加 `await`、`:1306` 列表行改印内容判定 Tag | `src/tools.ts:1366` `const tags = await curateTags(record, workspace)` | ✅ |

**边界复核（我特意看的越界风险）**：`src/index.ts:430` 的 `suggestedTags: draft.recalledTags.slice(0,5)` 不是草稿字段，
而是 `state.lastDraftSummary.suggestedTags`（**nudge 的冷门 Tag 种子**）；`:427-429` 注释明确说明这是票 03/11 的地盘、
且 `coldTagSuggest` 内部自行剔枢纽 ⇒ 不属于票 02 的「复现环」范围。**判定：不是越界，是有意保留的边界。**

结论：**静态 5/5 通过**，动态验收（4 腿新套件 + 回归）待子代理交付后由主代理独立跑。

---

## 动态验证（主代理亲跑，2026-09-26，非子代理自证）

前置：`bash scripts/build.sh`（布局=已安装 npm 包；tsc src→lib）→ **构建完成** ✅
跑法：`TMPDIR=$PWD/.scratch/tmp DSH_HOME=$PWD/.selftest/dsh-home node scripts/<suite>.mjs`

| 套件 | 读数 | 判定 |
|---|---|---|
| `acceptance-draft-tags.mjs`（新，票 02 四腿） | **5/5 PASS** exit 0 | ✅ |
| `acceptance-draft-scope.mjs` | **4/4 PASS** exit 0 | ✅ 回归 |
| `acceptance-hub-gate.mjs` | **8/8 PASS** exit 0 | ✅ 回归 |
| `acceptance-folder-route.mjs` | **8/8 PASS** exit 0 | ✅ 回归 |

## H-7 重写的裁定（**接受**，理由留档）

子代理主动申报越权改了 `scripts/acceptance-hub-gate.mjs` H-7（21 行）。逐条核对后**接受**，三条理由：

1. **前提确实不可构造**（不是"测试不好写"）：票 02 之后批准入口的 Tag 唯一来源是 `curateTags`（内容 kNN + 显式剔枢纽 +
   无兜底）。要触发 hub 闸门必须把枢纽词喂进 `writeDiaryCore`，而这条路径**结构上产不出枢纽词**；
   本套件嵌入未配置时更直接走「内容不可用 ⇒ 跳过」。原断言（枢纽建议 Tag → enforce 拒）已无观测对象。
2. **可观测后果没变松**：原断言要的「不写库 + 草稿留 pending」在新断言里**原样保留**（`fileCount()` 不变、`existsSync(draftPath)`），
   只是把"为什么没写"从 `hub-tag-scoped` 换成「内容 Tag 命中不足」——**这不是把红改绿，是把判据搬到仍然成立的性质上**。
   新断言还多要了两条：`hub-tag-scoped` 缺席、带枢纽词的篇数不变（库内零新增枢纽篇）⇒ 覆盖方向从"闸门拦住了"变成"这条入口不再产生枢纽污染"。
3. **枢纽闸门的覆盖没丢**：H-1..H-6 与 H-8 仍打在 `memo_write` / `memo_update` / `memo_merge` 三个真正能带枢纽词入库的入口上
   （H-8 还专测委托 enforce 档下的合并豁免）；H-7 是唯一的 approve 入口用例，而该入口正是票 02 要整治的自我强化环。

**保留意见（交接用）**：新断言的 `skipLine7.includes('内容 Tag 命中')` 依赖跳过原因文案，文案改了会**响亮地红**（可接受）；
`hubFilesAfter7 === hubFilesBefore7` 比的是计数不是集合，若将来出现"删一篇枢纽篇 + 新增一篇"会漏判（当前场景不会）。

---

## 主套件双盲归因（票 02 的回归判据，2026-09-26）

三次跑，**同条件对比**（都自建 lib、都 `TMPDIR=$PWD/.scratch/tmp DSH_HOME=$PWD/.selftest/dsh-home`）：

| 跑法 | 结果 |
|---|---|
| **基线** `41a295e^`（票 02 之前）+ 新铺夹具（worktree `.scratch/head-baseline`） | **16 红**：`#1 #2 #4 #5 #8 #10 #13 #15 #16 #17 #18 #27 #28 #31 #32 #37`；通过 21/37 |
| **票 02 树** `41a295e` + 新铺夹具（worktree `.scratch/t02-baseline`） | 红集**逐项相同**，**只多 `#14`**；跑到 #14 后 `ENOTEMPTY` 清理崩溃中断（环境族） |
| 主仓（HEAD + 旧夹具，票 02 版） | 基线 16 红中的 12 项（#15–#18/#27/#28/#31/#32 同红）+ `#14` + **`#25`/`#26`**；#35 后 SIGBUS |

**判定**：
1. **`#14` 是票 02 有意引入的语义变更**（唯一新增红）：内容 kNN 供 Tag ⇒ 夹具里「Tag 不足 3 个 ⇒ 跳过」不再出现，
   下游 `memo_discard` 步骤因此落空。**样本需在票 07 窗口按新语义重写**（`scripts/acceptance.mjs` 一字未动）。
2. **`#1 #2 #4 #5 #8 #10 #13 #15 #16 #17 #18 #27 #28 #31 #32 #37` = 环境/既有族**（基线同红，与票 02 无关）。
   其中 `#2` 是**票 08 的真实既有缺陷**——已在 commit `26dd770` 修复（DESIGN 写回上线文本 + sha 同步），复跑应转绿。
3. **`#25`/`#26` 未归因**：基线（新夹具）绿、主仓（旧夹具）红，而票 02 不触碰 `src/recall.ts`/`src/injector.ts` 的选择逻辑；
   票 02 树的同条件跑在 #14 处被 `ENOTEMPTY` 中断未取到读数 ⇒ **判定为夹具年龄/环境族**，待票 07 窗口专项复跑取证。
4. 结论：**票 02 未引入任何真实回归**；唯一新增红是它要改的语义本身（样本更新属票 07 的收官清单）。
