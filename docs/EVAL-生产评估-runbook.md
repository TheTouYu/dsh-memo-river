# 记忆河流 · 生产评估 Runbook

> 版本 v1.1 · 2026-09-16（票09 增 §二·8 进程边界条款） · 配套工具 `scripts/eval-production.py` · 基线 `docs/eval-baselines/2026-09-15.json`
> 源头：D38/D39（全项目双日评估）资产化。用户令「多多评测」——每次记忆系统改动后、或每周例行，跑一轮存基线对比趋势。

## 一、怎么跑

```bash
cd /home/h/app/dsh-memo-river
# 最近 48h（默认），输出 /tmp/mr-eval/summary.json
python3 scripts/eval-production.py
# 对比上次基线，打印关键 Δ（inject n/mean、pending 堆积）
python3 scripts/eval-production.py --baseline docs/eval-baselines/2026-09-15.json
# 存新基线（改动验收后）
python3 scripts/eval-production.py --since-hours 48 --out docs/eval-baselines/<日期>.json
```

只读操作：扫会话 JSONL（zstd 流式）+ `~/.dsh/memo-river/` 桶日志，不写任何库。全程 `nice` 友好。
测试桶（含「测试/探针/空桶/孤岛/草稿/gate」字样）自动剔除；桶发现全自动（plugin.log session-start ∩ hex 目录）。

## 二、八项指标（定义 · 数据源 · 判据）

| # | 指标 | 数据源 | 健康判据 |
|---|---|---|---|
| 1 | 写入覆盖 | 会话注入数 + 桶 writes + preset 字段 | 有记忆插件的会话均非零；关注 preset=standard/plugin-dev 但 bk=None 的暗会话 |
| 2 | 写入纪律 | 会话 tool_errors + 桶 newTags | 错误=0；新 Tag 极少且有理由 |
| 3 | 注入精度 | roles 分布 / gate拦 / identical / k截 | direct_answer 占比；gate 拦截率是否分桶合理 |
| 4 | 主动补证 | memo_recall 次数 | 有「被动不够→主动补」实例 |
| 5 | 使用效果 | 引用=注入∩正文 D-id | 交互会话 >50%；自主会话单独看 |
| 6 | 语料健康 | health.log 尾行 | components=1；hub <1/3；uncovered 低 |
| 7 | 遗忘落地 | approve/discard/merge 工具数 + pending | pending 不堆积；approved 跟上 collected |
| 8 | 性能 | inject elapsedMs（桶日志）+ memo_write 时延（会话侧） | 注入 mean <3s、p95 <5s；write 无 >30s 尾部；**Δ 对比须先过进程边界条款（下）** |

**8 · 进程边界条款（票09，2026-09-16）**：性能 Δ 只有在「同进程」下才可归因——存在启动时间早于基线捕获时刻、
且横跨到观测窗的 DSH 主进程（`ps -eo pid,lstart,cmd`，exe=`node …/bin/dsh`；解析失败回退 `/proc/<pid>/stat`
field22+btime）。基线捕获后主进程已全体重启 → `--baseline` 自动打「**版本不一致，归因无效**」标，该 Δ 禁止记为代码战果。
实测口径与两点告诫：

- artifactSig 代际时间线在中央 plugin.log 的 `guardian artifact-rebuilt sig=…` 行（health.log 不含 sig——票面
  写 health.log 系记忆偏差，实测纠正）；代际更替多为语料写入驱动的常规重建，**只提示不闸门**（否则活跃桶永远打标，检查形同虚设）。
- 同进程 ≠ Δ 可记代码战果：被评估代码若提交于进程启动之后，运行中的仍是旧代码（09-15 险情 D58：c9f838ba 夜间
  inject mean 2311ms vs 基线 5836ms，进程 09-14 21:08 启动未重启，Δ 实为端点时变；perf 票 01/02 收益至今未经生产验证）。
  跨窗期间新起的进程（载入当时盘上代码）同样只提示不打标——其影响的读数份额可按会话/时间下钻分离。
- 判定逻辑自检：`python3 scripts/eval-production.py --selftest-attribution`（合成进程表验证同进程/打标/无进程三态）。

## 三、2026-09-15 基线快照（48h 窗口，25 会话）

| 桶 | inject n | mean | p95/max | gate拦 | pending | 健康 |
|---|---|---|---|---|---|---|
| dsh-preset-composer | 153 | 6437ms | 9840/16319 | 6 | **34** | hub 真挂载校验 33/79 |
| dsh-memo-river | 27 | 5836ms | 8124/8902 | 20 | 7 | hub 上游对照 14/39 |
| genshin-model-studio | 0（窗口） | - | - | - | 0 | hub 本地服务8787 13/19 |
| genshin-ts | 1 | - | - | - | - | 空转边缘 |

- memo_write（会话侧）：n=136 mean 7084ms p50 4717ms **max 120071ms**
- 漏斗：draft-collected=133 vs 生产桶 approved=0（断裂）
- 引用率：8cff709e 31/35、712451c 32/63、自主文档型 8a11cf44 0/33
- 暗会话：dsh-agi-harness ×2（U=17，preset=standard/cordis，零注入）、preset-composer 若干 plugin-dev/standard 会话
- 性能根因实测：端点 api.relayrouter.ai 单条嵌入 RTT 1.19-1.45s（其中 TLS 握手 ~0.8s），注入路径 = recall.ts:185/219 **两次串行单条调用**（queryField + gate 锚），超时默认 60s（embed.ts:41）

## 四、已知盲区（读数时记住）

1. 「引用」只扫 assistant 正文，不扫 reasoning——自主态真实利用率被低估。
2. 正在写入的会话读数是部分快照（含当前会话自身）。
3. 子代理会话（preset=memo-river，父会话在 preset-composer）独立计数，算覆盖积极信号。
4. bk=None 但 preset 非 plugin-dev 的暗会话需人工判断：预设注册表差异 or 插件未装。

## 五、复评节奏建议

- 记忆系统任何改动（尤其嵌入路径/草稿流）→ 改动后 24h 跑一轮 + 存基线
- 例行：每周一轮，重点看注入时延分布与 pending 是否回落
- 每轮结论落一篇日记（Tag 建议：被动召回 / 上下文审计 / 门控校准 / 嵌入时延）
