# 03 — 注入 k 自适应（治 dropped 24/26）

**What to build:** 被动注入读出的固定 k=3 改为随候选池自适应：`k = clamp(ceil(候选数 × 比例), 保底3, 上界kMax)`（比例与 kMax 的缺省值在实现时以 c9f838ba 数据定标并注释依据）。注入 chars 总预算（tokenBudget）**不变**——自适应只改选择条数，不突破预算。目标：桶膨胀期（c9f838ba 一夜 2→27 篇，后期注入 dropped 24/26≈92%）不再「河流越肥、注入越瞎」。

**Blocked by:** None — can start immediately

**Status:** done — 2026-09-16（证据：commit 2d094e6 + acceptance-adaptivek 4/4 + 主套件 36/37；唯一红 #25 经 stash 双盲归因与本票无关——暂出本票三文件重跑仍红，系写道并行票的中间态）

- [x] 膨胀桶模拟（≥20 候选）：注入 dropped 率降至 <50% —— acceptance-adaptivek #53：池 23（27 篇复刻）→ kEff=14=clamp(ceil(23×0.6),3,16)，dropped 9/23=39.1%（固定 k=3 对照 87.0%）；kMax=8 钳位探针 kEff=8 ✅；ratio=0 回滚对照 selected=3/kEff=3 ✅
- [x] 稀疏桶（<5 候选）行为与现状一致 —— #52：池 3 时自适应开/关选集逐位一致 `[3,2,1]`；#31 口径 k=1 仍恰 1 条（ADAPTIVE_K_POOL_FLOOR=5 池地板护住显式小 k，#19/#25 的 k=2/池3 同理）
- [x] 注入总 chars 不超预算；选择阶段时延劣化可忽略（纯内存）—— #54：tokenBudget=600 下重算 cost=599≤600（截断保首句 1 条）；自适应开/关时延差 1ms（阈值 150ms）；预算截断代码零改动（recall.ts 只改 kEff 计算）
- [x] 回归：topology_v3 主套件 + acceptance 全绿 —— 主套件 36/37（≥36 底线达标；#17 因本票既定行为面改钉 adaptiveKRatio=0 保住原语义）；adaptivek 4/4；folder-route 5/5、shared-routes 6/6、tiebreaker 9/9、usage 6/6、p3 4/4；#25 红 + merge/update/consolidation 崩 = 写道（票01/02/06）并行中间态，双盲归因与本票无关
- [x] 定标依据（比例/kMax 取值理由）写入代码注释或 docs —— src/config.ts InjectConfig.adaptiveKRatio 全量注释（26 候选需 k≥14 才 <50%；ratio=0.5→13 恰 50% 不过线→取 0.6→16 条 38.5%；kMax=16=27 篇场景 41%）+ recall.ts ADAPTIVE_K_POOL_FLOOR=5 由头

**实现纪要：** `ADAPTIVE_K_POOL_FLOOR=5`（池地板）：池≥5 时 `kBase=max(k, min(ceil(池×ratio), kMax))`，池<5 严格旧行为；`kEff=max(1,round(kBase×dynamicK))` 保倍率语义；diagnostics 增 kEff/kBase/adaptivePool。memo_recall 主动路径不接线（tools.ts 属票01 道，保持显式 k）。
