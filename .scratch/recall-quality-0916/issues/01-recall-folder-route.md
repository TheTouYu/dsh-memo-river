# 01 — memo_recall folder 真路由（跨桶直查）

**What to build:** `memo_recall` 的 `folder` 参数从「本桶检索后按 diaryName 事后过滤」改为**真路由**：解析目标桶（桶名→状态目录），用目标桶的库与原生资产执行检索，返回结果与 diagnostics 均为目标桶口径；目标桶不存在时清晰报错并列出已知桶名；不传 folder 时行为完全不变。schema 描述同步改为真路由语义（现状文案「日记本桶名」有误导性）。动机：跨项目知识检索目前不可达——genshin-ts 桶一夜建成的千星知识图谱（65-208 条硬规则/篇）在其他项目查永远是 0 命中（D58 归因纠偏①）。

**Blocked by:** None — can start immediately

**Status:** done — 2026-09-16（证据：commit `ticket01: memo_recall folder 真路由` + acceptance-folder-route 5/5 + 主套件 35/37（#25 失败在纯 HEAD 复现，与本票无关，见下）+ usage 6/6 + tiebreaker 9/9 + 生产 genshin-ts 跨桶真实验证命中）

- [x] 在 memo-river 工作区 `memo_recall(folder=genshin-ts, query=节点图 客户端图 硬规则)` 返回 genshin-ts 桶真实条目
  - ✅ 生产实弹（HEAD+本票改动的干净构建上跑，未带其他在飞改动）：路由行 `🔄 folder 路由 → 桶=genshin-ts@4bde2299850f027e（cwd=/home/h/genshin-ts）`，命中 D54「D3b-客户端图与通信专题成文…官方与代码互证的硬规则」score=0.7627、D40「D3a-节点图基础与执行流-94 条硬规则落盘」等，候选=27、Ω=0.813、diagnostics 为目标桶口径（genshin-ts artifactSig）——旧实现此处必然 0 命中（D58 归因纠偏①打通）。
  - 侧效应（票面豁免「真实验证调用不算写」）：目标桶 kv 使用台账 selected 各 +1 active、emb-cache 追加、原生资产同 sig 幂等重建、目标桶 memo-river.log 一行 `bucket-route-open`。
- [x] `folder=不存在桶` → 明确报错并列出可用桶名
  - ✅ FR-2：报「不存在桶「route-不存在」（状态根 …；解析顺序：…）」+「可用桶（N 个）：…」清单。
- [x] 不传 folder：现有行为回归不变
  - ✅ FR-3：缺省与 folder=本桶名行为一致、无路由标注；主套件回归（除下述 #25）全绿。
- [x] 被召回条目的使用台账足迹记在**目标桶**（跨桶召回也是「使用」）
  - ✅ FR-4：跨桶调用后目标桶 B 的 ledger Δactive≥1（D1/D2 active=1）、本桶 A 台账键冻结 null；recordUsage(target.store, …)。
- [x] 新增 acceptance 用例：自建自净 A/B 双桶做跨桶查询验证
  - ✅ `scripts/acceptance-folder-route.mjs`（5/5 PASS ×2）：DSH_HOME 隔离到 mktemp 自净根，A=routeA（教室渲染话题）B=routeB（布料模拟话题）各 2 篇，跨桶查 B 命中 B 无 A 串扰；另覆盖 FR-5 同名多桶按名报错列候选 + folder=16 位哈希消歧精确路由（生产桶名不唯一的现实：状态根大量 /var/tmp 历史同名测试桶）。

**实现**（src/workspace.ts + src/runtime.ts + src/tools.ts memo_recall 处理器）：
- 解析规则：folder 为 16 位 hex → 按工作区哈希精确匹配（消歧通道）；否则 workspace.json manifest 的 bucket 字段 → dailynote/ 唯一子目录名兜底；只认有 knowledge_base.sqlite 的根。同名多桶 → 报错列候选（拒绝静默挑一个）。
- `WorkspaceRuntime.openExisting(paths, config)`：跨桶打开已存在桶——不建目录、不写 manifest；嵌入沿用本插件部署（全机同端点）；日志落目标桶 memo-river.log。注册表与 acquireWorkspace 同一张（键=工作区哈希），天然去重复用。
- 旧「本桶检索 + diaryName 事后过滤」删除；timeRange 过滤保留（在目标桶结果集上）。
- schema 描述同步改为真路由语义。

**已知无关失败**：主套件 #25（近因保底·写入时间戳）在**纯 HEAD**（不含本票改动，/var/tmp 独立 worktree + DSH_HOME 隔离探针复刻）以同一签名失败——嵌入端点把「同日晚些的会议纪要」排到「部署记录」之上（关保底控制组同样含会议纪要，纯 KNN 排序漂移，非保底逻辑回归；recall.ts 本票未触碰）。建议归 03/04（读出/定标）线跟进。
