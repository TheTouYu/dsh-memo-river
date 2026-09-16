# 09 — eval 归因自动化（进程版本边界标注）

**What to build:** eval-production.py 自动读 DSH 主进程启动时间（与嵌入资产 artifactSig 变更时间线），观测窗与基线窗对比时若跨越进程重启/代码版本边界，输出打「**版本不一致，归因无效**」标；runbook 性能判据补「同进程对比」条款。杜绝把端点时变方差记成代码战果。

**证据：** 2026-09-16 误归因险情（D58 纠偏②）：c9f838ba 夜间 inject mean 2311ms vs 基线 5836ms，DSH 进程 09-14 21:08 启动未重启——同进程读数差异实为端点/嵌入缓存时变，perf 票 01/02 收益至今未经生产验证。

**Blocked by:** 08 — 同一脚本，先扩作用域再加归因层

**Status:** done — 2026-09-16（证据：代码 commit 45cfff7 + 本票 docs/runbook 提交；selftest-attribution 4/4；主套件 37/37；两例演示见落地记录）

- [x] 跨重启窗口的对比输出带版本不一致标
- [x] 同进程窗口不带标
- [x] runbook §八性能指标附进程边界条件条款
- [x] 用 docs/eval-baselines/2026-09-15.json 演示两种情况各一例

## 落地记录

- **判据**：存在「启动 ≤ 基线 captured 且仍在运行」的 DSH 主进程（exe=`node …/bin/dsh`，ps lstart→epoch，
  procfs field22+btime 回退）→ 同进程不打标；一个都没有 → 判定行 + Δ 头均打「✗ 版本不一致，归因无效」。
  跨窗新起进程（如 09-16 02:01 的 web:3100）与 artifactSig 代际更替只提示不闸门——更替多为语料写入驱动
  的常规重建（本窗 20 代），做闸门则活跃桶永远打标，检查形同虚设；此口径已写入 runbook 条款。
- **实测纠正**：artifactSig 时间线在中央 plugin.log `guardian artifact-rebuilt sig=…` 行（health.log 不含
  sig，票面写 health.log 系记忆偏差）。
- **演示①（同进程，不打标）**：`--baseline docs/eval-baselines/2026-09-15.json`（captured 09-15 17:42）→
  贯穿代 pid 2442032@09-14 21:08、2460568@09-14 21:34；pid 3473205@09-16 02:01 标「跨窗新起，仅提示」；
  判定「同进程，Δ 对比成立」+ 提醒「同进程 ≠ Δ 可记代码战果（旧代码仍在跑，端点时变会伪装成效——即 D58 险情）」。
- **演示②（跨重启，打标）**：`/tmp/mr-eval/baseline-cross-demo.json`（同基线内容，generated 改 09-14 20:00=
  最早现存进程启动之前，另造跨边界样例）→ 三个现存进程全部晚于基线捕获 → 判定行与「=== Δ vs 基线 ===」头
  均带「✗ 版本不一致，归因无效」。
- **自检**：`python3 scripts/eval-production.py --selftest-attribution` → 4/4 PASS（同进程/同进程+新起/
  全体重启/无进程四态，验证标记串出现与缺席）。
- **回归**：npm run build ✅；acceptance.mjs 37/37（≥36 底线）。
