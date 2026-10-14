# BUG-1014 无头 bin 第三竞态（桶 open 与首写竞态）

**状态**：OPEN（低危，观察中）｜**来源**：D102 核验时发现，本篇为正式立案。

## 现象

2026-10-14 17:07:41，桶 `6d886c20ea072170`（全新工作区首写）产出**无头 bin 记录日志**
（12504B，keyLen=208 / vecLen=3072，缺 MREC 头）。同窗口 memo-river.log 出现：

```
artifact-rebuild-failed: database is not open
```

时间线关键点：该写入发生在 8e8bb63 部署**之后**（17:05:34 服务起、lib 17:05:18 已含验头逻辑），
即前两个竞态修复都在位时仍然复现 → 存在第三条路径。

## 当前假设

**桶 open 与首写竞态**：全新工作区首次写入时，artifact 重建/append 在 workspace open 完成
（database open）之前被触发；失败后回退路径写出的 bin 缺头。

## 为什么低危

- 仅影响全新工作区首写窗口；已知桶（open 已完成）不触发。
- 无头 bin 会被后续重建视为损坏并重建（清淤路径已验证）。
- 但它污染日志、消耗一次重建，且「database is not open」告警会**淹没真正的事故信号**。

## 待办（修复路线）

1. **复现**：脚本连续 create 100 个全新临时工作区并立即首写（沙箱 DSH_HOME），统计无头产出率。
2. **修复方向**（二选一或都做）：
   - JS 侧：workspace open 未完成时**排队**首写（写前 await open promise），而非直接走 fallback；
   - rust 侧：append 路径检测 db 未 open 返回明确错误码，JS 侧据此重试而非落 fallback。
3. **哨兵已接线**：`~/.local/bin/dsh-sentinel.sh` ⑤ 监控 `artifact-rebuild-failed|database is not open`
   24h 计数，>0 即弹通知——回潮不再静默。

## 关联

- D98/D101/D102：鲸鱼案全链（emb-cache 全量重写 → 原生 bin 路径 → 两竞态修复 → 本第三竞态）
- BUG-1003-reimpl-kernel-oom-explosion.md（前案）
