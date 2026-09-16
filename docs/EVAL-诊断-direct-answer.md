# EVAL·诊断：genshin-ts 会话夜 direct_answer=0 根因（票 07）

> 2026-09-16 · 诊断人：票 07 实现代理 · 方法：离线复放（scripts/replay-direct-answer.mjs）
> 对象：genshin-ts 桶（4bde2299850f027e）· c9f838ba 会话夜（2026-09-15 21:03→02:01 CST = 13:03Z→18:01Z）
> 姊妹篇：docs/EVAL-单会话深评-genshin-ts-c9f838ba.md（其指标③「direct_answer=0」为本票命题）

## 〇、结论速览

**判据合理，不改阈值、不改公式。** direct_answer=0 是**结构性结果**：被动注入的查询场（最近 6 条消息拼接）落在 Rust 形态学的 `atomic` 模式，而初判通道整体被 `mode != "atomic"` 这个**形态学门**关闭；唯一旁路（锚晋升）在生产整夜一次都没点燃。数值阈值（closure/direct_evidence 的 0.55）**根本不是闸门**——若把 mode 门假想打开，36/36 事件的初判条件本就满足；把阈值从 0.55 降到 0.45，通过率一个不变。**要改的不是阈值，若真要动手，杠杆在查询场构造（另票，不落地）**，见 §五。

另：主动 `memo_recall`（同桶同语料的聚焦查询）当晚也全是 atomic——问题不在「被动 vs 主动」，而在**查询形态 × 年轻枢纽语料**联合把形态学压进 atomic。

## 一、口径修正（对深评报告的三处订正）

1. **注入次数 37 → 36**：报告指标③写「37 次注入、gate 37/37」，指标①写「注入 8+28 次」（=36）。逐行核对生产日志：会话夜窗口 `[2026-09-15T13:00Z, 19:00Z]` 内 inject 行 = **36**（父会话 8 + 15 个子会话 28）。「37」是时区滑窗多算了 1 条 09-16 晨间续跑注入（01:25:33Z，晨间会话已不属于被评估的夜）。
2. **夜终点**：父会话夜里最后一条注入在 15:24Z（=23:24 CST，goal2 blocked 时刻），不是 02:01。
3. **生产桶现状已非夜桶**：09-16 晨会话被续跑，做了 tag 手术（memo_update 全量改写夜文件）与 merge（27→23 文件）——夜里 `files.updated_at` 时间线已被破坏。因此本诊断**不能**直接用生产库做语料态回放，须考古重建（§二）。

## 二、方法：夜语料考古重建 + 离线复放（scripts/replay-direct-answer.mjs）

**语料重建**（生产桶全程只读；复放在 /tmp 自净桶）：

- 写事件全集 = 生产日志 27 条 `memo_write` 行（path / chunk=D-id / tags / ts，权威顺序）；
- 每次写的精确正文 = 会话文件 `tool/call`（name=memo_write）的参数，按 **live 代码（b498127）writeDiaryCore 的归一化**重算 `full`：`title = 显式参数 || 正文首 # 行 || "${date} 未命名"`、`body = stripTagLine(content)`（**保留标题行**——「标题行重复拼两次」正是 live 行为）、`full = "# title\n\n body\n\nTag: a, b, c\n"`；
- 向量全部取自生产 `emb-cache.json`（键 = 嵌入原文，逐字节一致即同向量）。

**保真度硬指标**（v6 复放，2026-09-16）：

| 环节 | 指标 | 读数 |
|---|---|---|
| 语料 | D-id 断言（重建 chunkId == 日志 D-id，含未命名双写 D10→D11） | **27/27** |
| 语料 | `full` 逐字节命中生产嵌入缓存（=向量与生产同源） | **27/27** |
| 语料 | 写事件↔tool-call join（tags 集合相等） | 27/27 |
| 查询 | 查询场逐字节命中生产缓存（emb-cache oracle 挑 claimed 变体：A=无新输入 14 / B=带下条真实用户消息 11 / C=带 plugin 快照段 10 / D=仅 compact 摘要 1） | 28/36 |
| 查询 | 门控锚 gU / gA 逐字节命中 | 18/19 / 17/19 |
| 召回链 JS 侧 | 对照生产 memo_recall 渲染逐条 knn（同查询同语料态） | **Δ=0.0000（6/6 条）** |
| 召回链 JS 侧 | candidates 数 vs 日志 | 35/36 |
| 门控 | gateVector / gateMaxKnn / retrMaxKnn（缓存命中事件） | 26/28 / 27/28 / 28/28 |
| 形态学 | queryMode=atomic（36 注入 + 4 主动） vs 生产 157 条渲染角色全 atomic_concept | 双侧一致 |

**固有保真度上界**（诚实声明，两处）：生产 DSH 进程（09-14 21:08 启动）整夜**增量**重建 artifact/派生资产，复放是逐态**全新**重建——(a) 夜末（14:45Z 后）Ω 分歧：生产 0.97-0.99 vs 复放 0.20-0.60（前段 14:15-14:40 的 Ω 对齐良好，24/36 事件 ±0.05 内）；(b) 生产渲染的 anchorBonus/topologyBonus 全为 0.000（加成通道平坦），复放算出小幅非零加成 → top-3 排序逐条重合率低（idsSet 5/36）。同进程探针（同 artifact 两跑 + 新库新 artifact 一跑）结果逐位一致，排除了复放侧的运行不确定性；分歧属于**生产进程内状态不可克隆**，不影响本票结论（结论落分布层面，且生产侧地面真值 0 direct 由渲染层独立佐证）。

## 三、判定链逐环证据（36 次被动注入复放 + 生产渲染对照）

Rust 角色判定链（rust-vexus-lite/src/rivermemo_topology_v3.rs `assign_v3_scores`）：

```
初判 direct_answer ⟸ mode≠atomic ∧ closure≥0.55 ∧ ( direct_evidence≥0.55 ∨ (near_frontier ∧ query_score≥0.55) )
锚晋升（唯一旁路，不看 mode）⟸ 最强锚 strength≥0.1(anchor_frontier_abs_floor) ∧ ≥2.0×次强(anchor_frontier_contrast)
降级：Ω<0.12 → structural 降 thematic
```

逐环读数：

1. **形态学门（主闸）**：36/36 被动注入 + 4/4 主动 recall 的 `queryMode=atomic`。形态学权重中位 atomic=0.560 / prop=0.248 / narr=0.192——atomic 不是险胜，是结构性地占优。机制：查询河图浅而散（shallow_energy_ratio 高、有效深度低 → atomic_logit 大），且年轻小语料上图小 → sample_reliability 低 → confidence 低 → 权重被拉向均匀先验 [1/3,1/3,1/3]，而 dominant 判定 `weights[0]>=weights[1]&&weights[0]>=weights[2]` **平票偏 atomic**。生产佐证：夜内全部被动渲染 118 条 + 主动渲染 39 条角色**全是 atomic_concept**（被动 0 direct、主动 0 direct）。
2. **初判数值条件（若 mode 门开着）**：36/36 事件存在满足 `closure≥0.55 ∧ (direct≥0.55 ∨ frontier∧knn≥0.55)` 的候选（29/36 靠 direct_evidence、13/36 靠 frontier 路径，有重叠）。**closure 距 0.55 中位 -0.108（即 bestClosure≈0.66）、direct 距 0.55 中位 -0.030**——阈值不缺量，被 mode 门整段短路。
3. **阈值敏感性**：closure/direct 阈值 0.55 → 0.50 → 0.45，初判可通过事件数恒为 36/36。**降阈值零收益**（已饱和）。
4. **锚晋升旁路**：复放（对晋升**最有利**的全新健康 artifact）也只点燃 10/36，全部落在 D4（T01 收轮），strongest 中位 0.196、次强比中位 2.97×；未点燃的 26 个事件 strongest 中位 0.132 但次强比仅 1.13×——**年轻枢纽语料（「千星官方课程」21/26 篇 hub）让次强锚贴着最强锚，2× 对比度达不到**。生产侧整夜 0 次点燃（且生产渲染加成通道平坦，锚更弱）。
5. **降级通道**：与 direct_answer 无关（只降 structural）。生产夜 Ω 后段 0.97-0.99 不触发、前段 0.25 上下也只影响 structural/thematic 之间——渲染证实最终角色全 atomic，降级链未参与。

**主动对照**：4 次 memo_recall（关键词聚焦查询，gate=false、单条嵌入）在同语料同态上**同样是 atomic 模式、全 atomic_concept、0 direct**——排除了「被动查询场太弥散」单独成因；**查询短而聚焦也救不了**，因为瓶颈在语料年龄/枢纽度（图小 → confidence 低 → 先验拉平 → 平票偏 atomic）与查询场弥散（被动）的联合。

## 四、根因结论

**direct_answer=0 是「结构性邻居语料形态使然」，判定判据本身合理，不改：**

- 数值阈值（0.55）不是闸门（§三.2/3：条件本就满足，降阈值零增量）；
- 打分公式没有错杀（错杀发生在公式之前的形态学门，且该门在这类语料上的行为——小图低置信 → 先验拉平 → 偏 atomic——是设计内行为）；
- 主动路径同一晚 0 direct，说明这不是被动注入独有的病，放宽被动侧参数无济于事。

**生产含义**：年轻桶（一夜 2→27 篇、hub 80%）上，direct_answer 证据等级不可得是**预期行为**——证据分级应当从 atomic_concept 起步，随语料成熟（Tag 图分叉、hub 稀释）自然解锁。深评报告指标③的 ⚠️ 判定据此修正为：direct_answer=0 **不是缺陷信号**，k 截断（dropped 24/26）才是该指标的真正病灶（归票 03/04）。

## 五、建议（diff 级、不落地；落地需另起实现票）

按性价比排序：

1. **【渲染/提示词，低风险】补全证据等级词表**：系统提示的证据等级 legend 只解释了 direct_answer / structural_explanation / thematic_neighbor 三档，**没有 atomic_concept**——年轻桶上代理整夜看到未定义档位。建议在注入块 preamble 或提示词里补一句（可与票 05 的 nudge/渲染文案合并）。落点：src/render.ts 注入块头部 + 系统提示固定文本。
2. **【查询场构造，中风险，另票】被动查询场降弥散**：`buildQueryField` 的 6 条窗口拼接把多条消息的语义摊平，是 atomic 占优的推手之一。若要让被动注入在成熟语料上拿到 direct_answer，可试「末条用户消息为主（前缀重复 2-3 次）+ 窗口为辅」或窗口 6→3。**影响检索本体，必须独立票带生产评估**，不建议顺手改。
3. **【Rust 形态学，高风险，默认不做】平票偏向**：`dominant_mode` 判定在低置信（权重≈先验）时平票偏 atomic。若上游确认为病，最小 diff 是给 `weights[0]` 乘一个 `(1 - 0.1*(1-confidence))` 的先验惩罚，或在低置信段改判「propositional」。改的是全局形态学，跨桶影响，需上游（VCPToolBox rust-vexus-lite）合意——本仓只消费二进制，不动。
4. **不建议**：调 closure/direct_evidence 阈值（零收益）；调锚晋升 bar（0.1/2.0×）——复放显示健康 artifact 下 D4 类强锚已能点燃，生产没点燃是 artifact 状态平坦，不是 bar 太高。

## 六、复现

```bash
node scripts/replay-direct-answer.mjs --json /tmp/replay-da.json   # 全量复放+汇总（/tmp 自净，生产只读）
```

数据档案（本次结论的原始出处）：/tmp/replay-da-v6.json（36 注入 + 4 recall 逐事件 trace：queryMode/morphology/closure/direct/anchorStrength/omega/晋升明细 + 语料重建日志）。脚本依赖：构建产物 lib/、VCPToolBox 原生模块（与生产同一 .node，09-14 15:39 构建）、生产桶三处只读（memo-river.log / dailynote / emb-cache.json）与会话文件 zstd 流。
