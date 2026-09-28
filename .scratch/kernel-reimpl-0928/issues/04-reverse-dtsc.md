# 04 — 逆向补全：memo_dtsc.rs（1655 行，DTSC 读出模式）

**What to build:** 行号+系数级逆向文档至 `kernel/docs/reverse-dtsc.md`：DTSC（测地曲线）读出的候选构造、曲线相似度数学、与 topology_v3 读出的分野、载荷 schema（rerankMemoDtsc 的 inputJson 形状与输出 schema）。复放验证同 03（对账器 dtsc 轨 trace）。

**Blocked by:** 02

**Status:** ready-for-agent

- [ ] DTSC 候选来源与打分公式落文档（行号级）
- [ ] rerankMemoDtsc 输入/输出载荷 schema 落文档（字段全列，与 index.d.ts 对齐）
- [ ] classroom-flow 三查询 dtsc 轨复放：文档预测与实际分数/名次吻合
- [ ] 文档头标注逆向快照版本
