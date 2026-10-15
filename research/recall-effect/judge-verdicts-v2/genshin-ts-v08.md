<!-- req-08.json  桶=genshin-ts  注入=5条  messages=21  36949字 -->
<!-- question: 【元问题·不要继续原任务】上面那些自动召回并注入的记忆里，哪些对你起到了真正的作用？只回答这个问题，不要接着做原任务。**每个候选条目单独一行**，格式严格为：`CAND D<编号> used|topic|unused <理由≤40字>`（used=真起作用且能指到具体决策 / topic=只是话题相关 / unused=没用上；引错的写 `CAND D<编号> harmful <理由>`）。正文里可另写归纳，但**标签行必须一行一候选、不得合并**。 最后单独一行给汇总，格式严格为：SUMMARY 注入=<本块条目总数> 起作用=<真正起作用的条数> 反作用=<引错的条数> -->
<!-- evidence: 上下文原样 + 末尾追加提问，21 条消息 / 36949 字；模型 glm-5.3-flash；usage={"completion_tokens":183,"completion_tokens_details":{"reasoning_tokens":35},"prompt_tokens":20225,"prompt_tokens_details":{"cached_tokens":0},"total_tokens":20408} -->

CAND D262 used|上轮分诊结论与「字面命中是废指标」判据直接决定本轮只承接缺口不重扫
CAND D117 unused|环境补装链背景，本轮未触发装环境
CAND D81 unused|T03 精读方法论，本轮未做图谱条目
CAND D115 unused|模拟器/客户端Lua轴，未进入本轮决策
CAND D47 unused|去枢纽化，仅作 Tag 闸门背景，无具体决策
CAND D1@常识库 unused|代理环境常识，本轮无学术检索

SUMMARY 注入=6 起作用=1 反作用=0
