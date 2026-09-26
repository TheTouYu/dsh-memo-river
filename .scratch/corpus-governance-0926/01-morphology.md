# 票 01 实测：查询形态（QueryMorphology）只认图拓扑，不认查询措辞

- 桶：`50d29236c1297d2c`（日记名 deepseek-harness，22 篇 / 29 Tag）
- artifact：nodes=29 edges=202 sig=7d97aef001e9
- 形态数：10（含 3 种 ≥40 字长句）

| 形态 | 字数 | queryMode | Ω | regime | atomicW | propW | narrW | confidence | effDepth | chainness | aStrMax | topRole |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 标签词·流程 | 4 | atomic | 0.9132 | dense | 0.5752 | 0.2111 | 0.2137 | 0.7772 | 0.0393 | 0.1731 | 0.1463 | atomic_concept |
| 标签词·内容 | 7 | atomic | 0.5821 | dense | 0.5133 | 0.2421 | 0.2446 | 0.4834 | 0.0209 | 0.1981 | 0.1974 | atomic_concept |
| 短问题 | 10 | atomic | 0.5743 | dense | 0.5049 | 0.2614 | 0.2337 | 0.6959 | 0.02 | 0.0933 | 0.1722 | atomic_concept |
| 短问题 | 12 | atomic | 0.9254 | dense | 0.4959 | 0.2129 | 0.2912 | 0.8093 | 0.0279 | 0.2027 | 0.1557 | atomic_concept |
| 中文短语 | 19 | atomic | 0.9234 | dense | 0.5196 | 0.2463 | 0.2341 | 0.8012 | 0.0243 | 0.1232 | 0.2313 | atomic_concept |
| 长命题式 | 64 | atomic | 0.9355 | dense | 0.4527 | 0.2158 | 0.3315 | 0.7393 | 0.0426 | 0.2768 | 0.1807 | atomic_concept |
| 长叙事式 | 63 | atomic | 0.8173 | dense | 0.5015 | 0.2049 | 0.2936 | 0.8736 | 0.0273 | 0.2378 | 0.2514 | atomic_concept |
| 长命题式 | 64 | atomic | 0.6039 | dense | 0.4939 | 0.2289 | 0.2773 | 0.7316 | 0.0232 | 0.2147 | 0.185 | atomic_concept |
| 混合 | 14 | atomic | 0.9532 | dense | 0.4896 | 0.2262 | 0.2842 | 0.867 | 0.0429 | 0.172 | 0.1535 | atomic_concept |
| 单词·英文 | 6 | atomic | 0.664 | dense | 0.4951 | 0.2578 | 0.2471 | 0.7617 | 0.0209 | 0.103 | 0.19 | atomic_concept |

原始 JSON：`.scratch/morph-probe/morphology.json`
