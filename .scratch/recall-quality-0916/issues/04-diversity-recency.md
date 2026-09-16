# 04 — 注入选择多样性/新鲜度约束（防旧条目搭车）

**What to build:** 在 03 的自适应 k 之上，给选择循环加两个**有界**权重：①批内多样性——同 Tag/同轴条目去重，避免单条垄断；②近因——新写入条目在窗口期内获得加成。防 D1×36 式搭车：09-11 的魔方旧日记在年轻桶里被被动注入 36 次、贯穿整个千星会话（同域旧条目泛化，D58 归因修正）。权重上界可配、缺省保守，保证不推翻 topology 主排序。

**Blocked by:** 03 — 同一选择循环，先扩 k 再加权重

**Status:** done — 2026-09-16（证据：commit 271e3b3 + acceptance-selection-weights 6/6 + 主套件 37/37 + adaptivek 4/4）

- [x] 复放/模拟 c9f838ba 时序：同一旧条目在连续注入中占比显著下降（阈值实现时定标）
- [x] 候选充足时新鲜条目（<24h）至少占一席
- [x] 权重有界（上限可配），topology_v3 主套件 + acceptance 回归全绿
- [x] 不引入新嵌入调用（复用已有向量，零额外时延）

<!-- 票04 完成注记（2026-09-16，commit 271e3b3）：
  · 实现：src/recall.ts selectCandidates 纯函数（票03 k 公式 + 三权重）；曝光抑制读
    usage ledger passive 信号（与票05 tie-breaker 只认 active 互为镜像）；config 五参
    selectionTagCap=0.04 / selectionExposureCap=0.08 / 半衰 24h / selectionRecencyCap=0.05
    / 窗口 24h；injector.recallOptions 只走被动路径（主动 memo_recall 不接，显式 k 语义）。
  · 验收 scripts/acceptance-selection-weights.mjs（#55-60）：
    - #56 膨胀桶连续 12 注（k=3 复刻 D1×36 时代固定 k）：D1 占比 100%→17%（2/12），
      hub 簇 36/36→15/36 席，12 轮 distinct 3→20，新鲜条目（2h）占席，maxPenalty 0.0785≤0.08。
    - #57 近因窗口有界（2h 进席/30h 零加成/远题 0.30 不进）；#58 同 Tag 去重
      （[hub,hub,hub]→[hub,异轴,异轴]，tagDemotions=2 留痕）；#59 零权重/池<5 逐位旧行为
      （不传 ≡ 三cap=0 ≡ 旧单趟参考实现全等）；#60 全链路（台账惩罚生效、主动路径 on=false、
      embed 调用数与权重无关、injector 接线）。
  · 行为面：台账曝光使连续注入选集轮换 → 同集合去重按设计失配重注——acceptance.mjs #17
    按票03 先例（ratio=0）追加钉死三 cap=0（该判据对象是去重/刷新语义，需稳定选集）。
  · 有界性：三上界合计 0.17 < 锚奖励 0.18（不推翻 topology 主排序）；零新增嵌入调用。 -->

