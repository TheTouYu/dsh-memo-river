# 8122 决策服务生产一致性验证：/v1/choice 二选项形态复现 noul ⑥

> 2026-10-16 ｜ 接入实现代理 ｜ 草案 v1.1 第 1 步（`/home/h/cd-exp/h8-tri-state-validation-design.md`）
> 基准 = `run_gate2.py` 离线直编（`decision.schema.compile_prompt`，hmm-zh-v1 模板、T=1.10813307762146）⑥「改变做法」问法，gate2-runA。
> 服务 = `dsh-decision.service`（端口 8122，决策模型仓 commit `955b1d2`：`instructions` 参数化 + `append_none` 开关）。
> 数据与脚本 = `/home/h/cd-exp/{run_gate2_repro.py, gate2-repro.jsonl, gate2-repro-arr.jsonl}`。

## 0. 一句话判决

**满分复现，判据通过**：同一 185 条 / 同 state / 同候选集，8122 服务（`instructions`=⑥ 原文 + `append_none=false` 二选项）与离线直编两通路的 **P@3 macro 均 = 0.431**（官方 `analyze_rerank.py` 口径，micro 均 29/70），**|ΔP@3 macro| = 0.0000 ≤ 0.02** ✅。**8122 即 noul ⑥ 的正式生产通路**——H4 重排产品化的通路阻塞解除，客户端无需另载模型。

## 1. 请求形态（复现口径三件套，任何一件不同 ⇒ prompt 不同）

```json
POST /v1/choice
{
  "state_zh": "当前任务上下文：\n{state}\n\n候选记忆（{d}｜{title}）：\n{body}",
  "options": [{"key": "false", "desc": "否"}, {"key": "true", "desc": "是"}],
  "append_none": false,
  "instructions": "读了这条候选记忆之后，会改变当前任务接下来的做法吗？"
}
```

- `state_zh` = `run_gate2.py:87` 的完整拼接原文（含候选正文），不是裸 state；
- `options` = `options_for({"type":"noul"})` 原样 `[('false','否'),('true','是')]`；
- **`append_none=false` 必带**：缺省 `true` 会追加「以上都不需要」逃生位 ⇒ K+1 路 softmax ≠ 离线 2 路；
- 服务温度 T=1.10813307762146 与脚本同源（decision_config.json）。

## 2. 是非题等价性（choice 二选项 vs noul 字母 softmax 直编）

| 统计量 | 值 |
|---|---|
| 成功率 | **185/185**（tok 137–1362 全部 < MAXTOK 2400，零 422） |
| 逐位一致（\|Δp\|<1e-6） | **91/185（49%）** |
| 其余 \|Δp\| | p50=0.0028 / p90=0.0166 / p99=0.0326 / **max=0.0367** |
| 系统偏置 | mean(Δp)=+0.0012（服务微高，量级 ≪ 噪声带） |
| 服务确定性 | 非逐位 94 条抽 20 重打：**20/20 逐位零漂移** ⇒ 差异是两通路**固定执行差**（前向实现/kernel 路径），非随机噪声 |
| 轮内顺序 | Kendall tau mean=0.957（min=0.800）；top-3 集合被改变 6/24 轮，**全部 label 等价**（P@3 分毫不动） |

**结论**：近位吻合成立。两通路在 prompt 逐字符相同（tokenizer 实证）+ 同模型 + 同温度下仍余 max 0.037 的固定差，来源是服务端前向实现与 `forward_batch` 的浮点执行序差异；该量级对重排判据零影响（下表）。

## 3. 重排指标（官方 analyze_rerank.py 口径，全 24 轮重排）

| 条件 | P@3 macro | 95%CI | micro | nDCG@3 | used/槽位 |
|---|---|---|---|---|---|
| 基准（离线直编 ⑥，gate2-runA） | **0.431** | [0.306,0.569] | 0.414 | 0.729 | 29/70 |
| 服务（8122 二选项，gate2-repro） | **0.431** | [0.306,0.569] | 0.414 | **0.725** | 29/70 |
| **|Δ|** | **0.0000** | — | 0.000 | 0.004 | 0 |

口径注：70 槽位 = 23 轮 ×3 + 轮 24（仅 1 条候选，P@3 按 P@1 计）；「全 24 轮重排」无空轮回退——与 gate-calibration.md 的 0.431 同一函数同一口径。生产对齐口径（空 state 10 轮回退原序）另算：双通路均 0.347，Δ=0.000；非空 14 轮均 0.429。

**⚠️ 复现坑（主代理独立复跑时踩到，替后来者填上）**：喂 `analyze_rerank.py` 的**必须是 `gate2-repro-arr.jsonl`**（适配版，字段 = `d/device/label/p_true/q/round/run/sec`，与基准 `gate2-runA.jsonl` 同构）；**直接喂服务原始输出 `gate2-repro.jsonl`（字段 = `d/instructions_used/label/latency_ms/ok/p_true/ranked/round`，缺 `q`）会 `KeyError: 'q'` 崩掉**。复跑命令：

```bash
cd /home/h/cd-exp
/home/h/cd-exp/gpu/.venv/bin/python analyze_rerank.py gate2-repro-arr.jsonl   # 服务通路
/home/h/cd-exp/gpu/.venv/bin/python analyze_rerank.py gate2-runA.jsonl        # 基准（同函数同口径）
# 两行「⑥改变做法」应同为 P@3 macro 0.431 / 29 槽位
```

**主代理已独立复跑上述两行并逐项对上**：P@3 macro 双 **0.431**、CI 同区间 **[0.306, 0.569]**、used/槽位双 **29/70**；nDCG 0.729（基准）vs 0.725（服务）。⇒ `|ΔP@3| = 0.0000` 经第三方复现成立。

## 4. 延迟（串行 185 次实测）

p50=94 / p95=211 / p99=243 / max=270 ms。单条远优于 400ms 预算；**产品化注意**：k=3 注入逐条串行最坏 ≈ 3×p99 ≈ 730ms > 800ms 客户端超时预算——实现时并发 ≤2（GPU 礼仪上限）或按 ~300ms/条给预算。

## 5. 判决沿革与教训

- D313：choice 多候选竞争形态实测负信号（P@3 0.181）——**测量有效，措辞过强**（「noul 收益不可经 8122 获取」）。
- D315：归因修正——负信号真因 = `CHOICE_INSTR` 硬编码技能指令 × 记忆候选错配，非 choice 形态缺陷。
- **本报告（D320）：正向证明**——服务端 `955b1d2`（instructions 参数化 + append_none）后，同一端点以 ⑥ 问法 + 关 none 位完美复现 0.431。H4 通路阻塞解除。
- 教训两条（测量纪律）：① 负信号判决必须钉死「测的是哪种用法」，端点级判决过强；② 引用基准数字必须先跑**官方分析函数**对齐口径——本报告初稿曾自造口径（固定分母 3 / 空轮回退）算出 0.403/0.347 对不上 0.431，根因即轮 24 实际分母与全轮重排口径。

## 6. 对 H4/H8 的含义

- **H4（重排产品化）**：通路就绪。客户端 = 二选项 `append_none=false` 逐条打分（noul 形态），**不是**多候选竞争；超时 800ms 内并发 ≤2；任何失败静默降级原序（既有红线不变）。
- **H8（三态判定）**：继续挂起——四件【SPEC 定】未回，且三态是**多候选 choice 形态**，其有效性验证（草案 v1.1 第 2 步）与本报告的通路一致性是两个问题；CHOICE_INSTR 已参数化消除了最大污染源，但三态判别力仍未测。
