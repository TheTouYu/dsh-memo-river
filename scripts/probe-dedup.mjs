// 探针：写入去重阈值定标。三组数据：
// ① #19 场景三篇（同话题合法续写）写入结果 + 两两余弦
// ② preset-composer 三连重写（真实复读样本）两两余弦
// ③ #21 近重复对（应高）+ 不同主题对（应低）
import { rmSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { acquireWorkspace } from '../lib/workspace.js'
import { workspacePaths } from '../lib/runtime.js'
import { Config as ConfigSchema } from '../lib/index.js'

const cwd = join(tmpdir(), `probe-dedup-${process.pid}`)
const bucket = '探针'
const paths = workspacePaths(cwd, bucket)
rmSync(cwd, { recursive: true, force: true })
rmSync(paths.root, { recursive: true, force: true })
mkdirSync(cwd, { recursive: true })
const ws = acquireWorkspace(cwd, ConfigSchema({ bucket: '探针', native: { vcpRoot: '/home/h/app/VCPToolBox' } }))
const dim = ws.resolved.dimension
const cos = (a, b) => {
  let d = 0, x = 0, y = 0
  for (let i = 0; i < dim; i++) { d += a[i] * b[i]; x += a[i] * a[i]; y += b[i] * b[i] }
  return d / Math.sqrt(x * y)
}
const vecs = new Map()
const embedTexts = async (texts) => {
  const vs = await ws.embed.embed(texts)
  texts.forEach((t, i) => vecs.set(t, vs[i]))
  return vs
}

// ① #19 三篇
const TAG = '\n\nTag: 近因保底, 渲染管线, 索引优化\n'
const A1 = `# 旧渲染卡顿一月\n\n结论：渲染卡顿是阴影贴图分辨率过高，降到一半就流畅了。${TAG}`
const A2 = `# 旧渲染卡顿二月\n\n结论：二月的卡顿来自顶点数暴涨，合批后帧率翻倍。${TAG}`
const A3 = `# 今天新写的会议纪要\n\n结论：今天开了个会，讨论了界面配色方案，定下暖色调基调。${TAG}`
// ② 真实复读三连已被该会话自行清理（2026-09-13 晚，桶里只剩重写后的干净篇目）——
//    「必须拦截」端用 ③ 的近重写对 + 一组更强的逐句重排样本代替
const T1 = `# 仪器坏了：6 轮误诊\n\n延续：项目一直在爬同一座台阶——契约测试到真挂载到真会话。\n转折：坏的是仪器本身。旧进程占着端口，6 轮测量全打在旧进程上。\n因果：探针逐 contributor 调用拿到完整栈，profile 缺 version 字段。\nTag: 测量纪律, 静默失败`
const T2 = `# 仪器坏了：六轮误诊（重写）\n\n延续：这个项目一直在爬同一座台阶——从契约测试到真挂载再到真会话。\n转折：这次坏的是仪器本身。旧进程一直占着端口，六轮测量全部打在旧进程上。\n因果：探针逐个 contributor 调用后拿到完整栈，是 profile 少了 version 字段。\nTag: 测量纪律, 静默失败`
// ③ #21 对
const P1 = `# 渲染卡顿排查记\n\n结论：卡顿是阴影贴图分辨率过高导致，降到一半后帧率恢复六十。后续要盯顶点数指标。\n\nTag: 写入去重, 渲染管线, 索引优化\n`
const P2 = `# 渲染卡顿排查记（重写）\n\n结论：卡顿是阴影贴图分辨率过高导致的，把分辨率降到一半以后帧率就恢复到六十了。后续需要盯住顶点数指标。\n\nTag: 写入去重, 渲染管线, 索引优化\n`

await embedTexts([A1, A2, A3, T1, T2, P1, P2])
const pair = (n, a, b) => console.log(`${n}: ${cos(vecs.get(a), vecs.get(b)).toFixed(4)}`)

console.log('── ① #19 合法同话题续写（必须放行）')
pair('一月↔二月', A1, A2)
pair('一月↔会议', A1, A3)
pair('二月↔会议', A2, A3)
console.log('── ② 逐句重排复读样本（必须拦截）')
pair('仪器↔重写', T1, T2)
console.log('── ③ #21 近重复对（应拦）')
pair('排查记↔重写', P1, P2)

ws.store.close?.()
rmSync(cwd, { recursive: true, force: true })
rmSync(paths.root, { recursive: true, force: true })
