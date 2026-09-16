# 13 — 草稿队列破坏性操作的作用域收紧（读宽写窄）

**What to build:** memo_approve / memo_discard 的缺省作用域从「全部桶」收紧为**本桶**；跨桶操作必须显式传 `bucket`；ids 匹配同样只查本桶，未命中时报错并提示跨桶须显式。跨桶生效时输出首行带 `⚠️ 跨桶操作` 警告。schema 描述同步。

**设计原则（作用域不对称）**：读取（memo_drafts）可以宽缺省，写入/丢弃不行——破坏性操作的缺省必须是窄作用域，宽作用域是显式升级动作。

**证据（2026-09-16 事故）**：`memo_discard { all: true }` 未带 bucket，按旧语义「缺省全部桶」一次扫 66 篇——本桶 17 篇（有意弃）+ 两个工作区 48 篇未复核草稿（a92f187f 35 + 6c8bcf85 13）。事故代理已自行恢复（rejected/ 移回 pending/，现场核实 pending 35+15）。同族隐患：ids 子串匹配原本也跨全部桶。

**Blocked by:** None

**Status:** done — 2026-09-16（commit 见 git log；acceptance-draft-scope 4/4；重启后主套件 37/37 全程绿）

- [x] all=true 无 bucket → 只作用本桶；他桶原封不动（T-1）
- [x] ids 指向他桶文件名 → 未命中报错+跨桶提示，不误伤（T-2）
- [x] bucket=不存在 → 明确报错并列出有待处理草稿的桶（T-3）
- [x] all=true + 显式 bucket=他桶 → 跨桶生效且输出带 ⚠️ 跨桶警告行（T-4）
- [x] memo_approve 同一 selectDraftTargets 一并收紧；schema 两工具同步
