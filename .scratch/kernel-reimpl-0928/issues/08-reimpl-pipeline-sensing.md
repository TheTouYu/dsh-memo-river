# 08 — 复刻 pipeline + sensing（1550 + 529 行）

**What to build:** `kernel/src/memo_pipeline.rs` + `memo_sensing.rs`：七阶段统一查询管线（EPA 轴分析 / 残差金字塔 Gram-Schmidt / Handshake / 门控 / Spike 感知 / 融合 / 双场传播）。系数全部来自逆向文档 §2（γ=0.7、core 增益 [1.2,1.4]、local α=0.15 / transfer α=0.55、残差 ≤1e-9 收敛上限 80 轮、域裁剪 0.8/0.9）。

**Blocked by:** 07

**Status:** done — 2026-09-28（commit 821309f；范围注记：管线吃 `self.index`，本票实际含最小 usearch 索引层——构造参数/recover SQL 行序插入与上游逐项一致，原计划的 07→08 依赖边画乐观了）

- [x] 双轨 metadataJson 阶段对账：七阶段中间观测量阶段级比较绿（EPA 三量+主轴、金字塔逐层 Tag 序与 energyExplained、融合选择集与四计数、双场 iterations/converged/residual）——五腿 **0 分歧**
- [x] enhancedVector 对账：余弦 ≥0.999999——实测 classroom 三查询 **1.000000000000**
- [x] 收敛性属性：双场传播迭代轮数与 L1 残差双轨一致（±1e-9，阶段对账覆盖）
- [x] 退化路径对齐：空库 / 单篇 / 全同向量三夹具双轨不崩溃且 sig 一致、enhanced 达标（degenerate-fixture.mjs 三连绿）
- [x] 附带产出：usearch 版本归因——上游锁 2.21.3，"2.8" 区间漂到 2.26.2 会让金字塔层近距并列打破漂移（L1/L2 尾部集合不一致）；已精确钉 `=2.21.3` 并写入 Cargo.toml 注释
