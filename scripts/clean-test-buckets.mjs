/**
 * scripts/clean-test-buckets.mjs — 归档**测试夹具桶**（真源；哨兵 `dsh-sentinel.sh` 第③项调用它）。
 *
 * 背景（2026-10-17 补）：上一代清扫器只认「有 `dailynote/` 且子目录全是 `*测试*`」这一条判据，
 * 于是**带库无日记**的夹具桶（`空桶测试` 86 个、`压缩锚测试` 4 个、`时间戳保底测试` 4 个……）
 * 在两把清扫器之间漏掉：`clean-junk-buckets.mjs` 要求「无库」才删、本器要求「有 dailynote」才归档，
 * 结果 97 个假桶常驻生产柜子。哨兵只看得见其中 8 个（有 dailynote 的），连报 3 天无人可清。
 *
 * 判据（两条取或，均**只归档不删除**，目标 `~/memo-river-archive-test-buckets/`）：
 *   R1 名字判据：`workspace.json` 的 `bucket` 含「测试」——夹具桶名由套件写死
 *      （见 `setup-selftest.mjs`、`isolated-env.mjs`、`probe-31.mjs`），生产桶名字里不带「测试」。
 *   R2 形态判据（旧规则，兜 workspace.json 缺失/损坏）：有 `dailynote/` 且其下子目录全命中 `*测试*`。
 *   R3 孤儿抽屉：既无 `workspace.json` 也无 `dailynote/`——插件靠 workspace.json 或 dailynote 子目录名
 *      解析桶（`tools.ts` folder 路由），两者皆无 = 任何工作区都再解析不到它；且 mtime 早于 `--min-age`
 *      （缺省 30 分钟，避开「刚 mkdir 还没写 workspace.json」的建桶竞态）。归档不删，留证据。
 *   R4 `.selftest` 夹具 cwd：`workspace.json.cwd` 含 `/.selftest/`——仓内夹具工作目录（`setup-selftest.mjs`
 *      的三夹具之一），桶名不带「测试」的那两个（教室建模归档/孤岛）只有靠 cwd 才认得出来。
 * 跳过：点开头目录（`.git`）、`*.bak-local` 备份桶、归档目录已有同名者（不覆盖，报冲突）。
 *
 * 用法：
 *   node scripts/clean-test-buckets.mjs            # 干跑，只列清单（缺省）
 *   node scripts/clean-test-buckets.mjs --apply    # 真归档（mv 进归档目录，同盘 rename）
 *   node scripts/clean-test-buckets.mjs --min-age 5   # 放宽 R3 的年龄闸（分钟）
 * 环境：`DSH_HOME` 决定柜子位置（与生产一致）；`MEMO_TEST_ARCHIVE` 换归档目录。
 * 输出契约：**首行** `测试桶 <N> 个 / 总桶 <M>`——哨兵用 `head -1 | grep -oE '[0-9]+' | head -1` 取 N。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const ROOT = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'memo-river')
const ARCHIVE = process.env.MEMO_TEST_ARCHIVE || join(homedir(), 'memo-river-archive-test-buckets')
const APPLY = process.argv.includes('--apply')
const TEST_RE = /测试/
const ageArg = process.argv.indexOf('--min-age')
/** 注意 `Number(x) || 30` 会把显式的 `--min-age 0` 静默吃成 30（0 是 falsy）——用 isFinite 判。 */
const MIN_AGE_MIN =
  ageArg > 0 && Number.isFinite(Number(process.argv[ageArg + 1])) ? Math.max(0, Number(process.argv[ageArg + 1])) : 30
/** R3 年龄闸：mtime 早于此刻才认孤儿——避开「刚 mkdir、workspace.json 还没落盘」的建桶窗口。 */
const CUTOFF = Date.now() - MIN_AGE_MIN * 60 * 1000

if (!existsSync(ROOT)) {
  console.log(`测试桶 0 个 / 总桶 0（柜子不存在：${ROOT}）`)
  process.exit(0)
}

/** 读桶元数据（workspace.json 缺失或坏 → 空对象）。 */
function readWorkspace(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, 'workspace.json'), 'utf8')) || {}
  } catch {
    return {}
  }
}

/** R2：`dailynote/` 存在且其下子目录全是 `*测试*`。 */
function testShaped(dir) {
  const dn = join(dir, 'dailynote')
  if (!existsSync(dn)) return false
  const subs = readdirSync(dn)
  return subs.length > 0 && subs.every((s) => TEST_RE.test(s))
}

const victims = []
const collisions = []
let total = 0
for (const name of readdirSync(ROOT)) {
  if (name.startsWith('.')) continue
  if (name.endsWith('.bak-local')) continue
  const dir = join(ROOT, name)
  let st
  try {
    st = statSync(dir)
  } catch {
    continue
  }
  if (!st.isDirectory()) continue
  total++
  const ws = readWorkspace(dir)
  const nm = ws.bucket || ''
  const r1 = TEST_RE.test(nm)
  const r2 = !r1 && testShaped(dir)
  const r3 = !r1 && !r2 && nm === '' && !existsSync(join(dir, 'dailynote')) && st.mtimeMs < CUTOFF
  const r4 = !r1 && !r2 && !r3 && /\/\.selftest\//.test(ws.cwd || '')
  if (!r1 && !r2 && !r3 && !r4) continue
  if (existsSync(join(ARCHIVE, name))) collisions.push(name)
  const why = r1
    ? 'R1名字'
    : r2
      ? 'R2形态'
      : r3
        ? `R3孤儿(mtime ${new Date(st.mtimeMs).toISOString().slice(0, 10)})`
        : 'R4.selftest夹具'
  victims.push([name, nm || '(无 workspace.json)', why])
}

console.log(`测试桶 ${victims.length} 个 / 总桶 ${total}`)
for (const [name, nm, why] of victims) {
  console.log(`   ${APPLY ? 'ARCHIVED' : 'DRY-RUN '} ${name}  ${nm}  [${why}]`)
}
if (collisions.length) console.log(`⚠️ 归档目录已有同名 ${collisions.length} 个（跳过不覆盖）：${collisions.join(' ')}`)

if (!APPLY) {
  console.log(`(加 --apply 执行归档 → ${ARCHIVE})`)
  process.exit(0)
}

mkdirSync(ARCHIVE, { recursive: true })
let moved = 0
const failed = []
for (const [name] of victims) {
  if (collisions.includes(name)) continue
  try {
    renameSync(join(ROOT, name), join(ARCHIVE, name))
    moved++
  } catch (e) {
    failed.push(`${name}: ${e.message}`)
  }
}
console.log(`已归档 ${moved}/${victims.length}（失败 ${failed.length}）→ ${ARCHIVE}`)
for (const f of failed) console.log(`   失败 ${f}`)
