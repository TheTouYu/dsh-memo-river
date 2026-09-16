# 03 — 注入 k 自适应（治 dropped 24/26）

**What to build:** 被动注入读出的固定 k=3 改为随候选池自适应：`k = clamp(ceil(候选数 × 比例), 保底3, 上界kMax)`（比例与 kMax 的缺省值在实现时以 c9f838ba 数据定标并注释依据）。注入 chars 总预算（tokenBudget）**不变**——自适应只改选择条数，不突破预算。目标：桶膨胀期（c9f838ba 一夜 2→27 篇，后期注入 dropped 24/26≈92%）不再「河流越肥、注入越瞎」。

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

- [ ] 膨胀桶模拟（≥20 候选）：注入 dropped 率降至 <50%
- [ ] 稀疏桶（<5 候选）行为与现状一致
- [ ] 注入总 chars 不超预算；选择阶段时延劣化可忽略（纯内存）
- [ ] 回归：topology_v3 主套件 + acceptance 全绿
- [ ] 定标依据（比例/kMax 取值理由）写入代码注释或 docs
