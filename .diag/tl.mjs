import { readFileSync } from 'node:fs'
const lines = readFileSync(new URL('./sess-df68.jsonl', import.meta.url),'utf8').trim().split('\n').map(l=>{try{return JSON.parse(l)}catch{return null}}).filter(Boolean)
const t0 = lines[0].createdAt
const rel = t => ((t-t0)/1000).toFixed(0)+'s'
for (const ev of lines) {
  const d = ev.data ?? {}
  if (ev.type === 'user/message') {
    const src = d.source ?? {}
    const txt = (Array.isArray(d.content)?d.content:[]).map(b=>b.text??`[${b.type}]`).join(' ')
    if (src.kind === 'memo-river') console.log(`[${rel(ev.time)}] INJECT(${src.form}) ${txt.slice(0,160).replace(/\n/g,' | ')}`)
    else console.log(`[${rel(ev.time)}] USER(${src.kind}) ${txt.slice(0,160).replace(/\n/g,' | ')}`)
  } else if (ev.type === 'assistant/message') {
    const txt = (Array.isArray(d.content)?d.content:[]).map(b=>b.text??`[${b.type}${b.name?':'+b.name:''}]`).join(' ')
    if (!txt.startsWith('[thinking')) console.log(`[${rel(ev.time)}] ASSIST ${txt.slice(0,140).replace(/\n/g,' | ')}`)
  } else if (String(ev.type).includes('compact')) console.log(`[${rel(ev.time)}] ${ev.type}`)
}
