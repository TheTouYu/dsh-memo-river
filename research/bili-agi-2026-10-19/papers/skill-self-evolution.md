# Skill 自进化论文深挖（一手核实）

> 取证日期：2026-10-19 ｜ 取证方式：arXiv abs 页 + PDF/HTML 全文逐段精读（非二手转述）
> 全部原文缓存：`/tmp/rsch/`（PDF `t2s.pdf` / `txt_2605.19576.txt` / `txt_2605.22148.txt`）
> 证据分级：**L1** = 读过论文原文（abs + 全文）；**L2** = 仅字幕/口播转述；**L3** = 推测
> 触发来源：`learn/BV1BU5E6pEBL-*`（B 站口播，L2）→ 反查一手论文（L1）

---

## 零、结论先行：五条能改变本仓做法的硬结论

1. **「LLM 自写技能」在受控基准上是零收益，人工策展是 +16.2pp。** 这是 SkillsBench 的核心读数，也是整个「技能自进化」赛道必须回答的靶子（L1，arXiv:2602.12670）。本仓若要做自动写日记/自动沉淀，这条是第一道校验题——**先证明你的自写管线不是 +0.0pp**。
2. **技能库的真实瓶颈是「管理员」不是「作者」。** Library Drift 与 Ratchet 两篇同源论文的论点：同一冻结模型，无治理 → +0.002（平地板）；加治理 → +0.328。**差 0.326 全部来自生命周期管理，不来自写得好不好**（L1）。对本仓：`memo_write`（作者）已经够用，缺的是 `退役 + 宽度上限 + 写作先验` 三件套。
3. **治理做错比不治理更糟。** A4 消融（证据下限 100→20、τ→0）把 pass@1 压到 **−0.019，低于无技能基线**（L1）。对本仓的直接含义：**任何「按贡献分退役日记」的机制，在证据量不足时会主动伤害语料**。这条是刹车，不是油门。
4. **蒸馏成静态技能 > 检索式经验库，同轨迹池 +13.8pp（122B）/ +9.2pp（35B）。** Trace2Skill Table 5 与 ReasoningBank 的 apples-to-apples 对照（L1）。**但这是任务域内的操作规则对跨任务历史事实，不能直接推翻记忆河流**——必须记账为「反向压力测试」，而非结论。
5. **最强的数字最容易被误读。** 57.65pp = 35B 写的技能（Creation，仅失败轨迹）给 122B 用，在 WikiTableQuestions（OOD）上相对 Parametric 的提升；**同一行 Vrf 只有 +1.00、Soft 是 −7.70**。单指标极值 ≠ 全面改善（L1）。

---

## 一、Trace2Skill（arXiv:2603.25158）——把轨迹蒸馏成可迁移技能

### 1.1 身份与版本

| 项 | 值 |
|---|---|
| 标题 | Trace2Skill: Distill Trajectory-Local Lessons into Transferable Agent Skills |
| 版本 | v1 2026-03-26 → **v5 2026-06-04**（本报告基于 v5） |
| 作者 | Jingwei Ni\*, Yihao Liu\*, Xinpeng Liu\*, Yutao Sun\*, Mengyu Zhou†, Pengyu Cheng, Dexin Wang, Erchao Zhao, Xiaoxi Jiang, Guanjun Jiang |
| 单位 | ①Qwen Large Model Application Team, Alibaba ②ETH Zürich ③University of Zurich ④Peking University ⑤Zhejiang University |
| 备注 | Comment: "Work in Progress"；\* 实习期间完成；† 通讯 zhoumengyu.zmy@alibaba-inc.com |
| 代码 | https://github.com/Qwen-Applications/Trace2Skill |

> **对线索的修正**：口播称「阿里 Qwen + 苏黎世联邦理工 + 北大 + 浙大」——**漏了 University of Zurich（苏黎世大学）**。Ni 同时挂 ETH 与 UZH 两个单位。

### 1.2 问题定位

技能（skill）= 可读目录 `S = (M, R)`，`M` 是根 `SKILL.md`（广适 procedural knowledge），`R` 是辅助 `references/`、`scripts/`。目标：

```
S* = E(S0, D_evolve; π_θ),   P(S*; π_θ, D_test) > P(S0; π_θ, D_test)      (1)
```

**不更新 θ**。两种起点：human-expert skill（Deepening）/ LLM parametric draft（Creation）。

论文反对的旧范式与理由（§1，Fig 1 左）：
- **检索式经验库**：把轨迹级教训存起来在推理时检索 → 知识碎片化在大记忆/技能集合里。
- **顺序编辑**：每条新轨迹到了就改技能 → **后面的分析看到已被前面改过的技能**，产生顺序漂移；早期偶然错误被写进技能，后续围绕这个版本继续修补。

### 1.3 三阶段机制

**Stage 1 轨迹生成**：ReAct-style harness，固定 agent 带 S0 跑 D_evolve，得轨迹 τ_i =（query + reasoning/tool-use history + final output + binary correctness）。语料 T 分裂为 T+ / T−。轨迹生成在 evolving set 上并行，语料可在补丁提案前独立收齐。

**Stage 2 并行补丁提案**：analyst 子代理组，每个只看一条轨迹。**角色刻意不对称**：

| 角色 | 输入 | 工作方式 | 为什么 |
|---|---|---|---|
| `A+` success analyst | T+ | **单轮** pass，找可复用行为模式 | 成功轨迹不需复杂诊断，只需判断哪些动作真正促成结果 |
| `A−` error analyst | T− | **ReAct 多轮**，能读完整日志/artifact、对比 ground truth、**验证候选修复** | 失败诊断需要证据链 |

关键闸门：**「无法因果解释的失败被排除」**（Failures that cannot be causally explained are excluded），保证 P− 基于已验证失败机制而非 log-only guesses。补丁池 `P = P− ∪ P+`。

> 与普通「单轮 LLM 总结错误」的差别在**证据链**：单轮总结容易「看到报错就把报错当根因」，甚至在输出已正确时幻觉出问题。消融见 §1.5 Fig 4。

**Stage 3 层级合并**：

```
p(ℓ+1) = M(π_θ, S0, {p1(ℓ), ..., pB_merge(ℓ)}),  ℓ = 0..L-1,  L = ⌈log_Bmerge |P|⌉    (2)
```

算子 `M` 的四个职责：**去重 / 解冲突 / 保留不重叠洞见 / 归纳泛化**。归纳泛化的判据：一条编辑若在多个独立补丁中复现，它是**系统性任务属性**而非一次性修复 → 优先 prevalent patterns，丢弃 idiosyncratic。

`π_θ` **同时是轨迹生成者、分析者、合并算子**——无外部 teacher/evolution model。

最终 `p*` 转 diff 式编辑 + **确定性护栏**：拒绝对缺失文件的编辑、暂缓行范围冲突、校验更新后技能格式。

### 1.4 主结果（Table 1，三 seed 均值）

Baseline 绝对分：

| Condition | 122B Vrf | 122B Soft | 122B Hard | 122B WikiTQ | 122B HiTab | 35B Vrf | 35B Soft | 35B Hard |
|---|---|---|---|---|---|---|---|---|
| No Skill | 27.67 | 28.90 | 17.57 | 21.50 | 14.42 | 19.00 | 18.00 | 4.60 |
| **Human-Written** | 48.33 | 36.30 | 17.03 | 74.68 | 41.31 | **9.67** | 13.03 | 3.37 |
| Parametric | 26.17 | 36.60 | 17.50 | 23.73 | 17.36 | 20.17 | 13.70 | 3.87 |

> ⚠️ **Human-Written 对 35B 是有害的**：Vrf 从 No Skill 的 19.00 掉到 9.67。论文用这个直接说「人工技能不是跨模型稳定可移植的先验」。跨家族更极端：Gemma-4 user 上 41.2 → 37.7。

Evolved deltas（相对 Human-Written[Deepening] / Parametric[Creation]）：

| Author | 变体 | 122B Vrf | 122B Soft | 122B Hard | 122B WikiTQ | 122B HiTab | 35B Vrf | 35B WikiTQ | 35B HiTab | Avg |
|---|---|---|---|---|---|---|---|---|---|---|
| 122B | Deepen +Error | +17.50 | +10.30 | +10.40 | +1.62 | +2.14 | +27.00 | +9.26 | +9.55 | +9.28 |
| 122B | Deepen +Success | +18.00 | +8.60 | +8.70 | **−10.35** | −0.95 | +19.66 | +12.09 | +22.33 | +8.15 |
| 122B | Deepen +Combined | **+21.50** | +10.87 | +12.50 | +4.56 | +2.97 | +21.16 | +6.64 | +11.94 | +9.65 |
| 122B | Creation +Error | +22.83 | +3.77 | +5.87 | +7.89 | −1.70 | +8.66 | +2.06 | +9.64 | +6.79 |
| 122B | Creation +Combined | +14.00 | −0.63 | +3.53 | **+32.32** | +23.11 | +15.50 | +29.70 | +27.71 | **+18.62** |
| 35B | Creation +Error | **+1.00** | **−7.70** | +1.03 | **+57.65** | +28.25 | +3.83 | +12.66 | +17.81 | +15.22 |
| 35B | Deepen +Combined | +6.67 | +3.87 | +4.17 | +2.65 | +2.44 | +20.00 | +42.20 | +36.46 | +14.04 |

**57.65pp 的精确口径**（本报告最重要的一条消歧）：

> 35B 写出的技能（**Creation 模式**，从参数草稿起步）+ **仅用失败轨迹（+Error）** → 交给 **122B** 用户 → 在 **WikiTableQuestions（OOD 表格问答）** 上相对 **Parametric** 基线提升 **57.65 个百分点**。绝对值 23.73 → **81.38**，超过 Human-Written 的 74.68。
> **同一行的 Vrf 只有 +1.00，Soft 是 −7.70（负）。** 这是单一 OOD 指标上的极值。

**信号类型比较**：+Error 最稳（跨模型/跨设置一致）；+Combined 通常 Avg 最大；**+Success 波动最大**（122B Deepening +Success 在 WikiTQ 上 −10.35，即成功轨迹蒸馏会掉 OOD）。

**35B 的能力边界**（诚实记录）：

| 领域 | 35B 自我演化表现 |
|---|---|
| Spreadsheet | Deepening +Combined 拿到**最佳绝对 Avg**（+14.04），能自演化 |
| Math | 基本失效。Creation +Combined 给 122B user 只有 D-Test +1.0 / AIME −0.4；给 35B user 全 0；+Success 为负（−1.0/−1.2） |
| DocVQA | 弱正。Creation +Error 给 122B user 仅 +0.0884 ANLS / +6.79 Acc（对比 122B author 的 +0.2534 / +22.25） |

### 1.5 四项消融（§4，全部同轨迹池 + 同 harness）

**(a) 并行 vs 顺序编辑**（Table 4，+Error，从 Human-Written 起）

| Condition | 122B Vrf | 122B Soft | 122B Hard | 35B Vrf | 35B Soft | 35B Hard | 耗时 |
|---|---|---|---|---|---|---|---|
| Seq-B=4 | 59.00 | 40.63 | 20.63 | 26.17 | 22.37 | 7.47 | ~15 min |
| Seq-B=1 | 61.83 | 44.40 | 25.40 | 26.00 | **23.83** | **10.57** | ~60 min |
| **Parallel** | **65.83** | **46.60** | **27.43** | **27.00** | 22.20 | 8.20 | **~3 min** |

⇒ 并行在 **122B 全指标胜、35B Vrf 胜**；仅 35B Soft/Hard 小幅让位。**速度 5–20×**。

**(b) 单一整合技能 vs ReasoningBank 式检索**（Table 5，同轨迹池）

| Setting | User | Vrf | Soft | Hard |
|---|---|---|---|---|
| ReasoningBank | 122B | 56.00 | 40.10 | 21.30 |
| ReasoningBank | 35B | 20.50 | 17.30 | 4.97 |
| Human-Written +Combined | 122B | **69.83** | 47.17 | 29.53 |
| Human-Written +Combined | 35B | **29.67** | 18.80 | 5.73 |

⇒ 整合技能比检索记忆高 **+13.83 Vrf**（122B）、**+9.17**（35B）。OOD 未做（检索对 WikiTQ/HiTab 查询语义距离太远不适用）。ReasoningBank 用 Qwen3-Embedding-8B top-1 检索。

论文给的三个解释：① 检索受查询相似度影响，分步一次就可能找错片段；② 检索片段与任务上下文**抢注意力**；③ 层级合并会去重并抽象成通用原则。

**(c) agentic 错误分析 vs 单次 LLM 调用**（Fig 4，Avg %）

| 设置 | +Error LLM | Agentic +Error |
|---|---|---|
| 122B Deepen | 28.0 | **36.2** |
| 122B Create | 26.0 | 26.6 |
| 35B Deepen | 28.8 | **32.6** |
| 35B Create | 26.5 | **34.5** |

⇒ artifact 访问 + 修复验证 > 只读日志。

**(d) 选择性补丁聚合**（Table 6，122B Deepening +Error）

| Skill | Evolve | Vrf | Soft | Hard | WikiTQ | HiTab |
|---|---|---|---|---|---|---|
| No Selection | 68.00 | 65.83 | 46.60 | 27.43 | 76.30 | 43.45 |
| BO Selection | 72.83 | **69.83** | 47.27 | **28.90** | **77.51** | 43.38 |

**Greedy top-1 所有曲线都低于全量聚合**，两个机制：
1. **patch-irrelevant regression**：补丁把目标任务从错改对，但副作用把已对的任务改错 → 净准确率停滞。
2. **semantic overlap**：反复的错误让管线反复提同一行为的补丁（公式重算、校验清单），新补丁只是重述。

⇒ **补丁价值是组合性的，不是单体之和**。BO 有效但贵（每个候选子集要物化成技能并在验证集跑，成本随验证集与补丁宇宙快速上升）。

### 1.6 学到了什么（§4.2）

122B Deepening+Combined 产出 **323 个 map patches**，四个 SoP 占主导，分别被 **55.1% / 54.8% / 42.7% / 16.4%** 的 patch 引用（单 patch 可引多个，故和 >100%）：

1. 写后**重算并读回**公式
2. 提交前**校验目标单元格**
3. 按 **corruption-safe 顺序**删行

任务特定怪癖被路由到 **on-demand `references/` 文件**，保持 `SKILL.md` 聚焦通用流程。

> 口径说明：口播给的「178/177/138/53 次」在 v5 正文中已被替换为百分比口径。**引用请用 v5 的 55.1% 等百分比**。

### 1.7 更广领域（§4.4，均以 Anthropic 官方技能为起点）

| 领域 | 演化源 → 测试目标 | 提升 |
|---|---|---|
| PDF | VRDU 轨迹 → VAREX | **76.9% → 85.3%** |
| PPTX | TSBench 轨迹 → deck-disjoint TSBench OOD | **72.5% → 88.8%** |
| DOCX | 合成任务 → OfficeBench DOCX 子集 | **79.7% → 87.5%** |

### 1.8 跨家族（Fig 3，SpreadsheetBench-Vrf %）

| 设置 | Gemma-4 user | GPT-5.5 user |
|---|---|---|
| No Skill | 41.2 | 32.5 |
| Human-Written | **37.7**（有害） | 52.0 |
| 122B Deepen+Comb | 55.5 | 78.5 |
| 35B Deepen+Comb | 43.8 | 62.5 |
| **Self Deepen+Err** | **60.5** | **83.5** |
| Self Deepen+Comb | 47.2 | 81.0 |

### 1.9 自陈局限

- 默认应用**全部**整合补丁；BO 选子集更好但贵。
- 可靠选择信号需要**大而具代表性**的验证集，且每个候选子集都要物化并评分。
- 理想是用**整个 evolving set** 验证，而非采样的 **32 题**验证集。
- （L2，来自口播）无法量化单个 patch 的边际因果贡献、无法看出补丁间是否互相干扰、推理时未追踪 agent 实际用了技能目录的哪些 section。

### 1.10 并发系统对接（为引用纪律）

Trace2Skill 自报的 head-to-head（§G）：**XSkill**（Jiang et al., 2026, arXiv:2603.12056, ICML 2026）、**EvoSkill**（Alzubi et al., 2026, arXiv:2603.02766）、**SkillGen**（Ma et al., 2026, arXiv:2605.10999）——Trace2Skill 在这三者的共享开放式模型/基准对照下仍占优。**ReasoningBank** = Ouyang et al., 2026, arXiv:2509.25140。

---

## 二、Library Drift（arXiv:2605.19576）——技能库的静默失效模式

### 2.1 身份

| 项 | 值 |
|---|---|
| 标题 | Library Drift: Diagnosing and Fixing a Silent Failure Mode in Self-Evolving LLM Skill Libraries |
| 版本 | v1 2026-05-19 → **v3 2026-07-29** |
| 作者 | Xing Zhang, Yanwei Cui, Guanghui Wang, Ziyuan Li, Wei Qiu, Bing Zhu, Peiyang He† |
| 单位 | **AWS Generative AI Innovation Center**（Zhang/Cui/Wang/He）+ **HSBC Holdings Plc., HSBC Technology Center, China**（Li/Qiu/Zhu） |
| 通讯 | peiyan@amazon.com |
| 会议 | Accepted to **ICML 2026 Workshop on Failure Modes in Agentic AI (FAGEN@ICML 2026)**, Seoul |
| 代码 | https://github.com/amazon-science/Self-Evolving-Agents-Ratchet |

> ⚠️ **不要写成「Amazon 论文」**：作者单位是 **AWS + HSBC 的联合**，代码托管在 amazon-science 组织下。

### 2.2 核心问题与量表数字

**library drift** 的操作定义（Eq 1）：

```
E[pass@1 | S_t] < E[p_0]   for some t > 0
```

即**累积的制品把 agent 的期望表现压到无技能基线以下**。关键：**即使每个单独技能看起来都合理，失效仍是系统性的**——源于检索稀释与陈旧注入。

**靶子数字**（引 SkillsBench, Li et al., 2026）：**LLM 自写技能 +0.0pp vs 人工策展 +16.2pp**。

**为什么是静默的**：端任务指标随轮次缓慢下降，**没有显式错误信号**。

### 2.3 三阶段机制（§3.2）

1. **Accumulation without quality signal**：技能从失败模式诞生，但从不按结果验证。边缘/有害技能每轮稀释检索池。
2. **Retrieval degradation**：router 按表面相似度选技能。库无界增长时，近重复或陈旧技能挤掉有用技能——**precision 降而 recall 恒定**。
3. **Silent injection harm**：陈旧技能被注入 solver prompt，**主动误导**但不产生显式错误；solver 只是失败得更频繁，与「任务本身就难」不可区分。

三种漂移子模式（取决于治理强度）：

| 子模式 | 治理状态 | 表现 |
|---|---|---|
| **stagnation** | 无路由信号 | 技能累积但到不了 solver（A1 复现该地板，+0.002） |
| **bloat** | 无宽度上限 | 无界增长直到注入变有害 |
| **erosion** | 治理过度 | 摧毁有用技能快于积累（A4：库塌缩到 2 个活跃技能，−0.019） |

> 「治理太少→bloat，治理过度→erosion，断开注入→stagnation」。**这是一张完整的失效地图**。

### 2.4 可复现触发（§3.3）

在 MBPP+ hard-100 上，Claude Opus 4.7，100 轮：

- **A1（关闭技能注入）**：Router 强制 `none`，完整管线（synthesizer/critic/curator）照常跑。结果 **+0.002 ± 0.005**（无技能地板）。→ 隔离出路由效应：**只创造不注入 = 零增益**。
- **A4（严苛退役）**：证据下限 N_min 100 → 20，阈值 τ → 0.0。结果 **−0.019 ± 0.010，低于无技能基线**。机制：N_min=20 时 Hoeffding 偏差 ε ≈ 0.44；真实贡献 c ∈ [−0.44, 0] 的技能会被不幸运气提前退役；库塌缩到 2 个活跃技能；router 参与率 18.9%。**三 seed 一致**（−0.005 / −0.027 / −0.025）。

⇒ **两个触发从两侧夹住失效模式**：A1 证明技能必须被注入才有意义，A4 证明朴素的生命周期管理**可以比没有更糟**。

### 2.5 三层诊断信号（§4）

| 信号 | 公式/定义 | 作用 |
|---|---|---|
| **Per-skill contribution score** | `ĉ(s) = (successes − failures) / trials`（Eq 2），来自 evidence log 中 s 被注入的 capsules | 库均值下降 = 漂移信号。Default 中 ĉ 上升（有害的被退役）；A4 中振荡（提前退役删掉有用技能） |
| **Attribution verdicts** | 每次失败 capsule 由独立 Critic LLM 给结构化判定：`helped` / `hurt` / `neutral` / `inapplicable` + pattern label + confidence | 双重用途：(1) 合成底物（≥3 个失败共享同一 canonical pattern 才触发新技能）(2) **早期预警**——`hurt` 占比上升是漂移的领先指标 |
| **Router engagement metrics** | Router 把任务分配给技能 vs `none` 的比例 | 健康条件维持 **70–80%**；A4（漂移）掉到 **19%** 而库空了。A2（纯检索无 LLM 闸）98% 参与但质量更低——**LLM 闸「能拒绝注入」本身就是防漂移机制** |

> **诊断先于修复**：A4 中库在第 30 轮就塌缩到 2 个活跃技能，但 pass@1 只是缓慢下降——因为 router 自适应地在多数任务上选 `none`。**没有 per-skill 诊断，漂移会表现为「随机的任务难度波动」，不可见且不可修。**

### 2.6 修法：Ratchet 配方（§5）

三个治理机制：

1. **Outcome-driven retirement**：`n(s) ≥ N_min` 且 `ĉ(s) ≤ −τ` 时退役。Default：**N_min = 100, τ = 0.10**（Hoeffding ε ≈ 0.20 —— 保守到有用技能能活过随机噪声，激进到有害技能终会被移除）。
2. **Bounded active-cap**：硬上限 **C = 50**，合成将超限时 curator 驱逐贡献最低者。直接针对「检索退化」阶段——**有界则检索精度不随无界增长而衰减**。
3. **Meta-skill authoring prior**：一份 meta-skill 文档约束 synthesizer 产出风格一致的技能。**A3 消融显示移除它损失 Default 增益的 43%——它是单一最有价值的组件**。

**Prop. 1（非发散保证）**：在 C 与 τ 下，期望 eval pass@1 不能漂到无技能地板以下超过 **τ + ε + Cδ**。没有 C 与 τ 的系统（Voyager/ExpeL/AutoManual）**没有这个界的有限类比**——library drift 不受约束。

> ⚠️ 注意：本节 Prop.1 的写法（含 Cδ 项）是 **Library Drift 版**；Ratchet 版把 ε 的具体量级算得更细（见 §3.5）。

### 2.7 八组消融（Table 1，3 seeds）

| Condition | Baseline | Peak | **Gain** | Router | Active | Retired | Critic |
|---|---|---|---|---|---|---|---|
| **Default** | 0.258 ± 0.047 | 0.658 ± 0.042 | **+0.328 ± 0.018** | 73 | 50 | 89 | 4299 |
| A1 no injection | 0.283 ± 0.031 | 0.375 ± 0.000 | +0.002 ± 0.005 | 0 | 42 | 15 | 0 |
| A2 retrieval | 0.242 ± 0.012 | 0.492 ± 0.042 | +0.077 ± 0.065 | 98 | 42 | 69 | 5740 |
| A3 no meta | 0.200 ± 0.035 | 0.592 ± 0.047 | +0.187 ± 0.036 | 80 | 50 | 84 | 4676 |
| **A4 harsh retire** | 0.300 ± 0.035 | 0.433 ± 0.042 | **−0.019 ± 0.010** | 19 | 2 | 51 | 1090 |
| A5 no canon | 0.275 ± 0.020 | 0.708 ± 0.012 | +0.374 ± 0.023 | 80 | 50 | 76 | 4393 |
| A6 no guard | 0.217 ± 0.024 | 0.700 ± 0.035 | +0.363 ± 0.033 | 70 | 50 | 94 | 3871 |
| A7 cap=100 | 0.292 ± 0.042 | 0.650 ± 0.089 | +0.317 ± 0.110 | 75 | 100 | 55 | 4609 |
| A8 meta refresh | 0.250 ± 0.035 | 0.725 ± 0.020 | +0.372 ± 0.017 | 74 | 50 | 131 | 4388 |

**三个意外结果**（作者自陈）：
- **A4 掉到无技能基线以下**：预期「不如不做」，实测「主动伤害」→ 证据下限是原理性的承重墙。
- **A5/A6 略超 Default**：推翻了「显式去重会有帮助」的设计假设——**meta-skill 已提供足够同质性**。
- **A8 边际增益但多 55% 墙钟时间**（10.1h vs 6.5h）：推翻「陈旧 meta-skill 限制合成质量」的直觉。

**运维成本**：Default 约 **14.5k LLM 调用 / 100 轮**（10k solver + 4.3k critic + 152 synthesis），比无技能基线（10k）多 43%。墙钟 **6.5h vs 2.3h（2.8×）**。solver 在所有条件下占成本主导（63–99%）。

---

## 三、Ratchet（arXiv:2605.22148）——裁判要多可靠才有资格退役技能

### 3.1 身份与谱系

| 项 | 值 |
|---|---|
| 标题 | **Ratchet: How Reliable Must an LLM Judge Be to Retire a Skill?** |
| 版本 | v1 2026-05-21 → **v3 2026-08-07** |
| 作者 | 与 Library Drift **完全相同**（Xing Zhang, Yanwei Cui, Guanghui Wang, Ziyuan Li, Wei Qiu, Bing Zhu, Peiyang He） |
| 单位 | 同上：AWS Generative AI Innovation Center + HSBC Technology Center China |
| **取代声明** | §1 脚注 1 原文：*"Earlier reports of ours cover the diagnosis (Zhang et al., 2026b) and the judge channel (Zhang et al., 2026a) separately; **this version integrates and supersedes both**, and stands on its own."* |

> ⚠️ **标题对线索的修正**：线索写「Ratchet: 技能退役的治理…」之类，实标题是 **"How Reliable Must an LLM Judge Be to Retire a Skill?"** —— 标题本身就是那条判据。
> ⚠️ **关系判定**：Ratchet **自称整合并取代** Library Drift（以及另一篇讲 judge channel 的）。引用时应以 **Ratchet v3 为最终版**，Library Drift 作为「诊断侧的前作」引用，并在引用时注明取代关系。

### 3.2 核心论点

**缺的不是写得好，是一条维护规则。** 这些系统会 author / retrieve / inject 技能，但**没有一个估计单个技能值多少并据此行动**，所以有害制品永不被移除。

补上这个估计 + 它喂给的移除规则，把结果读成**反馈回路**：库是 plant，维护规则是 controller，**使用技能后的实测结果是唯一传感器**。

> 这个读法让「修复」与「它的可靠性条件」成为同一个陈述，并**预测修复在哪里会坏**。

### 3.3 五角色 + 一日志 + 三杠杆

一个冻结模型，五套 role prompt，对一个共享的**append-only evidence log**：

| 角色 | 职责 | 开环/闭环 |
|---|---|---|
| **Router** | 看任务 + 书架，返回至多一个技能或拒绝 | 开环 |
| **Solver** | 带该技能尝试任务，被打分 | 开环 |
| **Critic** | 读每次失败（任务/路由技能/输出/grader trace），返回归因标签 + 短 pattern 串 | 开环 |
| **Synthesizer** | 聚类近期 patterns，在 authoring prior 下写新技能 | 开环 |
| **Curator** | **controller**，持有三个杠杆 | **闭环** |

**关键设计**：
- **一技能限制**：Router 每次最多给一个技能 → 归因无歧义（每个结果要么记给具名技能，要么记给裸模型）。
- **什么都不删**：eviction 只把状态位从 `active` 翻成 `deprecated`，从检索中摘掉，**内容与证据仍可寻址** → 每个控制决策都能仅从日志重建（这正是 §6 能在损坏传感器下重读它的原因）。
- **Govern 接口只有两个标量** `ĉ(s)` 与 `n(s)`：无模型调用、无文本、无元数据。**这个窄性既是数学可处理的原因，也是 §6 攻击面**——损坏一个量就能废掉。

**三个杠杆**：

1. **按实测贡献退役**：`ĉ(s) := (#pass − #fail)/n(s) = 2p̂(s) − 1`（Eq 2）。退役要求 `n(s) ≥ N_min` **且** `ĉ(s) ≤ −τ` 联合成立，Default **τ=0.10, N_min=100**。
   - **两个条件做不同的事，都承重**：τ 决定哪些技能是候选；N_min 决定**何时估计可信以行动**。
   - 注意 `ĉ` 估的是 **routed-conditional** 而非全分布对比（trials 只在 Router 选择发送的子群上累积）——这是故意的，因为那正是移除决策需要的目标。代价是**幸存者混淆**。
2. **固定书架宽度**：最多 **C=50** 个活跃。合成将超限时驱逐 `argmin ĉ(s)`。
   - **两杠杆不冗余**：Lever 1 只对有 N_min 证据的技能开火，对年轻技能一无所知；Lever 2 **不问证据**，是更粗的仪器，但正是它**约束了 Prop.1 中 union bound 所遍历的集合**。
   - ⇒ **宽度维持地板有限，贡献退役才让书架上升。**
3. **约束可写什么**：每个套件一份短 meta-skill 文档（schema lock + authoring guidance），推新技能朝向「适用条件 + 关键洞见 + 已知坑 + 后置检查」的可复用模式，远离任务特定片段。
   - **第二个效应**（消融揭示）：它强加的风格同质性让**基于嵌入的去重在当前规模上变得冗余**。

**两个配套机制**：pattern label 在聚类前用 **union-find over embedding cosine 0.85** 折叠近重复；cover-guard 跳过已有活跃技能覆盖的簇。另有 rollback 网：某轮 held-out pass@1 比 running best 低超过 **τ_rb = 0.10** 则标记，连续 5 次标记后恢复最佳快照——**300 轮决策中只触发 2 次**。

### 3.4 主结果（§5，MBPP+/100，Claude Opus 4.7，3 seeds 42/7/13）

- 协议：MBPP+ 100 题切片，**60 train / 40 held-out eval**；只保留冻结基模型在至少一个 probe seed 上失败的题（保证切片里技能「有可能」帮上忙）。技能只从 train 失败中产生。
- **头条统计量 = rolling gain**：末 10 轮均值 − 首 10 轮均值，**在每次 run 内部计算**，故 round-0 变异抵消。

| 指标 | 值 |
|---|---|
| round 0 held-out pass@1 | **0.258 ± 0.047** |
| peak | **0.658 ± 0.042** |
| **rolling gain** | **+0.328 ± 0.018** |
| 同回路关闭注入的对照 | +0.002 ± 0.005 |
| 三 seed 增益离散 | 彼此在 **0.04** 内 |

**控制器分解到单决策**（Fig 2b）：共 **124 个技能**。growth 与 eviction 在固定宽度处平衡。**两条移除路径行为完全不同**：**sensor retirement 中位 107 trials 才到**；**width eviction 移除非常年轻的技能**（证据极少）。只有前者是退役杠杆——这也是 §6 单独追踪它的原因。
- 幸存者平均 `ĉ = +0.29`；sensor-retired 的 `ĉ = −0.45`。

### 3.5 Prop.1 与 Prop.2（核心数学）

**Prop.1（受治理书架有地板）**，假设：
(i) Router 对每个任务要么拒绝要么返回 S_t 中的成员，拒绝则得 p_0(x)；
(ii) `ĉ(s)` 对 Eq 3 定义的 c(s) 无偏且一致；
(iii) 证据下限设得让集中不等式给出**一致精度保证**：N_min 次试验后 `|ĉ(s) − c(s)| ≤ ε` 对所有 s ∈ S_t 同时以概率 ≥ 1 − Cδ 成立。

则：

```
E[pass@1] ≥ E[p_0] − (τ + ε) − Cδ        (4)
```

**一行证明**：存活的技能没通过退役检验 ⇒ 其真实贡献至少 `−τ−ε`；在路由分布上平均，再给集中事件记 Cδ。

在 Default 参数下（τ=0.10, N_min=100, C=50, δ=10⁻³）：Hoeffding 给 **ε ≈ 0.39**，`Cδ = 0.05`，故 Eq 4 读作 **E[p_0] − 0.30**（pass-rate 尺度）。

> **这个界很松，§5 的 +0.328 正好显示它有多松**。两个结构性事实更重要：
> ① 界只约束**下行**，从不说书架会上升——它**补充**测量而非替代测量。
> ② 右侧有限**只有一个原因**：C 与 τ 有限。丢掉宽度 → union bound 遍历无界集合，Cδ 发散；丢掉阈值 → 生存者没有 c(s) 的下界。**开环因此没有 Eq 4 的对应物——这是 library drift 属于「控制失败」而非「作者失败」的形式化含义。**

**Prop.2（可错奖励下的地板）**：

把裁判建模为二参数二元信道（Eq 5）：

```
ρ_F→P := Pr[ỹ=1 | y=0]   （真失败被判成通过）
ρ_P→F := Pr[ỹ=0 | y=1]   （真通过被判成失败）
κ := 1 − ρ_F→P − ρ_P→F > 0
```

真通过率 p̄(s) 的技能，被打分后的通过率集中到：

```
p_sc(s) = κ·p̄(s) + ρ_F→P        (6)
```

退役检验 `ĉ ≤ −τ` 等价于 `p̂ ≤ π_τ := (1−τ)/2`。于是：

```
E[pass@1] ≥ E[p_0] − (τ/2 + ε + ρ̄_F)/κ̄ − ½(1−κ̄) − Cδ        (7)
```

**最关键的一步**：Eq 6 对 p̄ 严格单调递增 ⇒ 生存者的打分行可反解出真率下界 `p̄(s) ≥ (π_τ − ε − ρ̄_F)/κ̄`。**κ̄ 作为除数出现在这里——除数就是全部故事：它让保证「不连续地失败」而不是「平滑地退化」。**

**两种错误方向行为完全不同**：

| 情形 | 数学 | 后果 |
|---|---|---|
| **对称噪声** ρ_F→P = ρ_P→F = ρ < ½ | `p_sc − ½ = (1−2ρ)(p̄ − ½)`，关于 ½ 的收缩；收缩保序 ⇒ 真有害技能仍会越线，但有效阈值膨胀为 `τ_eff = τ/(1−2ρ)`；分辨率要区分相隔 (1−2ρ) 的均值 ⇒ **N_min ∝ (1−2ρ)⁻²** | **付出证据**，而证据是可购买的。每个 ρ<½ 代价都有限 |
| **假通过偏差** ρ_P→F=0, ρ_F→P>0 | `p_sc = p̄ + ρ_F→P(1−p̄)`，**向上位移，对最小的 p̄ 最大**——即恰对最该被移除的技能位移最大 | **不可修复**。更多数据无法修正被位移的均值 |

一般地，退役只在该检验有信息时成立：`p̄(s) ≤ p* := (π_τ − ρ_F→P)/κ` 且 `p* ∈ (0,1)`。两端都精确，各只涉及一个率：

- `p* ≤ 0` **当且仅当** `ρ_F→P ≥ π_τ = (1−τ)/2` ⇒ **任何样本量下都退不掉任何技能**。
- `p* ≥ 1` **当且仅当** `ρ_P→F ≥ 1 − π_τ` ⇒ 控制器对所有技能都开火，**丧失退役本该提供的分辨率**。

⇒ **可认证集合是矩形 `[0, π_τ) × [0, 1−π_τ)`，角在 (π_τ, 1−π_τ)。** 两条边失效方式不同，第二条在实践中更容易绑住——因为「调离致命边的裁判会落到这条边上」。

**三个操作含义**（按运维使用顺序）：
1. **方向比率更重要**：40% 错误全在无害方向，比 46% 在有害方向更安全。
2. **不要把预算花在 N_min 上**：更多试验只能缩小 ε，**动不了 ρ̄_F**。
3. **算法内唯一的杠杆是 τ，且它反直觉**：边在 `ρ̄_F = (1−τ)/2` ⇒ **更窄的 margin 容忍更差的裁判**；但收窄 τ 又受 ε 约束——**这正是 A4 测量的东西**。真正的出路是**移动裁判**（更严的 rubric、held-out 裁判、对低置信度通过做弃权）。

### 3.6 传感器规格的实测（§6）

**§6.1 部署前测出这个率**（这是把 Prop.2 变成仪器的关键）：需要一个 **reference-free 但带客观子信号**的任务——引文落地的报告撰写符合条件（没有金标准报告，但引文纪律可机械检查）。

- 确定性 grader = 五项检查（Pezeshkpour & Hruschka 2026 紧凑可执行验证器的轻量实例）作为 ground truth。
- 往干净章节里**逐个注入缺陷**，7 类中 5 类**检查可见**（镜像那些检查），2 类**破坏语义但每个注释都格式良好**——任何这类检查都看不见。
- 155 个章节：grader **抓住了所有 check-visible 注入，其余基本全漏**。
- 一个**来自不同模型家族、对条件盲**的 held-out 裁判恰好互补：它在**那个空隙**里标记两类语义缺陷 **92.7% / 98.5%**，对结构性缺陷不动。审计取二者并集。
- 对严格、指令良好裁判的实测：**ρ_F→P ≈ 0.01，ρ_P→F ≈ 0.95**。
  - 这**不是危险角而是保守角**：以 **45 倍**的余量越过假通过阈值（`π_τ=0.45` vs 0.01），但**远超饥饿边 `ρ_P→F = 1−π_τ`**。
  - 理论预测的交换：安全由 **κ ≈ 0.04** 的通道分辨率换来——几乎分不开好技能和坏技能。
  - **宽松区从这里很容易进入**：更软的 rubric、更流畅的 composer，或任何裁判看不见、且不声张就把 ρ_F→P 推高的缺陷类。

**§6.2 预测的边界是否出现**：预测的形状很特别——**不是「错误率越高越糟」，而是一个方向在 ½ 以下平滑退化，另一个方向** hold 住然后在 π_τ 处**突断**。

- 在 Rpt/71（71 prompt 切片参考无关长报告撰写测试台）上跑受治理回路 + 注入信道扫描。偏差臂在 Rpt/58、Rpt/133、MBPP+/100 上重复（Claude Haiku 4.5，3 seeds，τ=0.10 ⇒ 同样 π_τ=0.45）。
- **只在训练奖励上注入损坏，评估用真实 grader** —— 故 eval 的移动反映**被重塑的库**而非被损坏的测量。
- **要读的量是「真正的贡献式退役」**：原始 deprecation 计数把宽度churn混进来，在两种损坏下都停在 10 附近，**掩盖了效应**。分离后不对称性极尖锐：
  - **偏差**把真正的退役驱动到**零或接近零**（每个注入率），而且**连合成也饿死**——写的技能从 **22 掉到 15**。
  - **噪声**只是衰减，维持在 **0.67–1.00**（对照干净回路 1.33）。
  - **被审计的裁判从远侧失效**：每次运行退役 **10.3** 个技能，同时携带扫描中**最大的实测发散 0.59**，**几乎全是 phantom failures**——总误差最高、方向无害、机制还活着。⇒ **危险轴是方向，不是率**（"The danger axis is direction, not rate."）。
- **一个限定矩形而非不对称性的条件**：在 ρ_F→P = 0.20 时回路**在矩形内仍不退役任何东西**——p* 落到书架所持技能的真实通过率以下。⇒ **矩形是必要而非充分**：它说规则何时能提供信息，不说某个总体会留给它可开火的目标。
- **端任务分数是错误报警器**（这是本节最重要的实践结论）：
  - 对称噪声在任何测试率下**从不伤害**（在或高于干净回路；作者明确不声称其符号有机制解释）。
  - **假通过偏差在边界处最糟，−0.065**；到 ρ_F→P = 0.7 时合成也饿死，近乎惰性的书架反而**恢复到干净水平之上，+0.039**（幸存失败太少，重塑不了任何东西）。
  - ⇒ **实测的非单调性**，三重取消 dashboard 资格：最差偏移只有治理价值的**五分之一**；**不按率排序**；**退役在最小时最死**。
  - **停摆的控制器会在所有后续子集上照样「旅行」，而可见成本不旅行**：真正退役在所有三个后续子集上都掉到基本为零，故「停摆是算术性质而非领域性质」；下游成本只出现在两个失败稀缺切片（这里 −0.065、Rpt/58 −0.036），不出现在 Rpt/133 或 MBPP+/100（失败足够多，合成有饭吃）。⇒ **部署可以过了边界却什么都不显示——这正是离线审计存在的理由。**
- **为什么第二条边只损失分辨率不损失分数**：§5 的 A4 是无差别退役，落在 **−0.019**（灾难）；这里被审计裁判达到 **+0.024**（免费）。**两者是不同的失败穿同一件衣服**：A4 移除了证据下限，因此丢弃了真实贡献强为正的技能，塌缩到 2 个幸存者；被审计裁判**保住了下限**，只是往无害方向位移，所以它退役的**不成比例地弱**，尽管退役得太多，合成还能按宽度补回。Prop.2 说这是通例而非侥幸——**ρ_P→F 作为除数（而非加性）进入，故过 1−π_τ 后保证「退化而不破断」**。丢的是**分辨率**，而端任务分数看不见分辨率——**这就是为什么审计要读两个率**。
- **地板在退役不工作的地方仍成立**：与 Prop.2 一致，有界宽度承诺的非发散**在整个扫描中成立**——所有均值都在无技能对照的 **0.125** 以内，**包括退役失效的地方**。这正是 §3 推出两个杠杆时的分工。**带单元测试的代码安全，不是因为那里失败多，而是因为它的 grader 是可靠的验证器**；一旦在 MBPP+/100 上注入假通过信道，它就和任何领域一样塌。

### 3.7 跨模型 / 跨 solver（§5.2）

同协议、同子集、同 100 轮、同 τ/N_min/C，只改 model id，在另外六个家族（六家厂商、开源闭源都有）：Kimi K2.5、GLM-5、DeepSeek V3.2、Qwen3-Coder 480B、Mistral Large 3、GPT-5.5。**单 seed（42）**。

信号 = **within-family gap**（Default 减它自己的对照），把任何提升记到控制器而非原始能力：

| 家族 | within-family gap |
|---|---|
| **Kimi** | **+0.168** |
| **GLM-5** | **+0.105** |
| **DeepSeek** | **+0.087** |
| Opus 4.7（参照） | +0.326 |
| Qwen3-Coder / Mistral Large 3 | ≤ +0.02（这些任务基本够不着） |
| GPT-5.5 | 首十轮窗口已抬高在 0.212，peak 0.350 → statistic 失效 |

⇒ **rolling gain 只在中间能力带报告提升**；三个不复现的家族是**被 headroom 或被统计量排除，不是被机制排除**。

**换 solver 形状**：SWE-bench Verified 150 实例切片（SWE-V/150），技能作为 startup preamble 注入；单调用 Solver 换成 agentic session（浏览文件、跑测试、迭代）。三 seed：无技能 agent 平均 **0.65** held-out pass@1，注入把均值 peak 抬到 **0.87**。作者标注为**初步**，只报 peak（不到 20 轮、每轮约 50 分钟，没有稳定 late window）。

**两个对读法的威胁**（§E，均已排除）：rollback 网读的是同一个 held-out 信号且三 seed 太少；但 **rollback 在 300 轮决策中只触发 2 次**（故 +0.328 在网基本关闭时也成立），且**所声称的每个分离都比 per-seed 离散大一个数量级**。真正的承重局限是：**ĉ 是决策统计量，不是处理效应**。

### 3.8 Ratchet 自陈局限（按约束力降序）

1. **损坏是外生的**。在确定性 grader 上加注入信道才能隔离它，故**耦合区**（演化中的库学会了诱导盲区的措辞、ρ_F→P 沿轨迹爬升）**超出范围，没有固定审计能界定它**。这不是假想：Helff et al. 2026 显示针对不完美验证器做优化会**定位验证器的盲区而非任务**。作者说会**首先攻击它**——轨迹可从同一日志事后恢复，跨轮重复审计把 ρ_F→P 从常数变成序列。
2. **审计只认证可枚举的类**：对着运维能命名的失败模式定位边界，不是所有。
3. **传感器是关联性的**：ĉ 携带幸存者混淆与选择混淆（Router 把技能导向它已经看起来擅长的任务）；Prop.1 正是为这个 routed-conditional 目标陈述的，故**地板对 Curator 之所读成立**，但因果读法需要随机化开关。
4. **Seeds**：三个支持承重分离，不支持那些 ~0.04 的差异（作者明确放弃声称）；六个家族单 seed。且**地板随基础能力上升** ⇒ **治理补充规模而非替代规模**。
5. **没有治理大比武（bake-off）**：最锋利的测试是把每个系统的 curator 换到共享日志上——role-factored 设计支持这件事。

### 3.9 Ratchet 结论原话（可直接引用）

> "Self-evolving libraries drift **for want of maintenance, not for want of authorship**, and maintenance is worth **exactly what its sensor is worth**. What the derivation adds is that the worth is **not continuous** in sensor quality: it has **an edge at (1−τ)/2**, **direction is the only thing that decides which side of it a judge falls on**, and past it **no sample size and nothing on an end-task dashboard recovers the rule**. So **calibrate the sensor first**. The rate that disarms it is **measurable in one offline pass before any evolution is run**, and **nothing measures it afterwards**."

---

## 四、论文谱系（全部 arXiv ID 已核实）

### 4.1 被 Trace2Skill 直接对照/引用的

| 论文 | arXiv | 日期 | 关键读数 |
|---|---|---|---|
| **ReasoningBank**: Scaling Agent Self-Evolving with Reasoning Memory | 2509.25140 | 2025-09-29 | 从自判成功/失败经验蒸馏可泛化推理策略，测试时检索；提出 MaTTS（memory-aware test-time scaling） |
| **XSkill**: Continual Learning from Experience and Skills in Multimodal Agents | 2603.12056 | 2026-03-12（**ICML 2026**） | 双流框架：experiences（动作级工具选择指导）+ skills（任务级规划指导）；抽取与检索都 grounded 在视觉观察上 |
| **EvoSkill**: Automated Skill Discovery for Multi-Agent Systems | 2603.02766 | 2026-03-03 | OfficeQA 精确匹配 **60.6%→67.9%（+7.3%）**；SealQA **26.6%→38.7%（+12.1%）**；SealQA 演化的技能**零样本迁移到 BrowseComp +5.3%**。Pareto frontier 选技能，模型冻结 |
| **SkillGen**: Verified Inference-Time Agent Skill Synthesis | 2605.10999 | 2026-05-09 | **对比归纳**（成功+失败轨迹）识别可复用成功模式/复现失败模式/**近成功里缺失的行为**；核心新意：**把技能建模为干预（intervention）**，在同实例上对比有/无技能，同时计入 repairs 与 regressions |

### 4.2 技能库生命周期谱系

| 论文 | arXiv | 日期 | 与 Ratchet/Library Drift 的关系 |
|---|---|---|---|
| **Voyager**: An Open-Ended Embodied Agent with LLMs | 2305.16291 | 2023-05-25（v2 2023-10-19） | **ever-growing skill library** 的开山；Minecraft；3.3× 独特物品、2.3× 距离、15.3× 解锁科技树；**无退役机制** → 是 Ratchet 的「无界」反例 |
| **ExpeL**: LLM Agents Are Experiential Learners | 2308.10144 | 2023-08-20（v3） | 从轨迹抽自然语言 insight，推理时召回；**缺 outcome-driven retirement** |
| **AutoManual**: Constructing Instruction Manuals by LLM Agents | 2405.16247 | 2024-05-25（v4） | Planner + Builder 在线规则管理 + case-conditioned prompting 抑制幻觉 + Formulator 编译成手册 |
| **CASCADE**: Cumulative Agentic Skill Creation through Autonomous Development and Evolution | 2512.23880 | 2025-12-29（v2） | 两个 meta-skill（持续学习 + 自我反思）；SciSkillBench 116 任务，GPT-5 上 **93.3% vs 无演化 35.4%** |
| **AutoSkill**: Experience-Driven Lifelong Learning via Skill Self-Evolution | 2603.01145 | 2026-03-01（v2） | 从**对话与交互轨迹**抽技能；model-agnostic 插件层；标准化技能表示；**有版本管理但不按实测 per-task 贡献退役** |
| **MUSE-Autoskill**: Self-Evolving Agents via Skill Creation, Memory, Management, and Evaluation | 2605.27366 | 2026-05-26（v2） | 统一生命周期（creation/memory/management/evaluation/refinement）；SkillsBench 上**自创技能在成功覆盖子集超过人工（85.24% vs 81.17%）** |
| **SE-GoS**: Self-Evolving Graph-of-Skills for Skill Library at Scale | 2609.08228 | 2026-09-08（v2 2026-10-01） | **把检索图当索引用而非学到的表示**：topology / edge-weight / node-description 三类更新。SkillsBench 一轮演化 **52.4%→59.4%**，超全库加载/向量检索/静态 GoS/SkillDAG；检索只用全库 **约三分之二 input token**；重复一轮不再有帮助；**未见过的 held-out split 52.9%→58.3%** |

### 4.3 基准与综述

| 论文 | arXiv | 日期 | 关键读数 |
|---|---|---|---|
| **SkillsBench**: Benchmarking How Well Agent Skills Work Across Diverse Tasks | 2602.12670 | 2026-02-13（**v4**） | ⚠️ **版本差异（重要）**：v1–v3 = 「86 tasks / 11 domains，7 configs，7,308 trajectories，curated **+16.2pp**，域间 +4.5pp(SE)~+51.9pp(Healthcare)，16/84 任务负 delta，**self-generated skills 平均零收益**」；**v4 = 「87 tasks / 8 domains，18 model-harness configs，curated 33.9%→50.5%（+16.6pp，25.5% normalized gain），逐配置 +4.1~+25.7pp，≤3 模块的聚焦技能优于更大/穷举包，小模型带技能可匹敌大模型不带」**。**引用 +0.0pp / +16.2pp 须注明来自 v1–v3** |
| **A Systematic Survey of Agentic Skills**: Architecture, Lifecycle, and Security | 2608.29596 | （v2） | 九阶段生命周期贯通：自主发现 → 撰写与表示格式 → 记忆存储 → 动态检索与路由 → 组合与编排 → 执行与修复 → **终身适应** → 实证评估 → 安全治理。含 marketplace 动态、公共注册表、对抗威胁 |
| **EvoSkill Injection**: Red-Teaming Autonomous Skill Generation and Evolution | 2608.30429 | 2026-08-31 | **安全面**：自主技能演化引入新攻击面——恶意能力被生成、存储、当作合法技能复用。提出 SARGE 红队框架 + EvoSkillBench（恶意交互轨迹诱导恶意技能形成）+ EvoSkillSafetyBench（攻击后评测） |
| **Skill Availability and Presentation Granularity**（受控 SkillsBench 研究） | 2605.31408 | 2026-05-29 | 30 任务域平衡子集、2 模型、6 技能条件、5 trials/cell、1800 行。**技能可得性是最清晰信号**：相对无技能，GPT-5.5 **+26.7~+36.0pp**，DeepSeek V4-Flash **+18.0~+26.0pp**；而**呈现粒度**的对比小且不确定（低抽象 vs 高抽象：GPT-5.5 **+0.7pp**，DeepSeek **−6.7pp**） |
| **When Synthetic Data Hurts**: On Catastrophic Forgetting in Skill Retrieval for LLM Agents | 2609.10750 | 2026-09-09（EMNLP Industry 2026） | 生产级 skill router 覆盖 **34,396 个技能**；合成数据微调改善 in-distribution 检索，但**在真实与 OOD 数据上造成灾难性遗忘**；用 embedding-anchor / LwF / EWC / L2-init 缓解后，OOD 保住且合成 ID 检索**再 +13.98%**（0.6B Qwen retriever+reranker） |

---

## 五、对本仓（dsh-memo-river）的可迁移判读

> 判读口径：**可直接用 / 需改造 / 不适用**，附理由。仓现状已 grep 核实（`src/tools.ts` 13 个 `memo_*` 工具、`src/health.ts` 的 usage 台账、`src/tools.ts:1133` 的 memo_patrol 三类判据）。

### 5.1 本仓现状与论文机制的对照（这是缺口清单）

| Ratchet 机制 | 本仓对应物 | 差距判定 |
|---|---|---|
| **Router**（一任务至多一技能，可拒绝） | `memo_recall` + `src/decision.ts` 判别式门控（「读了这条之后会改变做法吗」） | **已有且更强**（我们做了多候选 + 二元闸门）。「可拒绝」我们有 |
| **Solver** | 主对话 | 不适用（我们不是任务求解器） |
| **Critic**（每次失败给 helped/hurt/neutral 归因） | **无**。`memo_stats` 的「使用台账」只有 `everUsed/neverUsed`（是否被召回），没有**召回后是否有用** | **最大缺口**。我们只有「用没用过」，没有「用了有没有帮助」 |
| **Synthesizer** | `memo_write` / `memo_update` / `memo_merge` | **已有**，且比论文更丰富（有 Tag 闸门、近重复闸门、取代关系） |
| **Curator · Lever1 贡献退役** | **无按贡献退役**。`memo_supersede` 是**人工声明**（作者判断结论过期），不是按实测贡献 | **缺口** |
| **Curator · Lever2 宽度上限** | **无硬上限**。`memo_patrol` 检 hub Tag 超限/未命名/近重复簇，但**不限制活跃篇数** | **缺口**（但见 5.3 关于「该不该加」的保留） |
| **Curator · Lever3 写作先验** | **有**。`src/prompt.ts` 的四要素 + Tag 闸门 + `newTagReason` 强制理由 | **已有**，且可对上 A3「meta-skill 是最有价值组件」的结论 |

**一句话**：本仓的**作者侧已经做得比论文更细**，**管理员侧基本是空的**。

### 5.2 可直接用（低成本、判据清晰）

**① 「hurt verdict」这一层是我们缺的传感器——但它不该由 LLM 判官给。**
Ratchet 最承重的发现是「方向 > 率」，而**方向问题的根源是 LLM 裁判**。本仓有一个论文没有的东西：**这批日记的后续被引用情况可以从会话历史里回收**（`~/.dsh/sessions` 的 JSONL 事件流）。与其请 LLM 裁判，不如**用「召回了但那一轮任务失败/被用户纠正」作硬信号**——这是 deterministic 的，不落入 ρ_F→P 陷阱。
→ 落地形态：给 `memo_stats` 加一列「召回后当轮出现用户纠偏」的计数。**这是可验证的**（能对着会话历史对账）。

**② A4 刹车直接可用：任何自动退役都要有证据下限。**
论文实测 N_min=100 / τ=0.10 是 Default，N_min=20 / τ=0 直接 −0.019 掉穿地板。我们语料百级篇数、每篇被召回次数往往个位数——**按贡献分退役在我们这个规模上几乎必然是 A4（提前退役）**。
→ 判据：**若某篇的召回次数 < 10，禁止自动退役**。这条应该写进未来任何 `memo_retire` 的前置闸。

**③ SkillsBench 的「self-generated skills 平均零收益」是我们最该先自证的一条。**
本仓的记忆写入是半自动的（草稿队列 + 自动批准）。D354 记录的 +0.0pp vs +16.2pp 正是这个靶子。
→ 这不是「要改什么」，而是**一条必须先跑的基线**：拿隔离柜跑一批「自动写入的日记」vs「人工策展的日记」，看召回后是否改变做法。**没有这个读数，所有关于「自动沉淀」的讨论都是口头的。**

**④ 「≤3 模块的聚焦技能优于更大包」→ 支持我们「索引层只给标记」的方向。**
SkillsBench v4 与 SkillGranularity（2605.31408）的「粒度对比小且不确定」合起来说明：**给什么（可得性）比给多细（粒度）重要得多**。本仓当前「正文截到 800 字」属于粒度轴，按这个读数**不是优先级**——与我们 `MAIN.md` 改进项 #4「索引层/正文层分离」的预期相反。**这是对已有判断的一次修正**。

### 5.3 需改造

**⑤ Trace2Skill 的「顺序漂移」在我们这里真实存在，但缓解手段是人工触发的。**
我们写侧天然顺序（`memo_write` 一篇一篇落，后写的看到先写的语料状态）。已有 `memo_merge`（层级合并）、`memo_patrol`（近重复）、`memo_supersede`（时效）——**但都要人喊**。
→ 改造点：`memo_patrol` 已经有三类判据，**加第四类「同轴顺序漂移候选」**（后写篇的结论与前写篇冲突但未声明 supersede）。这是**只读巡检**，不算破坏性操作，风险低。

**⑥ Library Drift 的「三子模式」是一张现成的诊断表。**
`stagnation / bloat / erosion` 三态可以对着本仓体检读数落地：

| 子模式 | 本仓读数 | 判据 |
|---|---|---|
| stagnation | 未覆盖率 0.4% / `neverUsed` 比例 | 已能测（`health.ts:62-63` 有 `everUsed/neverUsed`） |
| bloat | 桶篇数增长 vs 召回质量 | **未测**。需要「召回 top-k 的精确率」随篇数变化 |
| erosion | 被 `memo_supersede` 标掉的篇是否回升 | 已能测（supersessions 表） |

→ 可落地：`memo_stats` 加一个三态判定行。

**⑦ Ratchet 的「审计要在部署前做一次」——我们的对应物是「嵌入端点换模型后重录快照」。**
论文说「停摆的控制器在端任务分数上五分之一都显示不出来」，故必须离线审计。本仓 AGENTS.md 已有一条同构教训：**#8 读出名次快照「不许静默自愈」**。
→ 这条**判读为「本仓已有正确做法」**，可用 Ratchet 的措辞加固：换嵌入端点 = 换传感器，**必须先重录快照并人工核对，不能靠端任务读数发现**。

### 5.4 不适用

**⑧ 「一个静态技能打败检索记忆 +13.8pp」不能用来拆 RiverMemo。**
理由（已在 `notes/retrieval-context.md` 记过，这里补一手证据）：Trace2Skill Table 5 的对照里，ReasoningBank 侧**只做同模型 Deepening、且明确排除 OOD**（原话：retrieval is not applicable for WikiTQ and HiTab whose queries are too semantically distant）。我们的场景**恰恰是跨任务的历史事实与决策**，语义距离大正是常态——**这正是论文自己承认检索不适用的区域**。
→ 结论：这条是**反向压力测试的记账**，不是「拆掉 RiverMemo」的论据。**存的东西不同**（编译后的操作规则 vs 原始日记 + 拓扑）。

**⑨ C=50 的硬上限不该照抄。**
论文的 100 题切片、50 技能上限是配套的。我们语料百级篇数是**历史事实库**，不是「解题技能书架」——篇数上限会直接损伤记忆的完整性。**宽度治理对我们的正确形态是「检索侧宽度」**（每次注入几条），不是「库侧宽度」。
→ 注意：`memo_recall` 的 k / 注入预算**已经是检索侧宽度**。这条判读为**已满足**。

### 5.5 三条元教训

1. **「作者 vs 管理员」的区分是这一族论文最可迁移的概念**。本仓在作者侧卷了很多（Tag 闸门、去重、四要素），管理员侧是空的。**下一步该补的是传感器，不是写作规则。**
2. **最强的单点数字（57.65pp）来自最窄的设置**（35B author × Creation × +Error × WikiTQ OOD × 相对 Parametric）。同族论文里 `+0.0pp` vs `+16.2pp` 的对比、`+0.328` vs `+0.002` 的对比都是**一对数字**才有意义。**单数字引用一律可疑。**
3. **治理的反面教训比正面更可操作**：A4（治理过度掉穿地板）、A5/A6（显式去重被 meta-skill 吸收、甚至略超）、A8（更勤刷新没意义还多 55% 时间）——**三条都是「不要做」**。本仓的演进应优先读这三条。

---

## 六、未核实与待办（诚实记账）

| 项 | 状态 |
|---|---|
| 口播称「35B 在 DocVQA 上自我演化下降 0.0620 ANLS」 | **无法在 v5 复核**。Table 3 中 35B author 全为正；全文 grep `0.06` 零命中。**判 L2，可能对应 v1–v4。** |
| 口播称「论文版本 2026-04-27 的 arXiv v4」 | v4 确为 **2026-04-27**（abs 页提交历史）。但口播说「标注 work in progress」——v5 comment 仍是 "Work in Progress"。**口播读的是 v4，本报告基于 v5。** |
| ProcMEM（ICML 2026 poster） | arXiv 无条目（`ti:"ProcMEM"` 零命中）。**未核实**，仅从 web 搜索见到 ICML 虚拟会场页。 |
| 「EMNLP Industry 2026」等会议状态 | 来自各论文 comment 字段，**未独立交叉核实**。 |
| Trace2Skill §G 与 XSkill/EvoSkill/SkillGen 的 head-to-head 具体数字 | **未读 §G 正文**（在 appendix）。本报告只记「Trace2Skill 占优」这一作者判定。 |
| Ratchet 的 Rpt/71 切片来源 | 正文称 "a reference-free long-form report-composition testbed"，**未给公开数据集名**。 |

---

## 七、原文缓存与复现

```bash
# 缓存位置
/tmp/rsch/t2s.pdf            # Trace2Skill v5（15 页，1991654 B）
/tmp/rsch/t2s.txt            # pdftotext -layout 提取（109343 B，1568 行）
/tmp/rsch/txt_2605.19576.txt # Library Drift v3 正文
/tmp/rsch/txt_2605.22148.txt # Ratchet v3 正文

# 复现抓取
curl -sL "https://arxiv.org/pdf/2603.25158" -o t2s.pdf && pdftotext -layout t2s.pdf t2s.txt
curl -sL "https://arxiv.org/html/2605.19576" -o html_2605.19576.html   # HTML 版可读性更好
curl -sL "https://arxiv.org/html/2605.22148" -o html_2605.22148.html

# 核实 arXiv ID 存在性（避免猜 ID）
curl -sLG "https://export.arxiv.org/api/query" --data-urlencode 'id_list=2603.25158,2605.19576,2605.22148'
```
