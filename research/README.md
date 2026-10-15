# research/ — 验证取证的留档区

本目录存放**为验证/选型/取证而产出的调查报告与实验数据**的归档（2026-10-15 起建）。它不是产品文档——产品文档在 `docs/`；这里的每一份文件都是「当时为什么这么判断」的证据底稿，供事后审计与翻案复核，不保证结论仍然成立（各件自带的日期与信源分级是判断时效的依据）。

## 索引

| 路径 | 一句话内容 | 来源代理/会话 | 日期 |
|---|---|---|---|
| `vcp-rp-forensics.md` | VCPToolBox 残差金字塔（RP）独立取证：判定「RP 只算查询↔tag 海的新颖度/覆盖率、V9.1 内生残差六消费点全为增益/门控、零过滤」成立，但修正一个隐含推论——上游已有条目级余弦去重（`result_deduplicator.rs` 裸余弦 0.92 贪心），「残差迁到条目空间」须论证为机制升级而非从无到有 | 独立取证子代理，受 session-d382c913 委托 | 2026-10-15 |
| `residual-selection-lit.md` | 「正交残差候选选择」文献调查：查询侧减除=OMP、候选侧残差=贪心 DPP（数值验证 Schur 补恒等式），无新颖性可言；A 级实测（arXiv 2610.09412，bge-m3、k=5）干净池上一切固定多样化输给纯 k-NN、高冗余池才反超；紧预算下多样化净亏，「砍紧+按有用性选」才是正解 | 残差选择专项子代理（glm-5.3 max），受 session-d382c913 委托（D266 简报③） | 2026-10-15 |
| `decision-models/` | 决策模型（System One 族）选型调查与采用结论，见子目录 [README](decision-models/README.md) | 多轮调查子代理，受 session-d382c913 委托 | 2026-10-15 |
| `recall-effect/` | 「注入的记忆是否真被用上」盲判实验全套数据，见下表 | 召回实效审计线（recall-effect-audit 方法） | 2026-10-15 |
| `recall-effect/adoption-summary.md` | 注入→被用上实验室汇总：52 条注入对齐 24 轮，L1（lexical-strict）判据注入组 31.4% vs 对照 29.6%，lift 仅 1.8pp——**几乎无信号，判据测的是话题重合不是被用上** | 召回实效审计线 | 2026-10-15 |
| `recall-effect/adoption-rounds.jsonl` | 上表的轮级明细：每行一会话轮（session/bucket/turn、注入 ids、诱饵 decoy ids、助手正文字数、工具调用序列） | 召回实效审计线 | 2026-10-15 |
| `recall-effect/adoption-sample-50.md` | 供人工复核的 50 轮样本单：逐条列 L1 分数与「□真用了 □碰巧 □无法判断」勾选框 | 召回实效审计线 | 2026-10-15 |
| `recall-effect/judge-verdicts-v2/`（24 件） | glm-5.3-flash 盲判逐轮裁决原文：每件头部注释记请求构造（上下文原样+末尾追加元问题、usage 数字），正文为 `CAND D<id> used\|topic\|unused <理由>` 标签行 + `SUMMARY 注入/起作用/反作用` 行 | 召回实效审计线（判官=glm-5.3-flash 直连） | 2026-10-15 |
| `recall-effect/candidate-labels-v2.json` | 从上述 24 份裁决机器提取的条级标签集（`{file, d, label}` 三元组，label∈used/topic/unused），供判据统计复用 | 召回实效审计线 | 2026-10-15 |
| `recall-effect/gate-calibration.md` | **判别式门控标定（P0b 定稿，202 行）**：判决=**软信号可用（轮内重排器）、阈值不可拍**——top-3 `used` 占比 **24.3%→41.4%**（⑥「会改变下一步做法」，p<0.001；负对照 随机 0.302 / bigram 痕迹 0.306）、nDCG@3 0.564→0.729、k=8 增益 CI 含 0、**RRF 融合更差（0.333 vs 0.431）**；概率区间压缩 [0.02,0.81]、9 问法里 8 个分箱非单调；**61/185 条 state 为空、其上信号=0**；**意外发现：现有检索序对 top-3 有用性 ≈ 无增益甚至低于随机（macro 0.264 vs 0.302）**。含被证伪项：「选问法看操作点不看 AUC」被推翻（错因=事后挑阈值的挑选偏差） | P0b 标定子代理（glm-5.3 max）；主代理独立复跑 `analyze_rerank.py` 复核 | 2026-10-15 |
| `recall-effect/gate-calibration-reliability.png` | 9 问法 reliability diagram（283KB）。⚠️ **未经视觉核验**——本机两个子代理 provider（`zai-coding-cn` / `deepseek-official`）**均无多模态模型**，只做了对象级核验（生成时零缺字形警告 + 文件非空白）。需要时用外部视觉模型复核 | 同上 | 2026-10-15 |
| `vcp-algorithm/` | VCP 浪潮算法作者口述知识提炼 + B站字幕库 + 上游文档快照，见子目录 [README](vcp-algorithm/README.md) | B站学习线（bilibili-learn 方法） | 2026-10-15 |

## 未入库但存在过（tmpfs 已失或仓外）

以下材料在调查期间真实存在并被使用，因**版权/隐私/体积/冗余**不入库。本节就是它们存在过的唯一索引：

| 东西 | 在哪 | 是什么 | 怎么重新生成 |
|---|---|---|---|
| 第三方论文原文缓存 | `/tmp/lit/`（8.3M，**tmpfs，重启已失**） | 14 篇多样化/选择文献的 PDF+全文 txt（mmr1998、dpp-coling2020/2022、lesota2021、xquad-trec2009、ziegler2005b、linbilmes2011、ashkan2015、sensor-jmlr2008、balance=arXiv 2610.09412、redundancy=2608.13956、noise=2401.14887、dppgreed=2206.05947、ethay=1909.00512） | 按 `residual-selection-lit.md` 头部列出的 arXiv id / DOI 逐篇重新下载；生成方式=该调查子代理自行下载，无脚本 |
| 判官数据包（真实会话原文） | `/tmp/batch2/judge-packets/`（3.9M，**tmpfs，重启已失**） | 24 份 `raw-NN.md`：一轮完整生产对话原文 + 末尾追加的元问题——含真实用户消息，隐私+体积不入库 | **生成方式未记录**（无脚本名落盘）。请求构造格式完整保存在 `recall-effect/judge-verdicts-v2/` 每件头部注释里，方法=recall-effect-audit 技能的盲判协议，可据此复做 |
| 决策模型实验资产 | `/tmp/cd-exp/`（2.6G，tmpfs）与 `/home/h/cd-exp/`（2.2G，**仓外持久位置，未失**） | 训练/评测全量资产：`analyze.py`、`build_tests.py`、下载与训练日志（download.log、full*.log） | 目录内自带脚本（`analyze.py`/`build_tests.py`）；`/home/h/cd-exp/` 不在 tmpfs，无需抢救 |
| v1 旧版标签 | `/tmp/decision-dataset/candidate-labels.jsonl`（63K，**tmpfs，重启已失**） | candidate-labels 的 v1 口径（jsonl），已被 v2（`recall-effect/candidate-labels-v2.json`）取代 | 无需再生，v2 已取代 |

另：`/tmp/startlux-9b.md`、`/tmp/lavoir.html`、`/tmp/startlux-paper.txt`、`/tmp/jev-mem.txt` 等 HTML/论文快照在调查报告中被引为「证据落盘」，同属 tmpfs，关键内容已摘录进各报告正文，原件未归档。

## 如何复跑

**报告正文均未记录可直接粘贴的复跑命令**（它们是取证/调查文档，不是脚本产物）。可指认的再生成路径：

- **vcp-rp-forensics**：无脚本。方法=按报告头部「方法」行列出的文件清单（ResidualPyramid.js 394 行、result_deduplicator.rs 286 行等）人工重读 `/home/h/app/VCPToolBox/` 源码；报告已附证据强度与盲区清单。
- **residual-selection-lit**：按报告头部 arXiv id 清单重新取原文；其「自查推导」（Schur 补恒等式数值验证）可用任意数值库对随机 Gram 复算，报告 ① 节给了完整参数。
- **recall-effect 系列**：生成脚本名未落盘。盲判请求构造（提示词原文、模型、usage 数字）完整记录在 `judge-verdicts-v2/` 每件头部 HTML 注释中，L1 判据定义在 `adoption-summary.md`；按 recall-effect-audit 技能的协议（生产对话原样 + 末尾只追加一句提问，直连独立模型）可重建全流程。
- **gate-calibration（P0b）——本目录唯一有可复跑脚本与数据的一件**。脚本与数据全在 `/home/h/cd-exp/`（durable）：`run_gate2.py`（前向）、`analyze_calibration.py`（Q1 校准）、`analyze_rerank.py`（Q2 重排收益，**主代理已独立复跑、数字逐位对上**）、`analyze_perm.py`（置换检验）、`stability_check.py`（Q4 两跑一致性）、`plot_calibration.py`（出图）、`bench_latency.py`（Q5 延迟）；数据 `gate2-runA.jsonl` / `gate2-runB.jsonl` 各 **1665 行**。
  ⚠️ 跑法：用 `/home/h/cd-exp/gpu/.venv/bin/python`，且**脚本必须 `torch.set_num_threads(2)`**——本仓血泪：不限线程曾吃到 **1126% CPU（11+ 核）**，把同机生产嵌入服务的 encode 从 49ms 饿到 **5633ms**，撞 8000ms 预算触发 embed-timeout。
  ⚠️ **重标定边界**：标签是单次 elicitation 的盲判（有噪声）、24 轮全来自单一工作区、n=124 上 P@3 的聚类 bootstrap **CI 宽 ±0.13** ⇒ **换工作区/任务域必须重跑本节命令**，这不是形式声明。
- **decision-models 系列**：全部一手信源带 URL（HF 卡、GitHub、arXiv、PyPI、榜单），按报告内链接重抓即可。
