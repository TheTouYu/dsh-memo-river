/**
 * src/patrol.ts —— 票 10（recall-quality-0916）：语料质量巡检（只读）。
 *
 * 三类检出（票面口径）：
 *   ① hub Tag 超限（频次/篇数 ≥ hubRatio，缺省 1/3）——直接锚泛化，检索失锐；
 *   ② 未命名/占位标题存量（正文无 `# ` 行或标题就是「未命名」）——票 02 闸门堵住了新增，
 *      这里管存量；
 *   ③ 同轴近重复簇（文件质心余弦 ≥ nearDupCosine，缺省 0.80）——批次复读稿的信号。
 *
 * 产出「具体修正建议」（哪篇、什么问题、建议动作 memo_update / memo_merge），
 * 由在场者确认后执行——本模块**绝不改写任何数据**（红线：不代批、不静默手术）。
 * 已知边界（D79 教训）：余弦测得出文本近重复、测不出叙事冗余——近重复簇只作候选，
 * 报告里明示需人在场判断。
 */
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { cosine } from './embed.js'
import type { KnowledgeStore } from './store.js'

export interface PatrolFinding {
  kind: 'hub' | 'untitled' | 'near-dup'
  fileIds: number[]
  /** 人读明细（篇目列表/频次/分数）。 */
  detail: string
  /** 建议动作（不执行）。 */
  advice: string
}

export interface PatrolOptions {
  /** hub 判定阈值（频次/篇数），缺省 1/3。 */
  hubRatio?: number
  /** 近重复质心余弦阈值，缺省 0.80。 */
  nearDupCosine?: number
  /** 向量维度截断（缺省：取首个非空向量长度）。 */
  dimension?: number
  /** hub 段最多列出的 Tag 数，缺省 3。 */
  maxHubTags?: number
  /** 每条发现列出的篇目上限，缺省 10。 */
  maxList?: number
}

const PLACEHOLDER_TITLE = /^(未命名|untitled)$/i

/** 从磁盘正文取标题：首个非空行若是 `# 标题` 返回之；否则 null（无标题行）。 */
function titleOfEntry(path: string): { title: string | null; heading: boolean } {
  try {
    const text = readFileSync(path, 'utf8')
    for (const raw of text.split('\n')) {
      const line = raw.trim()
      if (!line) continue
      const m = /^#\s+(.*)$/.exec(line)
      if (m) return { title: m[1].trim(), heading: true }
      return { title: line.slice(0, 40), heading: false } // 首个非空行不是标题
    }
    return { title: null, heading: false }
  } catch {
    return { title: null, heading: false } // 磁盘缺文件（导入语料等）：只报库内侧能报的
  }
}

/** 文件展示名：优先正文 # 标题，回退文件名 slug。 */
function displayTitle(path: string): string {
  const { title } = titleOfEntry(path)
  if (title && !PLACEHOLDER_TITLE.test(title)) return title
  return basename(path).replace(/\.md$/, '')
}

/** 并查集（近重复簇用）。 */
function dsuFind(parent: Map<number, number>, x: number): number {
  let r = x
  while (parent.get(r) !== r) r = parent.get(r)!
  while (parent.get(x) !== r) {
    const nxt = parent.get(x)!
    parent.set(x, r)
    x = nxt
  }
  return r
}

export function patrolBucket(
  store: KnowledgeStore,
  diaryName: string,
  opts: PatrolOptions = {},
): { findings: PatrolFinding[]; scanned: number; text: string } {
  const hubRatio = opts.hubRatio ?? 1 / 3
  const nearDupCosine = opts.nearDupCosine ?? 0.8
  const maxHubTags = opts.maxHubTags ?? 3
  const maxList = opts.maxList ?? 10

  const files = store.files(diaryName)
  const scanned = files.length
  const findings: PatrolFinding[] = []
  const fileById = new Map(files.map((f) => [f.id, f]))

  /* ① hub Tag 超限：tagFrequency 是库级口径（与 healthReport 一致）；分母用本桶篇数。 */
  if (scanned > 0) {
    const hubs = store
      .tagFrequency()
      .filter((t) => t.count / scanned >= hubRatio)
      .slice(0, maxHubTags)
    for (const hub of hubs) {
      const affected = files.filter((f) => store.fileTags(f.id).some((t) => t.name === hub.name))
      if (!affected.length) continue
      const list = affected
        .slice(0, maxList)
        .map((f) => `D${f.id}《${displayTitle(f.path)}》`)
        .join('、')
      findings.push({
        kind: 'hub',
        fileIds: affected.map((f) => f.id),
        detail: `「${hub.name}」${hub.count}/${scanned}（${((hub.count / scanned) * 100).toFixed(1)}%）：${list}${affected.length > maxList ? ` …（共 ${affected.length} 篇）` : ''}`,
        advice: `同轴批次稿 memo_merge 归一（压缩式遗忘），其余 memo_update 换更具体的 Tag——枢纽 Tag 让直接锚泛化，唯一锚的锐度消失`,
      })
    }
  }

  /* ② 未命名/占位标题存量。 */
  for (const f of files) {
    const { title, heading } = titleOfEntry(f.path)
    const placeholder = !heading || (title !== null && PLACEHOLDER_TITLE.test(title)) || /-未命名/.test(basename(f.path))
    if (placeholder) {
      findings.push({
        kind: 'untitled',
        fileIds: [f.id],
        detail: `D${f.id}《${title ?? '（无标题行）'}》 ${basename(f.path)}`,
        advice: `memo_update 提交新全文、首行补「# 标题」（标题是强检索信号；票 02 闸门已堵新增，此为存量残次品）`,
      })
    }
  }

  /* ③ 同轴近重复簇：文件质心 = 其 chunk 向量均值；单链聚类。 */
  const centroid = new Map<number, { vec: Float32Array; n: number }>()
  let dim = opts.dimension ?? 0
  for (const c of store.chunks(diaryName)) {
    if (!c.vector) continue
    /* 维度钳制：opts.dimension 可能大于库存向量实际长度（维度重配后的旧向量）——
     * 不钳制会读到 undefined、质心 NaN、近重复簇静默漏检（acceptance-patrol P-3 实测）。 */
    const eff = Math.min(dim || c.vector.length, c.vector.length)
    if (!dim) dim = eff
    const acc = centroid.get(c.file_id) ?? { vec: new Float32Array(dim), n: 0 }
    const v = c.vector.subarray(0, eff)
    for (let i = 0; i < eff; i++) acc.vec[i] += v[i]
    acc.n++
    centroid.set(c.file_id, acc)
  }
  for (const [fid, acc] of centroid) {
    if (acc.n > 1) for (let i = 0; i < dim; i++) acc.vec[i] /= acc.n
    centroid.set(fid, acc) // n=1 时均值=自身，无需除
  }
  const ids = [...centroid.keys()].filter((id) => fileById.has(id))
  /* 完备链聚类（非单链）：同簇成员须两两 ≥ 阈值。composer 真实桶实测单链会因
   * A~B≥t、B~C≥t 的链式传递把 114/123 篇连成一簇（最高对仅 0.866）——同域密集桶
   * 里那是失真信号不是建议。 */
  const sim = new Map<string, number>()
  const pairKey = (a: number, b: number) => `${Math.min(a, b)}:${Math.max(a, b)}`
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const score = cosine(centroid.get(ids[i])!.vec, centroid.get(ids[j])!.vec)
      if (score >= nearDupCosine) sim.set(pairKey(ids[i], ids[j]), score)
    }
  }
  const used = new Set<number>()
  const clusters: Array<{ members: number[]; top: number }> = []
  const pairsDesc = [...sim.entries()].sort((x, y) => y[1] - x[1])
  for (const [key, score] of pairsDesc) {
    const [a, b] = key.split(':').map(Number)
    if (used.has(a) || used.has(b)) continue
    const cluster = [a, b]
    used.add(a)
    used.add(b)
    for (const cand of ids) {
      if (used.has(cand)) continue
      if (cluster.every((m) => sim.get(pairKey(cand, m)) !== undefined)) {
        cluster.push(cand)
        used.add(cand)
      }
    }
    clusters.push({ members: cluster, top: score })
  }
  for (const { members, top } of clusters) {
    if (members.length < 2) continue
    members.sort((a, b) => a - b)
    const list = members
      .slice(0, maxList)
      .map((id) => `D${id}《${displayTitle(fileById.get(id)!.path)}》`)
      .join('、')
    findings.push({
      kind: 'near-dup',
      fileIds: members,
      detail: `${members.length} 篇（完备链，最高对 ${top.toFixed(3)}）：${list}${members.length > maxList ? ` …` : ''}`,
      advice: `候选同轴批次稿：memo_merge 归一（keep=首篇，正文合并增量）——余弦测不出叙事冗余，是否真同轴需人在场判断`,
    })
  }

  /* 报告渲染。 */
  const lines: string[] = [`【记忆河流·memo_patrol】桶=${diaryName}（只读巡检——不改任何数据）`]
  if (!findings.length) {
    lines.push(`· 扫描 ${scanned} 篇：✅ 三项全净（无 hub 超限 / 无未命名存量 / 无近重复簇）`)
  } else {
    const nHub = findings.filter((f) => f.kind === 'hub').length
    const nTitle = findings.filter((f) => f.kind === 'untitled').length
    const nDup = findings.filter((f) => f.kind === 'near-dup').length
    lines.push(`· 扫描 ${scanned} 篇；检出：枢纽 ${nHub}、未命名 ${nTitle}、近重复簇 ${nDup}`)
    const section = (mark: string, kind: PatrolFinding['kind'], heading: string) => {
      const group = findings.filter((f) => f.kind === kind)
      if (!group.length) return lines.push(`${mark} ${heading}：✅ 未检出`)
      lines.push(`${mark} ${heading}：`)
      for (const f of group) {
        lines.push(`   · ${f.detail}`)
        lines.push(`     → 建议：${f.advice}`)
      }
    }
    section('①', 'hub', '枢纽 Tag（频次 ≥ ' + (hubRatio * 100).toFixed(0) + '%）')
    section('②', 'untitled', '未命名/占位标题存量')
    section('③', 'near-dup', `同轴近重复簇（质心余弦 ≥ ${nearDupCosine}）`)
  }
  lines.push(`执行：建议清单经确认后走 memo_update / memo_merge；memo_patrol 不代批、不静默手术。`)
  return { findings, scanned, text: lines.join('\n') }
}
