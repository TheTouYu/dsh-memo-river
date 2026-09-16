# 01 — memo_recall folder 真路由（跨桶直查）

**What to build:** `memo_recall` 的 `folder` 参数从「本桶检索后按 diaryName 事后过滤」改为**真路由**：解析目标桶（桶名→状态目录），用目标桶的库与原生资产执行检索，返回结果与 diagnostics 均为目标桶口径；目标桶不存在时清晰报错并列出已知桶名；不传 folder 时行为完全不变。schema 描述同步改为真路由语义（现状文案「日记本桶名」有误导性）。动机：跨项目知识检索目前不可达——genshin-ts 桶一夜建成的千星知识图谱（65-208 条硬规则/篇）在其他项目查永远是 0 命中（D58 归因纠偏①）。

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

- [ ] 在 memo-river 工作区 `memo_recall(folder=genshin-ts, query=节点图 客户端图 硬规则)` 返回 genshin-ts 桶真实条目
- [ ] `folder=不存在桶` → 明确报错并列出可用桶名
- [ ] 不传 folder：现有行为回归不变
- [ ] 被召回条目的使用台账足迹记在**目标桶**（跨桶召回也是「使用」）
- [ ] 新增 acceptance 用例：自建自净 A/B 双桶做跨桶查询验证
