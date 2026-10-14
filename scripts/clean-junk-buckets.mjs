/**
 * scripts/clean-junk-buckets.mjs — 清扫**验收残渣桶**（2026-10-14 卫生整改）。
 *
 * 背景：memo-river 给每个工作目录配一个数据抽屉，抽屉名 = `sha256(cwd)` 前 16 位
 * （`src/runtime.ts:23`），柜子 = `$DSH_HOME/memo-river/`（`src/runtime.ts:14`，缺省 `~/.dsh`）。
 * 套件把**工作目录**放 tmpdir（好习惯），但其中 **8 个套件依赖 `setup-selftest.mjs` 预铺的夹具**
 * （`.selftest/教室建模归档` 等），**不能**隔离 `DSH_HOME`（隔离后环境自检必红）——于是它们每次运行
 * 都在真柜子里留下 7~14 个空抽屉：无 `knowledge_base.sqlite`、无 `dailynote/`，永远不会被复用，
 * 也永远不会被清理。实测：288 个抽屉里 186 个是空壳，其中 35 个正是最近 2 小时 5 次验收跑出来的。
 *
 * 危害不是磁盘（154 个空壳才 0.05MB），是**语义污染**：真假桶肉眼难辨、空壳里的
 * `artifact-rebuild-failed: database is not open` 告警淹没真告警，最贵的一次代价是 2026-10-14
 * 追查「无头 emb-cache.bin」时，最早的 8 个可疑文件全躺在这种假桶里，误导取证半小时。
 *
 * 判据（三条同时成立才删，保守优先）：
 *   ① 直接位于 `$DSH_HOME/memo-river/` 下的目录（跳过 `.git` 等）；
 *   ② 没有 `knowledge_base.sqlite`、没有 `dailynote/`、没有任何 `*.sqlite*`（= 从没真正落过库、没有日记）；
 *   ③ mtime 早于 `--min-age`（缺省 30 分钟）——避免误杀正在创建的新桶。
 *
 * 用法：
 *   node scripts/clean-junk-buckets.mjs              # dry-run（缺省，只打印）
 *   node scripts/clean-junk-buckets.mjs --apply      # 真删
 *   node scripts/clean-junk-buckets.mjs --apply --min-age 5   # 放宽到 5 分钟
 * 环境：`DSH_HOME` 决定柜子位置（与生产一致）。
 */
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const ROOT = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'memo-river')
const APPLY = process.argv.includes('--apply')
const ageArg = process.argv.indexOf('--min-age')
const MIN_AGE_MIN = ageArg > 0 ? Number(process.argv[ageArg + 1]) || 30 : 30
const CUTOFF = Date.now() - MIN_AGE_MIN * 60 * 1000

if (!existsSync(ROOT)) {
  console.log(`柜子不存在：${ROOT}`)
  process.exit(0)
}

const junk = []
let junkBytes = 0
let total = 0
for (const name of readdirSync(ROOT)) {
  const dir = join(ROOT, name)
  let st
  try {
    st = statSync(dir)
  } catch {
    continue
  }
  if (!st.isDirectory()) continue
  if (name.startsWith('.')) continue
  total++
  if (existsSync(join(dir, 'knowledge_base.sqlite'))) continue
  if (existsSync(join(dir, 'dailynote'))) continue
  const files = readdirSync(dir)
  if (files.some((f) => f.includes('.sqlite'))) continue
  if (st.mtimeMs > CUTOFF) continue
  let size = 0
  for (const f of files) {
    try {
      size += statSync(join(dir, f)).size
    } catch {
      /* 忽略 */
    }
  }
  junk.push([name, files, size])
  junkBytes += size
}

console.log(
  `${APPLY ? '删除' : 'DRY-RUN 待删'}：${junk.length} 个空壳桶 / 柜子共 ${total} 个，合计 ${(junkBytes / 1048576).toFixed(2)}MB（判据：无库 + 无 dailynote + mtime > ${MIN_AGE_MIN} 分钟）`,
)
for (const [name, files, size] of junk.slice(0, 10)) {
  console.log(`   ${name}  文件 ${files.length} 个  ${(size / 1024).toFixed(1)}KB`)
}
if (junk.length > 10) console.log(`   … 其余 ${junk.length - 10} 个同类`)

if (!APPLY) {
  console.log('（dry-run；确认无误后加 --apply）')
  process.exit(0)
}
let removed = 0
for (const [name] of junk) {
  try {
    rmSync(join(ROOT, name), { recursive: true, force: true })
    removed++
  } catch (e) {
    console.log(`   删除失败 ${name}: ${e.message}`)
  }
}
console.log(`已删 ${removed}/${junk.length}；柜子剩 ${total - removed} 个桶目录`)
