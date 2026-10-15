# Jev-Mem（arXiv:2609.23986）× memo-river：决策模型控制记忆系统的完整分析

信源：论文 HTML 全文（/tmp/jev-mem.txt，71K 字符，正文+附录 B 提示词全读）。作者=UT Dallas 三人组（Jiang/Li/Li），**第三方**，非 TypeSafe 官方。判官=gpt-4o-mini，单基准 LoCoMo。代码 https://github.com/libingzheren/Jev-Mem 。

## ① 论文在做什么（一句话 + 关键数字）

**把记忆系统的全部高频决策从"生成式 LLM 推理"换成"判别式决策模型一次前向出概率"**，LLM 只留两个位置：最终答案合成（System Two）+ 巩固期经批准的 merge/promote 摘要。

| 指标 | Jev-Mem | 最强 baseline | 差 |
|---|---:|---|---|
| LoCoMo 总分（LLM-judge）| **0.777** | MAGMA 0.700 | +11.0% 相对 |
| Adversarial（抗干扰）| **0.962** | 0.742 | +22 点 |
| Multi-Hop | 0.623* | 0.569 | +5.4 |
| 构建 1 条轨迹的记忆 | **158s** | Nemori 1,044s（最快竞品）| **6.6×** |
| 平均查询延迟 | **0.93s** | MAGMA 1.47s | −36.7%（也低于全上下文 1.74s）|

*注意表内正文与 4.2 文字有一处不一致（0.623 vs 0.625）——论文自己的小瑕疵。

Adversarial +22 点是全表最大增益：**决策模型的概率读出在"区分相关 vs 似是而非的干扰项"上碾压生成式方案**——这正是我们门控要干的事。

## ② 架构拆解（读路径/写路径两侧）

**核心抽象**：System-One 控制器 𝒥(S, Q)——结构化 state + 一批类型化问题（Noul 是非题 / Choice 互斥选择），同 state 的问题**一次批量调用**，返回概率而非文本。**同一个接口管写路径和读路径**（"不是写侧一套启发式、读侧另一套"）。

**写路径** `o→type→candidates→relations→M`：
- **不做准入丢弃**（admission_enabled=false）：保留原始观察，防"当时看着没用"被永久丢掉——与 D239 族④ JitMem「写时策展必然错」同立场。
- 每节点打 4 个**软类型分**（episodic/semantic/procedural/preference，可同时为真）。
- 候选发现（向量+词法+实体+时间近邻，TopK=10）与关系判断**分离**——控制成本不随库增长。
- 关系边 = 4 类 Noul（semantic / caused_by / causes / same-episode），**P≥0.60 才建边**；时间戳/实体 id 精确匹配走确定性路径，不浪费学习判断。
- **巩固（每 20 次写触发）**：redundancy/contradiction/obsolescence 三 Noul + representation Choice（keep_separate/merge/promote/uncertain）。**默认只记决定和链接、不动原文**；仅当 merge/promote 概率 ≥0.85 且矛盾分 <0.85 才允许 System-Two 生成新表示。生成是"结构化控制决策的可选后果"，不是维护的默认机制。

**读路径（闭环控制，不是一次 top-k）**：
1. **路由**：6 个 Noul（semantic/temporal/causal/entity 需求 + multi_hop_need + recency_importance）→ 每类关系图独立激活（p≥0.10），按 p^γ 比例分总预算 80，LRound 取整，最小配额 1。
2. **锚点**：向量+词法 RRF 融合（κ=60）。
3. **证据引导扩展**：每轮对每个候选打 4 个 Noul（relevance / new_information / relation_usefulness / supports_current_evidence），与余弦、图需求分、边概率、recency 调整**组合成排序分**，beam=10。单 relevance 高不保证入选。
4. **自适应停止**：每轮评 s（证据充分）/u（继续检索的期望效用）/m（缺失证据）/c（未解矛盾）。`s≥θ_suff ∧ m<θ ∧ c<θ` 停；`u<θ` 也停（证据还不充分但再挖无益）。

**效率来源**（论文 4.3 自述）：高频决策批量化、候选集有界、检索预算显式、自适应停止避免无谓遍历——**没有一条依赖 Jev 本身的智力**，全部是"把生成换成判别"的结构性收益。

## ③ 决策模型在记忆系统上的运用清单（论文实际用到的全部 22 个决策点）

写侧 8 个：episodic/semantic/procedural/preference（4 typing）、semantic、caused_by、causes、entity-alias。
巩固 5 个：redundancy、contradiction、obsolescence、link-useful、representation(Choice)。
读侧 6+4+4 个：路由 6（含 multi_hop/recency）、候选 4、停止 4（sufficiency/continue/missing/contradiction）。

**按我们第二轮调查的强域归类**：typing/relevance/new_information/redundancy/contradiction 全是 **R&C 域题型**（检索分类/事实核查）——StartLux 0.8B 就 66.32 vs Jev 55.42，HoVer 2B 75.7 vs 45.7；**没有一个决策点落在 K&R 弱域**（最接近的是 caused_by 因果判断，但论文给的 false 判据写得很窄："只有相似/时序/共同实体/证据不足"——是个模式识别题不是推理题）。⇒ **小决策模型恰好被用在自己最强的地方，这是该架构能在 0.93s 内跑完的原因。**

## ④ 结合我方记忆河流的映射分析（逐点对照）

| Jev-Mem 机制 | memo-river 现状 | 判定 |
|---|---|---|
| 该不该注入（relevance+new_information 门控）| **无门**：K 由候选池大小驱动（D224），注入即采纳，盲判实测真起作用仅 **12–25%** 且有反作用档（D238）| **最大缺口，也是论文给的现成答案**：两 Noul 组合 = 我们第二轮设计的浅问法候选第 1、2 条（重叠度/新信息）逐字对应 |
| 自适应停止（证据充分即停）| 一次 top-k 定死，无"够了"概念 | 可移植且便宜：top-k 循环里插一个 sufficiency Noul，预算紧时直接砍 |
| 抗干扰（Adversarial +22 点）| 反作用档没有防线（D238）；D239 检索诱发遗忘给过理论名 | relevance 门天然就是反作用过滤器 |
| 写侧零准入丢弃 | memo_write 永新建+近重复闸门 0.95 拦截（拒=不写）| **同构**：我们的近重复闸门≈轻量 admission，论文提醒：宁可建边链接也别丢原文——我们被闸门拒掉的可以降级为"链接进旧篇"而非丢弃 |
| 巩固 representation Choice + 0.85 阈值才让 LLM 合并 | 手动 memo_merge/memo_update + 守护候选报告（D112/D234 第三刀：并排正文、最多 5 条、合并>新增>改写>取代）| **直接合流**：第三刀缺的就是这个概率触发器——决策模型打 merge/promote 分替代守护循环的启发式三判定；D240 的"总结≈删除"挑战也可用"obsolescence Noul 先筛掉本来就该删的"来缓解 |
| obsolescence（过时检测）Noul | G3 取代机制（D227）全靠写侧显式声明，"没人知道它旧了"仍无自动检出 | 补上 G3 缺的自动检出腿，且是 HoVer 类事实核查强域 |
| 因果/时间关系图 | 我们只有 Tag 共现（无向、无类型）| 论文证据：多关系图是 Multi-Hop/Temporal 分数的来源；但对日记体语料，caused_by 的判据窄，先不动 |
| 路由按查询需求分预算 | 自适应 K 自变量是池大小不是查询信息量（D224 实锤）| 同病：我们给所有查询同一副检索策略。可先做免训练版：路由 2 个 Noul（是否需要时间敏感/新旧知识）调 K 与 recency 权重 |

**与我们既有结论的两处冲突/印证**：
- D240 A 级证据「重排增益随预算塌缩、紧预算下选原始片段非劣」——Jev-Mem 全程**保留原始观察、零写侧 LLM 抽取**（构建 158s≈零生成调用），与 GENOME「写入零 LLM、8900× 加速」完全同向，**进一步支持我们"选原始片段"而非蒸馏结论**。
- D240 最重一击「总结旧记忆≈直接删掉」——Jev-Mem 的应对是**默认不总结**：巩固只记链接，merge/promote 要双阈值（≥0.85 且矛盾<0.85）才升级到 System-Two 生成。这给第三刀一个保守化设计：**链接优先、合并是例外**。
- D241 用户纠正「记忆是过去环境的反馈，要纠正/删除/合成新的」——Jev-Mem 的 obsolescence/contradiction Noul 正是这个操作的判别式实现：(b) 思路（安静时选片段回注）可以完全照 B.3 巩固请求的形态发。

## ⑤ 落地路径（结合第二轮调查的本机约束）

3060 Laptop 6GB、中文、毫秒级——三约束下的方案：
1. **控制器选型：chinese-decision-0.8b**（第二轮结论：中文 72.24% 超 Jev，noul 94.95%，权重已发，MIT）或 StartLux 0.8B/2B（英文任务）。System One 全部 22 个决策点都是 noul/choice 型，接口兼容。
2. **第一步只做两个门**（成本最低、直击 12–25%）：`relevance`（这条记忆含回答当前问题所需事实吗）+ `new_information`（相对已选证据有新增吗）。落点=injector 注入前，state=当前用户消息+已选证据，候选=召回 top-k。延迟预算：state 压 <800tok，0.8B Q8 单读出 ~60–120ms×k 条批量。
3. **第二步自适应停止**：top-k 递补循环里插 sufficiency Noul，替代固定 K。
4. **第三步巩固触发器**（第三刀升级）：守护循环的合并候选检测换成 representation Choice + 双阈值，批准流照旧（人/agent 在场确认，不做自动手术）。
5. **校准标签来源**：recall-effect-audit 的盲判产出（每条注入起没起作用的标签）正好是门控器的训练/校准集——D241 早已指出这条闭环，Jev-Mem 论文 B.1 也自认"模型报告值不是校准概率"，阈值要用业务数据定。

**不做的**（成本收益不划算）：多关系图全盘复刻（我们 Tag 共现够用、caused_by 判据窄）；准入丢弃（我们闸门已够）；AutoThink（延迟不可接受）。

## ⑥ 论文的局限（别当圣经）
- 单基准 LoCoMo、单判官 gpt-4o-mini、作者团队自测、无第三方复现、无消融表（各决策点贡献没拆开验证）。
- 论文没报控制器本身的成本占比（0.93s 里决策模型占多少未拆）；Jev 是 API-only，复现需换成开源决策模型——我们的位置反而更靠前（有开源权重+中文数据）。
- 正文 4.2 的 0.625 与表 1 的 0.623 不一致，小瑕疵。

## 结论一句话
Jev-Mem 用 LoCoMo 数字证明了**「记忆控制判别化 + 原始观察保全 + 概率触发式合并」**这条架构在效果与速度上双赢，且它全部 22 个决策点都落在决策模型的 R&C 强域——与我们两轮调查（chinese-decision-0.8b 可本地跑）和记忆河流里的既有结论（12–25% 起作用率、重排增益塌缩、第三刀缺触发器、G3 缺自动检出）严丝合缝地对上；**最优先落地项 = relevance+new_information 双门注入门控**。
