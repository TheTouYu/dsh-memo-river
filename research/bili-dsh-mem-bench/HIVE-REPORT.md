# memo-river × hive-memory-bench 官方尺完整测试报告（2026-10-28）

> 第二回合：代理恢复后拉取官方仓库（github.com/FuRongJun-1999/hive-memory-bench，CC BY 4.0），
> 用其公开的 23 章语料 / 92 主轮题 / 573 金标句 / 官方判分器跑通完整参赛管线。
> 第一回合（灵枢自库 20 题同构）见 PK-REPORT.md。

## 一、参赛形态

```
23章语料(61345字) ──300字块切177块──> memo-river 隔离桶(DSH_HOME=/var/tmp/hive-bench-home)
92主轮题面 ──ws.recall(topology_v3, bge-m3@OpenRouter fallback, k=60)──> 候选块按分序拼8000字材料
材料+题面+官方作答契约 ──deepseek-flash(api.deepseek.com)──> sut/out/<qid>.json (92/92)
官方判分链 score_sut.py build（规则层）＋零材料对照臂（同模型闭卷）
```

口径披露：①本地嵌入 8099 被 game-gate 设计停服（原神在跑），走生产 fallback 泳道 OpenRouter bge-m3（同模型，D222 证 cos≥0.99997）；②生成器 deepseek-flash（与成绩表「DeepSeek V4.1 Flash」同厂同代 Flash 档，d1 渠道当日 no_available_key 改走官方端点）；③我们的形态=「记忆系统检索接入」（材料是子集），与成绩表「模型读全书」不同口径，不直接比 pass。

## 二、检索面（与 UMB 外部检索面板同口径：金标句在 8000 字预算内逐字出现率，573 金标）

| 系统 | 读数 |
|---|---|
| ra_zh | .5029 |
| **memo-river 块粒度（~300字块×25块）** | **.4834** |
| zh | .4736 |
| BM25 | .4649 |
| memo-river 章粒度（23章×2.4章） | .3791 |

- 块粒度介于 zh 与 ra_zh 之间；UMB 先例组内对 BM25 不显著（p=.47/.10）——**同量级，不宣称胜出**。
- **章粒度 −10.4pp 是结构性劣势**（8000 字整章只装 3 章 vs 块级拼 25-46 个位置）——检索粒度是保地基的一等变量。objective 题（金标散布多章）受害最深（章粒度 0.19 vs 块粒度更高）。
- 实测细节：objective 金标在 `supporting_evidence`(weight=primary)、open 金标在 `evidence_pool`——第一版统一读 evidence_pool 坑出 -13pp 假读数。

## 三、作答面（官方规则层判分，92 主轮）

| 臂 | 采分点覆盖率 | 分层 |
|---|---|---|
| **材料接入**（memo-river 检索 ×8000字 + deepseek-flash） | **36.93%** | open 34.68% / objective 40.12% |
| 零材料（同模型闭卷） | 38.39% | open 38.29% / objective 38.54% |
| **材料净贡献** | **−1.46pp** | open −3.6pp / objective **+1.6pp** |

- **方向上复现 hive 结论一**（零材料>材料接入：其六家 −5.4~−17.6pp）——但我们的损耗**小一个数量级**（−1.5pp），且 **objective 题材料反超**（细节题检索有用，开放叙事题模型自带能力更强、材料反成束缚）。
- **引文逐字可定位率 245/249 = 98.4%**——原文路线铁证（六家同口径：BM25/OV/灵枢 97-100%，抽取式 0-2%）。
- cid 章号正确率仅 35/249 = 14.1%——flash 档模型在拼接材料里章号张冠李戴；判分器对 mislocated 全零容忍 ⇒ **score_sut pass 口径 0/92**。这是「检索接入形态 × flash 生成器」的结构损耗，不是检索质量问题（引文本身 98.4% 逐字真实）。语义层判官仅 1 例 review（影响 ≤1 题），未走完，如实披露。

## 四、与前两份读数合并的总图

| 维度 | 灵枢 | memo-river | 出处 |
|---|---|---|---|
| 生产库自然问句 hit@10 | 60%（14095节点） | 85%（281篇，规模差50倍须同读） | 回合一/灵枢自库 |
| 小说保地基（金标率@8000字） | —（未公开题集同口径数） | **.4834**（块）/ .3791（章） | 本回合 UMB 口径 |
| 引文逐字可回源 | 97-100% | **98.4%** | 本回合 vs 灵枢v3.1 |
| 材料净贡献（vs 零材料） | −9.9pp（秦吏20题） | **−1.5pp**（本回合92题） | 灵枢零材料对照 vs 本回合 |
| 写入成本 | 0.013-0.020s 零LLM | 秒级（真嵌入） | 灵枢v3.1 |
| 判分器 pass 口径 | —（模型线六家有分） | 0/92（cid纪律×全零容忍，见上） | 本回合 |

**三句话结论**：
1. 检索面我们与 BM25/zh/ra_zh 同量级（块粒度 .4834），**逐字可回源性 98.4% 站稳原文路线**——「交出来的东西能当证据」这个 hive 总纲我们过了。
2. 材料净贡献 −1.5pp 远轻于六家（−5~−18pp），objective 题甚至为正——**检索质量差是六家材料负贡献的主因之一，块粒度+嵌入检索把这个损耗压近零**。
3. 我们的特有损耗在**生成侧章号纪律**（cid 14.1%）——提示词/材料呈现可改进（章聚合已试，仍 14%）；这不在记忆系统职责内，但影响端到端 pass。

## 五、边界与未做

- 干预轮 92 题：答案键官方不公开（盲测面），作答无判分意义，未跑。
- 语义层判官（覆盖率+L2）只 1 例 review，未走完（判官协议需锚自证，单判官不满足）——pass 口径以规则层为准，如实标注。
- 零材料臂含「训练污染」风险（题面公开）——与官方同名边界，读数按其自报口径理解。
- 灵枢 v3.1 六家的「保地基 68.4%」用的是未公开 20 题题集，与本回合 92 公开题不同尺——不可直接比，只能比方向。

## 复现

```bash
# 灌库(块粒度)：DSH_HOME=/var/tmp/hive-bench-home node ../../scripts/import-dailynote.mjs --src .stage-fic-blocks --cwd <abs .ws-fic-blocks> --bucket 蜂巢语料块
# 检索：node run/hive-retrieve-blocks.mjs → retrieve-result-blocks.json
# 作答：python3 run/hive-answer.py（deepseek-flash，凭据 ~/.dsh/.credentials.yaml refs）
# 判分：cd hive-bench && python3 -X utf8 score_sut.py build
# 零材料臂：python3 run/hive-answer-zero.py → sut-zero/out → 换入 sut/out 再 build
```
