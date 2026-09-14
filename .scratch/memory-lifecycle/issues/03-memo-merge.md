# 03 — memo_merge：多篇归一与归档退役

**What to build:** agent 能把多篇旧日记合并成一篇：给出源篇 id 列表与合并后内容；源篇 `.md` 移入 `archive/` 子目录（人可读、保留原 Tag 行），库内行级联退役（chunks/file_tags 随之外清）；合并篇入库——新篇走 `memo_write` 路径，或并入既有篇走 `memo_update` 的 upsert；合并内容**仅对声明的源篇**豁免去重闸门；正文自动落「合并自 D…, D…」溯源行。合并后召回只命中合并篇。这是「压缩式遗忘」的执行通道：600 token 注入预算下，语料变瘦变响亮。

**Blocked by:** 02 — memo_update（复用其 upsert 与闸门自排除机制）

**Status:** ready-for-agent

- [ ] 2 合 1 后：总篇数 -1，archive/ 留有 2 个源文件，召回不再命中源篇
- [ ] 合并后体检连通分量仍 = 1（Tag 语义延续不断裂）
- [ ] 去重豁免只对声明源生效：与未声明篇高相似的合并内容仍被拒
- [ ] 合并篇正文含「合并自 D…, D…」溯源行
- [ ] archive 源文件保留完整原文与 Tag 行，可追溯
- [ ] DESIGN.md 更新（归档语义、溯源规范）
