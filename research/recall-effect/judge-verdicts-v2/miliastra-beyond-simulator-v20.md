<!-- req-20.json  桶=miliastra-beyond-simulator  注入=3条  messages=11  12170字 -->
<!-- question: 【元问题·不要继续原任务】上面那些自动召回并注入的记忆里，哪些对你起到了真正的作用？只回答这个问题，不要接着做原任务。**每个候选条目单独一行**，格式严格为：`CAND D<编号> used|topic|unused <理由≤40字>`（used=真起作用且能指到具体决策 / topic=只是话题相关 / unused=没用上；引错的写 `CAND D<编号> harmful <理由>`）。正文里可另写归纳，但**标签行必须一行一候选、不得合并**。 最后单独一行给汇总，格式严格为：SUMMARY 注入=<本块条目总数> 起作用=<真正起作用的条数> 反作用=<引错的条数> -->
<!-- evidence: 上下文原样 + 末尾追加提问，11 条消息 / 12170 字；模型 glm-5.3-flash；usage={"completion_tokens":286,"completion_tokens_details":{"reasoning_tokens":73},"prompt_tokens":4505,"prompt_tokens_details":{"cached_tokens":0},"total_tokens":4791} -->

CAND D7 used|最隐蔽坑 updateEnabled=false 直接指导写 EnableUpdate(true)，rawget 坑影响脚本安全写法
CAND D6 topic|只确认了项目定位（单Lua交付），对本次 main.lua 编写无具体决策贡献
CAND D3 unused|字体回退/probe 测试与当前任务无关

归纳：D7 是唯一有实质影响的——它记录的“挂载脚本 updateEnabled 默认 false，须显式 EnableUpdate(true)”属于假宿主冒烟抓不到的平台契约，若没召回很可能复现同样的零报错故障；“script.object 是 Control userdata 非 table”也直接约束了父子遍历写法。D6/D3 仅为背景噪音。另外本回合真正决定性的信息其实来自工具返回（SimulateCursorClick、CursorEventData 字段、EnableUpdate 实现），记忆只是提供了“去哪里验证”的先验。

SUMMARY 注入=3 起作用=1 反作用=0
