<!-- req-02.json  桶=dsh-plugins  注入=12条  messages=28  71946字 -->
<!-- question: 【元问题·不要继续原任务】上面那些自动召回并注入的记忆里，哪些对你起到了真正的作用？只回答这个问题，不要接着做原任务。**每个候选条目单独一行**，格式严格为：`CAND D<编号> used|topic|unused <理由≤40字>`（used=真起作用且能指到具体决策 / topic=只是话题相关 / unused=没用上；引错的写 `CAND D<编号> harmful <理由>`）。正文里可另写归纳，但**标签行必须一行一候选、不得合并**。 最后单独一行给汇总，格式严格为：SUMMARY 注入=<本块条目总数> 起作用=<真正起作用的条数> 反作用=<引错的条数> -->
<!-- evidence: 上下文原样 + 末尾追加提问，28 条消息 / 71946 字；模型 glm-5.3-flash；usage={"completion_tokens":447,"completion_tokens_details":{"reasoning_tokens":49},"prompt_tokens":32666,"prompt_tokens_details":{"cached_tokens":0},"total_tokens":33113} -->

本次注入的 13 条，逐条判定如下（元问题，只答这个）：

CAND D78 used 语料修复后需备份/git 通道，其「本地未接 origin 假绿」提醒风险意识
CAND D149 topic dsh-ops 源码结论与本题（语料修复/AGENTS）无直接决策作用
CAND D98 unused 鲸鱼案背景，本轮未涉
CAND D26 unused 双库 WAL 互毁，本轮未涉
CAND D59 unused 卡死归因，本轮未涉
CAND D45 unused 票14 旧账，本轮未涉
CAND D7 unused 迁移损伤，本轮未涉
CAND D229 topic 嵌入缓存/端点背景，与孤岛修复无关
CAND D95 unused 千星奇域笔记，完全无关
CAND D3 used 「交付前自审三问」直接支撑了修复后跑体检确认收敛的动作
CAND D91 topic 语料质量审计方法同族，但本次用的是体检工具而非其结论
CAND D16 topic 枢纽 Tag 治理相关话题，未直接引用
CAND D2 used 「敷衍的根子在系统提示词」直接印证了落盘 AGENTS.md 的做法

SUMMARY 注入=13 起作用=3 反作用=0

归纳：真正起作用的两类——①常识桶协作纪律（D3/D2）直接塑造了「修完必须验证」和「思维落盘到提示词」两个决策；②D78 提供了备份通道的风险背景。其余 10 条是 token-budget 压力下的高 Ω 泛召回，与本题无关——召回判据按语义近邻打分，对「元任务切换」场景无过滤能力。
