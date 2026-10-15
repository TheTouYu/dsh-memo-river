<!-- req-13.json  桶=genshin-ts  注入=10条  messages=11  29856字 -->
<!-- question: 【元问题·不要继续原任务】上面那些自动召回并注入的记忆里，哪些对你起到了真正的作用？只回答这个问题，不要接着做原任务。**每个候选条目单独一行**，格式严格为：`CAND D<编号> used|topic|unused <理由≤40字>`（used=真起作用且能指到具体决策 / topic=只是话题相关 / unused=没用上；引错的写 `CAND D<编号> harmful <理由>`）。正文里可另写归纳，但**标签行必须一行一候选、不得合并**。 最后单独一行给汇总，格式严格为：SUMMARY 注入=<本块条目总数> 起作用=<真正起作用的条数> 反作用=<引错的条数> -->
<!-- evidence: 上下文原样 + 末尾追加提问，11 条消息 / 29856 字；模型 glm-5.3-flash；usage={"completion_tokens":386,"completion_tokens_details":{"reasoning_tokens":106},"prompt_tokens":13736,"prompt_tokens_details":{"cached_tokens":0},"total_tokens":14122} -->

CAND D245 used|topic|used relay全案重构（D245/D246/D242 系列）直接支撑 Wine 会话篇（t21/t30/t39 等）的半覆盖复核判据
CAND D246 used|used v7大反转与 D245 同案，复核「编辑器supervisor/死法」草稿判定时用作河内覆盖依据
CAND D242 used|used dump=看门狗私有格式，是判 647ff503 各篇「已在河」的关键河内事实
CAND D152 used|topic|used 11:05窗口全灭+pgrep假匹配陷阱，判 t18/t7（编辑器无响应）篇时参考
CAND D31 topic|unused 知识图谱检索改道，与本轮分诊任务无关
CAND D54 unused|unused D3b客户端图专题，与41篇草稿无交集
CAND D32 unused|unused K2引导专题成文，未参与任何判定
CAND D261 unused|unused river-acp预设补技能面，与分诊无关
CAND D1 unused|unused 代理加速常识，本轮未涉网络检索

SUMMARY 注入=9 起作用=4 反作用=0
