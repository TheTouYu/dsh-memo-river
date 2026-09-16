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
import { bucketQueueStats, type BucketQueueEntry } from './drafts.js'

/** 可调键清单（面板按此渲染；扩键只加这里）。 */
export interface TuningSpecItem {
  key: string
  label: string
  hint: string
  min: number
  max: number
  /** 键落地的 config 段（票06 首次出现 write 段键；缺省 'inject' 兼容既有八键）。 */
  target?: 'inject' | 'write'
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
  {
    key: 'hubGateMode',
    label: 'hub 写入闸门（票06）',
    hint: 'autonomous/delegation 会话写已枢纽化 Tag（桶内频次≥1/3）：0=关（只软警告）1=建议（缺省：放行+观察日志+替代建议）2=硬拒+替代建议。交互会话不受影响',
    min: 0,
    max: 2,
    target: 'write',
  },
] as const

const SPEC_KEYS = new Set(TUNING_SPEC.map((s) => s.key))

/** 键 → config 段（inject/write；票06 前全部住在 inject）。 */
function configSection(config: Config, target: 'inject' | 'write' | undefined): Record<string, number> {
  return (target === 'write' ? config.write : config.inject) as unknown as Record<string, number>
}

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
  /* 票06：键按 spec.target 分段灌入（hubGateMode → config.write，其余 → config.inject）。 */
  for (const s of TUNING_SPEC) {
    if (values[s.key] !== undefined) configSection(config, s.target)[s.key] = values[s.key]
  }
}

/** 每次求值时调用：外部改了文件（别的进程/手编）也能自动跟进。 */
function refreshPresetTuning(config: Config): void {
  const { mtime, values } = readTuningFile()
  if (mtime !== fileMtimeMs) applyPresetTuning(config)
}

/** 会话生效值：会话级 > 预设级（config 段已含） > 默认。 */
export function tuningValues(config: Config, sessionId: string | null): Record<string, number> {
  refreshPresetTuning(config)
  const out: Record<string, number> = {}
  for (const s of TUNING_SPEC) {
    out[s.key] = configSection(config, s.target)[s.key] ?? 0
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
  /** 票05：各桶草稿队列可见性（面板顶部常显，含 pending=0 的桶；只读 pending/ 实际文件）。
   *  票06 扩展位：守护预审三态标记将作为每桶条目的额外字段挂进同一数组。 */
  draftQueue: BucketQueueEntry[]
}

/** 面板读取：spec + 三层值 + 活跃会话清单 + 草稿队列读数。 */
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
    draftQueue: bucketQueueStats(),
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
    /* 票06：按 spec.target 分段变异（hubGateMode → config.write）。 */
    for (const [k, v] of Object.entries(applied)) {
      const spec = TUNING_SPEC.find((s) => s.key === k)!
      configSection(config, spec.target)[k] = v
    }
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
    for (const s of TUNING_SPEC) out[s.key] = configSection(parsed, s.target)[s.key] ?? 0
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
h2{font-size:15px;margin:22px 0 6px}
table.q{width:100%;border-collapse:collapse;margin:4px 0 10px;font-size:13px}
table.q th{color:#8b93a1;font-weight:600;text-align:left;padding:5px 10px;border-bottom:1px solid #333845}
table.q td{padding:5px 10px;border-bottom:1px solid #23262e}
table.q td.n,table.q th.n{text-align:right;font-variant-numeric:tabular-nums}
table.q tr.tot td{font-weight:700;border-bottom:2px solid #333845}
.qb{display:inline-block;min-width:26px;text-align:center;border-radius:11px;padding:0 8px;font-weight:700}
.qb.z{background:#23262e;color:#8b93a1}
.qb.s{background:#4a3a20;color:#f0c48f}
.qb.h{background:#4a2020;color:#f28f8f}
.pk{display:inline-block;min-width:22px;text-align:center;border-radius:10px;padding:0 7px;margin-left:4px;font-weight:700;font-size:12px}
.pk.ok{background:#2a3a2f;color:#8fe3a1}
.pk.manual{background:#4a3a20;color:#f0c48f}
.pk.discard{background:#4a2020;color:#f28f8f}
.pk.unchecked{background:#23262e;color:#8b93a1}
</style></head><body>
<h1>memo-river · 写入节律调参</h1>
<div class="sub">改完即生效（无需重启）。预设级写入 tuning.json 对全工作区持久；会话级仅当前会话、随进程消亡——先在单会话试，好用了再固化。</div>
<h2>草稿队列（各桶待批）</h2>
<table class="q" id="queue"></table>
<div class="hint">计数 = pending/ 目录实际 .md 文件数；队列空显示 0。可对模型说「看草稿 / 批准 / 丢弃」处理积压。</div>
<div class="hint">预审三态（票06）：绿 <b>批</b>=可一键批 / 黄 <b>人</b>=需人工 / 红 <b>丢</b>=建议丢弃——守护循环只读预审（伴随 .status.json，随守护轮刷新），绝不代批；灰 <b>?</b>=尚未审到。</div>
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
function esc(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function ageTxt(h){if(h===null||h===undefined)return'—';if(h<1)return'&lt;1 小时';if(h<72)return Math.round(h)+' 小时';return Math.round(h/24)+' 天'}
/* 票06：预审三态列（ok/manual/discard/unchecked，读快照里的 precheck 计数）。 */
function pcBadges(p){
  if(!p)return'<span class="hint">—</span>';
  const out=[];
  if(p.ok)out.push('<span class="pk ok" title="可一键批">批'+p.ok+'</span>');
  if(p.manual)out.push('<span class="pk manual" title="需人工">人'+p.manual+'</span>');
  if(p.discard)out.push('<span class="pk discard" title="建议丢弃">丢'+p.discard+'</span>');
  if(p.unchecked)out.push('<span class="pk unchecked" title="尚未审到">?'+p.unchecked+'</span>');
  return out.join('')||'<span class="hint">—</span>';
}
function renderQueue(Q){
  const tot=Q.reduce((a,b)=>a+(b.pending||0),0);
  const pcTot={ok:0,manual:0,discard:0,unchecked:0};
  Q.forEach(b=>{const p=b.precheck||{};['ok','manual','discard','unchecked'].forEach(k=>pcTot[k]+=p[k]||0)});
  const rows=Q.length?Q.map(b=>{
    const n=b.pending||0,cls=n===0?'z':(n<5?'s':'h');
    return '<tr><td>'+esc(b.bucket)+' <span class="hint">'+esc(String(b.hash||'').slice(0,6))+'</span></td>'+
      '<td class="n"><span class="qb '+cls+'">'+n+'</span></td>'+
      '<td>'+ageTxt(b.oldestAgeHours)+'</td>'+
      '<td class="n">'+((b.pending||0)>0?pcBadges(b.precheck):'<span class="hint">—</span>')+'</td></tr>';
  }).join(''):'<tr><td colspan="4" class="hint">（尚无工作区桶）</td></tr>';
  $('queue').innerHTML='<tr><th>桶</th><th class="n">待批</th><th>最老年龄</th><th class="n">预审</th></tr>'+rows+
    '<tr class="tot"><td>合计</td><td class="n">'+tot+'</td><td>—</td><td class="n">'+pcBadges(tot.ok+tot.manual+tot.discard+tot.unchecked>0?pcTot:null)+'</td></tr>';
}
function srcOf(k){
  if(SESS[k]!==undefined)return['会话覆盖','session'];
  if(PRE[k]!==undefined)return['预设覆盖','preset'];
  return['默认',''];
}
function valOf(k){return SESS[k]??PRE[k]??DEF[k]}
async function load(){
  const d=await(await fetch('/memo-river/tuning',{cache:'no-store'})).json();
  SPEC=d.spec;DEF=d.defaults;PRE=d.preset;SESSIONS=d.sessions||[];
  renderQueue(d.draftQueue||[]);
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
