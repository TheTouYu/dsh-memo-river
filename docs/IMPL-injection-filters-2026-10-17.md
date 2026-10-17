# 实现设计：注入通道 §2 压缩泵三修法 + §3 修法5 等待窗口锚 + §4 时机感知 + §5 教训行为化

> 状态：**已实现已验证，未上生产**（lib 已编译，dsh-web 未重启——重启需用户确认时机，全局守则第 2 条）。
> 上游证据：`docs/PLAN-2026-10-17-两真会话注入通道工程优化.md`（§2/§3/§4/§5，第四批精读证据已并入）。
> 代码：本仓 kernel-reimpl 分支（见 git log「注入通道§2/§3修法5/§4/§5」提交）；决策日记：D346。
> 姊妹篇：`docs/IMPL-embed-notify-and-nudge-anchor-2026-10-17.md`（§1/§3 增量锚，同一部署窗口）。
> 本文回答：改成了什么、边界语义、如何调、如何回滚、后来者如何溯源。

## 1. §2 修法1：强刷仍走条目级去重（压缩泵断开）

`src/injector.ts` 条目级去重段：`liveKeys = dedupeLiveEntries ? liveInjectedKeys(...) : null`——
**`&& !refreshDue` 已拆**。语义变化：

| 场景 | 旧 | 新 |
|---|---|---|
| 压缩后强刷 + 旧注入块**还在**请求消息里 | 整批重放（泵：25 次压缩=315 条次重注） | 块在场 → 条目被剔，不重放 |
| 压缩后强刷 + 块**真被吃掉**（shadowedRange） | 重放 | rawHistory 无块 → 放行补注（记忆不丢） |
| 集合级 identical-selection 短路 | 强刷越过 | **仍越过**（不变——强刷意图触发重评，条目在场则被上述刀剔光，渲染空 → skip 'all-selected-already-in-context'） |

配套：`acceptance.mjs` #16 mock 改真实压缩形态（压缩=移除注入块，旧 mock 保留块还要求必重注，锚的是已拆语义）；`acceptance-inject-dedup.mjs` #68 源码断言改为「`dedupeLiveEntries && !refreshDue` 残留 = 必须 false」。

## 2. §2 修法2：条目级注入频次上限（本会话口径）

`filterOverInjected(selected, state, homeBucket, ledger, now)`：**本会话** 24h 窗内已注入 ≥2 次
（计数源 = `SessionState.audits` 的 selectionKeys+at）且 7d 内无主动召回（`memo_river.usage_ledger`
的 active/lastActiveAt——台账只承担豁免，不承担计数）→ 剔，归因 `over-injected-window`。

**设计教训（首版翻车，已回滚）**：首版用桶级台账 recentP（每次被动注入时刻数组）计窗——验收实测
**跨会话误伤**：同桶多会话互相累计（他会注入≠本会话上下文里有；acceptance #10 串行/并发分叉）。
生产目标形态是**单会话**跨压缩 7 连注（D3@常识库）。台账的 recentP 字段与写入已随之回滚（未上线）。

## 3. §2 修法3：写入回声冷却（会话级，15 分钟）

- `SessionState.recentWrites: Array<{fileId, chunkId, at}>`（有界 24 条）；
  `writeDiaryCore` 成功路径按 `input.sessionId` 上报（memo_write/update/merge/approve 四入口都传
  `viewerOf(exec).sessionId`；`WriteDiaryResult` 新增 `fileId` 字段）。
- `filterRecentWriteEcho`：本会话 15min（`inject.writeEchoCooldownMs`，0=关）内写入的 fileId/chunkId
  双口径匹配 → 剔，归因 `recently-written-echo`。**只判本会话**（D334 反例：子代理写入、父会话注入
  是 delegation 变体的设计目标）；父桶候选（srcBucket）不判。
- 证据面：11 例两会话实锤（D331 写入 **7 秒**注回最快；D328 与用户严批同拍到达），见 PLAN §2 修法3。

## 4. §3 修法5：等待窗口锚（第五锚）

- 检测 `detectWaitingWindow(log)`：最近一条 assistant 的工具调用为 `job_output`（带 job_id）或
  bash 且命令含 ≥20s 的 sleep（`WAITING_SLEEP_SECONDS`）→ `{jobId}`。
- 触发 `evaluateWriteNudge(..., waiting)`：waiting ≠ null 且距上次写入/提醒 ≥3 步
  （`WAITING_NUDGE_MIN_STEPS`）且有鲜 digest（lastAssistantDigest 非空）→ 提醒，文案
  「等待中的后台任务「job」在跑——趁此窗口把刚才的产出入河」。四锚全关时等待锚不单独破总闸；
  5 分钟全局重发间隔不豁免。
- 证据面：模型两次自发在等待窗口写日记（长 09:15/短 14:57），同窗口虚高增量催写全被无视。

## 5. §4 时机感知

- **修法①（默认开，`inject.metaWindowSuppress`）**：`isMetaOperationWindow(rawMsgs)`——最近 3 条
  带工具调用的 assistant 全为 compress/decompress/acp_status/search_context/读 session 文件
  （bash 命令含 `.dsh/sessions`）→ 本轮**自主态**召回整窗跳过（federatedRecall 之前短路，省 embed），
  `inject-skip reason=meta-window`。回合首发（新用户输入）不压。
- **修法③（默认关，`inject.weakSignalFloorSuppress=false`）**：`filterWeakSignal` 剔
  anchor=0&topology=0&knn<0.7 的非 top-1（近因保底席位 floorPulled 豁免）。**默认关的实证**：
  acceptance-inject-dedup #65/#66 首轮 3 选 1（正常语料中排条目大量 0/0）；§4 证据集中在元操作窗，
  已被①覆盖。纯函数与探针保留为实验通道。

## 6. §5 教训行为化（写前回注 + 契约 ⑨）

- `composeReinjection`（`src/tools.ts`）新增两行：「涉教训类日记，末尾补『触发条件→动作』行」
  +「Tag 行格式 `Tag:` 单数无 s」（N7c：唯一真写入重试根因）。
- 契约规范 ⑨（DESIGN.md §6.1 围栏块 → `node scripts/gen-prompt.mjs` 重生成 `src/prompt.ts`）：
  sha256 `62e8331…` → `3628e5ac163fb31fa3f92b7fdd8a6875191d4afd733799196a6d2598e1eb64eb`，
  2768 → 3023 字节。acceptance #2 自校验（读模块常量比对，无需改）。
- 挂账：草稿预审三态加分项未做（precheck 是 kNN 值判定，教训形态检测是模糊匹配，ROI 低）。

## 7. 可调参数

| 参数 | 默认 | 通道 | 说明 |
|---|---|---|---|
| `inject.writeEchoCooldownMs` | 900,000 | 配置（zod 默认） | 写入回声冷却窗；0=关 |
| `inject.overInjectSuppress` | true | 同上 | 本会话 24h≥2 次且无主动召回 → 剔 |
| `inject.metaWindowSuppress` | true | 同上 | 元操作窗自主态召回跳过 |
| `inject.weakSignalFloorSuppress` | **false** | 同上 | 弱信号护栏（默认关，见 §5） |
| 常量 | — | 代码 | OVER_INJECT_WINDOW_MS=24h / ACTIVE_EXEMPT=7d / WAITING_SLEEP_SECONDS=20 / WAITING_NUDGE_MIN_STEPS=3 / WEAK_SIGNAL_KNN_GUARD=0.7 |

## 8. 验证与回滚

**验证（2026-10-17，8099 因游戏互斥停机、acceptance/探针走 openrouter 保底）**：
`acceptance 37/37`（reimpl 轨）+ `acceptance-queryfield 6/6` + `acceptance-inject-dedup 8/8` +
`diff-runner 五腿 OK`（分差 1.11e-16）+ `probe-h7 6/6`（保底端点：`H7_EMBED_URL=https://openrouter.ai/api
H7_EMBED_KEY=<TAG_EMBED_KEY> H7_EMBED_MODEL=baai/bge-m3`——apiUrl **不带 /v1**，客户端自拼）+
`probe-injection-filters 13/13`（新行为契约）+ `probe-write-nudge-growth 7/7` + usage/title-gate/
hub-gate/selection-weights 全绿。**预存环境红（负对照定罪，非本批）**：acceptance-update（embed-
unavailable，8099 停机）、acceptance-merge（夹具 archive ENOENT）、acceptance-folder-route（同族）。

**回滚**：`git revert <本批提交>` + 重启；行为级分刀回滚 = 对应 `inject.*` 旋钮关掉（§4③ 本就默认关）。

**观察期判据（上生产 48h）**：桶日志 `echoed=`/`overInjected=`/`weak=`/`reason=meta-window` 计数非零
（生效证明）；`inject trigger=compaction` 行的 ids 与前次注入的重复率应显著下降（压缩泵收益）；
等待锚文案在 write-nudge 行出现且模型响应率高于增量锚。

## 9. 变更约定（与姊妹篇同款）

改本机制语义 = 改代码 + 同步改探针（probe-injection-filters.mjs 13 判 / acceptance #16 / dedup #68
源码断言是行为契约）+ 同步改本文与 PLAN 对应节 + commit 引用本文路径 + 决策入河。
