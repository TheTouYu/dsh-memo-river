<!-- req-04.json  桶=dsh-plugins  注入=12条  messages=24  103723字 -->
<!-- question: 【元问题·不要继续原任务】上面那些自动召回并注入的记忆里，哪些对你起到了真正的作用？只回答这个问题，不要接着做原任务。**每个候选条目单独一行**，格式严格为：`CAND D<编号> used|topic|unused <理由≤40字>`（used=真起作用且能指到具体决策 / topic=只是话题相关 / unused=没用上；引错的写 `CAND D<编号> harmful <理由>`）。正文里可另写归纳，但**标签行必须一行一候选、不得合并**。 最后单独一行给汇总，格式严格为：SUMMARY 注入=<本块条目总数> 起作用=<真正起作用的条数> 反作用=<引错的条数> -->
<!-- evidence: 上下文原样 + 末尾追加提问，24 条消息 / 103723 字；模型 glm-5.3-flash；usage={"completion_tokens":344,"completion_tokens_details":{"reasoning_tokens":118},"prompt_tokens":37241,"prompt_tokens_details":{"cached_tokens":0},"total_tokens":37585} -->

CAND D30 unused 整理旧收官账本，与当前技能优化无关
CAND D134 unused 鲸鱼案归因，本任务零交集
CAND D60 unused 鲸鱼复现 bisect，话题无关
CAND D131 unused 服务端复现方法，未参考
CAND D94 used 「别自研、先找现成的」教训提醒我先召回原版再动手
CAND D8 unused vhdx 数据恢复旧案，未触及相关场景
CAND D102 unused 鲸鱼修复核验，无决策输入
CAND D85 unused 重启验证闭环，仅是桶内背景
CAND D88 used 极简底座闸门机制帮我理解 dsh-ops 注册形态参考
CAND D229 unused 嵌入端点勘误，与任务无关
CAND D16 used 热载契约与「测不了要如实说」口径影响我验证方式

SUMMARY 注入=11 起作用=3 反作用=0
