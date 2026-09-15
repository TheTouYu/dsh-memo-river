#!/usr/bin/env python3
"""记忆河流 · 生产评估提取器（生产化版，v2）
================================================
用途：对「全部项目 × 时间窗」做 8 指标评估，产出 JSON 基线 + stdout 摘要。
数据源（只读，不写任何库）：
  ① ~/.dsh/sessions/*/*/session*.jsonl.zstd  会话事件流（注入块/memo工具/时延）
  ② ~/.dsh/memo-river/<hash>/memo-river.log  桶级 inject/memo_write/write-nudge（含 elapsedMs）
  ③ ~/.dsh/memo-river/plugin.log             guardian/write-nudge/session-start/draft 漏斗
  ④ ~/.dsh/memo-river/<hash>/health.log      体检快照（枢纽/未覆盖/使用）
用法：
  python3 scripts/eval-production.py                       # 最近 48h，输出 /tmp/mr-eval/summary.json
  python3 scripts/eval-production.py --since-hours 24
  python3 scripts/eval-production.py --baseline docs/eval-baselines/2026-09-15.json   # 对比基线打印 Δ
指标映射（详见 docs/EVAL-生产评估-runbook.md）：
  1 覆盖=会话有无注入/写入  2 纪律=工具错误数  3 精度=role分布+gate拦截+k截断
  4 主动=recall调用  5 使用=注入∩正文D-id引用  6 健康=health.log  7 遗忘=approve/discard/merge
  8 性能=inject/memo_* elapsedMs 分布
注意：会话仍在写入时读到的当轮数据是部分快照；「注入∩引用」只扫 assistant 正文，
不扫 reasoning——自主态真实利用率可能被低估（已知盲区，见 runbook）。
"""
import json, re, subprocess, os, glob, sys, argparse
from datetime import datetime, timedelta, timezone
from collections import defaultdict, Counter

CST = timezone(timedelta(hours=8))
HOME = os.path.expanduser('~')
MR = os.path.join(HOME, '.dsh/memo-river')
TEST_BUCKET_PAT = re.compile(r'测试|探针|空桶|孤岛|草稿|gate|^h$')

log_re = re.compile(r'^\[([\dT:.:-]+)Z\] \[(\w+)\] ([^ ]+)(.*)$')
inject_re = re.compile(
    r'ids=([\w,]*) omega=([\d.]+) regime=(\w+) mode=([\w_]+) chars=(\d+) '
    r'candidates=(\d+) dropped=(\d+) injectMode=(\w+) session=(\S+)'
    r'(?: gate=\{([^}]*)\})? elapsedMs=(\d+)')
did_re = re.compile(r'\bD(\d{1,3})\b')
INJ_MARK = '⟨memo-river·被动召回⟩'
NUDGE_MARK = '[memo-river·写入节律]'

def parse_ts(s):
    try:
        return datetime.strptime(s, '%Y-%m-%dT%H:%M:%S.%f').replace(tzinfo=timezone.utc).astimezone(CST)
    except Exception:
        return None

def zstd_lines(path):
    p = subprocess.Popen(['zstd', '-d', '-c', path], stdout=subprocess.PIPE,
                         text=True, errors='replace')
    for line in p.stdout:
        yield line
    p.wait()

def discover_buckets():
    """hex 目录 → bucket 名；只保留真实会话用过的（plugin.log session-start），剔除测试桶。"""
    used = set()
    for line in open(os.path.join(MR, 'plugin.log'), errors='replace'):
        if 'session-start' in line:
            m = re.search(r'bucket=(\S+)', line)
            if m: used.add(m.group(1))
    out = {}
    for d in sorted(glob.glob(os.path.join(MR, '*/'))):
        log = os.path.join(d, 'memo-river.log')
        if not os.path.exists(log): continue
        for line in open(log, errors='replace'):
            m = re.search(r'bucket=(\S+)', line)
            if m:
                b = m.group(1)
                if b in used and not TEST_BUCKET_PAT.search(b):
                    out[os.path.basename(d.rstrip('/'))] = b
                break
    return out

def dist(ms):
    if not ms: return {}
    s = sorted(ms)
    return {'n': len(s), 'mean': sum(s)//len(s), 'p50': s[len(s)//2],
            'p95': s[max(0, int(len(s)*0.95)-1)] if len(s) >= 5 else max(s), 'max': max(s)}

def part_logs(since, buckets):
    r = {}
    for h, bucket in buckets.items():
        path = os.path.join(MR, h, 'memo-river.log')
        b = {'injects': [], 'gate_block': 0, 'identical': 0, 'writes': 0,
             'nudges': 0, 'ids_freq': Counter()}
        for line in open(path, errors='replace'):
            m = log_re.match(line.strip())
            if not m: continue
            ts = parse_ts(m.group(1).replace('Z', ''))
            if not ts or ts < since: continue
            ev, rest = m.group(3), m.group(4)
            if ev == 'inject':
                im = inject_re.search(rest)
                if not im: continue
                gate = im.group(10) or ''
                b['injects'].append({'ts': ts.isoformat(),
                                     'ids': [x for x in im.group(1).split(',') if x],
                                     'candidates': int(im.group(6)), 'dropped': int(im.group(7)),
                                     'injectMode': im.group(8), 'session': im.group(9)[:23],
                                     'gate_pass': 'passed:true' in gate, 'ms': int(im.group(11))})
                b['ids_freq'].update(x for x in im.group(1).split(',') if x)
            elif ev == 'inject-skip':
                if 'gate-below' in rest: b['gate_block'] += 1
                elif 'identical' in rest: b['identical'] += 1
            elif ev == 'memo_write': b['writes'] += 1
            elif ev == 'write-nudge': b['nudges'] += 1
        ms = [i['ms'] for i in b['injects']]
        b['ms_dist'] = dist(ms)
        b['ids_freq'] = dict(b['ids_freq'].most_common(8))
        b['per_session'] = dict(Counter(i['session'][:15] for i in b['injects']))
        # health 快照（最新一行）
        hp = os.path.join(MR, h, 'health.log')
        if os.path.exists(hp):
            tail = [l for l in open(hp, errors='replace') if l.strip()][-1]
            hb = {'raw': tail.strip()[:220]}
            for k, pat in [('components', r'components=(\d+)'), ('hub', r'hub=(\S+)'),
                           ('uncovered', r'uncovered=(\S+)'), ('used', r'used=(\S+)')]:
                mm = re.search(pat, tail)
                if mm: hb[k] = mm.group(1)
            b['health'] = hb
        # 草稿队列
        b['pending'] = len(glob.glob(os.path.join(MR, h, 'pending', '*')))
        r[bucket] = b
    return r

def find_sessions(since):
    out = []
    for d in sorted(glob.glob(os.path.join(HOME, '.dsh/sessions/*/*'))):
        if not os.path.isdir(d): continue
        for f in (os.path.join(d, 'session.v3.jsonl.zstd'), os.path.join(d, 'session.jsonl.zstd')):
            if os.path.exists(f) and datetime.fromtimestamp(os.path.getmtime(f), CST) >= since:
                out.append({'dir': d, 'file': f})
                break
    return out

def part_sessions(since, sb_map):
    sessions = []
    tool_lat = defaultdict(list)
    for s in find_sessions(since):
        proj = s['dir'].split('sessions/')[1].split('/')[0]
        st = {'sid': os.path.basename(s['dir'])[:23], 'project': proj,
              'bucket': None, 'cwd': None, 'agent_preset': None,
              'user_msgs': 0, 'asst_texts': 0, 'turns': 0, 'turn_incomplete': 0,
              'injections': 0, 'roles': Counter(), 'k_limit': 0, 'nudges': 0,
              'injected_ids': set(), 'd_mentioned': set(), 'tool_calls': []}
        pending = {}
        for line in zstd_lines(s['file']):
            try: e = json.loads(line)
            except Exception: continue
            t = e.get('type'); d = e.get('data') or {}; tm = e.get('time')
            if t == 'session':
                st['sid'] = (e.get('id') or st['sid'])[:23]
                st['cwd'] = e.get('cwd'); st['agent_preset'] = e.get('agentPreset')
            if t == 'turn/start': st['turns'] += 1
            if t == 'turn/end' and (d.get('reason') or {}).get('kind') != 'completed':
                st['turn_incomplete'] += 1
            if t == 'user/message':
                txt = ''.join(c.get('text', '') for c in (d.get('content') or [])
                              if isinstance(c, dict))
                if txt.startswith(INJ_MARK):
                    st['injections'] += 1
                    st['roles'].update(re.findall(r'role=(\w+)', txt))
                    st['k_limit'] += len(re.findall(r'\(k-limit\)', txt))
                    st['injected_ids'].update('D'+i for i in did_re.findall(txt.split('未注入明细')[0]))
                elif txt.startswith(NUDGE_MARK):
                    st['nudges'] += 1
                elif (d.get('source') or {}).get('kind') == 'user':
                    st['user_msgs'] += 1
            if t == 'assistant/message':
                for c in (d.get('message') or {}).get('content') or []:
                    if isinstance(c, dict) and c.get('type') == 'text' and c.get('text'):
                        st['asst_texts'] += 1
                        st['d_mentioned'].update('D'+i for i in did_re.findall(c['text']))
            if t == 'tool/call' and str(d.get('name', '')).startswith('memo_'):
                pending[d.get('callId')] = {'name': d.get('name'), 't0': tm}
            if t == 'tool/result':
                for c in (d.get('message') or {}).get('content') or []:
                    if isinstance(c, dict) and c.get('toolCallId') and c.get('toolCallId') in pending:
                        pc = pending.pop(c['toolCallId'])
                        text = ''.join(x.get('text', '') for x in (c.get('content') or [])
                                       if isinstance(x, dict))
                        st['tool_calls'].append({'name': pc['name'],
                                                 'ms': (tm - pc['t0']) if (tm and pc['t0']) else None,
                                                 'err': bool(c.get('isError')),
                                                 'snip': text[:120].replace('\n', ' ')})
                        if pc['name'] == 'memo_write' and pc['t0'] and tm:
                            tool_lat['memo_write'].append(tm - pc['t0'])
                        break
        st['bucket'] = sb_map.get(st['sid'])
        st['roles'] = dict(st['roles'])
        st['tools'] = dict(Counter(c['name'] for c in st['tool_calls']))
        st['tool_errors'] = sum(1 for c in st['tool_calls'] if c['err'])
        st['injected_ids'] = sorted(st['injected_ids'], key=lambda x: int(x[1:]))
        st['d_mentioned'] = sorted(st['d_mentioned'], key=lambda x: int(x[1:]))
        st['overlap'] = len(set(st['injected_ids']) & set(st['d_mentioned']))
        del st['tool_calls']
        sessions.append(st)
    return sessions, {k: dist(v) for k, v in tool_lat.items()}

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--since-hours', type=int, default=48)
    ap.add_argument('--out', default='/tmp/mr-eval/summary.json')
    ap.add_argument('--baseline', default=None, help='旧基线 JSON，打印关键指标 Δ')
    args = ap.parse_args()
    since = datetime.now(CST) - timedelta(hours=args.since_hours)

    sb_map, funnel = {}, Counter()
    for line in open(os.path.join(MR, 'plugin.log'), errors='replace'):
        if 'session-start' in line:
            sid = re.search(r'id=(session-[\w-]+)', line)
            bk = re.search(r'bucket=(\S+)', line)
            if sid and bk: sb_map[sid.group(1)[:23]] = bk.group(1)
        m = log_re.match(line.strip())
        if m:
            ts = parse_ts(m.group(1).replace('Z', ''))
            if ts and ts >= since and m.group(3) in ('draft-collected', 'write-nudge'):
                funnel[m.group(3)] += 1

    buckets = discover_buckets()
    r_logs = part_logs(since, buckets)
    r_sessions, tool_stats = part_sessions(since, sb_map)
    summary = {'since': since.isoformat(), 'generated': datetime.now(CST).isoformat(),
               'since_hours': args.since_hours, 'buckets': r_logs,
               'sessions': r_sessions, 'tool_stats': tool_stats,
               'plugin_funnel': dict(funnel)}
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    json.dump(summary, open(args.out, 'w'), ensure_ascii=False, indent=1, default=str)

    print(f"=== 桶级（since {since:%m-%d %H:%M}，{args.since_hours}h）===")
    for bk, b in r_logs.items():
        d = b['ms_dist']
        att = d.get('n', 0) + b['gate_block'] + b['identical']
        gate_rate = f"{b['gate_block']*100//max(att,1)}%" if att else '-'
        print(f"[{bk}] inject n={d.get('n',0)} ms mean={d.get('mean','-')} p50={d.get('p50','-')} "
              f"p95={d.get('p95','-')} max={d.get('max','-')} | gate拦={b['gate_block']}({gate_rate}) "
              f"identical={b['identical']} writes={b['writes']} nudges={b['nudges']} pending={b['pending']}")
        if b.get('health'): print(f"   health: {b['health'].get('raw','')[:150]}")
    print(f"=== 漏斗 === {dict(funnel)}")
    print("=== memo_write 工具时延（会话侧实测）===")
    for k, v in tool_stats.items():
        print(f"  {k}: n={v['n']} mean={v['mean']}ms p50={v['p50']}ms max={v['max']}ms")
    print(f"=== 会话（{len(r_sessions)}）===")
    for st in sorted(r_sessions, key=lambda x: -x['injections']):
        print(f"[{st['sid'][:15]}] {st['project'].replace('--','')[:28]:28s} bk={st['bucket']} "
              f"preset={st['agent_preset']} U={st['user_msgs']} 注入={st['injections']} "
              f"direct_answer={st['roles'].get('direct_answer',0)} k截={st['k_limit']} "
              f"引用={st['overlap']}/{len(st['injected_ids'])} 工具={st['tools']} 错={st['tool_errors']}")
    if args.baseline and os.path.exists(args.baseline):
        base = json.load(open(args.baseline))
        print(f"=== Δ vs 基线 {os.path.basename(args.baseline)} ===")
        for bk, b in r_logs.items():
            ob = (base.get('buckets') or {}).get(bk) or {}
            od = ob.get('ms_dist') or {}
            if od or b['ms_dist']:
                print(f"[{bk}] inject n {od.get('n','-')}→{b['ms_dist'].get('n','-')} "
                      f"mean {od.get('mean','-')}→{b['ms_dist'].get('mean','-')}ms "
                      f"pending {ob.get('pending','-')}→{b['pending']}")
    print(f"→ {args.out}")

if __name__ == '__main__':
    main()
