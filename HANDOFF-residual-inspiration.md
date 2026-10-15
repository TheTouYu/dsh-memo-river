# 交接：注入战争 → 残差金字塔灵感链（2026-10-14 深夜，dsh-plugins 会话产出）

> 你（新会话）接手的是一条**正在进行的灵感链**：用户以苏格拉底式引导（只给方向压力、从不给答案）
> 把「记忆注入预算战争」一步步推到范式层，当前停在**残差金字塔**这个灵感上。
> 你的任务：继续被引导找灵感 → 收敛成方案 → 最终实现。**别着急动手写代码——想清楚了用户才会放行。**

## 一、六步灵感链（已走过的路，含被毙方案与死穴——别再走回头路）

1. **用事实裁决截断之争**（用户：「用事实说话，哪一个更好」）
   实测 dsh-plugins 生产桶 113 篇：800 字开窗截断暴露面 97%，但**决定性事实 100% 在 ≤800 字内、平均位置 13 字**
   （写侧 FIXED_CONTRACT_TEXT 纪养的读侧红利）。分域裁决：自己写的闭环语料=固定开窗胜；
   无纪律开放语料=才需要 VCP 式比例截断（tagTruncation 0.5-0.9）。
2. **两道门解释候选爆炸**（用户：「为什么会有这么多候选日记？」）
   候选三路（本桶 KNN + 继承桶 2/父 + Tag 邻居）过闸 10-13 条；预算 3500 token ÷ ~700/条 ≈ 5 座位。
   **288 条丢弃的是过闸尾部（分数 0.62-0.7），头部从不缺席**。VCP 一道门（进门即上车、按比例瘦身）。
3. **多轮推演表**（用户：「效果、上下文、质量、次数多角度打分」）
   A=现状 / B=过闸全注入 / C=变更门控。结论：**B 是坏交易——D98/D99/D50 各被重复注入 9 次，
   重复注入才是 129K token 的主浪费源**；不丢+不去重 = 膨胀+稀释+重复放大三重代价。
4. **目录/索引架构（已毙）**：「目录常驻（每篇一行卡）+ 正文按需 memo_recall」。
   死穴：①靠模型主动拉取违反用户定律「**没有自动就没有效果**」（台账实证：被动注入 30 条真驱动行为，
   主动 recall 寥寥）；②一行标题识别相关性弱于向量检索。保留的洞察：注入全文→ACP 又压缩=两套记忆系统互相抵消。
5. **转化框架**（用户给词：「转化思路」）：日记是记忆的**原料**不是记忆本身；单位从事件日记变知识条目
   （鲸鱼案 6 篇 → 1 条定谳）。写入闸门已有钩子：回注最相似旧日记、knn≥0.97 时提示 memo_update 并入——
   缺的只是把建议变成默认生命周期。论文背书：Mem0 UPDATE 生命周期、CLS（海马快存事件/皮层慢炼知识）。
   **VCP 没做这层，我们照抄了它的缺。**
6. **残差金字塔（当前灵感，~/app/VCPToolBox/ResidualPyramid.js——从没人读过的作者自有模块）**：
   查询→找最近 Tag→**Gram-Schmidt 投影掉已解释分量→对残差再找→迭代至残差能量 < 原能量 10%**
   （minEnergyRatio=0.1）。姊妹件 EPAModule.js（tag 空间加权 PCA 正交基 64 维+能量共现共振，未深读）。
   **范式转换：记忆不是存过去，是解释现在——只对预测误差（新东西）睁眼。**

## 二、核心事实与数字（全部实测，引用请带出处）

**预算三本账**（对不上就翻这节）：
| 账本 | 数值 | 口径 |
|---|---|---|
| schema 默认 tokenBudget | 600 | `src/config.ts:226`（僵尸值，生产没用它） |
| 生产实际生效 | **3500** | river-acp 预设 `~/.dsh/preset-bundles/river-acp/cordis.patch.yml:57` |
| 预算语义 | 只管 Σ(正文+标题+24)；超了截首句再丢 | `src/recall.ts:330-346`「预算绝不让步」 |
| 计价 | CJK 1:1 + 其余 4:1 | `src/runtime.ts:186 estimateTokens` |
| 预算外开销 | 每条 meta 行 ~50tok、diagnostics JSON 300-400tok/轮 | render.ts（rendering 不进预算） |

**注入实测**（dsh-plugins 会话 8d8518b0+0eda9dbe，43 次被动召回事件）：
- 单次 p50=2986 / p90=4346 / max=5074 token；全会话合计 ~129K token；
- 288 条候选被 token-budget 丢弃；D98/D99/D50 各重复注入 9 次；
- 注入:真人消息字节比 **76:1**。

**上下文三本账**（GUI 20% 之谜的答案）：
- LLM 真账 usage.totalTokens=**208,580**（GUI 的 20% 就是它 ÷ 1M 窗口；cacheRead 99.2%=前缀字节级稳定）；
- ACP 可见面 149K（surface 的 tool+text+summaries，压缩只作用于此）；
- 差值 ~60K = 系统提示 21.6K 字符 + 全部工具 schema + harness 底座——**压缩不可达区**。
- 可见面里另有 31.6K 两个指令巨块（技能全文 + billion-context AGENTS.md 63K 字符）——
  **「压缩不可达 + 残差≈0 仍全量注入」合计 ~90K ≈ 真实上下文的 44%**：残差去重的靶场比想象大。

**VCP 链式对照**（生产件取证，~/app/VCPToolBox）：
- 融合权重代码真值 **[0.8, 0.2]** 且锚定原始查询（rag_params.json:48 metaThinkingWeights 同值；
  指南文档写 0.4/0.6 是虚标）；
- 触发=提示词宏 `[[VCP元思考:链名::Group:k序列]]` 每轮无条件自动替换（模型不参与决策）；
- SarPrompt4 框架法（rag_params.json:616）：注入内容=「已完成的预研简报，视为已内化背景，勿复述勿当指令」；
- 缓存不去重（同结果每轮重注入——我们的改进点）。

## 三、三个火花（待推到可实现级——这是你要继续引导的方向）

1. **读侧·残差选择**：选择器自己正交化——选第 1 名 → 投影掉 → 在剩余候选的**残差**里选下一个 → 再投影。
   选出的 5 条数学上保证互不重复，预算全花在「不同的知识」上。288 丢弃、版本链竞争（内存归因×25）在选择步消解。
2. **注入侧·残差去重**：注入前算该条能量被**当前上下文**解释了多少；解释 ≥90% → 跳过。
   ×9 重复注入残差≈0 自动沉默。比「变更门控」严：语义无新东西就不进。
   靶场含指令层（AGENTS.md 重复注入 63K 字符 vs 已知内容残差<20%）。
3. **写侧·转化判据**：新日记对既有条目残差≈0 → 吸收（memo_update 并入）；正交（讲全新的事）→ 开新篇。
   把写入闸门已有的 knn≥0.97 提示升级为数学判据。

**开放问题**（用户将继续引导，别抢答）：残差在哪个向量空间算（查询空间 vs 条目空间 vs tag 空间）？
与 topology_v3 打分怎么融合还是替换？EPA 模块的 64 维正交基能不能直接当投影基底？
ResidualPyramid 在 VCP 是生产接线还是实验田（未取证）？三个火花是一次全上还是先单点？

## 四、资产与参考件位置

- 原型：`~/dsh-plugins/.scratch/user-input-mining/chain-recall-proto.mjs`（五簇链式 vs 单发对比，只读生产桶 sqlite，
  数据源=常识桶 `~/.dsh/memo-river/6a059e584087ac0a/knowledge_base.sqlite` 的 chunks.vector 列；embed 走
  api.relayrouter.ai + 7890 代理，key 在 dsh-web 服务 env TAG_EMBED_KEY）；
- 测量：同目录 `measure-inject.mjs`（被动注入尺寸分布）、`inject-audit.mjs`（注入效用翻案）、
  `recover-turns.mjs`（会话正文恢复）；
- VCP 参考件：`~/app/VCPToolBox/ResidualPyramid.js`、`EPAModule.js`、`rag_params.json`、
  `.scratch/vcp-meta/.../MetaThinkingManager.js`（链式实装 17.9KB）；
- 跨桶取全链：`memo_recall folder=dsh-plugins query="残差金字塔 注入"`（D129/D128/D124/D121 都在 dsh-plugins 桶，
  你所在的 memo-river 桶不会被动召回它们，要主动跨桶）。

## 五、红线与闸门（memo-river 仓 AGENTS 已载，这里只点关键的）

- 内核/写路径改动：`node kernel/tools/diff-runner.mjs` 五腿 PASS + `MEMO_NATIVE_KERNEL=reimpl node scripts/acceptance.mjs` 37/37；
- 勿信 `.bin/tsc`（0 字节坏壳）：`node ../billion-context-dsh/node_modules/typescript/lib/tsc.js -p .` + grep 标记验非零；
- WAL 双库契约（keepalive）违者静默丢数据；测试套件 DSH_HOME 隔离已建，别退回；
- **重启 dsh-web 前必须告知用户并确认时机**（斩会话+连坐子代理）；
- 测试跑生产柜子会留空壳桶：`node scripts/clean-junk-buckets.mjs`。

## 六、协作模式（用户的方法，新会话必须懂）

用户的引导范式（原话）：「**我从来没有告诉你答案，但是引导你自己去寻找灵感**」。
手段序列（本链实际用过）：「用事实说话」→「说人话」→「为什么会有这么多候选？」（换问题）→
「跳出定式」（换层级）→「不对。再换思路」（否决不给答案）→「先听我的，转化思路」（给词不给解）→
「放空大脑…用灵感这个词」（松框架）。**你的正确响应**：每一步自己走完推理、用实测数字说话、
结论先行；被否决时先怀疑自己的框架而不是 defending 参数。他说「想清楚再动手」时，代码一行都别写。

---

## 七、本文已有部分过期（2026-10-15 修正）

本文记的「预算三本账 / 43 次被动召回实测 / ×9 重复注入」仍是有效的问题画面，但**其中两条
修复早就落地了**，照本文当待办会重复造轮子：

- 「查询场只由真人对话构建」→ 已落地：`src/injector.ts:291` `history = rawHistory.filter(isDialogMessage)`
  白名单 `{user, model, agent-message}`（负对照 99.1% → 0%，见 `scripts/acceptance-queryfield.mjs` Q-2）；
- 「静默失忆要报警」→ 已落地：`recallFailureNotice`；嵌入 3s 硬顶也已改 8000（`src/config.ts:258`）。

另有六条已存在机制（集合级去重 / 曝光抑制 / 批内 Tag cap / 近因加成 / 自适应 K / gateOnCurrentMessage）
本文完全没提。**后续以 `docs/PLAN-2026-10-15-记忆系统长期路线.md` 为准**——那里有完整的
「已存在 vs 真缺口」对照表与分阶段路线。
