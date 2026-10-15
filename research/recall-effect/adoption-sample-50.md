# 注入 → 被用上：人工判样本（请逐轮判：□真用了 □碰巧）

判据代码：L1=lexical-strict

## 轮 #1  2026-10-15T08:40:43.455Z  session=session-a049ce76-0ef…  bucket=dsh-plugins  turn=1/42
注入 7 条 ｜ 助手正文 497 字 ｜ 块 8622 字 ｜ 工具 memo_stats,memo_tags,bash,bash,bash,bash,bash,bash,read,read,read,memo_update,memo_update,memo_update,read,bash,read,write
各判据命中：L1:-
  D78  L1=0.000
  D149  L1=0.000
  D98  L1=0.000
  D26  L1=0.000
  D59  L1=0.000
  D45  L1=0.000
  D7  L1=0.000
  判定：□真用了  □碰巧  □无法判断

## 轮 #2  2026-10-15T08:39:46.222Z  session=session-a049ce76-0ef…  bucket=dsh-plugins  turn=1/40
注入 12 条 ｜ 助手正文 540 字 ｜ 块 7082 字 ｜ 工具 acp_status,compress,memo_stats,memo_tags,bash,bash,bash,bash,bash,bash,read,read,read,memo_update,memo_update,memo_update,read,bash,read,write
各判据命中：L1:D110
  D149  L1=0.000
  D110  L1=1.000✓
      [L1] 说得过去
  D96  L1=0.000
  D51  L1=0.000
  D12  L1=0.000
  D138  L1=0.000
  D78  L1=0.000
  D98  L1=0.000
  D26  L1=0.000
  D59  L1=0.000
  D45  L1=0.000
  D7  L1=0.000
  判定：□真用了  □碰巧  □无法判断

## 轮 #3  2026-10-15T08:33:48.334Z  session=session-a049ce76-0ef…  bucket=dsh-plugins  turn=1/26
注入 19 条 ｜ 助手正文 1087 字 ｜ 块 8333 字 ｜ 工具 edit,memo_write,bash,read,read,read,read,read,acp_status,compress,compress,read,read,read,read,read,read,read,read,read,read,read,read,bash,read,read,bash,acp_status,compress,memo_stats,memo_tags,bash,bash,bash,bash,bash,bash,read,read,read,memo_update,memo_update,memo_update,read,bash,read,write
各判据命中：L1:D30D134D149D110D51D138D78D7
  D30  L1=1.000✓
      [L1] ACP
  D134  L1=2.000✓
      [L1] persona shot
  D60  L1=0.000
  D131  L1=0.000
  D94  L1=0.000
  D8  L1=0.000
  D102  L1=0.000
  D149  L1=4.000✓
      [L1] PTC patch 技能修复 文件工具
  D110  L1=3.000✓
      [L1] ACP persona 说得过去
  D96  L1=0.000
  D51  L1=1.000✓
      [L1] ACP
  D12  L1=0.000
  D138  L1=1.000✓
      [L1] persona
  D78  L1=1.000✓
      [L1] AGENTS
  D98  L1=0.000
  D26  L1=0.000
  D59  L1=0.000
  D45  L1=0.000
  D7  L1=1.000✓
      [L1] head
  判定：□真用了  □碰巧  □无法判断

## 轮 #4  2026-10-15T08:26:14.212Z  session=session-a049ce76-0ef…  bucket=dsh-plugins  turn=1/10
注入 12 条 ｜ 助手正文 762 字 ｜ 块 4760 字 ｜ 工具 memo_tags,read,bash,edit,edit,edit,edit,edit,edit,bash,edit,bash,edit,bash,edit,read,edit,memo_write,bash,read,read,read,read,read
各判据命中：L1:D15D23D94D102
  D78  L1=0.000
  D15  L1=1.000✓
      [L1] SKILL.md
  D20  L1=0.000
  D23  L1=2.000✓
      [L1] ref docs
  D82  L1=0.000
  D30  L1=0.000
  D134  L1=0.000
  D60  L1=0.000
  D131  L1=0.000
  D94  L1=2.000✓
      [L1] mjs 用户自己
  D8  L1=0.000
  D102  L1=1.000✓
      [L1] lib
  判定：□真用了  □碰巧  □无法判断

## 轮 #5  2026-10-15T08:25:59.421Z  session=session-a049ce76-0ef…  bucket=dsh-plugins  turn=1/10
注入 15 条 ｜ 助手正文 762 字 ｜ 块 9987 字 ｜ 工具 read,read,memo_tags,read,bash,edit,edit,edit,edit,edit,edit,bash,edit,bash,edit,bash,edit,read,edit,memo_write,bash,read,read,read,read,read
各判据命中：L1:D15D23D94D102
  D135  L1=0.000
  D125  L1=0.000
  D1  L1=0.000
  D78  L1=0.000
  D15  L1=1.000✓
      [L1] SKILL.md
  D20  L1=0.000
  D23  L1=2.000✓
      [L1] ref docs
  D82  L1=0.000
  D30  L1=0.000
  D134  L1=0.000
  D60  L1=0.000
  D131  L1=0.000
  D94  L1=2.000✓
      [L1] mjs 用户自己
  D8  L1=0.000
  D102  L1=1.000✓
      [L1] lib
  判定：□真用了  □碰巧  □无法判断

## 轮 #6  2026-10-15T08:25:13.088Z  session=session-a049ce76-0ef…  bucket=dsh-plugins  turn=1/6
注入 18 条 ｜ 助手正文 785 字 ｜ 块 3141 字 ｜ 工具 read,bash,read,read,read,read,read,read,memo_tags,read,bash,edit,edit,edit,edit,edit,edit,bash,edit,bash,edit,bash,edit,read,edit,memo_write
各判据命中：L1:D120D15D20D23D131D94D102
  D120  L1=1.000✓
      [L1] mjs
  D110  L1=0.000
  D85  L1=0.000
  D135  L1=0.000
  D125  L1=0.000
  D1  L1=0.000
  D78  L1=0.000
  D15  L1=2.000✓
      [L1] clone SKILL.md
  D20  L1=1.000✓
      [L1] write
  D23  L1=2.000✓
      [L1] ref docs
  D82  L1=0.000
  D30  L1=0.000
  D134  L1=0.000
  D60  L1=0.000
  D131  L1=1.000✓
      [L1] one
  D94  L1=2.000✓
      [L1] mjs 用户自己
  D8  L1=0.000
  D102  L1=1.000✓
      [L1] lib
  判定：□真用了  □碰巧  □无法判断

## 轮 #7  2026-10-15T08:22:21.879Z  session=session-a049ce76-0ef…  bucket=dsh-plugins  turn=1/2
注入 20 条 ｜ 助手正文 921 字 ｜ 块 8142 字 ｜ 工具 skill,bash,web_search,bash,bash,read,read,read,bash,read,read,read,read,read,read,memo_tags,read,bash,edit,edit,edit,edit,edit,edit,bash,edit,bash,edit,bash
各判据命中：L1:D148D120D20D23
  D80  L1=0.000
  D83  L1=0.000
  D46  L1=0.000
  D148  L1=1.000✓
      [L1] works
  D139  L1=0.000
  D101  L1=0.000
  D42  L1=0.000
  D137  L1=0.000
  D145  L1=0.000
  D120  L1=1.000✓
      [L1] mjs
  D110  L1=0.000
  D85  L1=0.000
  D135  L1=0.000
  D125  L1=0.000
  D1  L1=0.000
  D78  L1=0.000
  D15  L1=0.000
  D20  L1=2.000✓
      [L1] https write
  D23  L1=3.000✓
      [L1] HTTPS ref https://github.com/
  D82  L1=0.000
  判定：□真用了  □碰巧  □无法判断

## 轮 #8  2026-10-14T07:18:56.551Z  session=session-901ba747-2db…  bucket=genshin-ts  turn=6/2
注入 5 条 ｜ 助手正文 1762 字 ｜ 块 4284 字 ｜ 工具 bash,bash,read,read,memo_write,memo_write,memo_write,bash
各判据命中：L1:D262
  D117  L1=0.000
  D262  L1=8.000✓
      [L1] status.json has mrd-triage/ 草稿本身 稿本身仍 篇正式日
  D81  L1=0.000
  D115  L1=0.000
  D47  L1=0.000
  判定：□真用了  □碰巧  □无法判断

## 轮 #9  2026-10-14T07:18:47.857Z  session=session-901ba747-2db…  bucket=genshin-ts  turn=6/1
注入 10 条 ｜ 助手正文 1861 字 ｜ 块 8287 字 ｜ 工具 bash,bash,bash,read,read,memo_write,memo_write,memo_write,bash
各判据命中：L1:D262D52
  D262  L1=8.000✓
      [L1] status.json has mrd-triage/ 草稿本身 稿本身仍 篇正式日
  D52  L1=1.000✓
      [L1] status
  D258  L1=0.000
  D78  L1=0.000
  D53  L1=0.000
  D81  L1=0.000
  D55  L1=0.000
  D117  L1=0.000
  D115  L1=0.000
  D47  L1=0.000
  判定：□真用了  □碰巧  □无法判断

## 轮 #10  2026-10-14T07:15:14.150Z  session=bc7349eb-8388-417c-b…  bucket=genshin-ts  turn=3/2
注入 8 条 ｜ 助手正文 944 字 ｜ 块 5021 字 ｜ 工具 bash,bash,bash,bash,write,read,write,bash,bash,acp_status,acp_status,send_message
各判据命中：L1:D31D54D242
  D245  L1=0.000
  D31  L1=1.000✓
      [L1] 401
  D54  L1=1.000✓
      [L1] D19
  D246  L1=0.000
  D242  L1=1.000✓
      [L1] 92
  D152  L1=0.000
  D32  L1=0.000
  D261  L1=0.000
  判定：□真用了  □碰巧  □无法判断

## 轮 #11  2026-10-14T07:15:04.750Z  session=session-901ba747-2db…  bucket=genshin-ts  turn=5/2
注入 19 条 ｜ 助手正文 1173 字 ｜ 块 4508 字 ｜ 工具 send_message,acp_status,acp_status,compress,bash,memo_tags,bash,memo_write,list_agents,bash
各判据命中：L1:D70D257D33D42D250D47D118D262D52D258D78D53D81D115
  D70  L1=1.000✓
      [L1] scratch
  D257  L1=1.000✓
      [L1] 65
  D56  L1=0.000
  D33  L1=1.000✓
      [L1] 38
  D42  L1=1.000✓
      [L1] 已落盘的
  D250  L1=1.000✓
      [L1] 38
  D47  L1=2.000✓
      [L1] 27 可复用的
  D167  L1=0.000
  D118  L1=3.000✓
      [L1] true all: rejected/
  D261  L1=0.000
  D262  L1=14.000✓
      [L1] mrd-triage/ 12% 0.95 38 只查标题 查标题会
  D52  L1=3.000✓
      [L1] status 27 38
  D258  L1=2.000✓
      [L1] graph 27
  D78  L1=1.000✓
      [L1] client
  D53  L1=3.000✓
      [L1] 65 27 38
  D81  L1=1.000✓
      [L1] 可复用的
  D55  L1=0.000
  D117  L1=0.000
  D115  L1=1.000✓
      [L1] 65
  判定：□真用了  □碰巧  □无法判断

## 轮 #12  2026-10-14T07:12:18.985Z  session=session-901ba747-2db…  bucket=genshin-ts  turn=4/2
注入 25 条 ｜ 助手正文 2055 字 ｜ 块 5308 字 ｜ 工具 list_agents,bash,bash,bash,bash,bash,bash,bash,present
各判据命中：L1:D176D184D179D183D70D33D250D47D118D262D52D258D78D53D55D117
  D176  L1=1.000✓
      [L1] time
  D184  L1=1.000✓
      [L1] 79
  D173  L1=0.000
  D179  L1=3.000✓
      [L1] json txt 79
  D183  L1=1.000✓
      [L1] 79
  D260  L1=0.000
  D70  L1=2.000✓
      [L1] str 内容不是
  D257  L1=0.000
  D56  L1=0.000
  D33  L1=1.000✓
      [L1] 38
  D42  L1=0.000
  D250  L1=5.000✓
      [L1] D234 comm Wine 38 194
  D47  L1=1.000✓
      [L1] 27
  D167  L1=0.000
  D118  L1=4.000✓
      [L1] true all: rejected/ 守护预审
  D261  L1=0.000
  D262  L1=67.000✓
      [L1] VERY revealing has SAME weird structure
  D52  L1=5.000✓
      [L1] struct status str 27 38
  D258  L1=2.000✓
      [L1] graph 27
  D78  L1=2.000✓
      [L1] client 92
  D53  L1=2.000✓
      [L1] 27 38
  D81  L1=0.000
  D55  L1=2.000✓
      [L1] 92 就失去了
  D117  L1=1.000✓
      [L1] port
  D115  L1=0.000
  判定：□真用了  □碰巧  □无法判断

## 轮 #13  2026-10-14T07:09:36.871Z  session=bc7349eb-8388-417c-b…  bucket=genshin-ts  turn=2/1
注入 10 条 ｜ 助手正文 65 字 ｜ 块 3117 字 ｜ 工具 bash,bash,bash,bash
各判据命中：L1:-
  D53  L1=0.000
  D117  L1=0.000
  D261  L1=0.000
  D245  L1=0.000
  D31  L1=0.000
  D54  L1=0.000
  D246  L1=0.000
  D242  L1=0.000
  D152  L1=0.000
  D32  L1=0.000
  判定：□真用了  □碰巧  □无法判断

## 轮 #14  2026-10-14T07:09:19.171Z  session=session-901ba747-2db…  bucket=genshin-ts  turn=3/4
注入 27 条 ｜ 助手正文 814 字 ｜ 块 4039 字 ｜ 工具 bash,send_message,bash,bash,bash,bash,bash,bash,bash,bash,bash,list_agents,bash,bash
各判据命中：L1:D117D250D262D78
  D117  L1=1.000✓
      [L1] port
  D53  L1=0.000
  D261  L1=0.000
  D47  L1=0.000
  D115  L1=0.000
  D81  L1=0.000
  D40  L1=0.000
  D119  L1=0.000
  D176  L1=0.000
  D184  L1=0.000
  D173  L1=0.000
  D179  L1=0.000
  D183  L1=0.000
  D260  L1=0.000
  D70  L1=0.000
  D257  L1=0.000
  D56  L1=0.000
  D33  L1=0.000
  D42  L1=0.000
  D250  L1=1.000✓
      [L1] comm
  D167  L1=0.000
  D118  L1=0.000
  D262  L1=6.000✓
      [L1] 机器触发 用户字段 篇真人回 真人回合 人回合里 河里只有
  D52  L1=0.000
  D258  L1=0.000
  D78  L1=1.000✓
      [L1] 口径一致
  D55  L1=0.000
  判定：□真用了  □碰巧  □无法判断

## 轮 #15  2026-10-14T07:08:59.188Z  session=session-901ba747-2db…  bucket=genshin-ts  turn=3/3
注入 27 条 ｜ 助手正文 893 字 ｜ 块 9335 字 ｜ 工具 list_agents,bash,bash,bash,bash,send_message,bash,bash,bash,bash,bash,bash,bash,bash,bash,list_agents,bash,bash
各判据命中：L1:D117D250D262D78
  D173  L1=0.000
  D117  L1=1.000✓
      [L1] port
  D179  L1=0.000
  D184  L1=0.000
  D183  L1=0.000
  D261  L1=0.000
  D53  L1=0.000
  D47  L1=0.000
  D115  L1=0.000
  D81  L1=0.000
  D40  L1=0.000
  D119  L1=0.000
  D176  L1=0.000
  D260  L1=0.000
  D70  L1=0.000
  D257  L1=0.000
  D56  L1=0.000
  D33  L1=0.000
  D42  L1=0.000
  D250  L1=1.000✓
      [L1] comm
  D167  L1=0.000
  D118  L1=0.000
  D262  L1=6.000✓
      [L1] 机器触发 用户字段 篇真人回 真人回合 人回合里 河里只有
  D52  L1=0.000
  D258  L1=0.000
  D78  L1=1.000✓
      [L1] 口径一致
  D55  L1=0.000
  判定：□真用了  □碰巧  □无法判断

## 轮 #16  2026-10-14T03:53:36.616Z  session=session-f0a703ab-ddf…  bucket=miliastra-beyond-simulator  turn=9/1
注入 3 条 ｜ 助手正文 1530 字 ｜ 块 2674 字 ｜ 工具 skill,read,bash,bash,bash,bash,bash,bash,bash,bash,bash,bash,bash,bash,bash,bash,bash,bash,bash,bash,bash,bash,bash
各判据命中：L1:D3
  D3  L1=1.000✓
      [L1] 真机在场
  D2  L1=0.000
  D7  L1=0.000
  判定：□真用了  □碰巧  □无法判断

## 轮 #17  2026-10-13T16:37:57.149Z  session=session-f0a703ab-ddf…  bucket=miliastra-beyond-simulator  turn=8/16
注入 3 条 ｜ 助手正文 849 字 ｜ 块 2211 字 ｜ 工具 bash,edit,edit,bash,compress,edit,edit,edit,bash,bash,qxqy_studio_load
各判据命中：L1:D6
  D6  L1=2.000✓
      [L1] index 000
  D7  L1=0.000
  D2  L1=0.000
  判定：□真用了  □碰巧  □无法判断

## 轮 #18  2026-10-13T16:00:30.181Z  session=session-f0a703ab-ddf…  bucket=miliastra-beyond-simulator  turn=6/3
注入 3 条 ｜ 助手正文 1146 字 ｜ 块 2644 字 ｜ 工具 qxqy_studio_play,qxqy_studio_play,qxqy_studio_play_screenshot,qxqy_studio_play,edit,bash,bash,bash,write,bash,write,bash,bash,write,bash,bash,qxqy_studio_load
各判据命中：L1:D2
  D3  L1=0.000
  D2  L1=1.000✓
      [L1] 永不触发
  D7  L1=0.000
  判定：□真用了  □碰巧  □无法判断

## 轮 #19  2026-10-13T14:52:39.736Z  session=session-f0a703ab-ddf…  bucket=miliastra-beyond-simulator  turn=4/38
注入 3 条 ｜ 助手正文 1475 字 ｜ 块 2746 字 ｜ 工具 bash,bash,edit,edit,edit,bash,bash,edit,edit,edit,edit,edit,bash,write,bash,bash,qxqy_studio_load,qxqy_studio_play,qxqy_studio_play_screenshot,qxqy_studio_play,qxqy_studio_play,qxqy_studio_play
各判据命中：L1:D7
  D3  L1=0.000
  D1  L1=0.000
  D7  L1=1.000✓
      [L1] 07
  判定：□真用了  □碰巧  □无法判断

## 轮 #20  2026-10-13T14:39:18.671Z  session=session-f0a703ab-ddf…  bucket=miliastra-beyond-simulator  turn=4/23
注入 3 条 ｜ 助手正文 369 字 ｜ 块 2076 字 ｜ 工具 bash,write,read,bash,bash,bash,bash,bash,bash
各判据命中：L1:D6
  D7  L1=0.000
  D6  L1=1.000✓
      [L1] index
  D3  L1=0.000
  判定：□真用了  □碰巧  □无法判断

## 轮 #21  2026-10-13T14:16:03.167Z  session=session-f0a703ab-ddf…  bucket=miliastra-beyond-simulator  turn=2/167
注入 3 条 ｜ 助手正文 1821 字 ｜ 块 2742 字 ｜ 工具 read,edit,bash,edit,edit,edit,write,acp_status,compress,compress,acp_status,todo_write
各判据命中：L1:D7D1
  D3  L1=0.000
  D7  L1=20.000✓
      [L1] save.json 06 07 三个假宿 个假宿主 假宿主盲
  D1  L1=3.000✓
      [L1] Left Right spec
  判定：□真用了  □碰巧  □无法判断

## 轮 #22  2026-10-13T14:03:44.816Z  session=session-f0a703ab-ddf…  bucket=miliastra-beyond-simulator  turn=2/106
注入 3 条 ｜ 助手正文 2814 字 ｜ 块 2667 字 ｜ 工具 read,bash,write,bash,bash,qxqy_studio_patch,qxqy_studio_play,edit,edit,qxqy_studio_play,qxqy_studio_play,qxqy_studio_play,qxqy_studio_play_screenshot,qxqy_studio_play,qxqy_studio_play,grep,read,grep,read,read,grep,read,qxqy_studio_play,qxqy_studio_play,grep,read,read,grep,bash,read,bash,read,grep,read,read,edit,edit,qxqy_studio_play,qxqy_studio_play,qxqy_studio_play,qxqy_studio_play,qxqy_studio_play,grep,edit,qxqy_studio_play,qxqy_studio_play,qxqy_studio_play,qxqy_studio_play,qxqy_studio_play,qxqy_studio_play,qxqy_studio_play,qxqy_studio_play,qxqy_studio_play,qxqy_studio_play,qxqy_studio_play,qxqy_studio_play,qxqy_studio_play_screenshot,memo_tags,memo_write,memo_write,edit,edit
各判据命中：L1:D6
  D3  L1=0.000
  D2  L1=0.000
  D6  L1=6.000✓
      [L1] EnableUpdate session.js runtime.js clicker-demo 000 学习报告
  判定：□真用了  □碰巧  □无法判断

## 轮 #23  2026-10-13T13:49:57.395Z  session=session-f0a703ab-ddf…  bucket=miliastra-beyond-simulator  turn=2/46
注入 2 条 ｜ 助手正文 1650 字 ｜ 块 2735 字 ｜ 工具 edit,bash,bash,bash,bash,bash,bash,bash,bash,bash,bash,bash,todo_write,memo_update,acp_status,acp_status,compress,skill,skill,read,todo_write,read,read,read,qxqy_studio_get,grep,read,grep,read,read,grep,grep,grep,read,grep,read,read,grep,grep,read,grep,read,grep,read,grep
各判据命中：L1:-
  D3  L1=0.000
  D1  L1=0.000
  判定：□真用了  □碰巧  □无法判断

## 轮 #24  2026-09-28T07:52:00.631Z  session=session-0fbc5c61-f59…  bucket=ai小说  turn=1/16
注入 1 条 ｜ 助手正文 1072 字 ｜ 块 1020 字 ｜ 工具 无
各判据命中：L1:D1
  D1  L1=64.000✓
      [L1] Patreon KDP B2B Amazon Wattpad Medium
  判定：□真用了  □碰巧  □无法判断
