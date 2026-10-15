# 第二轮：中文 / 速度 / 性能

续第一轮 `/tmp/investigation-decision-models.md`。信源分级：[A]=论文/官方一手，[B]=可复核第三方代码+数据，[C]=社区博客，[D]=媒体报道。本轮所有关键数字均带 URL。

## 一句话结论

**中文这条路通了，但通的不是 StartLux**：StartLux 官方零中文训练/评测披露；而第三方 `chinese-decision`（Qwen3.5-0.8B+LoRA，权重已发布，MIT）在中文 CJ-Bench 上通用 72.24% **超过**闭源 Jev（68.35%）与复旦/NUS 的 Chinese-Jev（69.20%），单模型专业域 76.98% ≈ Jev 77.01%，未校准 ECE 1.07%——**这才是我们 3060 门控器的首选候选**。

---

## ① 中文（一票否决项的答案）

### StartLux-Decision：官方没有中文证据 [A]
- 技术报告 arXiv:2610.17309 全文（已下载 /tmp/startlux-paper.txt）关键词统计：`Chinese` ×1（即 CJ-Bench 一处）、`multilingual`/`CJK`/`tokenizer`/`Qwen` 均 ×0。**无中文训练数据披露、无 tokenizer 适配披露、无中文能力评测表**。
- 唯一涉中实验：附录 C.3 路由/校准，StartLux-Decision-4B think-gate 在 CJ-Bench 上 α=0.05，10%/20% think rate 下 reasoning-route error 27.9%/27.3%；policy-specific 阈值下 system error 4.6%、0 route 接受。这是**错误率口径的间接实验，不是中文能力分数**（https://arxiv.org/abs/2610.17309）。
- 中文社区实测：CSDN 小毕超 2026-10-11 部署帖（[C]，https://xiaobichao.blog.csdn.net/article/details/167171875）用 4B 跑通了**中文 state/questions 工单分流示例**（截图有返回结果），但**零准确率数字**；ModelScope 有镜像（StartLuxAI org）。知乎/公众号**未找到任何带实测数字的帖子**。36kr「Jev 跌下王座」（https://eu.36kr.com/zh/p/4009510615027849）、钛媒体「38 项基准中 31 项高于 Jev」（https://www.tmtpost.com/8158976.html）均为 [D] 媒体转述官方口径。
- **判定：StartLux 中文能力=未知（无证据），不能作为中文门控的依据。**

### Jev 中文：有第三方实测，且不算强 [A/B]
- 复旦+NUS（Shuicheng Yan 组）**Chinese-Jev** 论文 arXiv:2609.36965（2026-09-29，https://arxiv.org/abs/2609.36965，项目页 https://gulucaptain.github.io/Chinese-Jev/）：论文开篇即说「existing Jev models exhibit limited Chinese-language decision accuracy」。
- 论文实测（第三方口径 [A]）闭源 Jev 托管 API 在 **CJ-Bench**（307,900 条 held-out 中文决策：通用 100K / 医疗 200K / 法律 4.3K / 金融 3.6K）：
  - 通用 68.35% ACC / ECE 11.45% / 284ms（含网络）
  - 专业域均值 77.01%（医疗 84.29 / 法律 68.35 / 金融 78.39）/ ECE 5.57%
- Chinese-Jev 本体：322M encoder-only（mmBERT-base 类），通用 1000 万条中文决策训练，通用 69.20% / ECE 3.78% / 14ms@H200；手机 INT8 ~1s/条。**权重「planned for open release」——尚未发布**，代码 Apache-2.0（https://github.com/gulucaptain/Chinese-Jev），数据集 HF bbldCVer-hf/CJ-Dataset（需申请）/CJ-Bench。

### 本轮最大发现：chinese-decision（社区第三方复现，权重已发布）[B]
- 仓库 https://github.com/yanqiangmiffy/chinese-decision（2026-10-14 建，MIT，17 star），权重 **HF `quincyqiang/chinese-decision-0.8b`**（2026-10-15 上传，BF16 safetensors + decision_config.json 温度 T=1.108，含 GGUF 转换与 CPU 服务流程）。
- 方法：Qwen3.5-0.8B + LoRA（改编自 n4ze3m/hmm），1,304.8 万条 CJ-Dataset 混合训练单模型；读末位候选字母 logits 一次前向出概率，零 token 生成。
- CJ-Bench（与论文同口径，全量 307,900 条，未校准 T=1）：

| 模型 | 通用 ACC | 专业均值 ACC | 整体 ECE | 延迟 |
|---|---:|---:|---:|---:|
| Jev（API）| 68.35 | **77.01** | 5.57(专业) | 284ms(含网) |
| Chinese-Jev G/S | 69.20 | 70.82 | 12.08(专业) | 14ms@H200 |
| **chinese-decision-0.8b** | **72.24** | 76.98 | **1.07(整体)** | 70ms@A800 |

  - 分题型：noul（是非）**94.95%** / choice 78.33% / score 56.47%——**我们门控要的正是 noul 型判断，恰好是最强档**。
  - 微调前后对照（验证集 1,200 条）：Qwen3.5-0.8B 裸模型整体 34.56% → 微调后 73.49%。
  - 局限：单一作者项目、发布 2 天、HF 下载量 4；评测基线数字直接引 Chinese-Jev 论文（本项目未复现 Jev）；CJ-Dataset 需申请。
- **对我们的意义：中文门控不必赌 StartLux 的中文能力，直接用 chinese-decision-0.8b（Qwen3.5 底座，中文原生 tokenizer），或照它的管线用 CJ-Dataset 自训。**

### Intern-Decision 中文 [A-]
- 上海 AI Lab，Qwen3.5 底座（中文原生），README（https://github.com/InternLM/Intern-Decision）双语，但**七套准确率基准与校准基准全是英文口径，无任何中文评测数字**。底座决定它中文不会差，但没有可引用的数字。另注意其准确率口径（七套 Jevbench 系，自评 4B 90.02% vs Jev 88.74%）与 DI 不可比。
- `rev-decision`/`decision-jef`：未找到中文评测证据。

---

## ② 速度（落到 RTX 3060 Laptop 6GB，实余 ~2.8GB 显存）

### 官方精确数字 [A]
- **GGUF 文件大小（HF API 实查）**：2B Q4_K_M = **1,274,396,256 B（1.19GiB）**、2B Q8_0 = 2,012,012,128 B（1.87GiB）、mmproj-F16 = 668MB（纯文本门控不需要视觉塔）。修正第一轮「2B Q4≈1.4GB」估算。0.8B Q4_K_M ≈ 0.5–0.6GB（按比例推算，未逐一实查）。
- **H200/vLLM BF16（Table 5/6，1,024-token DI 请求中位）**：0.8B 24.8ms / 2B 24.6ms / 4B 27.4ms / 27B 51.9ms；Jev-27B 第三方 46.8ms。注意 0.8B≈2B≈4B——**该档位是 kernel 启动开销主导，不能线性外推到消费卡**。
- **消费级锚点（Table 8，Apple M5 Pro 64GB / MLX，中位单读出）**：

| 精度 | 长度 | 0.8B | 2B | 4B |
|---|---:|---:|---:|---:|
| 4-bit | 1,024 | 64ms | 144ms | 571ms |
| 4-bit | 4,096 | 488ms | 851ms | 2,547ms |
| 4-bit | 8,192 | 1,067ms | 1,992ms | 5,571ms |

  这是唯一接近我们场景的官方本地数据。**官方没有 3060 级 NVIDIA 卡的数据**（只有 H200/A800/M5）。
- **量化损失（Table 9，DecisionPivot chance-corrected，Q4_K_M vs Q8_0）**：0.8B 9.7→8.7、2B 23.7→21.9、4B-I 46.2→43.7；**DI 0.3 的 Q4 数字官方未给**（只报了 BF16/FP8/Q8，Q8≈无损）。结论：Q8 优先，Q4 在小模型上有实打实的额外损失。

### 3060 上的可推算延迟（估算，非实测——本机显存被嵌入服务占用，未跑）
- 依据：M5 Pro 内存带宽 ~546GB/s vs 3060 Laptop ~336GB/s（≈0.6×），预填充为算力/带宽混合瓶颈，取 1.5–2.5× 惩罚系数。
- **单次读出（Q4_K_M）估算**：0.8B @500tok ≈ **60–120ms**、@1K ≈ 100–200ms、@3K ≈ 0.4–0.8s；2B @500tok ≈ 150–250ms、@1K ≈ 250–450ms、@3K ≈ 1–1.8s。
- **显存可行**：0.8B Q4（~0.55GB）+ 16K KV（数百 MB）在 2.8GB 内宽裕；2B Q4（1.27GB）+ KV 紧但可行；4B Q4（~2.7GB）排除。
- **k=8、state≈3K token 的单轮总延迟（Instant 档，每问重读 state）**：0.8B ≈ **3–7s**、2B ≈ **8–15s**。**这在「每轮注入前门控」场景不可接受**。缓解：
  1. **压缩 state**：门控不需要完整对话历史，state=当前任务一句话 + 候选记忆摘要，≈400–800tok ⇒ k=8 总延迟 0.8B ≈ **0.5–1s**、可接受；
  2. 候选记忆本身短（title+首句），长度主导项是任务侧 state；
  3. 官方 llama.cpp 路线存在（b11549 验证过），但 3060 上逐问重复 prefill 是结构性开销，无法靠量化消除。
- **AutoThink vs Instant**：AutoThink 需先生成推理 token（27B 官方 A800 上 27 tok/s，9B 默认阈值下平均 596 token/例 ⇒ 单例数十秒级）；收益集中在计算密集任务（4B：GSM8K +26、CRUXEval +22、GPQA +10、MMLU-Pro +11），**DI 0.3 整体只 +0.5**。对我们（短文本是非/重叠判断）：**Instant 足够，AutoThink 既放不进显存也不值得**。

---

## ③ 性能（分领域，DI 0.3 公开子集，Table 4 + Table D.1，团队自测 [A]）

### 全尺寸分领域（Instant；★=官方训练用过该基准的训练split，见④污染表）

| 域（权重） | 0.8B | 2B | 4B | 4B-AT | Jev hosted |
|---|---:|---:|---:|---:|---:|
| **Retrieval & Classification（20%）** | 66.32 | 69.65 | 73.13 | 71.12 | 55.42 |
| **Tools & Automation（18.3%）** | 74.61 | 78.62 | 86.44 | 83.98 | 75.09 |
| Knowledge & Reasoning（25.8%） | 28.45 | 36.03 | 50.49 | 57.48 | 53.87 |
| Language Understanding（25.8%） | 55.63 | 62.44 | 71.09 | 69.84 | 59.23 |
| Arts & Human Taste（10%） | 51.00 | 53.65 | 60.11 | 57.07 | 39.08 |
| **总 DI 0.3** | 53.75 | 59.14 | 67.88 | 68.21 | 57.96 |

**关键读数：**
- 我们关心的两个域里 **0.8B/2B 都大幅碾压 Jev**：R&C 域 0.8B 已 +10.9、2B +14.2、HoVer（事实核查）2B 75.7 vs Jev 45.7、RAGTruth（检索真实性）2B 60.8 vs 51.3、BRIGHT（检索）2B 32.8 vs 40.6（唯一反例）。
- 最弱域确认：K&R 0.8B 28.45 / 2B 36.03，被 Jev 反超 17.4/25.5 分；GPQA 0.8B 仅 6.8、CRUXEval 2B 5.6。**小模型完全不能问「推理/知识」型问题**。
- 消融（5.1）：任务族数据收益局限在已代表族（+8.6）vs 未覆盖族（+0.3）；**双向注意力在未覆盖族 +3.0**；程序性决策数据 61.5→75.8%。⇒ 训练分布外泛化主要靠注意力设计，这是 StartLux 相对裸 Qwen 的真实增量。
- 校准（对我们重要）：概率即接口，官方带 checkpoint 级温度；C.3 显示 policy-aware 校准在路由场景有效。

### 「该不该注入这条记忆」怎么问（浅问法候选，落在 R&C 强域）
把「会不会改变推理结果」（K&R 域，小模型最弱）改写成 R&C/T&A 域的浅判断，全部可编译为 noul/choice：
1. **重叠度**（noul）：「这条记忆与当前任务的内容是否直接相关？」——语义匹配/检索类，R&C 域（CJ-Bench 里中文 semantic matching 类 noul 94.95%）。
2. **新旧性**（score/choice）：「相对当前上下文，这条信息是【已知/新信息/过时】？」——分类任务，R&C 域。
3. **冲突检测**（noul）：「这条记忆与当前上下文中的事实是否有冲突？」——RAGTruth/HoVer 风格核查，正是 StartLux/Jev 分差最大的子项（HoVer +30）。
4. **时效**（noul）：「这条记忆的结论现在是否仍成立？」——略偏 K&R，风险档。
5. 风险问法（避免）：「注入这条记忆会改变回答吗?」「哪个答案正确?」——纯 K&R，0.8B/2B 会给出近乎随机的概率。
命中强域可能性：**高**——1/2/3 都是 R&C 域原生题型，且中英两边（DI 的 R&C 域、CJ-Bench 的匹配/是非类）都有强证据。

---

## ④ 「StartLux 效果比 Jev 好」证据链核实

| 环节 | 事实 | 口径 |
|---|---|---|
| 谁测的 | **StartLux 团队自测**，Table 4/6/D.1 | DI 0.3 **公开子集只占榜单 20%**；榜单是社区非官方榜（HF 员工个人维护） |
| 分差 | 总分：4B 67.88 / 9B 69.96 / 27B 72.83 vs Jev 57.96；38 基准中 31 项更高（tmtpost 转述官方） | chance-corrected 指数，非准确率 |
| 训练污染 | **Table A.2：18 项基准的官方训练 split 进了 Stage 2**（第一轮口径 14/38 修正为 18 项 T 标，含 BANKING77/CLINC150/HoVer/GSM8K/WinoGrande/HellaSwag 等；另有 R 标相关公开数据：API-Bank/BFCL/GPQA(layout)/MMLU-Pro）。官方声明评测 item 未进训练、并做了去污染筛查（A.6），但**训练/评测同分布不可避免** | 官方披露 [A] |
| 扣污染后仍站得住的 | R&C 域内未 T 标的 BRIGHT（2B 32.8 vs Jev 40.6，**反而输**）、PhishNChips（2B 77.9 vs 58.7，赢）、Amazon ESCI（50.5 vs 50.3，平）；T&A 域无 T 标的 ToolRet（60.6 vs 59.9，平）。**干净基准上分差缩水到 ±个位数，不存在 31/38 式碾压** | 推算 |
| 独立复现 | **英文：未找到**（第一轮结论维持）。**中文：无任何 StartLux 数字**；反倒是第三方（Chinese-Jev 论文 + chinese-decision）只测了 Jev 没测 StartLux | [B] |
| 打脸数据 | K&R 域 0.8B/2B 比 Jev 低 17–25 分；GPQA 27B-I 35.4 vs Jev 71.4；干净检索基准 BRIGHT 2B 输 Jev | [A] |
| **判定** | 「**≥4B 的 StartLux 在英文 DI 公开子集（团队自测）上比 Jev 好**」成立；「0.8B/2B 比 Jev 好」**总分成立但 K&R 域不成立**；「中文比 Jev 好」**无任何证据**。我们的场景（中文+小模型+R&C 浅问法）真正该选的是 **chinese-decision-0.8b**（中文实测超 Jev 3.89 分，[B] 可复核）或 Intern-Decision（无中文数字但底座中文原生、延迟数字好） | |

---

## 与第一轮结论的冲突修正
1. 「StartLux 是唯一完整开源的一支」→ 修正：**中文赛道 chinese-decision-0.8b 已开源（MIT+权重），且是唯一有中文实测数字超 Jev 的开源模型**；Chinese-Jev 代码开源但权重未发。
2. 「训练用了 14/38」→ 修正为 Table A.2 的 **18 项 T 标**（另含 R 标相关数据若干项）。
3. 2B GGUF 尺寸估算 1.4GB → 实查 1.19GiB。

## 建议下一步（不在本轮范围）
- 拿 `quincyqiang/chinese-decision-0.8b` 转 Q8_0 GGUF 在 3060 上实测（嵌入服务占显存时段外跑）：500tok 单读出真实延迟 + 我们的 5 类浅问法在 50 条真实召回样本上的判别一致性（对照 recall-effect-audit 的 12–25% 起作用率口径）。
- 风险跟踪：chinese-decision 单作者、发布 2 天；可先用它、同时用 CJ-Dataset 申请自训兜底。
