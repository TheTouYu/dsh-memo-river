/**
 * 调参面板（tuning）：把写入节律的关键数字从 yml 文件里解放出来，
 * GUI 面板/工具实时可调，改完即生效（进程内 config 对象直接变异 +
 * 会话级覆盖优先于预设级），预设级写盘持久化（tuning.json）。
 *
 * 双域模型（DESIGN §6.6）：
 *  · 预设级 —— ~/.dsh/.agent-presets/memo-river/tuning.json，全工作区生效，
 *    重启后由 apply() 重放（yml 仍是基线，本文件只覆盖 TUNING_SPEC 内的键）；
 *  · 会话级 —— 进程内 Map<sessionId, values>，仅该会话生效、随进程消亡
 *    （实验旋钮：先在一个会话里试，好用了再固化到预设级）。
 *
 * 优先级：会话级 > 预设级(tuning.json) > yml/代码默认值（config.ts）。
 * 文件 mtime 变化（外部编辑/多进程）会在下一次求值时被自动重读。
 */
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Config as ConfigSchema } from './config.js'
import type { Config } from './config.js'

/** 可调键清单（面板按此渲染；扩键只加这里）。 */
export interface TuningSpecItem {
  key: string
  label: string
  hint: string
  min: number
  max: number
}

export const TUNING_SPEC: readonly TuningSpecItem[] = [
  {
    key: 'writeNudgeEveryMinutes',
    label: '时间锚（分钟）',
    hint: '模型主动思考累计超 N 分钟（llm/stream 流时长；工具执行与空闲不计入）且有未入河进展 → 提醒；兜长任务。0=关',
    min: 0,
    max: 1440,
  },
  {
    key: 'writeNudgeEveryTurns',
    label: '汇报轮锚（小轮数）',
    hint: 'N 个实质汇报小轮（≥400 字收尾）未写 → 提醒；兜快节奏。0=关',
    min: 0,
    max: 100,
  },
  {
    key: 'writeNudgeEverySteps',
    label: '步锚（步数）',
    hint: '距上次锚点 ≥N 步 → 提醒；oneshot/长回合同用，不依赖草稿。0=关',
    min: 0,
    max: 10_000,
  },
  {
    key: 'writeNudgeGrowthChars',
    label: '增量锚（字符）',
    hint: '上下文自锚点累计增长 ≥N 字符 → 提醒（5 万字符≈2–3 万 token）。0=关',
    min: 0,
    max: 10_000_000,
  },
  {
    key: 'tieBreakerEnabled',
    label: '有界 tie-breaker 开关',
    hint: '票05 读侧强化：Rust 读出后对台账主动使用信号施加 ≤cap 的排序微调。1=开 0=关（默认关；分数逐位不变）',
    min: 0,
    max: 1,
  },
  {
    key: 'tieBreakerCap',
    label: 'tie-breaker 上界',
    hint: '强化幅度上限（默认 0.05，远小于锚奖励 0.18——只在近似并列处翻序）',
    min: 0,
    max: 0.2,
  },
  {
    key: 'tieBreakerTau',
    label: 'tie-breaker 饱和常数',
    hint: 'tanh(active/τ) 的 τ（默认 2：约 3 次主动召回近饱和，防曝光积累）',
    min: 0.1,
    max: 10,
  },
  {
    key: 'tieBreakerRecencyHalfLifeDays',
    label: 'tie-breaker 半衰期（天）',
    hint: '最近主动召回的半衰期（默认 30 天：长期不被主动召回 → 强化向基线收缩）',
    min: 1,
    max: 365,
  },
] as const

const SPEC_KEYS = new Set(TUNING_SPEC.map((s) => s.key))

/** 预设级覆盖文件（测试可换路径）。 */
let tuningFile = join(homedir(), '.dsh/.agent-presets/memo-river/tuning.json')
export function setTuningFileForTest(path: string): void {
  tuningFile = path
}

const sessionTuning = new Map<string, Record<string, number>>()
let fileMtimeMs = 0
let fileValues: Record<string, number> = {}

function readTuningFile(): { mtime: number; values: Record<string, number> } {
  try {
    const st = statSync(tuningFile)
    if (st.mtimeMs !== fileMtimeMs) {
      const parsed = JSON.parse(readFileSync(tuningFile, 'utf8')) as Record<string, unknown>
      const values: Record<string, number> = {}
      for (const [k, v] of Object.entries(parsed)) {
        if (SPEC_KEYS.has(k) && typeof v === 'number' && Number.isFinite(v)) values[k] = v
      }
      return { mtime: st.mtimeMs, values }
    }
    return { mtime: fileMtimeMs, values: fileValues }
  } catch {
    return { mtime: 0, values: {} }
  }
}

/** apply() 时调用：把 tuning.json 的预设级覆盖灌进活的 config 对象（进程级即时生效）。 */
export function applyPresetTuning(config: Config): void {
  const { mtime, values } = readTuningFile()
  fileMtimeMs = mtime
  fileValues = values
  Object.assign(config.inject as unknown as Record<string, number>, values)
}

/** 每次求值时调用：外部改了文件（别的进程/手编）也能自动跟进。 */
function refreshPresetTuning(config: Config): void {
  const { mtime, values } = readTuningFile()
  if (mtime !== fileMtimeMs) applyPresetTuning(config)
}

/** 会话生效值：会话级 > 预设级（config.inject 已含） > 默认。 */
export function tuningValues(config: Config, sessionId: string | null): Record<string, number> {
  refreshPresetTuning(config)
  const out: Record<string, number> = {}
  for (const s of TUNING_SPEC) {
    const base = (config.inject as unknown as Record<string, number>)[s.key] ?? 0
    out[s.key] = base
  }
  const ov = sessionId ? sessionTuning.get(sessionId) : undefined
  if (ov) Object.assign(out, ov)
  return out
}

export interface TuningSnapshot {
  spec: readonly TuningSpecItem[]
  defaults: Record<string, number>
  preset: Record<string, number>
  session: Record<string, Record<string, number>>
  sessions: Array<{ sessionId: string; cwd: string | null }>
}

/** 面板读取：spec + 三层值 + 活跃会话清单。 */
export function tuningSnapshot(
  config: Config,
  defaults: Record<string, number>,
  listSessions: () => Array<{ sessionId: string; cwd: string | null }>,
): TuningSnapshot {
  refreshPresetTuning(config)
  const session = new Map(sessionTuning)
  return {
    spec: TUNING_SPEC,
    defaults,
    preset: { ...fileValues },
    session: Object.fromEntries(session),
    sessions: listSessions(),
  }
}

export interface TuningSetResult {
  scope: 'preset' | 'session'
  applied: Record<string, number>
  file?: string
  rejected: Array<{ key: string; reason: string }>
}

/** 写入调参：scope=preset 落盘+进程级变异；scope=session 内存覆盖。 */
export function setTuning(
  config: Config,
  scope: 'preset' | 'session',
  values: Record<string, number>,
  sessionId: string | null,
): TuningSetResult {
  const applied: Record<string, number> = {}
  const rejected: Array<{ key: string; reason: string }> = []
  for (const [k, v] of Object.entries(values ?? {})) {
    const spec = TUNING_SPEC.find((s) => s.key === k)
    if (!spec) {
      rejected.push({ key: k, reason: '不在可调键清单' })
      continue
    }
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      rejected.push({ key: k, reason: '值必须是有限数字' })
      continue
    }
    if (v < spec.min || v > spec.max) {
      rejected.push({ key: k, reason: `超出范围 [${spec.min}, ${spec.max}]` })
      continue
    }
    applied[k] = v
  }
  if (Object.keys(applied).length === 0) return { scope, applied, rejected }
  if (scope === 'preset') {
    const next = { ...fileValues, ...applied }
    mkdirSync(dirname(tuningFile), { recursive: true })
    writeFileSync(tuningFile, JSON.stringify(next, null, 2) + '\n', 'utf8')
    fileValues = next
    fileMtimeMs = statSync(tuningFile).mtimeMs
    Object.assign(config.inject as unknown as Record<string, number>, applied)
  } else {
    if (!sessionId) return { scope, applied, rejected: [...rejected, { key: '(scope)', reason: '会话级需要 sessionId' }] }
    const cur = sessionTuning.get(sessionId) ?? {}
    sessionTuning.set(sessionId, { ...cur, ...applied })
  }
  return { scope, applied, rejected, file: scope === 'preset' ? tuningFile : undefined }
}

/** 会话清场（dropSession 时调用）。 */
export function dropSessionTuning(sessionId: string): void {
  sessionTuning.delete(sessionId)
}

/** 面板/工具展示用的「代码默认值」（全默认解析；失败返回空对象，不阻塞）。 */
export function tuningDefaults(): Record<string, number> {
  try {
    // cordis z：运行时全字段有默认，空对象即可解出默认值（TS 签名要求完整 Config，故双 cast）
    const parsed = ConfigSchema({} as unknown as Config) as Config
    const out: Record<string, number> = {}
    for (const s of TUNING_SPEC) out[s.key] = (parsed.inject as unknown as Record<string, number>)[s.key] ?? 0
    return out
  } catch {
    return {}
  }
}

/* ── HTTP 面（webServer 路由）：GET/POST JSON API + 面板页 ── */

type Req = { method?: string; url?: string; on(event: 'data', cb: (chunk: Buffer) => void): void; on(event: 'end', cb: () => void): void }
type Res = { statusCode?: number; setHeader(k: string, v: string): void; end(body?: string): void }

function json(res: Res, code: number, body: unknown): void {
  res.statusCode = code
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

function queryParam(url: string | undefined, key: string): string {
  if (!url || !url.includes('?')) return ''
  for (const pair of url.slice(url.indexOf('?') + 1).split('&')) {
    const [name, value] = pair.split('=')
    if (name === key) return decodeURIComponent(value ?? '')
  }
  return ''
}

async function readBody(req: Req): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
  })
}

export function handleTuningApi(
  req: Req,
  res: Res,
  config: Config,
  defaults: Record<string, number>,
  listSessions: () => Array<{ sessionId: string; cwd: string | null }>,
): void {
  try {
    if (req.method === 'GET') {
      json(res, 200, tuningSnapshot(config, defaults, listSessions))
      return
    }
    if (req.method === 'POST') {
      void readBody(req).then((raw) => {
        try {
          const body = JSON.parse(raw || '{}') as { scope?: string; session?: string; values?: Record<string, number> }
          const scope = body.scope === 'session' ? 'session' : 'preset'
          const sessionId = body.session ?? queryParam(req.url, 'session') ?? null
          const result = setTuning(config, scope, body.values ?? {}, sessionId || null)
          json(res, result.rejected.length > 0 && Object.keys(result.applied).length === 0 ? 400 : 200, result)
        } catch (e) {
          json(res, 400, { error: String(e) })
        }
      })
      return
    }
    json(res, 405, { error: 'method not allowed' })
  } catch (e) {
    json(res, 500, { error: String(e) })
  }
}

/** GUI 卫星包探针：?session=<id> 问该会话是否挂载 memo-river；不带则问本进程是否有任一会话挂载。 */
export function handleActiveProbe(
  req: Req,
  res: Res,
  listSessions: () => Array<{ sessionId: string; cwd: string | null }>,
): void {
  const sessions = listSessions()
  const want = queryParam(req.url, 'session')
  const matched = want ? sessions.some((s) => s.sessionId === want) : undefined
  json(res, 200, { ok: true, active: sessions.length > 0, matched, count: sessions.length })
}

/** 面板页：同源 HTML，读 GET /memo-river/tuning，写 POST。中文、零依赖、暗色。 */
export function serveTuningPanel(res: Res): void {
  res.statusCode = 200
  res.setHeader('content-type', 'text/html; charset=utf-8')
  res.end(PANEL_HTML)
}

const PANEL_HTML = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>memo-river 调参</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{color-scheme:dark}
body{font:14px/1.6 system-ui,sans-serif;background:#16181d;color:#d7dae0;margin:0;padding:24px;max-width:720px}
h1{font-size:18px;margin:0 0 4px}
.sub{color:#8b93a1;font-size:12px;margin-bottom:20px}
.row{display:grid;grid-template-columns:150px 130px 1fr;gap:10px;align-items:center;padding:10px 0;border-bottom:1px solid #23262e}
.row label{font-weight:600}
.hint{font-size:12px;color:#8b93a1}
input[type=number]{width:120px;background:#1e2129;color:#e8eaed;border:1px solid #333845;border-radius:6px;padding:6px 8px;font:inherit}
select,input[type=text]{background:#1e2129;color:#e8eaed;border:1px solid #333845;border-radius:6px;padding:6px 8px;font:inherit}
.bar{display:flex;gap:16px;align-items:center;margin:18px 0;flex-wrap:wrap}
button{background:#3d6df2;color:#fff;border:0;border-radius:8px;padding:8px 18px;font:inherit;font-weight:600;cursor:pointer}
button:disabled{opacity:.5}
.src{font-size:11px;padding:2px 8px;border-radius:10px;background:#2a2f3a;color:#9db3f8}
.src.preset{background:#2a3a2f;color:#8fe3a1}
.src.session{background:#3a2f2a;color:#f0b48f}
#msg{margin-top:14px;font-size:13px;min-height:20px}
.ok{color:#8fe3a1}.err{color:#f28f8f}
</style></head><body>
<h1>memo-river · 写入节律调参</h1>
<div class="sub">改完即生效（无需重启）。预设级写入 tuning.json 对全工作区持久；会话级仅当前会话、随进程消亡——先在单会话试，好用了再固化。</div>
<div class="bar">
  <label>生效范围：
    <select id="scope"><option value="session">仅此会话</option><option value="preset">预设级（全工作区，落盘）</option></select>
  </label>
  <label>会话：<select id="session"></select></label>
  <button id="save">保存</button>
</div>
<div id="rows"></div>
<div id="msg"></div>
<script>
const $=id=>document.getElementById(id);
let SPEC=[],DEF={},PRE={},SESS={},SESSIONS=[];
function srcOf(k){
  if(SESS[k]!==undefined)return['会话覆盖','session'];
  if(PRE[k]!==undefined)return['预设覆盖','preset'];
  return['默认',''];
}
function valOf(k){return SESS[k]??PRE[k]??DEF[k]}
async function load(){
  const d=await(await fetch('/memo-river/tuning',{cache:'no-store'})).json();
  SPEC=d.spec;DEF=d.defaults;PRE=d.preset;SESSIONS=d.sessions||[];
  SESS={};
  $('session').innerHTML='<option value="">（预设级，不选会话）</option>'+
    SESSIONS.map(s=>'<option value="'+s.sessionId+'">'+s.sessionId.slice(0,14)+'… '+(s.cwd||'').split('/').pop()+'</option>').join('');
  $('rows').innerHTML=SPEC.map(s=>
    '<div class="row"><label>'+s.label+'</label>'+
    '<input type="number" id="v_'+s.key+'" min="'+s.min+'" max="'+s.max+'" step="1" value="'+valOf(s.key)+'">'+
    '<div><span class="src '+srcOf(s.key)[1]+'" id="s_'+s.key+'">'+srcOf(s.key)[0]+'</span> <span class="hint">'+s.hint+'</span></div></div>').join('');
  $('session').onchange=async()=>{
    const id=$('session').value;
    if(!id){SESS={};}
    else{const d=await(await fetch('/memo-river/tuning?session='+encodeURIComponent(id),{cache:'no-store'})).json();SESS=(d.session&&d.session[id])||{};}
    SPEC.forEach(s=>{$('v_'+s.key).value=valOf(s.key);const t=srcOf(s.key);const el=$('s_'+s.key);el.textContent=t[0];el.className='src '+t[1];});
  };
}
$('save').onclick=async()=>{
  const values={};SPEC.forEach(s=>{const v=Number($('v_'+s.key).value);if(Number.isFinite(v))values[s.key]=v;});
  const scope=$('scope').value,session=$('session').value||undefined;
  const r=await fetch('/memo-river/tuning',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({scope,session,values})});
  const d=await r.json();
  if(d.rejected&&d.rejected.length){$('msg').innerHTML='<span class="err">被拒：'+d.rejected.map(x=>x.key+' '+x.reason).join('；')+'</span>';return;}
  $('msg').innerHTML='<span class="ok">已保存（'+(scope==='preset'?'预设级，落盘 '+d.file:'会话级，即时生效')+'）</span>';
  await load();if(session){$('session').value=session;$('session').onchange&&0;SESS={};const dd=await(await fetch('/memo-river/tuning?session='+encodeURIComponent(session),{cache:'no-store'})).json();SESS=(dd.session&&dd.session[session])||{};SPEC.forEach(s=>{$('v_'+s.key).value=valOf(s.key);});}
};
load().catch(e=>{$('msg').innerHTML='<span class="err">加载失败：'+e+'（API 不可达或宿主进程还是旧代——重启 dsh web 后再试）</span>'});
</script></body></html>`
