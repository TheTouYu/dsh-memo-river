<!-- req-10.json  桶=genshin-ts  注入=8条  messages=12  57212字 -->
<!-- question: 【元问题·不要继续原任务】上面那些自动召回并注入的记忆里，哪些对你起到了真正的作用？只回答这个问题，不要接着做原任务。**每个候选条目单独一行**，格式严格为：`CAND D<编号> used|topic|unused <理由≤40字>`（used=真起作用且能指到具体决策 / topic=只是话题相关 / unused=没用上；引错的写 `CAND D<编号> harmful <理由>`）。正文里可另写归纳，但**标签行必须一行一候选、不得合并**。 最后单独一行给汇总，格式严格为：SUMMARY 注入=<本块条目总数> 起作用=<真正起作用的条数> 反作用=<引错的条数> -->
<!-- evidence: 上下文原样 + 末尾追加提问，12 条消息 / 57212 字；模型 glm-5.3-flash；usage={"completion_tokens":284,"completion_tokens_details":{"reasoning_tokens":41},"prompt_tokens":31210,"prompt_tokens_details":{"cached_tokens":0},"total_tokens":31494} -->

CAND D245 used | relay 编辑器无对话框调用的定谳，直接用于复核 wine 线多篇判定
CAND D246 used | true-editor 定位纠错与 RST 因果链，支撑 t45/t37 判据修正
CAND D242 used | dump=看门狗私有格式，支撑 t33 判定并补强其依据
CAND D152 used | MangoHud 事件线索，辅助 wine 线上下文但未引到具体行
CAND D31 topic | 千星知识图谱检索法话题相关，未进入任何判定
CAND D54 unused | 客户端只读不写一句带过，未起作用
CAND D32 unused | 引导专题成文流水，与复核无关
CAND D261 used | river-acp 能力面史实，用于确认 D104 系半覆盖判定边界
CAND D1@常识库 used | 代理 7890 环境事实，检索 river-full 时默认生效

SUMMARY 注入=9 起作用=5 反作用=0
