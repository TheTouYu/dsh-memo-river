# decision-models/ — 决策模型选型归档

> ## ⚠️ 结论先行（2026-10-15 定）：已采用 `chinese-decision-0.8b`
>
> **我们要采用的门控/排序模型是 `chinese-decision-0.8b`**（yanqiangmiffy/chinese-decision，Qwen3.5-0.8B + LoRA，**中文原生底座**；权重 HF `quincyqiang/chinese-decision-0.8b`）。CJ-Bench 全量 307,900 条：通用 72.24%（超闭源 Jev 68.35%）、专业域 76.98% ≈ Jev 77.01%、整体未校准 ECE 1.07%、noul（是非题）94.95%——门控要的恰是 noul 判断，正中最强档。**许可是两轨，两个说法都对（指的不是同一个东西）**：**仓库代码 = MIT**（`repo/LICENSE` 首行 `MIT License` 实证）；**导出模型目录（权重）= Apache-2.0**（跟权重一起来的 `LICENSE`；仓库 `## License` 节原文：「The base model Qwen3.5-0.8B is under Apache-2.0; **exported model directories keep its original LICENSE**」）。⚠️ **另有一条代理漏掉、对商用有真约束的**：仓库原文「**CJ-Dataset and CJ-Bench licenses are source-specific (some sources are non-commercial)**」——商用前必须逐源核。
>
> ⚠️ **模型作者自报的最硬一条局限（写在这里防后人踩）**：「**`confidence` is not accuracy** — it only measures how sharp the distribution is. **Before acting automatically on a threshold, check calibration on your own data.**」⇒ **拿它的概率拍阈值做自动动作之前，必须在我们自己的数据上先校准。** 其余自报局限：CJ-Bench 分数取自**未合并的 step 10000 / T=1**，导出模型默认 **T=1.108 从未单独评测**；finance 落后闭源 Jev **4.17 点**；`score` 类型整体较弱（56.47%）；**legal 的 ECE 最高 5.70%**；只训中文、不适合开放式生成；不复现 Microsoft Decision/Jev/Chinese-Jev 的训练。
>
> **StartLux / Jev / Laya 这一族是当初的候选、现已降为背景**：StartLux 官方零中文训练/评测披露（一票否决项）、横向数字全为团队自测口径、权重 CC BY-NC 4.0 禁商用；Jev 架构不公开、API-only；Laya base 近随机。选型过程与全部数字见下表各件——**不要从本目录文件名推断我们还在选型**。

## 本目录各件

| 路径 | 一句话内容 | 来源代理/会话 | 日期 |
|---|---|---|---|
| `round1-investigation.md` | 第一轮 System One 族总调查：Jev/StartLux/Laya/Intern-Decision/rev-decision/decision-jef 六家分级评测（StartLux A- 为唯一完整开源但全自测、6GB 显卡只跑得动 0.8B/2B 档）、`/v1/systemone` 接口逐字记录、本地部署可行性 | 决策模型调查子代理，受 session-d382c913 委托 | 2026-10-15 |
| `round1-raw/startlux-gh.md` | StartLux-Decision GitHub README 原文快照（模型家族与 Instant/AutoThink 两型、typed questions、vLLM/llama.cpp/MLX 三后端）——round1 的原始信源 | 同上（抓取件） | 2026-10-15 |
| `round1-raw/startlux-api.md` | StartLux API 参考原文：`/v1/systemone` 与 `/v1/decisions` 请求/响应逐字段（choice/noul/score 三题型、think_mode/gate/think_budget 参数）——round1 的原始信源 | 同上（抓取件） | 2026-10-15 |
| `round2-chinese-speed-perf.md` | 第二轮中文/速度专项：**采用结论的出处**。StartLux 零中文证据判负；Chinese-Jev（复旦/NUS 322M）权重未发布；社区 `chinese-decision-0.8b` 全量 CJ-Bench 实测胜出，含分题型数字与局限清单（单一作者、发布 2 天、基线数字转引论文） | 决策模型调查子代理（第二轮），受 session-d382c913 委托 | 2026-10-15 |
| `jev-mem-analysis.md` | Jev-Mem 论文（arXiv:2609.23986，UT Dallas三方）完整拆解：决策模型控制记忆系统读/写路径的架构、22 个决策点清单（写 8/巩固 5/读 14）、LoCoMo 0.777 与 6.6× 构建加速、Adversarial +22 点——决策模型做记忆门控的最强方法学参照 | 论文精读子代理 | 2026-10-15 |
| `memory-papers-quality-sweep.md` | 高质量论文补扫（用户标准=有实测/可复现/生产级）：A 级「Suggested Is Not Superseded」（arXiv 2610.15710）**否决全自动退役路线**——二元门 39.2% 误伤，须三态+待确认缓冲，直接约束 memo_supersede 自动化红线；含 Mem0 生产延迟数字（p50 75ms） | 论文补扫子代理 | 2026-10-15 |
| `bili/` | B站「决策模型/Jev/StartLux」三关键词搜索 round1 原始结果：`bvids.txt`（12 个候选 BV）、`details.json`（视频详情）、`round1-{关键词,-all}.json`（搜索命中清单，含播放量/时长）——用于筛可学的中文视频，全部落选（无字幕/无实测数字） | B站搜索线（bilibili-learn 方法） | 2026-10-15 |

## 与仓库其他部分的关系

- 采用后的**接入工程**（服务部署、prompt 构造、决策点接线）不属于本目录，见产品文档 `docs/`。
- `memory-papers-quality-sweep.md` 的 G3 红线结论（三态门）与 `recall-effect/` 的盲判实验是同一「判别式有用性」调查线的两条腿。
