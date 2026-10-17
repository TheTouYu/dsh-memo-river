# 实现设计：嵌入通知状态转换沿（§1）+ 催写增量锚只计 assistant（§3）

> 状态：**已实现已验证，未上生产**（lib 已编译，dsh-web 未重启）。
> 上游证据文档：`docs/PLAN-2026-10-17-两真会话注入通道工程优化.md`（为什么改，含生产实证）
> 代码：commit `03b9ee5`；决策日记：D340（记忆河流）；行为契约：两个探针（见 §5）。
> 本文回答：**改成了什么、边界语义、如何调整、如何回滚、后来者如何溯源**。

## 1. §1 嵌入链路通知：状态转换沿取代冷却窗

### 语义矩阵（`src/embed-health.ts:50-110` 真源）

| # | 场景（最新非 all-failed 事件相对上次播报） | 行为 | 为什么 |
|---|---|---|---|
| 1 | lane 无前史 + degraded | **播报一次**，记 `announcedState[lane]='degraded'` | 故障要让模型知道一次 |
| 2 | 前史 degraded + 新 degraded（含重试、不同 reason/id） | **静默吸收**（`announcedIds.add`，面板卡片与桶日志仍全量可见） | 持续故障重复播报=纯噪声（生产实证 13h 77 条同内容、模型零理会） |
| 3 | 前史 degraded + recovered | **播报一次**，记 `'ok'` | 恢复是状态转换 |
| 4 | 前史 ok + 新 ok | 静默吸收 | 同上 |
| 5 | 前史 ok + degraded | 播报一次（回 case 1 语义） | 再度故障是转换 |
| 6 | **无前史 + recovered**（进程启动时端点本就正常） | **静默** | 没报过降级就别报恢复（2026-10-15 语义保留） |
| 7 | `all-failed` 事件（任何情况） | **永不进对话通道** | 已有可见路径：inject 走 `inject-skip` 通知、写入走工具报错；重复播报挤占注入预算（实测多发一条会把验收 #9 额外消息数 2→3） |
| 8 | degraded→recovered→degraded 快速抖动 | 只报**最新**状态，中间被覆盖的 recovered 不翻旧账 | 判定对象是「最新非 all-failed 事件」而非任意未播报事件 |

- 状态存于内存 `announcedState: Map<lane, 'degraded'\|'ok'>`——**进程重启即重置**（重启后首轮故障会重新播报一次，这是特性不是 bug：新进程新观察窗）。
- 事件环淘汰（MAX_EVENTS）时同步清理 `announcedIds`，防 id 复用误判。
- 时钟不参与判定（旧 5min 冷却窗已废弃，`pending(now)` 的 now 仅签名兼容）。

### 行为对照（探针内复现 + 生产实证）

13h 每 6min failover 场景：旧冷却窗语义 **130 条**（生产实证 77 条/13h 同形）→ 新状态沿 **1 条**。

## 2. §3 催写增量锚：量尺只计 assistant 产出

### 量尺定义（`src/injector.ts:888-895`）

```ts
assistantGrowthChars(log) = Σ messageText(m).length  for m in log where m.role === 'assistant'
```

旧口径=全量消息字符（含系统注入与工具输出）→ 生产实证开局 41s 把 54K 系统注入（AGENTS/skill-catalog/召回/通知）误报成「模型增长」。新口径只计 assistant 的 reasoning+text。

### 锚定语义与边界（`src/injector.ts:937-955`）

| 场景 | 行为 | 设计意图 |
|---|---|---|
| 开局 contextChars=0 | 锚不定住，每轮重打底 | 防开局零产出误报 |
| 首个非零 assistant 产出 | `nudgeAnchorChars` 定锚于此 | 增长从真产出起算 |
| 「单轮巨产」 | **要多等一轮才催** | 已知代价（防误报的正确姿势），探针 F 轮实证 |
| memo_write / 催写触发 | 锚重置为当前 contextChars，四锚同时重置 | 防同一信号连拍 |
| 任何锚触发 | 5 分钟全局最小间隔限流（`WRITE_NUDGE_MIN_SPACING_MS`）不豁免 | issue #108 连拍教训 |

### 跨会话误引 guard（`src/injector.ts:1032-1033`）

「上篇止于」锚：`lastDiaryWriteTurn <= 0`（本会话无 memo_write）→ 返回 null，不引用**上一会话**的日记结尾（生产实证：短会话 b96dea52 开局 34 秒首催误引上会话话题）。

## 3. 可调参数（不改代码的调整通道）

| 参数 | 默认 | 通道 | 说明 |
|---|---|---|---|
| `writeNudgeGrowthChars` | 50,000 | `memo_tuning` 工具 / `GET /memo-river/tuning/panel` 面板 / tuning.json（preset 级落盘） | 增量锚阈值（只计 assistant 后语义不变，**无需改默认**——50K 真产出远大于旧误报场景）；0=关 |
| `writeNudgeEverySteps/Minutes/Turns` | 预设各异 | 同上 | 其余三锚不受本次改动影响 |

§1 无运行时参数（状态机语义即全部）——若生产出现「该报没报」，见 §4 回滚。

## 4. 回滚路径

- **代码回滚**：`git revert 03b9ee5` + 重启 dsh-web（本仓在 kernel-reimpl 分支，生产轨=systemd drop-in `MEMO_NATIVE_KERNEL=reimpl`，与本次改动正交）。
- **行为级关闭**（不回代码）：`writeNudgeGrowthChars=0`（memo_tuning）即关增量锚；§1 无软开关——若需要「旧语义应急开关」（如 `MEMO_EMBED_NOTIFY_LEGACY=1`），单开一刀，约 20 行。
- 观察期判据（上生产后 48h 看）：①failover 通知条数应从 ~6/h 降到转换沿（0 或 1-2 条/事件）；②催写误报（开局/注入主导型）应归零；③桶日志 `inject-skip reason=embed-*` 占比不变（通知与跳过是两件事，本文不动后者）。

## 5. 溯源链与变更约定（后来者入口）

**五点链**：PLAN（问题+生产证据）→ **本文**（语义+参数+回滚）→ commit `03b9ee5`（代码+提交信息）→ D340/D342（决策日记，记忆河流被动可召回）→ 探针（行为契约）。

**变更约定（动本机制必须走）**：
1. 改语义 = 改代码 + **同步改探针用例**（`scripts/probe-embed-notify-edge.mjs` 11 用例、`scripts/probe-write-nudge-growth.mjs` 7 用例是行为契约，不接受探针与语义漂移）；
2. 改语义 = **同步改本文矩阵表**（本文与 `src/embed-health.ts` / `src/injector.ts` 注释三处同源，注释里已反向引用本文与 PLAN）；
3. 验收闸门：动 injector/embed-health → `node scripts/acceptance-queryfield.mjs` 6/6 + `node scripts/acceptance.mjs` 37/37（注意 acceptance #29 已适配新锚语义：首轮产出定锚、次轮起算——这不是回归，是语义差）；
4. commit 信息引用本文路径；
5. 决策与理由入河（memo_write，D340 同款）。

**历史语义对照**（读旧日志/旧代码时防混淆）：
- 旧 §1：`(kind,lane)` 对 + 5min 冷却窗 → 持续降级时每冷却窗报一条（77 条/13h 的来源）；
- 旧 §3 增量锚：全量消息字符（注入计入增长）→ 开局 41s 54K 误报；
- 生产日志里旧格式通知与新格式并存属预期（重启分界），判别点：新语义下同 lane 同状态永不重播。

## 6. 未尽事项（挂账）

- §2 压缩泵 / §4 时机感知 / §5 教训行为化：见 PLAN「实施顺序」，未动工；
- 「等待窗口催写」（PLAN §3 修法 5）、写入回声冷却（PLAN §2 修法 3）：证据充分，未实现；
- `MEMO_EMBED_NOTIFY_LEGACY` 软开关：按需再开（默认不做，避免参数面膨胀）。
