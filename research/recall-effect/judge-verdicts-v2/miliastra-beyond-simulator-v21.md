<!-- req-21.json  桶=miliastra-beyond-simulator  注入=3条  messages=17  26985字 -->
<!-- question: 【元问题·不要继续原任务】上面那些自动召回并注入的记忆里，哪些对你起到了真正的作用？只回答这个问题，不要接着做原任务。**每个候选条目单独一行**，格式严格为：`CAND D<编号> used|topic|unused <理由≤40字>`（used=真起作用且能指到具体决策 / topic=只是话题相关 / unused=没用上；引错的写 `CAND D<编号> harmful <理由>`）。正文里可另写归纳，但**标签行必须一行一候选、不得合并**。 最后单独一行给汇总，格式严格为：SUMMARY 注入=<本块条目总数> 起作用=<真正起作用的条数> 反作用=<引错的条数> -->
<!-- evidence: 上下文原样 + 末尾追加提问，17 条消息 / 26985 字；模型 glm-5.3-flash；usage={"completion_tokens":185,"completion_tokens_details":{"reasoning_tokens":38},"prompt_tokens":12425,"prompt_tokens_details":{"cached_tokens":0},"total_tokens":12610} -->

CAND D3 unused|字体回退,真机探针,网页试玩|PR#12 字体/probe 议题与本次技能闭环无关，未触发任何决策
CAND D7 used|光标事件链,单文件交付,模板目录|唯一驱动力：三个假宿主盲区 bug 直接决定回灌 SKILL.md 硬规则与 runtime-api.md 新增节的全部内容
CAND D1 topic|分支堆叠,拖拽阈值,键盘事件转发|上游 PR 评审与单 Lua 试玩任务平行，仅背景，未影响任何具体动作

SUMMARY 注入=3 起作用=1 反作用=0
