# BUG-1014 无头 bin 第三竞态（**已结案：真因是「头被外部删掉而内存仍记着头在」**）

**状态**：**CLOSED**（2026-10-14 晚，修复 `1811c6b` + 实测零新增）｜**来源**：D102 核验时发现。

## 结案结论（推翻了原假设）

原假设「桶 open 与首写竞态」**被实验证伪**：用修复版（17:05:18 编译，已含验头逻辑）新起一次
acceptance，**仍新增 3 个**无头文件（17:18:46/17:19:01）——说明与「open 未完成」无关，是修复代码
自身还有第三条路径。

**真因**：`headerEnsured` 只是「我们写过头」的**内存记忆**，不等于「盘上头还在」。测试拆桶
`rmSync(bucketRoot)`／外部清理把 `.bin` 删掉后，实例仍以为头在，下一次（去抖 2s 后的）追加
就把路径**重新建成无头记录日志**。`artifact-rebuild-failed: database is not open` 只是同窗口
的**伴生告警**（短命工作区被拆），不是病因。

判据链：
1. 修复版 acceptance 跑完仍新增 3 个无头 → 排除「陈旧进程」与「open 竞态」两种解释；
2. 这些桶只有 `emb-cache.bin`+`memo-river.log`、无库无 dailynote，且**全库零 `.corrupt-*` 留证**
   → 排除「畸形文件改名留证」路径（那条路会留下留证件）；
3. 解出的缓存键是验收夹具（`# 渲染卡顿排查记（关闸重写）` 等）→ 写者是套件的临时工作区。

**修复（`1811c6b`）**：`appendGuarded[Sync]()` —— 每次 append 前**读盘验头**
（`ok|nofile|short|noheader`），非 `ok` 就 `mergeExistingSync()` + 连头全量重写，**绝不 append**；
只有 `nofile && fileBytes===0`（真·新桶）才建头+追加。`load()` 对 0 字节/短于头的文件**不再改名
留证**（那是另一实例正在 create 的中间态，改名会把别人正在写的文件挪走）；删掉被取代的
`ensureHeader[Sync]`。

**验证**：修复版 acceptance **真 EXIT=0 37/37**，无头集合 **10→10 零新增**；存量 10 桶就地补头
（全库 0 无头）；探针 28→36→**49/49**，新增 [I] 文件被删/目录被删/0 字节中间态、[J] 子进程真 exit
的 `flushSync` 通道。

## 现象（原始记录，留档）

2026-10-14 17:07:41，桶 `6d886c20ea072170`（全新工作区首写）产出**无头 bin 记录日志**
（12504B，keyLen=208 / vecLen=3072，缺 MREC 头）。同窗口 memo-river.log 出现：

```
artifact-rebuild-failed: database is not open
```

时间线关键点：该写入发生在 8e8bb63 部署**之后**（17:05:34 服务起、lib 17:05:18 已含验头逻辑），
即前两个竞态修复都在位时仍然复现 → 确实还有第三条路径（真因见上）。

## 顺带修掉的**上游成因**：套件不隔离 DSH_HOME

这些无头文件之所以出现在**生产柜子**里，是因为 `scripts/acceptance.mjs` 等 12 个套件只把 cwd 放
tmpdir、**不设 `DSH_HOME`** → 每跑一次就在真 `~/.dsh/memo-river/` 留 7~14 个永久空壳桶
（288 桶里 186 个空壳，其中 35 个正是最近 2 小时 5 次验收跑出来的）。这不仅堆垃圾，还**污染取证
现场**（本案最早的 8 个可疑文件全躺在假桶里，误导半小时）。整改见 `aa5bb13`：4 个可隔离套件已接
`scripts/isolated-env.mjs`；8 个依赖 `setup-selftest.mjs` 预铺夹具的套件**不能**隔离（隔离后环境
自检必红，实测 EXIT=2），改用 `scripts/clean-junk-buckets.mjs` 定期清扫。详见 AGENTS.md「套件卫生」节。

## 哨兵

`~/.local/bin/dsh-sentinel.sh` ⑤ 监控 `artifact-rebuild-failed|database is not open` 计数仍然有效
（该告警另有独立含义），但**无头 bin 本身的哨兵**应是「`.bin` 首 4 字节 ≠ MREC」扫描——
`scripts/probe-emb-cache.mjs` 的 [G]/[I]/[J] 已把三条路径全部纳入回归。

## 关联

- `1811c6b`（修复）、`aa5bb13`（套件卫生整改）、`docs/whale-fix-2026-10-14.md`（全链复盘）
- D98/D101/D102/D211：鲸鱼案全链（emb-cache 全量重写 → 原生 bin 路径 → 三路径竞态闭环）
- BUG-1003-reimpl-kernel-oom-explosion.md（前案）
