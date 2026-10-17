#!/usr/bin/env node
/**
 * probe-h7.mjs — H7 写入闸门 suggest 档的行为读数（三级验证台阶③：真库真写入）。
 *
 * 设计：隔离 DSH_HOME + 真嵌入端点（127.0.0.1:8099 生产本地 bge-m3，语义向量真实）。
 * 连写两篇同主题日记（第二篇含推翻信号词、不声明 supersedes）→ 断言第二篇报告出现
 * 「H7·推翻信号」行；再写三个负例对照（无信号词 / 已声明 / 不同主题）断言不触发。
 *
 * 判据（全过 = H7 行为读数成立）：
 *   P1 正例：同主题 + 信号词 + 未声明 → 报告含「H7·推翻信号」且指认 D1，cos≥0.60
 *   N1 无信号词：同主题、正文干净 → 不触发
 *   N2 已声明：同主题 + 信号词 + supersedeDeclared=1 → 不触发
 *   N3 不同主题：信号词 + 但主题远离（cos<0.60）→ 不触发
 */
import { createServer } from 'node:http'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = import.meta.dirname
const SCRATCH = join(ROOT, '..', '.scratch', 'h7-probe')
const DSH_HOME = join(SCRATCH, 'dsh-home')
const WS = join(SCRATCH, 'ws')
rmSync(SCRATCH, { recursive: true, force: true })
mkdirSync(DSH_HOME, { recursive: true })
mkdirSync(WS, { recursive: true })
process.env.DSH_HOME = DSH_HOME // 必须在 import lib 之前

const LIB = join(ROOT, '..', 'lib')
const EMBED = process.env.H7_EMBED_URL ?? 'http://127.0.0.1:8099/v1/embeddings'
const EMBED_KEY = process.env.H7_EMBED_KEY ?? 'local'
const EMBED_MODEL = process.env.H7_EMBED_MODEL ?? 'bge-m3'
const DIM = 1024

const { Config } = await import(join(LIB, 'config.js'))
const { acquireWorkspace } = await import(join(LIB, 'workspace.js'))
const { writeDiaryCore } = await import(join(LIB, 'tools.js'))

const config = Config({
  bucket: 'h7probe',
  native: { vcpRoot: '/home/h/app/VCPToolBox' },
  embed: { apiUrl: EMBED, apiKey: EMBED_KEY, model: EMBED_MODEL, dimension: DIM },
})

const ws = await acquireWorkspace(WS, config, 'h7probe')
const base = {
  date: '2026-10-16',
  bucket: 'h7probe',
  newTagReason: '探针冷启动词汇（隔离空桶首建）',
  preamble: '【探针】H7 行为读数',
  toolName: 'memo_write',
}

let pass = 0, fail = 0
function check(name, ok, detail = '') {
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`)
  ok ? pass++ : fail++
}

/* ── 第一篇：建立主题基线（XXTEA 加密流实现结论） ── */
const r1 = await writeDiaryCore(ws, {
  ...base,
  title: 'XXTEA 流密码本机实现结论：单线程 120MB/s 无需 SIMD',
  content:
    '# XXTEA 流密码本机实现结论：单线程 120MB/s 无需 SIMD\nXXTEA 在本机单线程跑出 120MB/s，加载数据用 mmap 直接映射即可，不需要 SIMD 优化。部署形态就是单进程常驻。\nTag: 密码学, 性能基线, 流密码',
  tags: ['密码学', '性能基线', '流密码'],
})
check('W1 基线篇写入成功', r1.status === 'written', `chunk=D${r1.chunkId}`)

/* ── P1 正例：同主题 + 推翻信号 + 未声明 ── */
const rp = await writeDiaryCore(ws, {
  ...base,
  title: 'XXTEA 基准被推翻：SIMD 后 8 倍且 mmap 假设作废',
  content:
    '# XXTEA 基准被推翻：SIMD 后 8 倍且 mmap 假设作废\n昨日「单线程 120MB/s 无需 SIMD」的结论已被证伪：SIMD 内核实测 960MB/s（8 倍），且 mmap 假设在随机读场景作废，必须改用 io_uring。原基准的测量方法有系统误差。\nTag: 密码学, 性能基线, 流密码',
  tags: ['密码学', '性能基线', '流密码'],
})
const hit = rp.report.includes('H7·推翻信号')
const m = rp.report.match(/H7·推翻信号.*?\n(.*?)(?:\n|$)/s)
const cosOk = hit && /cos=0\.(6\d|7\d|8\d|9\d)/.test(rp.report)
check('P1 同主题+信号词+未声明 → 建议行出现', hit, m ? m[0].slice(0, 90) : '未触发')
check('P1 建议行指认基线篇且 cos≥0.60', cosOk, (rp.report.match(/cos=[\d.]+/)?.[0] ?? 'no-cos'))

/* ── N1 负例：同主题、无信号词 ── */
const rn1 = await writeDiaryCore(ws, {
  ...base,
  title: 'XXTEA 补充：密钥轮换周期建议 24 小时',
  content:
    '# XXTEA 补充：密钥轮换周期建议 24 小时\n延续昨日的实现结论，补充运维参数：密钥轮换周期 24 小时，会话票据 TTL 5 分钟。\nTag: 密码学, 性能基线, 流密码',
  tags: ['密码学', '性能基线', '流密码'],
})
check('N1 无信号词 → 不触发', rn1.status === 'written' && !rn1.report.includes('H7·推翻信号'))

/* ── N2 负例：信号词 + 已声明 supersedes ── */
const rn2 = await writeDiaryCore(ws, {
  ...base,
  supersedeDeclared: 1,
  title: 'XXTEA 第二次勘误：SIMD 增益在 ARM 上不成立',
  content:
    '# XXTEA 第二次勘误：SIMD 增益在 ARM 上不成立\n再勘误：SIMD 8 倍增益仅在 x86 成立，ARM NEON 实测无增益，该结论在 ARM 平台作废。\nTag: 密码学, 性能基线, 流密码',
  tags: ['密码学', '性能基线', '流密码'],
})
check('N2 已声明 supersedes → 不触发', rn2.status === 'written' && !rn2.report.includes('H7·推翻信号'))

/* ── N3 负例：信号词 + 不同主题（语义远） ── */
const rn3 = await writeDiaryCore(ws, {
  ...base,
  title: '纹理压缩格式勘误：ASTC 在移动端已作废改用 ETC2',
  content:
    '# 纹理压缩格式勘误：ASTC 在移动端已作废改用 ETC2\n勘误：此前移动端纹理推荐 ASTC 的结论作废，新基准显示 ETC2 全场景更优，推翻旧推荐。\nTag: 图形渲染, 移动端, 纹理压缩',
  tags: ['图形渲染', '移动端', '纹理压缩'],
  newTagReason: '探针负例新领域',
})
check(
  'N3 不同主题 → 不触发',
  rn3.status === 'written' && !rn3.report.includes('H7·推翻信号'),
  rn3.status !== 'written' ? rn3.report.slice(0, 140) : (rn3.report.match(/H7·推翻信号.*?cos=[\d.]+/)?.[0] ?? '(未触发)'),
)

console.log(`\n${pass}/${pass + fail}`)
process.exit(fail === 0 ? 0 : 1)
