# 决策模型 / System One 族调查报告

**日期**：2026-10-15 ｜ **委托**：session-d382c913（调查 Jev/StartLux-Decision/Laya 等决策模型族的实测证据、本地部署可行性与接入形态）
**调查代理工作区**：/home/h/dsh-plugins/dsh-memo-river（只读，未改动任何文件；未重启/触碰任何服务）
**证据落盘**：/tmp/startlux-9b.md（HF 卡原文）、/tmp/startlux-gh.md（GitHub README）、/tmp/startlux-api.md（API 参考）、/tmp/lavoir.html（LAVOIR 论文）

---

## 一句话结论

这一族确实存在、形态确如描述（双向编码器 + 每候选一个读出、一次前向返回全概率分布、无文本生成），**StartLux-Decision 是唯一完整开源且带评测/LoRA/校准工具链的一支（A- 级）**，但它的一切横向数字都是团队自测或对公开榜单快照的自跑；本机（RTX 3060 Laptop 6GB，其中 3.2GB 已被嵌入服务占用）现实可跑的只有 **0.8B/2B（Q4/Q8）两档，4B Q4 勉强、9B 不可跑**；对我们「记忆片段选择」用例，它给出的是一个**可本地部署、毫秒级、输出全概率分布的门控/排序器**，但知识与推理能力弱于 Jev、校准需自己按域重拟合、且权重 CC BY-NC 4.0 禁商用。

---

## 1. 实测数据核实与分级

### 分级表

| 模型/产品 | 谁测的 | 样本量/口径 | 关键数字 | 分级 | 出处 |
|---|---|---|---|---|---|
| **Jev 1.13**（TypeSafe AI） | 团队自测 + **多个第三方实测（API 黑盒）** | 第三方：nibzard DMB 40,226 决策；AbdelStark 小样本 | Banking77 79.2%、CLINC150 88.6%、NLU++ micro-F1 48.3%；p50 延迟 267-316ms；DI 0.2.1=57.91（2026-09-28 榜单快照） | **B**（API-only 可第三方测，但架构/训练不公开、无法复现内部） | https://github.com/nibzard/decision-model-benchmark；https://huggingface.co/spaces/multimodalart/jev-decision-index |
| **StartLux-Decision v1/v1.1**（上海原点星辉，HKU/南科大合作） | **团队自测**（用 DI 官方评测工具 + 2026-09-28 公开榜单快照对照；明确注明"非官方上榜"） | DI 0.2.1：38 项基准；JevBench 231 公开题；七套 Intern-Decision 评测；延迟=单张 H200 bf16 短请求 200 次串行平均 | 27B DI=63.88（Jev 57.91）；9B=58.63；4B 三问 26.0ms；Q8_0 与 BF16 决策一致率 100%（231 题复测） | **A-**：权重（CC BY-NC）+ 推理代码（Apache-2.0）+ 评测脚本（v1/eval/di/）+ 结果 CSV + 游戏日志全公开、可复现；扣分在**横向对比全是自测口径**，且训练用了 38 项基准中 14 项的公开训练集（测试题已过滤，但仍有域内优势嫌疑） | https://huggingface.co/startlux-models/StartLux-Decision-v1-9B；https://github.com/StartLuxLabs/Startlux-Decision；https://www.tmtpost.com/8158976.html |
| **Laya 0.2.1**（Convai Innovations，单人 nandakishor） | **作者自测，且诚实披露失败模式** | 17,416 问共享基准；typed-decisions 2,000 决策；T4 实测延迟 | typed-decisions 零样本 0.362/0.352（随机基线 0.318！）→ 微调后 0.766；ECE 0.466→温度拟合后 0.081；单问 33-39.5ms（T4） | **A-**：权重+微调 notebook+基准 colab 全公开；base 近随机是硬伤，价值在"可专门化的快底座" | https://pypi.org/project/laya/0.2.1/ |
| **Intern-Decision**（上海 AI 实验室 internlm，0.8B/2B/4B） | 团队自测（其七套评测成为社区对照面） | 七套：JevBench Easy/Original/Hard、Typed Decisions、ToolACE、AG News、WildJailBreak | 4B 七套平均 90.02%；延迟 RTX 4090 上 0.8B/2B/4B ≈ 34.0/33.3/44.2ms（StartLux 转引¹）；DI 0.2.1=37.81（4B） | **B+**：权重开源（internlm/Intern-Decision-*，见 DI 榜 models 列表），评测脚本公开度未深查 | 榜单 models 清单；StartLux HF 卡转引 |
| **rev-decision**（jaswanthsanjay88） | 作者自测 | 宣称 ECE<0.09、亚毫秒路由 | 具体基准数字未在本次抓取中核实到样本量 | **C+**（有代码+HF 模型+CI，但数字口径未核） | https://pypi.org/project/rev-decision/ |
| **decision-jef 0.1.0**（bet0x/BarraHome，307M） | 作者自测 | typed-decisions 2,000 决策（与 Laya 同集同 split） | 77.50（选项乱序 77.60）；3 决策 12.0ms；ECE 0.011 出厂 | **B+**：同集可复现，规模小 | https://pypi.org/project/decision-jef/0.1.0/ |
| **Decision Index 0.2.1**（榜单本身） | **社区维护，非 TypeSafe 官方**：HF Space `multimodalart/jev-decision-index`（维护者 multimodalart = HF 员工个人；明确标注 "Unofficial and community-maintained; not affiliated with TypeSafe AI"） | Full 分 = 20% 公开基准 + 50% 同技能私有测试 + 30% 新领域私有任务；公开面 37 项基准 × 5 领域，**每项随机基线校正（0=随机，100=满分），未答记错** | 榜上 150+ 模型（含 Qwen3.8、gemma-4、Cloudflare clef、perplexity pplx-decider 等大厂入场）；Jev 1.13 = 57.91（2026-09-28 快照），当时榜首 | **A-**（方法论、每项子集与基线在 Methodology 页公开；私有部分不可训练不可见） | https://huggingface.co/spaces/multimodalart/jev-decision-index |

**重要口径澄清**：
- StartLux 的 DI 对比数字 = **用榜单官方评测工具自跑 + 引用榜单公开值**，不是官方认证上榜（tmtpost 与 HF 卡都明示）。
- 延迟不可横比：StartLux=H200 本地 bf16；Jev=API 网关服务端耗时 100 次平均（不含网络）；Intern=RTX 4090。三个不同硬件/服务栈。
- StartLux 站点明示（FAQ）："We compared data recipes and checkpoints on the public subset of Decision Index 0.3, so **treat those scores as development numbers**. DecisionPivot … is the independent evaluation in the technical report."——团队自己承认 DI 公开子集被用于开发选型。

---

## 2. 接口与本地部署

### 2.1 `/v1/systemone` 请求/响应（逐字引用，来自 repo `docs/api.md` 与 README）

请求：
```json
{
  "state": "any text, or any JSON value",
  "questions": {
    "team":     {"type": "choice", "instructions": "Which team?", "criteria": {"billing": "Payments", "shipping": null}},
    "urgent":   {"type": "noul", "instructions": "Answer today?"},
    "severity": {"type": "score", "instructions": "How bad?", "criteria": ["minor", "major", "critical"]}
  },
  "images": ["data:image/jpeg;base64,..."],
  "think_mode": "auto", "gate": 0.6, "think_budget": 4096,
  "allow_none": false, "none_check": true, "return_details": false, "return_thought": false
}
```
响应（27B AutoThink，-rounded）：
```json
{"answers": {
  "team":     {"type": "choice", "choice": "billing", "confidence": 0.992,
               "probabilities": {"billing": 0.995, "shipping": 0.000, "technical": 0.005},
               "none_probability": 0.002},
  "urgent":   {"type": "noul", "noul": 0.870},
  "severity": {"type": "score", "score": 1.858, "confidence": 0.787,
               "legend": {"0": "cosmetic", "1": "annoying", "2": "blocks the customer"},
               "probabilities": {"0": 0.005, "1": 0.133, "2": 0.863}}},
 "usage": {"input_tokens": 290, "output_tokens": 144}, "model": "startlux-decision-27b-autothink"}
```
- **候选项表达**：`criteria` = `{option_id: 描述或 null}`（choice）或有序等级数组（score）。**一次前向最多 26 个选项**（字母 A-Z），超出自动走淘汰赛（每组 ≤25，组前三进决赛）。
- **一次多问**：`questions` 是字典，一请求内所有问题共享 `state`、一次前向（AutoThink/v1 长态只读一次；Instant 每问重读一遍）。
- **概率形态**：`probabilities` = 全选项分布；`confidence` 按 TypeSafe 定义（choice: `(p_max − 1/n)/(1 − 1/n)`）；`noul` = P(yes) 标量；`score` = 概率加权期望等级 + 每等级概率；`none_probability` = "以上皆非"警报分（官方建议阈值 0.2：抓住 66.3% 全错题、误报 2.2%，AUROC 0.920）。
- `POST /v1/decisions` 是同一 API 的 OpenRouter 命名。**StartLux 明确兼容 TypeSafe `/v1/systemone` 格式，"clients written for Jev work unchanged"**（用户说法核实为真）。

### 2.2 GGUF 与 llama.cpp

GGUF 仓库按 规格×精度 分列（v1.1 实测文件大小，HF API）：
| 档 | Q4_K_M | Q8_0 | mmproj(F16, 视觉) |
|---|---|---|---|
| 0.8B Instant | 0.53 GB | 0.81 GB | 0.20 GB |
| 4B AutoThink | 2.71 GB | 4.48 GB | 0.67 GB |
| 9B AutoThink | 5.63 GB | 9.53 GB | 0.92 GB |
（2B 档 API 查询返回异常未取到，按比例 Q4≈1.4GB/Q8≈2.2GB 估算；v1 时代另有 BF16 GGUF，共 15 个 GGUF 条目。）

llama.cpp 路线：GGUF Q8_0/Q4_K_M + F16 mmproj 跑图像；官方口径 Q8_0 在 DecisionPivot 上距 BF16 ≤1.3 分、Q4_K_M 最多掉 4.3 分。专用引擎 StartLux-Prism（CUDA，跑 GGUF）自称比 llama.cpp 快 7.5-14×（Q8_0）。**注意：GGUF/MLX 只读文本**（README："The MLX backend and the GGUF files read text only"，v1 卡原文；v1.1 站点说 llama.cpp 配 mmproj 可读图）。

**官方工具链（已核实存在于 repo 树）**：
- 评测复现：`v1/eval/di/`（Decision Index 批量评测引擎 + merge）、`startlux_decide/evaluate.py`（准确率+校准）、`bench.py`（延迟）、`v1/results/decision_index_benchmarks.csv`（结果数据）。
- LoRA 微调：`v1/finetune/finetune_lora.py`；温度校准：`v1/finetune/calibrate.py`。用户所说"官方评测复现脚本与 LoRA 微调/温度校准工具"**全部核实为真**。

### 2.3 本机核实（2026-10-15 17:37 实测）

- GPU：**NVIDIA GeForce RTX 3060 Laptop，6144 MiB 显存**，已用 3256 MiB（Xorg+kwin+dsh-embed 进程占 ~3.2GB）→ **实际可用 ≈ 2.8-2.9 GB**。驱动 615.78.08 / CUDA UMD 13.4。
- 无 /dev/dxg、无 rocm-smi（非 WSL/AMD）；/dev/dri 存在（card1/card2，NVIDIA + 可能核显）。
- RAM 15GB（已用 9，可用 6）；swap 29GB；/tmp 7.7GB 剩 6.6GB（放得下 9B Q4 文件但跑不动）。
- CPU 16 核。
- `http://127.0.0.1:8099/v1/models` → **BAAI/bge-m3**（本地嵌入服务，dsh-embed venv，吃掉 3.2GB 显存）。

### 2.4 判档（可跑性）

| 档 | 显存需求(估) | 判定 |
|---|---|---|
| 0.8B Q4/Q8 | ~0.7-1.1 GB | ✅ 轻松，甚至可与嵌入服务共存；官方也说 0.8B/2B 可纯 CPU llama.cpp |
| 2B Q4/Q8 | ~1.6-2.4 GB | ✅ Q4 稳妥、Q8 顶格；长上下文 KV/激活另计 |
| 4B Q4_K_M（2.71GB 文件） | ~3.2-3.5 GB | ⚠️ 超出当前余量——需先停嵌入服务（红线禁止本任务动）或接受部分 offload 到 RAM（llama.cpp CPU offload，延迟升到几十-上百 ms 级） |
| 9B Q4（5.63GB）/27B | ~6-7GB / ~17GB | ❌ 6GB 卡无论如何放不下（含嵌入服务共存更不可能） |

**结论：这台机器上现实组合是 0.8B（首选，低摩擦）或 2B Q4（上限）；想要 4B+ 的判断质量，要么等嵌入服务让位显存、要么走 bamboonode.dev 免费托管 API（27B AutoThink，`POST /v1/decisions` 同格式）做离线批处理实验。**

---

## 3. Decision Index 0.2.1 查清

- **维护者**：HF Space [`multimodalart/jev-decision-index`](https://huggingface.co/spaces/multimodalart/jev-decision-index)，multimodalart（HF 员工个人号），**社区非官方、与 TypeSafe 无关**（README 原文 "Unofficial and community-maintained; not affiliated with TypeSafe AI"）。PR 制贡献（news 数据在一个 JS 数组里）。
- **算法**：Full 分 = 20% 公开基准 + 50% 同技能**私有**测试 + 30% 新领域**私有**任务，同尺度汇总。公开面 37 项基准、5 领域，**每项做随机基线校正（0=随机猜测，100=完美；未答记错）**——所以它不是准确率，是校正后加权指数。0.2 版引入 chance-corrected headline score（commit 969a3425）。私有部分防训练污染。
- **榜上模型**：150+（README models 列表实数），含 internlm/Intern-Decision 全系、convaiinnovations/laya、vllm-sr/d3 系、Cloudflare/clef、perplexity pplx-decider、Qwen3.8-27B、gemma-4-31B、Mapika/decider、JevK5、OpenJev 等。
- **Jev 1.13 位置**：2026-09-28 快照 = **57.91，当时公开榜首**（StartLux 27B 自测 63.88 超出 5.97 分，但非官方认证）。
- **独立第三方复现**：榜单本身就是第三方（对 Jev 而言）；nibzard/DMB、AbdelStark、nxtg-ai/jev-calibration-eval（预注册校准研究）、luckykevvv/Decision_Model_Benchmark（arXiv 论文配套）等多个独立评测存在。**对 StartLux 的独立复现：本次未找到**（v1.1 发布仅两周；其 DecisionPivot 是自建自报的"独立评测"）。

---

## 4. 接到我们的两个想法（具体形态）

背景锚点：我们实测 24 轮/258 条注入仅 12% 真起作用（独立模型盲判，D238）；LAVOIR 的 VOI 上界定理（VOI* ≤ 1−Σp(y)²，模型越确定价值越趋 0）从理论上解释了这个数字——**很多轮模型本来就会，注入任何东西的边际价值≈0**。

### 方案 (a)：决策模型做"选择性注入"门控

**输入组织**（单次 `/v1/systemone` 请求）：
```json
{
  "state": {
    "task": "<当前用户请求 + 最近 1-2 轮摘要，~300-500 字>",
    "already_known": "<系统提示词/当前上下文已含的关键事实清单，~200 字>",
    "candidates": [
      {"id": "D207", "excerpt": "<记忆前 800 字（被动召回同口径）>"},
      {"id": "D239", "excerpt": "..."},
      "...k 条，k=当前注入上限>"
    ]
  },
  "questions": {
    "inject_D207": {"type": "noul", "instructions": "Does this memory change what the correct next action or answer would be, beyond what the task and already_known already provide?"},
    "inject_D239": {...}, "...每条候选一个 noul 问"
  }
}
```
**问法选择**：k 个 `noul`（是非）而非一道 k 选 N 的 choice——理由：①noul 每问独立打分，天然支持"多选/全不选/全选"；②choice 强制归一化会把无关选项的概率挤在一起；③一次前向全部出，成本不变。
**输出使用**：三层决策——
1. `noul ≥ τ_high`（如 0.7）→ 全文注入；
2. `0.3-0.7` → 降级注入（只注入首段决定性事实，配合 Provence 式剪枝）；
3. `< τ_low` → 不注入。
加预算约束：按 noul 降序取 top-m（m=2-3）而非放行所有过阈者——对齐我们 12% 真作用率的先验。
**概率校准**：出厂概率≠真实命中率（Laya ECE 0.466 的教训；Jev 的 confidence 被 nibzard 判为"provider-defined score, not a calibrated probability"）。必须用现成的盲判标注集（我们已有 258 条人工判读 + recall-effect-audit 技能可再产）在本地域上拟合每问题类型一个温度（StartLux 提供 `v1/finetune/calibrate.py`，Laya 的做法同款）。**阈值定在校准后分位数上，不定在原始概率上**。
**成本**：state ≈ 500 + k×800 字 ≈ k×1200 token 输入，0 输出 token。0.8B 本地 Q4：估算 10-30ms/请求（H200 12.2ms、3060 慢 3-5×）；2B 类似量级。对每轮注入管线是可忽略的增量。
**失败模式**：①决策模型读懂了"话题相关"但判不出"改变行动"（Laya 在 held-out 上 0.36 的教训——**门控问题必须在自己的域上验证 ROC，不能信零样本**）；②知识与推理弱项（StartLux 该域 44.3 vs Jev 51.4）导致需要推理"这条经验是否适用于当前情形"时误判；③阈值漂移——记忆语料演化后校准温度需定期重拟合；④把"模型已知道"判成"需要注入"（VOI 逻辑的反向失败），靠 `already_known` 字段缓解；⑤最长候选项>26 时注意——noul 问不受 26 选项限制（每问是独立二分类），这是选 noul 的又一理由。

### 方案 (b)：安静期用决策模型选记忆片段回注、纠正旧记忆

**候选粒度**：记忆**片段**（chunk 口径，与库内 chunks 表对齐）而非整篇。每个候选 = {D-id, chunk 正文（现成）, 该篇 Tag, 时间}。
**形态**（批量、离线、`decide_batch`）：
```
state = {
  "current_environment": "<当前环境快照：AGENTS.md 守则要点 + 最近 N 天的新日记结论>",
  "candidate_fragment": "<单条旧片段>"
}
questions = {
  "still_true":   {"type": "noul", "instructions": "Is this statement still true in the current environment?"},
  "supersede":    {"type": "noul", "instructions": "Has this conclusion been replaced by a newer entry in current_environment?"},
  "needs_update": {"type": "noul", "instructions": "Does this entry need rewriting to match current_environment?"},
  "confidence":   {"type": "score", "instructions": "How internally certain was the original author?",
                   "criteria": ["guess", "verified once", "verified with tests"]}
}
```
**输出使用**：`supersede ≥ τ` → 进 `memo_supersede` 候选队列（人审后才落，绝不全自动改库）；`needs_update` → 进 memo_update 候选；`still_true 低 + confidence 高` → **优先人工复查的高危项**（曾验证过但现在可疑 = 最可能的过期事实）。score 型问用其概率全分布做排序而非硬阈值。
**成本**：纯安静期批处理，吞吐不敏感；0.8B/2B 本地跑一夜可扫全库（146 篇×若干 chunk）。**用 `none_probability` 思路反推**：给"以上判断都不适用"留出口，防止强制二分。
**失败模式**：①最致命——把仍正确的旧结论误标 superseded（静默丢经验）：必须人审闸门 + 只输出候选队列；②环境快照本身有偏（只喂近期日记会系统性贬低旧经验——检索诱发遗忘的算法化）；③chunk 脱离原篇叙事后语义残缺，误判率高于整篇口径；④跨桶记忆的适用域判断（原桶的事实对新桶未必假）。

### 与 LAVOIR 的结合点（升级路径）

LAVOIR（已核实**确实构建在 Laya 之上**：论文原文 "ModernBERT-large (a question-type embedding, two transformer layers and an option scorer)"，Laya 出现 51 次，"On Laya's twelve benchmarks LAVOIR is above Laya's reported scores on seven"）给出免训练版思路：把"是否注入"视为 VOI 槽位，用 **当前主模型对下一动作的不确定度（可从主模型 log-probs 算）作为注入价值上界**——模型确定时直接跳过决策模型调用，省掉一半门控成本。这是 D239 已入河的结论，本轮核实了其模型底座真实存在且开源（HF `moganai/lavoir` 在 DI 榜 models 列表中）。

---

## 5. 反例与风险（必答）

1. **上下文窗口**：用户担忧"编码器吃不下 1-3K 字 × k 条"——**对 StartLux 不成立**：原生 262,144 token（256K），长态分块读一次、每问分支（AutoThink/v1）；Instant 档 131K 但**每问重读一遍 state**（k 个 noul = k 次全文前向，延迟×k——门控用例应选 v1/AutoThink 架构或限制 state 长度）。**对 Laya 成立且致命**：512/1024 token，一条记忆就爆，只能做句子级判断。
2. **知识与推理弱于 Jev**：核实为真——tmtpost 原文"知识与推理领域则由 Jev 1.13 领先"（44.3 vs 51.4），API-Bank 也未领先。含义：我们的门控问题恰恰是"这条记忆是否会**改变推理结果**"——落在其最弱域。缓解：①用 AutoThink + gate 0.9（推理域准确率从 57%→93%）；②或该问法改造成更浅的"内容重叠/新旧/冲突"判断（落在其强的检索与分类域 66.8）。
3. **训练/评测集污染**：StartLux 训练用了 DI 38 项基准中 **14 项的公开训练集**（测试题已过滤，官方披露）；且其 DI 0.3 公开子集被用于开发选型（自认 "development numbers"）。**不可信的结论**：StartLux 对 Jev/Intern 的任何 DI 公开面分差（含 63.88 vs 57.91）都应打折；可信度排序：DecisionPivot（声明未用于任何训练/选型）> 七套 Intern 评测 > DI 公开子集。第三方对 StartLux 的独立复现：**未找到**。
4. **失败/打脸报道**：Laya 自曝 base 零样本近随机、出英语崩溃（Khmer 0.000@95.2% 置信）且 multilingual 档**不附带任何拟合温度**；Jev 被 nibzard 实测 NLU++ micro-F1 仅 48.3%、且"confidence 不是校准概率"（Banking77 上 0.96 阈值才能把接受集错误压到 3.68%，覆盖只剩 51.2%）；jev-local-alternatives 记录"Jev 无独立基准或架构论文（2026-10 快照）、性能与采用数字全为 TypeSafe 自报"。OpenAI Decisions API 已入场（竞品压力=该赛道可能快速变天）。
5. **可能不适合我们的地方**（明说）：
   - **许可**：StartLux 权重 CC BY-NC 4.0——研究/内部用没问题，**商用需另行授权**；Laya/decision-jef 是 Apache-2.0/MIT 无此问题。
   - **判断质量的天花板**：0.8B/2B 在 DI 上只有 38.86/44.19（v1），本机可跑档位的综合判断力有限；4B 以上才是 52.75+。**本机硬件与"高质量门控"存在错位**——这是最现实的矛盾。
   - **中文语料**：StartLux 卡只标 English；Laya 英语档出英语即崩。我们的记忆是中文为主——**两个开源族都没有验证过中文决策能力**，DI 也主要是英文基准。这可能是整族对我们的一票否决项，必须先做中文门控的 ROC 小样实验再谈接入。
   - 决策模型**不理解"为什么"**：它给 P(选项)，不给理由；调试门控误判时没有解释面（`return_thought` 只对 AutoThink 且是生成的思考文本）。
   - 单人维护风险：Laya/rev/jef 都是单人项目，迭代快、断供也快。

---

## 6. 对委托方给定事实的核实结论

| 说法 | 核实结果 |
|---|---|
| 24 轮/258 条注入/12% 真作用 | 本调查无法重测（属委托方内部实验），与 D238 入河数字一致，无矛盾 |
| Provence/MemReader/两篇 Zenodo 为 A 级 | 本轮未复核（不在任务重点），未发现矛盾信源 |
| Jev API-only、权重不公开 | ✅ 真（jev-local-alternatives："closed and hosted… no self-hosting"；2026-09-15 发布，$0.042/M input，64K 输入上限） |
| StartLux 完整开源、五档 | ✅ 真，且已更新到 **v1.1（+35B-A3B，Instant/AutoThink 双变体，共 8+ 模型）**——委托方信息滞后一代 |
| StartLux 兼容 TypeSafe 接口 | ✅ 真（"Requests and responses use the TypeSafe `/v1/systemone` format, so clients written for Jev work unchanged"） |
| LAVOIR 挂在 Laya 上 | ✅ 真（论文原文构建于 ModernBERT-large = Laya 底座，直接比较 Laya 十二基准） |
| 中文报道是团队自测口径 | ✅ 真（tmtpost 全文为 StartLux 官方公众号原文授权转载，自带"团队自测"免责段） |
| "26ms 级" | ⚠️ 需修正：26.0ms 是 **4B 三问在 H200** 的数字；9B 是 35.7ms、单是非 17.6ms；我们本机可达档（0.8B/2B）对应 12.2/15.5ms@H200，3060 上估 40-80ms。"一次前向 26ms"作为族级口号成立，具体数字必须带档位与硬件 |
| "双向编码器 + [MASK] 打分" | ⚠️ 部分修正：StartLux 是 **transformer LLM 底座（qwen3_5 系标签）+ prompt 双向注意力读出**，不是经典 BERT 式 [MASK]；"不生成文本（Instant 档）"为真，但 **AutoThink 档会先生成短推理再读出**——"绝不生成任何文本"只对 Instant/v1 成立 |

## 自审（交付三问）

1. 任务 6 项全覆盖：①分级表✅ ②接口逐字+GGUF+本机实测✅ ③Decision Index✅ ④两方案含输入/输出/成本/失败模式✅ ⑤反例五条✅ ⑥事实核实表✅。
2. 未验证处明示：StartLux 延迟在本机的实测未做（不下载 0.5-1GB 模型试跑，避免占满 /tmp 与带宽——判断基于官方 CPU/GPU 对照表推断）；rev-decision 的数字口径未深挖（判 C+）；2B GGUF 精确尺寸 API 查询失败（按比例估算）。
3. 最可能被打回的三点：中文能力未实测（已列为潜在一票否决）；4B 可行性判断偏保守（如肯停嵌入服务可跑）；第三方对 StartLux 独立复现可能存在于 X/论坛等本次未扫到的角落。

> 第二轮（中文/速度/性能）已续做：见 `/tmp/investigation-decision-models-cn.md` —— 核心修正：中文赛道候选换为 chinese-decision-0.8b（实测超 Jev），StartLux 官方零中文证据；训练污染修正为 18 项 T 标。
