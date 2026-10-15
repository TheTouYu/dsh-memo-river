<!-- req-18.json  桶=miliastra-beyond-simulator  注入=3条  messages=24  45158字 -->
<!-- question: 【元问题·不要继续原任务】上面那些自动召回并注入的记忆里，哪些对你起到了真正的作用？只回答这个问题，不要接着做原任务。**每个候选条目单独一行**，格式严格为：`CAND D<编号> used|topic|unused <理由≤40字>`（used=真起作用且能指到具体决策 / topic=只是话题相关 / unused=没用上；引错的写 `CAND D<编号> harmful <理由>`）。正文里可另写归纳，但**标签行必须一行一候选、不得合并**。 最后单独一行给汇总，格式严格为：SUMMARY 注入=<本块条目总数> 起作用=<真正起作用的条数> 反作用=<引错的条数> -->
<!-- evidence: 上下文原样 + 末尾追加提问，24 条消息 / 45158 字；模型 glm-5.3-flash；usage={"completion_tokens":208,"completion_tokens_details":{"reasoning_tokens":28},"prompt_tokens":15370,"prompt_tokens_details":{"cached_tokens":0},"total_tokens":15578} -->

CAND D3 topic|提到 probes/惯例与 PR 流程，本次修 bug 未涉及上游互动决策
CAND D2 unused|拖拽阈值取证链与本渲染 bug 无关，未影响任何决策
CAND D7 used|「假宿主冒烟抓不到真 bug」直接强化了补 visible 断言的决策方向

归纳：这次真正起作用的是 D7——它记录了「测试全绿≠无 bug」的教训，与我现场发现「断言无 visible 字段」相互印证，促使我立即补渲染可见性防回归用例而非只修一行了事。D3 仅在工具链语境上擦边（试玩/探针），D2 的拖拽阈值前史与本问题完全不相干。

SUMMARY 注入=3 起作用=1 反作用=0
