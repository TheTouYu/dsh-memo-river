# chinese-decision-0.8b 独立调查报告

- 调查日期：2026-10-15 ｜ 调查代理：独立子代理（受 session-d382c913 委托）
- 对象：`yanqiangmiffy/chinese-decision`（GitHub）→ 权重实际发布于 **`quincyqiang/chinese-decision-0.8b`**（HF）
- 本地副本：`/home/h/cd-exp/`（git HEAD `f0e1867` = 远端最新，已核对）
- 信源分级标注：【官方】仓库/模型卡自述（团队自测）｜【论文】arXiv:2609.36965｜【第三方】独立实测｜【社区】帖子/视频。**未标注第三方的数字一律视为官方自测。**

---

## ① 这个仓库/模型是什么

### 1.1 一句话定位【官方】

中文概率决策模型：Qwen3.5-0.8B + LoRA(r=32) 微调后合并的单模型。给定上下文（state）+ 2–26 个候选项，**一次前向读末位候选字母 A–Z 的 logits → softmax → 每个候选一个概率**，零 token 生成。支持 `noul`（是非）/ `choice`（单选）/ `score`（有序等级）三型，general/medical/legal/finance 四域混训。

### 1.2 仓库与维护者画像【官方 API 数据】

| 项 | 值 | 出处 |
|---|---|---|
| GitHub 创建 | 2026-10-14T09:52:05Z | api.github.com/repos/yanqiangmiffy/chinese-decision |
| 最后推送 | 2026-10-15T09:47:15Z（"add gguf"） | 同上 |
| Star / Fork / Issue | **19 / 3 / 0**（截至 2026-10-15 晚） | 同上 |
| 提交数 | **7 个，全部落在 48 小时内**（10-14 09:53 → 10-15 09:47 UTC） | commits API |
| 共同作者 | **7 个提交全部 "Co-Authored-By: Claude Opus 5.5"**——单人 + AI 高速产出 | commits API |
| 代码许可 | MIT；`decision/rlcd.py` Apache-2.0；模型权重 Apache-2.0（继承 Qwen3.5-0.8B） | repo LICENSE / THIRD_PARTY_NOTICES.md |
| 配套论文 | **无**。引用格式指向 GitHub 仓库本身；数据集/基线引用 Chinese-Jev 论文 | README §引用 |
| 博客 | 无独立博客；README/模型卡即全部文档 | — |

**维护者**：yanqiangmiffy（GitHub id 15925090），ICT-CAS（中科院计算所）、北京，720 followers / 291 repos，2015 年注册老号，联系方式在 bio（微信/邮箱 1185918903）。**HF 账号为 `quincyqiang`**（GitHub 名 yanqiang ↔ Quincy Qiang，同邮箱线索吻合）。他还是 `yanqiangmiffy/chinese-laya`（Laya 复刻，14 star，2026-09-23 建）的作者——Jev/Laya 族的持续追踪者，非匿名一次性号。
- 出处：https://api.github.com/users/yanqiangmiffy 、https://api.github.com/repos/yanqiangmiffy/chinese-laya

**权重发布位置（重要更正）**：`yanqiangmiffy` 名下 HF API 查无此模型（401/空）；实际权重在：
- **`quincyqiang/chinese-decision-0.8b`**（HF，Apache-2.0，公开非 gated，2026-10-15T03:24:25Z 创建，**4 次下载 / 0 like**）
- `quincyqiang/chinese-decision-0.8b-gguf`（Q8_0，812MB，2026-10-15T11:22:30Z）
- ModelScope 同名镜像（模型卡给出 `modelscope download --model quincyqiang/chinese-decision-0.8b`）
- 出处：https://huggingface.co/api/models?search=chinese-decision 、https://huggingface.co/quincyqiang/chinese-decision-0.8b

### 1.3 `n4ze3m/hmm` 是什么【官方（hmm 仓库自述）】

- **hmm = "Open source JEV"**（仓库 description 原文）。它是**闭源商业模型 Jev（TypeSafe 公司，"System One" 范式）的开源复刻实验**，不是范式定义者。作者 n4ze3m（个人，Ko-fi 求赞助），MIT，4 star，2026-09-20 单日单次推送。
- 形态：Qwen3.5-4B + LoRA，**只在英文上训练，提示长度上限 768 tokens**；服务器兼容 TypeSafe 的 `/v1/systemone` 与 `/api/alpha/decisions` 请求格式。
- 作者原话（README）：*"This is a fun experiment. Hmm is nowhere near the quality of Jev from TypeSafe"*；*"It can miss things a careful reader would catch. In my tests it allowed a shell command that hid an `rm -rf` behind base64. **Do not use it as your only safety gate, and do not use it for anything important.**"*
- 出处：https://github.com/n4ze3m/hmm （README.md 原文）
- **chinese-decision 与 hmm 的关系（THIRD_PARTY_NOTICES.md 原文）**：*"The option-letter decision objective, LoRA workflow, candidate formatting, and System One response conventions in this project are adapted from n4ze3m/hmm, revision 78d8d4a"*。即：**候选字母读出目标、LoRA 流程、候选格式化、System One 响应约定四件套来自 hmm**；RLCD 可选目标移植自 Chinese-Jev（Apache-2.0，逐位一致）；训练数据用 Chinese-Jev 的 CJ-Dataset。README 明确"不复现 Microsoft Decision、Jev 或 Chinese-Jev 的训练过程"。

### 1.4 谱系总图

```
Jev（TypeSafe，闭源，"System One" 原型）
 ├─ n4ze3m/hmm（开源复刻，Qwen3.5-4B，英文，768tok，自认玩具）
 ├─ Chinese-Jev（arXiv:2609.36965，复旦/NUS/国科大，encoder-only 322M，
 │   CJ-Dataset + CJ-Bench 出处；权重"planned"未发布）
 │   └─ yanqiangmiffy/chinese-decision = hmm 的方法（decoder 读字母）× Chinese-Jev 的数据（CJ-Dataset 13M）
 └─ StartLux / Laya / ……（另案，见 /tmp/investigation-decision-models*.md）
```

### 1.5 `hmm-zh-v1` prompt 模板（照抄，`decision/schema.py:72-82` + HF 模型卡一致）

```
待判断的上下文：
{state}

问题：
{instructions}

候选项：
A: {key₁} — {描述₁}
B: {key₂} — {描述₂}
...
只返回候选项对应的字母。
```

- 外层套 Qwen chat template：`apply_chat_template([{role:"user", content}], tokenize=False, add_generation_prompt=True, enable_thinking=False)`。
- `state`/`instructions`/候选描述可以是字符串或 JSON 对象（非字符串自动 `json.dumps(ensure_ascii=False)` 紧凑序列化）。
- 这是唯一的 prompt_version——**没有为其他问法准备的其他模板**。

### 1.6 CJ-Dataset 是什么【官方数据卡】

- **13,048,000 条训练 + 134,318 条验证**决策，gzip JSONL，`{state, questions, gold}` 三段；100% 中文（`language: zh`）。8.2GB。出处：https://huggingface.co/datasets/bbldCVer-hf/CJ-Dataset
- 组成（与本地 training_summary.json 完全一致）：

| 域 | choice | noul | score | 合计 | 验证 |
|---|---:|---:|---:|---:|---:|
| General | 3,333,334 | 3,333,333 | 3,333,333 | 10,000,000 | 30,000 |
| Medical | 1,194,496 | 1,792,223 | 13,281 | 3,000,000 | 100,000 |
| Legal | 8,000 | 8,000 | 8,000 | 24,000 | 2,518 |
| Finance | 8,000 | 8,000 | 8,000 | 24,000 | 1,800 |

- **输入长度上限（Laya Multilingual tokenizer 口径）**：General/Finance **1,024** tokens、Medical **2,048**、Legal **8,192**；CJ-Bench 实测平均输入 **223 tokens**。⇒ 训练分布以短上下文为主，>1K token 的 state 只在 legal 域见过。
- 构造：General=20 公开来源+10,700 程序构造题（阅读推理/推断/匹配/情感/评分/类别/意图）；Medical=30 来源家族（cMedQA2 一家占 1,486,404 条=49%）；Legal=ClaimGen-CN/AppealCase/LeCaRDv2/eCAIL/LCR-CN/CAPP-130；Finance=CFLUE/FinRE/RoleCS/FinTruthQA。单答案→choice、二元命题/选项成员→noul、有序等级→score。
- **许可**：`license: other`（source-specific）——ClaimGen-CN、CFLUE 为 **CC BY-NC-SA 4.0**，AppealCase 为 **CC BY-NC 4.0**，部分医学来源无独立数据许可确认。数据集**不授再分发权**。模型权重 Apache-2.0 不受影响，但"拿这套数据自己再训一版对外发布"有许可雷。
- 版本钉死：文件拷贝自 `chinese-jev` revision `a3963a61f71e00051a80721e587d720d8926e8e7`（与本地 training_summary.json 记录的 revision 一致）。

### 1.7 有没有更新版本/更大档位

**没有。**【官方】GitHub README 模型表与 HF 全局搜索都只有 0.8b 一档（+Q8_0 GGUF 量化档）。Chinese-Jev 官方（322M encoder，4 变体）权重状态 = "Weights coming soon"（2026-10-15 未发布，出处：https://gulucaptain.github.io/Chinese-Jev/ ）。StartLux 有 0.8B–27B 五档但权重 CC BY-NC 4.0 非商用且中文证据薄弱（另案报告）。

---

## ② 推理接口怎么用（最重要）

### 2.1 三种任务形态

| 型 | criteria 格式 | 候选构造 | 输出读法 |
|---|---|---|---|
| `noul` | 可选 `{"false":"否","true":"是"}` | 固定 2 项，**顺序恒为 false 在前、true 在后**（训练与推理都不打乱） | `probs[1]` = 真值概率 |
| `choice` | 对象 `{键: 描述}` | 2–26 项；**训练时随机打乱候选序并同步重排目标**（抗位置偏差），评测时保序 | argmax 键 + 全分布 |
| `score` | 列表 `[低,…,高]` | 2–26 项，**保序**（等级语义不许打乱） | `score = Σ i·p_i`（期望等级 0..K−1）+ 全分布 |

所有型都返回 `probabilities`（全分布）和 `confidence = (K·p_max−1)/(K−1)`——**这是分布尖锐度不是准确率**（模型卡原话："它不等于经验准确率"）。

### 2.2 概率怎么读、温度在哪一步

1. prompt（§1.5 模板 + chat template）→ tokenize（`add_special_tokens=False`）。
2. 单次前向 `logits_to_keep=1`：取**最后位置**的 logits，按 26 个字母 token id gather（A–Z 每个是单 token，加载时校验），本问只保留前 K 个、其余 `masked_fill(-1e4)`。
3. `(logits[:K] / T).softmax(-1)`——**T = 1.10813307762146（decision_config.json）只在 softmax 前缩放 logits**，不改变 argmax，只压平/锐化分布。T 拟合自 validation 独立 20% 划分（1,993 条硬标签）上的温度标定。要未校准原始概率就把 T 设 1。

所以：**是 softmax over 候选字母 logits，不是逐候选独立打分**；候选间互斥竞争（这正适合"这批记忆里选哪条"，也意味着单条 noul 的 p_true 与"其他什么都不给"的绝对语义有耦合——见 §4 坑 6）。

### 2.3 `max_options 26` / `max_length 16384` / `max_position 262144`

- `max_options 26`：字母表 A–Z 物理上限，一问最多 26 候选（HTTP 层超 26 直接 422；hmm 原版的"255 分块"玩法本项目未实现）。我们一次问 1 条记忆（noul 2 候选），远在界内。
- `max_length 16384`：**编译后 prompt 总长**（含模板与候选行）的硬上限；超长**不截断直接报错**（HTTP 返回 422；本地示例 raise ValueError）。训练时超长样本被过滤（从不截断）。
- `max_position_embeddings 262144`：底座 Qwen3.5-0.8B 的位置上限（RoPE θ=1e7）。**16384 是训练/工程约束，远小于 262144 的架构约束**——架构能吃 26 万 token 不代表决策头在 >16K 上有意义（训练分布上限 1024–8192，见 §3）。

### 2.4 官方调用示例（原样照抄——接入合同）

**A. HF 模型卡快速开始（自包含，不依赖仓库，提示格式与训练/评测完全一致）**——出处 https://huggingface.co/quincyqiang/chinese-decision-0.8b （2026-10-15 版模型卡原文照抄）：

```python
import json

import torch
from transformers import AutoModelForCausalLM, AutoTokenizer

path = "chinese-decision-0.8b"
tokenizer = AutoTokenizer.from_pretrained(path)
model = AutoModelForCausalLM.from_pretrained(path, dtype=torch.bfloat16, attn_implementation="sdpa").to("cuda").eval()
config = json.load(open(f"{path}/decision_config.json", encoding="utf-8"))
temperature, max_length = config["temperature"], config["max_length"]

LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
letter_ids = [tokenizer.encode(c, add_special_tokens=False)[0] for c in LETTERS]


def text(value):
    return value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def options_for(question):
    kind, criteria = question["type"], question.get("criteria")
    if kind == "choice":
        return [(str(k), text(v)) for k, v in criteria.items()]
    if kind == "score":
        return [(str(i), text(v)) for i, v in enumerate(criteria)]
    criteria = criteria or {}
    return [("false", text(criteria.get("false", "否"))), ("true", text(criteria.get("true", "是")))]


def build_prompt(state, instructions, options):
    content = ("待判断的上下文：\n" + text(state)
               + "\n\n问题：\n" + text(instructions)
               + "\n\n候选项：\n" + "\n".join(f"{LETTERS[i]}: {k} — {v}" for i, (k, v) in enumerate(options))
               + "\n只返回候选项对应的字母。")
    return tokenizer.apply_chat_template([{"role": "user", "content": content}], tokenize=False,
                                         add_generation_prompt=True, enable_thinking=False)


@torch.inference_mode()
def decide(state, question):
    options = options_for(question)
    ids = tokenizer.encode(build_prompt(state, question["instructions"], options), add_special_tokens=False)
    if len(ids) > max_length:
        raise ValueError(f"input is {len(ids)} tokens; the limit is {max_length}")
    logits = model(torch.tensor([ids], device=model.device), logits_to_keep=1, use_cache=False).logits
    probs = (logits[0, -1, letter_ids[:len(options)]].float() / temperature).softmax(-1).tolist()
    k, best = len(probs), max(range(len(probs)), key=probs.__getitem__)
    answer = {"probabilities": {key: round(p, 4) for (key, _), p in zip(options, probs)},
              "confidence": round((k * probs[best] - 1) / (k - 1), 4)}
    if question["type"] == "noul":
        answer["noul"] = round(probs[1], 4)
    elif question["type"] == "choice":
        answer["choice"] = options[best][0]
    else:
        answer["score"] = round(sum(i * p for i, p in enumerate(probs)), 4)
    return answer


state = "客户留言：付款后一直没有收到发票，我已经催了三次，今天必须拿到。"
questions = {
    "urgent": {"type": "noul", "instructions": "客户是否表达了紧迫性？"},
    "department": {"type": "choice", "instructions": "应该由哪个部门处理？",
                   "criteria": {"billing": "支付、发票及退款", "technical": "故障和系统问题", "sales": "购买咨询与升级"}},
    "frustration": {"type": "score", "instructions": "客户有多不满？", "criteria": ["平静", "不满", "非常愤怒"]},
}
for name, question in questions.items():
    print(name, decide(state, question))
```

官方给定输出：

```text
urgent {'probabilities': {'false': 0.1346, 'true': 0.8654}, 'confidence': 0.7309, 'noul': 0.8654}
department {'probabilities': {'billing': 0.9406, 'technical': 0.0423, 'sales': 0.0172}, 'confidence': 0.9108, 'choice': 'billing'}
frustration {'probabilities': {'0': 0.0088, '1': 0.6055, '2': 0.3856}, 'confidence': 0.4083, 'score': 1.3768}
```

**B. 仓库内调用链（README:286-315，等价）**：`compile_prompt(tokenizer, state, instructions, options)` → `tokenizer.encode(prompt, add_special_tokens=False)` → `item={"input_ids": ids, "target":[0.0]*len(options)}` → `torch.inference_mode()` 内 `forward_batch(model, tokenizer, letters, [item])` → `probs = (logits[0,:len(options)]/temperature).softmax(-1)`。

**C. HTTP 服务**：`python scripts/serve.py --base <模型目录> --port 8787`；`POST /v1/systemone` 或 `/api/alpha/decisions`（hmm 兼容），body=`{"state":…, "questions":{id:{type,instructions,criteria}}}`；单请求 ≤64 问、每问 2–26 候选、单题 ≤16,384 tok 超长 422；`GET /health` 返回温度与校准状态；GGUF 后端走 llama.cpp（`--backend gguf`，逐请求校验 tokenizer 一致性、每请求 `reset()` 清线性注意力递归态）。

### 2.5 `run_gate.py` 对账结论（本地 `/home/h/cd-exp/run_gate.py` vs 官方）

**机械契约零偏差**（逐行核对过，D277 存档）：模板拼接、chat template 参数、`add_special_tokens=False`、`logits_to_keep=1`、末位字母 logits gather、`(logits/T).softmax(-1)`、noul `probs[1]`（false 在前 true 在后）、T=1.10813307762146 从 decision_config.json 读、单条 batch 不 padding——全部与官方一致。唯一脆弱点：`sys.path` 指向 `/tmp/cd-exp/repo`（临时目录），持久副本在 `/home/h/cd-exp/repo`，重启后 /tmp 清空会断——**接入时应改为固定路径或直接抄 §2.4A 的自包含版**。

**单条不 padding 不是风格选择而是正确性判据**：commit `2dc119a`（2026-10-15T02:45Z，"fix: stop padding single-item batches in forward_batch"）原文——*"Qwen3.5's linear-attention layers zero padded positions only when a batch has two or more rows, so left-padding a lone input to a multiple of 64 leaked pad tokens into its recurrent state and **shifted the released model's probabilities by up to 0.11**. The HTTP server scores one question at a time, so **every response was affected**; the batched CJ-Bench and validation results were not."* 我们的门控正是单条路径，本地副本已含此修复+回归测试（`tests/test_model.py`）。任何自写调用代码必须保住"单条不 pad"。

---

## ③ 匹配度评估（我们的用法 vs 它的训练分布）

我们的用法：**state ≈ 500 token（当前任务上下文）+ 1 条候选记忆 → noul 问"这条会不会改变你的做法" → 读 p_true 做注入门控**。

### 3.1 形态差距（逐项）

| 维度 | 训练时 | 我们的用法 | 差距 |
|---|---|---|---|
| state 长度 | 平均 223 tok；域上限 1024（General/Finance）–8192（Legal，Laya tokenizer 口径） | ~500 tok | **在分布内**（General 上限的一半） |
| state 形态 | 考题/客服留言/临床对话/法规条款等自然文本 | agent 会话上下文（工具调用、代码、中文混合） | **分布外**：会话式 state 在训练里只有 RoleCS 对话轮一类近似物 |
| 候选数 | noul 恒 2（false/true） | 2 | 一致 |
| 问法语义 | **对 state 内容的命题判断**（"该消息是否传达紧迫性""选项是否属于答案键"）——判断对象是**state 本身** | "这条记忆**会不会改变你的做法**"——反事实元问题，判断对象是**自己未来的行为** | **这是最大的 gap**：训练集里没有"改变行为"类反事实命题；CJ 的 noul 全是内容命题 |
| 候选内容 | 短标签/描述（部门名、等级词） | 整条记忆正文（标题+正文，几百字） | **偏分布**：训练候选行是短语级（`A: billing — 支付、发票及退款`），我们的候选行是长文本。候选行长度分布明显右移 |
| 域 | general/medical/legal/finance | 记忆系统/软件工程 | 无该域。最近的 analog = general 域里的"意图/类别/匹配"类 + RoleCS 对话理解 |

### 3.2 OOD 能力的证据（全部是旁证，无一为本模型 OOD 实测）

- 【官方·英文表亲】hmm（同范式、Qwen3.5-4B、英文）zero-shot 迁移：typed-decisions 0.709（Jev 0.727，天花板 ~0.735，标签本身来自另一个模型）；Bespoke 13 任务 macro 0.750（Jev 0.760）。**说明范式能零样本迁移到未见任务**。但同一张表里：phishing 0.648→0.629（微调比底座还差）、HellaSwag 0.765→0.722（负迁移）、游戏决策 16-21%（低于多数基线 43%）——**微调对 OOD 有时会伤害**。出处：https://github.com/n4ze3m/hmm/blob/main/BENCHMARKS.md
- 【官方·本模型唯一 OOD-ish 证据】微调前后对照（1200 条验证子集，in-domain）：base Qwen3.5-0.8B ACC 34.56/ECE 27.45 → 本模型 73.49/2.48。这是 in-domain 增益，不是 OOD 证据。
- 【第三方·我方实测】本机 185 候选 × 6 问法 = 1110 次前向（父代理记录，D262）：最优问法⑥"会改变下一步做法吗" **AUC 0.679**，precision 0.456–0.50（痕迹判据基线 0.11/0.17 的约 3 倍），但 recall 仅 0.565，used 基线 25%；标签噪声（24 轮里 6 轮多标 4 轮少标）压低可达上限。**这是全宇宙目前唯一一份本模型在我们场景下的实测**——它就是"软排序信号存在、二元硬门不可用"的直接证据。
- 【社区·族系反证】B 站 749 题实测（BV17uaX6fESz，早于本模型发布）：Jev 1.13 94.7%，同场小开源模型远弱于 Jev（另案 D244）。对本模型无直接结论。

### 3.3 有没有更贴合的 prompt_version / 微调配方

- **prompt_version 只有 `hmm-zh-v1` 一个**，无备选。
- Chinese-Jev 官方权重未发布（"coming soon"），且它是 encoder-only 322M、按论文先 General 后分域微调，输入编译口径不同——即使发布也要重新对账。
- **现实的自适配路径是自微调**：本 repo 的 `scripts/train.py` + `decision/` 全流程开源（LoRA、软标签分布交叉熵、温度标定、候选打乱），数据格式就是 CJ 的 `{state, questions, gold}` JSONL。用我们 recall-effect-audit 盲判产出的标签（D241/D262 闭环）构造几百到几千条"state+记忆→会不会改变做法"样本做 LoRA 微调 + 温度重标定，是把 OOD gap 消掉的最短路径。训练成本参照：hmm 作者用 1×RTX 3090 训 4B 只花 2 小时 $0.42——我们 0.8B + 小数据在 3060 Laptop 上可行。

---

## ④ 已知评测与坑

### 4.1 评测全景（**除我方 D262 外无任何第三方实测**）

【官方·模型卡】CJ-Bench 全量 307,900 条，两套温度口径（T=1 adapter 与 T=1.108 合并权重；⚠️ GitHub README:505 仍写"T=1.108 尚未单独评测"——**陈旧**，HF 模型卡已补全量数字，以 HF 为准）：

| 口径 | micro ACC/ECE | general | medical | legal | finance | noul | choice | score |
|---|---|---|---|---|---|---|---|---|
| T=1（adapter） | 83.11 / 1.07 | 72.24/3.03 | 88.86/0.17 | 67.86/5.70 | 74.22/1.50 | 94.95/0.39 | 78.33/1.48 | 56.47/2.35 |
| **T=1.108（发布权重）** | 83.11 / **0.27** | 72.26/**1.68** | 88.85/**1.12**↑ | 67.84/**4.05** | 74.00/**2.45**↑ | 94.96/**0.19** | 78.32/**0.58** | 56.45/**1.67** |

（ECE 单位 %；↑=比 T=1 恶化。基线行 Jev 68.35/11.45（通用）、77.01/5.57（专业均）等**直接引自 Chinese-Jev 论文 Table 1/2，本项目未复现**。）

【官方·验证子集 1200 条】温度前后的分型 ECE：**noul 0.39→3.44（恶化 +3.05pp）、choice 4.05→2.99、score 6.69→5.21**；分域：general 3.69→5.18 恶化、medical 3.51→3.76 微恶化、legal 8.62→7.47、finance 3.72→3.67 改善。**与 CJ-Bench 大表方向相反**（那边 noul 0.39→0.19 改善）——同温度在两个口径下对 noul 的校准方向不一致，小样本（每格 100 条）波动大。

【官方·分来源弱点】（validation_report.json，after 口径小样本）：webmedqa ECE 0.583(n=1)、usts 0.540、medqa_taiwan 0.405；general 域 ACC<0.65 且 ECE>0.1 的来源：explicit_legal_rules 0.447/0.133(n=123)、cflue_knowledge 0.541/0.086(n=109)、poetry_mteb 0.424/0.199(n=33)、t2ranking 0.588/0.181(n=17)——**文学/排序/显式规则类是明确弱点**。

【第三方】**没有**。HF 4 下载 0 评论、GitHub 0 issue 0 PR、中英文搜索（知乎/CSDN/X/HF discussions）无任何独立评测帖——只有 Chinese-Jev 论文的聚合转载（CSDN Together_CZ、chatpaper）。B 站实测视频不含本模型（早于发布）。**任何"有人说它好用/不好用"目前都不存在。**

### 4.2 坑清单（按对我们门控的杀伤力排序）

1. **【校准-域依赖】单一全局温度对 noul 的校准方向在两个官方口径上互相矛盾**（CJ-Bench 0.39→0.19 改善 vs 验证子集 0.39→3.44 恶化）；且 OOD 上概率可信度未知——hmm 表亲实测 in-domain ECE 0.02–0.03 但 vitaminc/squad2/helpsteer2 等 OOD 任务 0.14–0.20（作者原话 "the probabilities are not equally trustworthy everywhere"）。**⇒ 我们的门控阈值绝不能直接拿官方 ECE 背书，必须在自己语料上重标定（画 reliability diagram / 算 ECE 后再拍阈值）。**
2. **【问法 OOD】"会不会改变你的做法"是反事实元问题，训练集 1305 万条里没有这一类**——所有训练 noul 都是对 state 内容的命题判断。我方实测 AUC 0.679 已量化了这个 gap：信号存在但中等，**只可当软排序器，禁二元硬过滤**（recall 0.565 会漏掉近半真会改变做法的记忆；二元退休门的错杀教训见 arXiv:2610.15710：39.2% 暗示变更被错杀）。
3. **【候选行长度分布】训练候选行是短语级，我们的候选行是几百字记忆正文**——`A: true — {整条记忆}` 的形态在训练分布右尾之外。缓解：候选行只放标题+首句/摘要，正文并入 state（我方 run_gate 已是"state=上下文+候选记忆全文"的混合形态，等价于把长文本放 state 侧——比放候选侧更贴训练分布）。
4. **【单条 padding bug 的复活风险】**自写调用代码若把单条输入 pad 到 64 倍数（为了对齐或批量），概率会漂移至 0.11（commit 2dc119a 实测）。**判据：单条绝不 pad；批量时 pad_to_multiple_of=64 且 batch≥2。**
5. **【互斥 softmax 语义】概率是候选间竞争的归一化结果。noul 的 p_true 语义="true 比 false 更像答案"，不是独立的置信度——如果候选描述写得含糊，分布会趋近均匀而 p_true 仍有读数。confidence=(K·p_max−1)/(K−1) 只是尖锐度。**
6. **【长度悬崖是硬的】16,384 tok 超长直接 422/报错，不截断。我们 500 tok state 安全，但若未来把整个会话历史塞进去要注意。训练分布上限其实是 1024（General 域），1K–16K 区间的行为无训练保证。**
7. **【score 题弱 + legal/finance 训练占比 0.37%】**我们不用 score 型，法律/金融域也非我们主题——影响有限但知悉。
8. **【供应链新鲜度】**仓库 48 小时大龄、7 提交全 AI 共著、0 社区验证、权重 4 次下载。模型卡/README 已发现一处文档失同步（T=1.108 评测）。**风险=上游随时可能出 v2 或改数**——好处是全流程开源可自持（权重已本地化 + 训练代码在 repo，上游消失也能自训）。
9. **【generate() 无意义】**只在末位字母上训练过，当文本生成器用会输出乱码——不要复用这个权重做任何生成。
10. **【许可组合】**模型 Apache-2.0 ✅；但 **CJ-Dataset 部分来源非商业（CC BY-NC/NC-SA）且不授再分发**——自用没问题，若未来"拿 CJ-Dataset 补训我们门控数据再发布模型"需逐来源核查。

### 4.3 延迟与本机适配（父代理已实测）

- 官方口径（A800 80GB BF16）：单条中位 70.1ms、132 条/s、峰值显存 6.7GB、平均输入 223 tok。
- 本机（RTX 3060 Laptop 6GB，已占 ~3.2GB 跑嵌入）：**全量 706 次前向 122 秒 ≈ 173ms/条**（父代理实测），可用；GGUF Q8_0（812MB）+ llama.cpp CPU 是无 GPU 显存时的备选。

---

## 判决（回给委托方）

**① 一句话判决：有重大保留——形态匹配（中文、一次前向、noul、500tok 在分布内）、校准有官方证据（CJ-Bench noul ECE 0.19%），但"会不会改变做法"这个反事实问法是 1305 万训练样本里不存在的 OOD 问法，唯一实测（我方 1110 前向）AUC 0.679 定死了它的上限：只能当软排序/加权信号，不能当二元硬门。**

**② 我们最可能用错的地方（按概率排序）**：
1. **直接拍固定阈值做二元过滤**（p_true>0.5 就注入/退休）——recall 0.565 会漏掉近半正样本，且 OOD 校准未验证，官方两口径 noul ECE 方向都矛盾；
2. **把整条记忆塞进候选行**（应放 state 侧，候选行保持短语级贴训练分布）；
3. **自写代码时单条输入 pad 到 64 倍数**（概率漂移 ≤0.11 的已修复 bug，极易复活）；
4. 混用两套温度口径的 ECE 数字给阈值背书。

**③ 报告路径**：`/tmp/chinese-decision-model-report.md`（本文件）。配套：本地契约+对账存档 D277；网络侧收口 D283；调用脚本 `/home/h/cd-exp/run_gate.py`（与官方零偏差，注意 sys.path 指向 /tmp 副本的脆弱点）。

**主要出处**：
- GitHub：https://github.com/yanqiangmiffy/chinese-decision （README、THIRD_PARTY_NOTICES.md、commits）
- HF 模型卡（权重+T=1.108 全量评测）：https://huggingface.co/quincyqiang/chinese-decision-0.8b
- CJ-Dataset：https://huggingface.co/datasets/bbldCVer-hf/CJ-Dataset
- hmm（方法上游）：https://github.com/n4ze3m/hmm 、https://github.com/n4ze3m/hmm/blob/main/BENCHMARKS.md
- Chinese-Jev 论文：https://arxiv.org/abs/2609.36965 ；项目页：https://gulucaptain.github.io/Chinese-Jev/
- 我方实测（D262/D241/D244，记忆河流）
