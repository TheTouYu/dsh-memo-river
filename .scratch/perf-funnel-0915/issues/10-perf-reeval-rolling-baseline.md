# 10 — 性能复评 + 滚动基线

**What to build:** 01-04 性能票全部落地并稳定运行 ~24h 后，用资产化评估器做一轮正式复评：`python3 scripts/eval-production.py --baseline docs/eval-baselines/2026-09-15.json`，按 runbook 判据验收，把新基线滚动存入 `docs/eval-baselines/`，结论（含是否达标、残余瓶颈）写入河流日记。这是性能优化的闭环票——没有它，前面四张票只是「改了」而不是「好了」。

**Blocked by:** 01（注入合批+超时）、02（连接保活）、03（写侧合批）、04（approve 并行）。

**Status:** ready-for-agent

- [ ] 复评命令一次跑通，Δ 对比表完整输出
- [ ] 注入 mean <3s、p95 <5s（基线 5836/6437ms → 判据见 runbook §二.8）
- [ ] memo_write 会话侧 max <30s（基线 120071ms）
- [ ] 新基线 JSON 落 docs/eval-baselines/&lt;日期&gt;.json，后续复评以它为对照
- [ ] 结论入河（Tag 建议：嵌入时延 / 被动召回）
