<!-- req-01.json  桶=dsh-plugins  注入=7条  messages=22  58201字 -->
<!-- question: 【元问题·不要继续原任务】上面那些自动召回并注入的记忆里，哪些对你起到了真正的作用？只回答这个问题，不要接着做原任务。**每个候选条目单独一行**，格式严格为：`CAND D<编号> used|topic|unused <理由≤40字>`（used=真起作用且能指到具体决策 / topic=只是话题相关 / unused=没用上；引错的写 `CAND D<编号> harmful <理由>`）。正文里可另写归纳，但**标签行必须一行一候选、不得合并**。 最后单独一行给汇总，格式严格为：SUMMARY 注入=<本块条目总数> 起作用=<真正起作用的条数> 反作用=<引错的条数> -->
<!-- evidence: 上下文原样 + 末尾追加提问，22 条消息 / 58201 字；模型 glm-5.3-flash；usage={"completion_tokens":470,"completion_tokens_details":{"reasoning_tokens":190},"prompt_tokens":26381,"prompt_tokens_details":{"cached_tokens":0},"total_tokens":26851} -->

CAND D78 topic|提过插件仓连通分量旧账，但修复决策靠当场体检数据
CAND D149 topic|dsh-ops 背景，与本次修 Tag/写守则无关
CAND D98 topic|鲸鱼 emb-cache 史，本次未涉缓存修复
CAND D26 unused|内核复刻 BUG-0930，本次未引用
CAND D59 unused|熔断防线史，本次未引用
CAND D45 unused|票14 提交史，本次未引用
CAND D7 unused|迁移零填充案，本次未引用
CAND D229 topic|端点与 BUG-1014 勘误，仅背景未进决策
CAND D95 unused|千星奇域笔记，完全无关
CAND D3 used|「该改的位置都改到+验证」自审影响了三篇全补齐并核对体检收敛
CAND D91 topic|Tag 治理方法背景，实操靠体检工具回传
CAND D16 unused|契约测试史，未引用
CAND D2 used|「敷衍根子在系统提示词、修在政策区」直接支撑了把守则写入 AGENTS.md

SUMMARY 注入=13 起作用=2 反作用=0
