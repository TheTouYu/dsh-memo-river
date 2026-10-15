#!/usr/bin/env node
// v1.1 升级脚本：给 golden.jsonl 35 对逐对盖 oldClaim/newClaim（关键结论对）。
// 由来：用户抽检反馈「什么取代什么表达的信息很少，把关键结论加上」——
// 取代关系从「编号对」升级为「断言对」，抽检者无需回读 600 字底稿即可核对。
// 防呆：id 必须一一对应（缺失/多余/重复都抛错），原字段一律不动只追加。
import { readFileSync, writeFileSync } from 'node:fs';

const claims = {
  G01: ['旧端点时代注入半数静默死在嵌入（skip 率 45.3%）', '新链路超顶 0%、120/120 成功——明言旧报告作废'],
  G02: ['0.8B 本机不可行：CPU 单次 1.8–4.4s，离毫秒级门控差 4 个数量级', 'GPU 单前向 0.15s 可行；AUC 0.679 只够软排序（硬过滤误伤 43%）'],
  G03: ['mmap 假说被证伪（DEFAULT_MMAP_SIZE=0）；崩点游移=竞态判据', '崩因定性：进程内两份 sqlite 的 fcntl 锁盲区（两必要条件）——排除结论被证实'],
  G04: ['通道矩阵反转：uinput 活、portal 键盘精确且免授权直通', '复核：uinput 确证、乱键复现一致；但 portal 只对一半（字母乱键）'],
  G05: ['火花①冻结：若本库是高冗余池，残差选择才值得做', '全库 0 对 cos>0.90（干净池）——冻结条件被证伪，火花①退役定谳'],
  G06: ['拆批省 49%（1299→662ms）；顺带纠正「批内逐位等价」旧断言', '受控复测定案：拆 1+2=860ms（-55.3%）；padding 计费模型坐实'],
  G07: ['H3 判决：时效签零收益（C 25%≥A 17%），正文自声明才是强机制', '修正：签没错是用法错——证伪的只是最弱形态，正解=重排/物理折叠'],
  G08: ['02:00 切换 OpenRouter/bge-m3 已生效、skip 归零（裁决+勘误版）', '同题实测确认：超顶 0%（其「旧报告作废」指 D208/D214 系，非本文）'],
  G09: ['Jev-Mem 调研中期：LoCoMo 0.777、三平面架构', '完结：22 决策点全落决策模型强域，双门注入门控最优先'],
  G10: ['自查推导（待文献确证）：贪心残差选择≡贪心 DPP MAP', '硬数字确证补强：MMR 原始证据仅 B 级；DPP vs 判别有直接对照'],
  G11: ['第一轮调查：StartLux 9B H200 35.7ms；本机 6GB 显存判档', '第二轮调查：官方零中文效果证据（唯一=CJ-Bench 校准附录）'],
  G12: ['portal 通道在位而未被选用；FORCE 变量存在（弹药篇）', '实测：FORCE_PORTAL_KEYBOARD 直开无授权弹窗；FORCE_POINTER 对 click 无效'],
  G13: ['10-14/15 波复盘：10 条错误谱系+3 条根因；写侧 padding 漏网待做', '10-15 波复盘：跨 4 仓 11 提交 9 条谱系；生产收尾行为读数通过'],
  G14: ['诊断：读写两侧都假设回合边界，oneshot 长任务双双失明', '落地：三触发自主注入+近因保底，19/19 全绿'],
  G15: ['票04 校准判决：A 锚拼接完胜；17/17 gate-skip 全误杀', '票08 落地：gU@0.55∨gA@0.62 双锚分阈'],
  G16: ['三道闸取证：闸①②已修；闸②主动召回默认域+自满未修', '闸④坐实：ask_user_question 回答对记忆系统双重不可见'],
  G17: ['票01 勘察：注入侧 query+锚合批设计', '票03 判定：写侧 3 串行改 2 并行、失败即拒'],
  G18: ['票03 设计判定：三串行改两并行', '落地 c2f63e3：请求 3→2、746→518ms，失败即拒成真'],
  G19: ['票③ memo_merge：压缩式遗忘有了手动执行通道', '票④ 冗余三判定自动建议流——四票连成闭环（互补非推翻）'],
  G20: ['票④落地：①台账②update③merge④检测闭环成型', '六票收官终验全绿：遗忘/强化/修正全部兑现'],
  G21: ['SIGBUS 修复设计定稿：闸-计数-护栏三层', '进度：三层已铺到主要入口，验证未跑'],
  G22: ['三层已铺完主入口，验证未跑', '验收：连跑 3 次零崩溃；验收期修 2 个收尾段 bug（实现细节）'],
  G23: ['硬数字收割：MMR 试点仅 N=5（B 级证据）；DPP 对照 Acc .477', '定谳：DPP 等价六位小数全等；干净池上多样化全亏'],
  G24: ['票09a：topology 半边首跑即绿（分数差 1.11e-16）', '票09 收官：dtsc 半边全链差分 PASS（累计 6300/13598 行）'],
  G25: ['票06 设计定盘：预审三态顺序，垃圾判定必须先于 Tag', '落地 3db8709：与设计一致（两处实测修正属精化）'],
  G26: ['票02 勘察：标题派生链三级，「未命名」兜底定位', '落地 5fba02c：闸门覆盖四入口；新发现「格式即语义」三连锁'],
  G27: ['票04 勘察：跨注入状态用 usage ledger 的双权重设计', '代码落地：selectCandidates 纯函数抽取，构建绿'],
  G28: ['票10 落地报告：完备链胜单链+巡检逼出 2 个静默 bug', '自动批准草稿机械复述同事件（真实场景该 merge 的冗余）'],
  G29: ['票11 落地：委托写入引导两要素（堵改疏）', '自动批准草稿机械复述同事件（该 merge 的冗余）'],
  G30: ['票⑥A 根修：HashMap 迭代序×f64 累加=artifactSig 漂移根因', '收官：12/12 逐位一致验证+B 半 artifact 行 GC 落地'],
  G31: ['kernel-reimpl 立项：分支+11 票，票01/02 done', '一日四票：artifact_builder 逐位对上 oracle（进度 4/11）'],
  G32: ['评估范围锁定：15 会话/4 生产桶+数据源地图', '八项结论：注入 mean 5.7–6.4s 与草稿漏斗断裂两大红灯'],
  G33: ['九票落盘启动：两波工作流编排与依赖边定盘', '9/9 done 终验全绿；效率取证 219 分钟纯等待（新发现非推翻）'],
  G34: ['09-28 拦截论：uinput 点击未送达、键盘不可用（BENCHMARK.md 根因）', '通道矩阵反转：uinput 活（检测器假阴性）、portal 直通——明言推翻'],
  G35: ['旧端点时代取证：skip 45–58%，半数会话静默无注入', '新链路超顶 0%——明言旧报告作废'],
};

const path = new URL('./golden.jsonl', import.meta.url);
const lines = readFileSync(path, 'utf8').trim().split('\n');
const seen = [];
const out = lines.map((l, i) => {
  const o = JSON.parse(l);
  if (!o.id) throw new Error(`line ${i + 1}: no id`);
  if (seen.includes(o.id)) throw new Error(`dup id ${o.id}`);
  const c = claims[o.id];
  if (!c) throw new Error(`no claims authored for ${o.id}`);
  seen.push(o.id);
  return JSON.stringify({ ...o, oldClaim: c[0], newClaim: c[1] });
});
const orphan = Object.keys(claims).filter((k) => !seen.includes(k));
if (orphan.length) throw new Error(`claims map has orphan ids: ${orphan.join(',')}`);
if (out.length !== 35) throw new Error(`expected 35 lines, got ${out.length}`);
writeFileSync(path, out.join('\n') + '\n');
console.log(`ok: ${out.length} lines stamped (oldClaim/newClaim), ids ${seen[0]}..${seen.at(-1)}`);
