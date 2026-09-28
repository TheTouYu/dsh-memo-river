# 08 — 复刻 pipeline + sensing（1550 + 529 行）

**What to build:** `kernel/src/memo_pipeline.rs` + `memo_sensing.rs`：七阶段统一查询管线（EPA 轴分析 / 残差金字塔 Gram-Schmidt / Handshake / 门控 / Spike 感知 / 融合 / 双场传播）。系数全部来自逆向文档 §2（γ=0.7、core 增益 [1.2,1.4]、local α=0.15 / transfer α=0.55、残差 ≤1e-9 收敛上限 80 轮、域裁剪 0.8/0.9）。

**Blocked by:** 07

**Status:** ready-for-agent

- [ ] 双轨 metadataJson 阶段对账：七阶段各有中间观测量，阶段级比较绿（比端到端更可定位）
- [ ] enhancedVector 对账：余弦 ≥0.999999
- [ ] 收敛性属性：双场传播迭代轮数与 L1 残差轨迹双轨一致（±1e-9）
- [ ] 退化路径对齐：空库 / 单篇 / 全同向量三夹具双轨不崩溃且输出一致
