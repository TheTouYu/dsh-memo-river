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
  python3 scripts/eval-production.py --session c9f838ba     # 单会话八项指标（含子代理树聚合+写入自发性）
  python3 scripts/eval-production.py --bucket genshin-ts    # 单桶健康（components/hub/used/pending）
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
    r'candidates=(\d+) dropped=(\d+) injectMode=(\w+)(?: trigger=(\w+))? session=(\S+)'
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
                gate = im.group(11) or ''
                b['injects'].append({'ts': ts.isoformat(),
                                     'ids': [x for x in im.group(1).split(',') if x],
                                     'candidates': int(im.group(6)), 'dropped': int(im.group(7)),
                                     'injectMode': im.group(8), 'session': im.group(10)[:23],
                                     'gate_pass': 'passed:true' in gate, 'ms': int(im.group(12))})
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

# ---------------------------------------------------------------- 单会话 / 单桶作用域（票 08）

def parse_until(s):
    """--until 快照截止：接受 CST 本地时间（2026-09-16 02:01[[:ss]]）或带 Z 的 UTC ISO。→ epoch ms。"""
    if not s: return None
    s2 = s.replace('T', ' ')
    for fmt in ('%Y-%m-%d %H:%M:%S', '%Y-%m-%d %H:%M', '%Y-%m-%d'):
        try:
            return datetime.strptime(s2, fmt).replace(tzinfo=CST).timestamp() * 1000
        except Exception: pass
    for fmt in ('%Y-%m-%dT%H:%M:%S.%fZ', '%Y-%m-%dT%H:%M:%SZ', '%Y-%m-%dT%H:%M'):
        try:
            dt = datetime.strptime(s, fmt)
            tz = timezone.utc if s.endswith('Z') else CST
            return dt.replace(tzinfo=tz).timestamp() * 1000
        except Exception: pass
    print(f"!! --until 无法解析：{s}（示例：'2026-09-16 02:01' 或 2026-09-15T18:01:00Z）"); sys.exit(2)

def scan_session_file(path, until_ms=None):
    """全量解析单个会话流（无时间窗），为 --session 聚合取数。只读。"""
    st = {'file': path, 'sid': None, 'parent': None, 'preset': None, 'cwd': None,
          'origin': None, 'created': None, 'last_ts': None, 'label': None,
          'user_msgs': 0, 'injections': 0, 'roles': Counter(), 'k_limit': 0,
          'injected_ids': set(), 'd_mentioned': set(), 'nudge_times': [],
          'write_times': [], 'memo_calls': Counter(), 'memo_err': 0,
          'write_lat': [], 'children_ids': []}
    pending = {}
    for line in zstd_lines(path):
        try: e = json.loads(line)
        except Exception: continue
        t = e.get('type'); d = e.get('data') or {}; tm = e.get('time')
        if until_ms and tm and tm > until_ms: continue
        if tm: st['last_ts'] = tm
        if t == 'session':
            st['sid'] = e.get('id'); st['cwd'] = e.get('cwd')
            st['preset'] = e.get('agentPreset'); st['parent'] = e.get('parentSession')
            st['origin'] = e.get('origin'); st['created'] = e.get('createdAt')
        elif t == 'subagent/descriptor':
            if d.get('label'): st['label'] = d['label']
        elif t == 'subagent/catalog':
            if d.get('childId'): st['children_ids'].append(d['childId'])
        elif t == 'user/message':
            txt = ''.join(c.get('text', '') for c in (d.get('content') or [])
                          if isinstance(c, dict))
            if txt.startswith(INJ_MARK):
                st['injections'] += 1
                st['roles'].update(re.findall(r'role=(\w+)', txt))
                st['k_limit'] += len(re.findall(r'\(k-limit\)', txt))
                st['injected_ids'].update('D'+i for i in did_re.findall(txt.split('未注入明细')[0]))
            elif txt.startswith(NUDGE_MARK):
                st['nudge_times'].append(tm)
            elif (d.get('source') or {}).get('kind') == 'user':
                st['user_msgs'] += 1
        elif t == 'assistant/message':
            for c in (d.get('message') or {}).get('content') or []:
                if isinstance(c, dict) and c.get('type') == 'text' and c.get('text'):
                    st['d_mentioned'].update('D'+i for i in did_re.findall(c['text']))
        elif t == 'tool/call' and str(d.get('name', '')).startswith('memo_'):
            pending[d.get('callId')] = {'name': d.get('name'), 't0': tm}
        elif t == 'tool/result':
            for c in (d.get('message') or {}).get('content') or []:
                if isinstance(c, dict) and c.get('toolCallId') and c.get('toolCallId') in pending:
                    pc = pending.pop(c['toolCallId'])
                    st['memo_calls'][pc['name']] += 1
                    if c.get('isError'): st['memo_err'] += 1
                    if pc['name'] == 'memo_write':
                        st['write_times'].append(pc['t0'])
                        if tm and pc['t0']: st['write_lat'].append(tm - pc['t0'])
                    break
    return st

def resolve_session_file(sid):
    """按 id/前缀找会话文件：目录名等于、前缀或包含给定串。多命中则列出候选退出。"""
    hits = []
    for d in sorted(glob.glob(os.path.join(HOME, '.dsh/sessions/*/*'))):
        if not os.path.isdir(d): continue
        base = os.path.basename(d)
        if sid == base or base.startswith(sid) or sid in base:
            for fn in ('session.v3.jsonl.zstd', 'session.jsonl.zstd'):
                f = os.path.join(d, fn)
                if os.path.exists(f): hits.append(f); break
    uniq = sorted(set(hits))
    if len(uniq) == 1: return uniq[0]
    if not uniq:
        print(f'!! 找不到会话：{sid}（在 ~/.dsh/sessions/*/* 下按目录名匹配）'); sys.exit(2)
    print(f'!! 会话前缀多命中（{len(uniq)}），请用更长的前缀：')
    for f in uniq[:20]: print('   ', f)
    sys.exit(2)

def build_tree(root_file, until_ms=None):
    """父 + 子代理树：父流 subagent/catalog childId ∪ 同项目目录 parentSession 链接，BFS ≤4 层。"""
    root = scan_session_file(root_file, until_ms)
    tree = [root]
    seen = {root['sid'] or os.path.basename(os.path.dirname(root_file))}
    proj_glob = os.path.dirname(root_file)
    # 一次性首行扫描同项目目录，建立 parentSession -> 会话文件 索引
    by_parent = defaultdict(list)
    sid_to_file = {}
    for d in sorted(glob.glob(os.path.join(os.path.dirname(proj_glob), '*'))):
        if not os.path.isdir(d): continue
        f = os.path.join(d, 'session.v3.jsonl.zstd')
        if not os.path.exists(f): continue
        p = subprocess.Popen(['zstd', '-d', '-c', f], stdout=subprocess.PIPE,
                             text=True, errors='replace')
        first = p.stdout.readline(); p.kill(); p.wait()
        try: e = json.loads(first)
        except Exception: continue
        sid = e.get('id') or os.path.basename(d)
        sid_to_file[sid] = f
        par = e.get('parentSession')
        if par: by_parent[par].append(f)
    frontier = [root]
    for _ in range(4):
        nxt = []
        for node in frontier:
            proj_dir = os.path.dirname(os.path.dirname(node['file']))
            kids = []
            for k in node['children_ids']:
                for fn in ('session.v3.jsonl.zstd', 'session.jsonl.zstd'):
                    kf = os.path.join(proj_dir, k, fn)
                    if os.path.exists(kf): kids.append(kf); break
            kids += by_parent.get(node['sid'], [])
            for kf in kids:
                if not os.path.exists(kf): continue
                ksid = os.path.basename(os.path.dirname(kf))
                if ksid in seen: continue
                seen.add(ksid)
                ks = scan_session_file(kf, until_ms)
                nxt.append(ks); tree.append(ks)
        if not nxt: break
        frontier = nxt
    return tree

def spont_alignment(st):
    """每次 memo_write 的自发性：write 前最近一次 write-nudge 到达 → NUDGED(间隔秒)；无 → SPONT。"""
    evs = sorted([('nudge', t) for t in st['nudge_times'] if t] +
                 [('write', t) for t in st['write_times'] if t], key=lambda x: x[1])
    out, last_nudge = [], None
    for kind, t in evs:
        if kind == 'nudge': last_nudge = t
        elif last_nudge is None: out.append(('SPONT', None))
        else: out.append(('NUDGED', round((t - last_nudge) / 1000.0, 1)))
    return out

def health_snapshot(h, until_ms=None):
    """桶 health.log 尾行完整解析（--until 时取 ≤ 截止的最后一行）。"""
    hp = os.path.join(MR, h, 'health.log')
    if not os.path.exists(hp): return None
    lines = [l for l in open(hp, errors='replace') if l.strip()]
    if until_ms:
        lines = [l for l in lines if (lambda ts: ts is None or ts <= until_ms)(parse_ts_z(l[1:25]))]
    if not lines: return None
    tail = lines[-1].strip()
    hb = {'raw': tail}
    for k, pat in [('round', r'round=(\d+)'), ('components', r'components=(\d+)'),
                   ('hub', r'hub=(\S+)'), ('omegaMean', r'omegaMean=([\d.]+)'),
                   ('omegaN', r'omegaN=(\d+)'), ('uncovered', r'uncovered=(\S+)'),
                   ('used', r'used=(\S+)'), ('topUsed', r'topUsed=(\S+)'),
                   ('mergeCandidates', r'mergeCandidates=(\S+)'), ('warnings', r'warnings=(\d+)')]:
        mm = re.search(pat, tail)
        if mm: hb[k] = mm.group(1)
    mm = re.match(r'(\S+):(\d+)/(\d+)', hb.get('hub', ''))
    if mm: hb['hub_pct'] = round(int(mm.group(2)) * 100 / int(mm.group(3)), 1)
    mu = re.match(r'(\d+)/(\d+)', hb.get('used', ''))
    if mu: hb['used_pct'] = round(int(mu.group(1)) * 100 / int(mu.group(2)), 1)
    return hb

def pending_md_count(h):
    """pending 草稿数（只数 .md，剔除 .status.json 边车）。"""
    return len([f for f in glob.glob(os.path.join(MR, h, 'pending', '*')) if f.endswith('.md')])

def parse_ts_z(s):
    """health.log/桶日志行首 UTC 时间戳（[2026-09-16T00:01:21.092Z] 的内部段）→ epoch ms。"""
    try:
        return datetime.strptime(s, '%Y-%m-%dT%H:%M:%S.%fZ').replace(tzinfo=timezone.utc).timestamp() * 1000
    except Exception:
        return None

def bucket_log_alltime(h, tree_sids=None, until_ms=None):
    """桶日志统计（--until 时为 ≤ 截止的快照）；给了 tree_sids 则附带树内会话归属的 inject 明细。"""
    path = os.path.join(MR, h, 'memo-river.log')
    b = {'injects': 0, 'gate_block': 0, 'identical': 0, 'other_skip': 0,
         'writes': 0, 'updates': 0, 'nudges': 0,
         'tree_injects': 0, 'tree_ms': [], 'tree_dropped': 0, 'tree_max_candidates': 0,
         'tree_gate_pass': 0, 'tree_inject_sessions': Counter(), 'all_ms': []}
    if not os.path.exists(path): return b
    for line in open(path, errors='replace'):
        m = log_re.match(line.strip())
        if not m: continue
        if until_ms:
            lts = parse_ts_z(m.group(1) + 'Z')
            if lts is not None and lts > until_ms: continue
        ev, rest = m.group(3), m.group(4)
        if ev == 'inject':
            im = inject_re.search(rest)
            em = re.search(r'elapsedMs=(\d+)', rest)
            if em: b['all_ms'].append(int(em.group(1)))
            b['injects'] += 1   # 全量口径：含无 session= 的旧格式行
            if im:
                if tree_sids and im.group(10) in tree_sids:
                    b['tree_injects'] += 1
                    b['tree_inject_sessions'][im.group(10)[:23]] += 1
                    if em: b['tree_ms'].append(int(em.group(1)))
                    b['tree_dropped'] += int(im.group(7))
                    b['tree_max_candidates'] = max(b['tree_max_candidates'], int(im.group(6)))
                    if 'passed:true' in (im.group(11) or ''): b['tree_gate_pass'] += 1
        elif ev == 'inject-skip':
            if 'gate-below' in rest: b['gate_block'] += 1
            elif 'identical' in rest: b['identical'] += 1
            else: b['other_skip'] += 1
        elif ev == 'memo_write': b['writes'] += 1
        elif ev == 'memo_update': b['updates'] += 1
        elif ev == 'write-nudge': b['nudges'] += 1
    return b

def fmt_t(ms):
    if not ms: return '?'
    return datetime.fromtimestamp(ms / 1000, CST).strftime('%m-%d %H:%M:%S')

def report_session(args):
    root_file = resolve_session_file(args.session)
    until_ms = parse_until(getattr(args, 'until', None))
    tree = build_tree(root_file, until_ms)
    parent = tree[0]
    kids = tree[1:]
    root_sid = parent['sid'] or os.path.basename(os.path.dirname(root_file))
    # 桶定位：plugin.log session-start；子会话无自身记录则沿 parentSession 继承
    starts = {}
    for line in open(os.path.join(MR, 'plugin.log'), errors='replace'):
        if 'session-start' in line:
            sm = re.search(r'id=(session-[\w-]+|[0-9a-f-]{36})', line)
            bm = re.search(r'bucket=(\S+)', line)
            if sm and bm: starts[sm.group(1)] = bm.group(1)
    bucket = starts.get(root_sid)
    if not bucket:
        node = parent
        for _ in range(4):
            par = node['parent']
            if not par: break
            if starts.get(par): bucket = starts[par]; break
            proj_dir = os.path.dirname(os.path.dirname(node['file']))
            pf = os.path.join(proj_dir, par, 'session.v3.jsonl.zstd')
            if not os.path.exists(pf): break
            node = scan_session_file(pf, until_ms)
    buckets_rev = {v: k for k, v in discover_buckets().items()}
    h = buckets_rev.get(bucket)
    tree_sids = set(s['sid'] for s in tree if s['sid']) | {root_sid}
    bl = bucket_log_alltime(h, tree_sids, until_ms) if h else None
    health = health_snapshot(h, until_ms) if h else None

    inj_total = sum(s['injections'] for s in tree)
    writes_total = sum(s['memo_calls'].get('memo_write', 0) for s in tree)
    updates_total = sum(s['memo_calls'].get('memo_update', 0) for s in tree)
    recall_total = sum(s['memo_calls'].get('memo_recall', 0) for s in tree)
    roles = Counter()
    for s in tree: roles.update(s['roles'])
    k_limit = sum(s['k_limit'] for s in tree)
    err_total = sum(s['memo_err'] for s in tree)
    inj_sessions = sum(1 for s in tree if s['injections'])
    write_sessions = sum(1 for s in tree if s['memo_calls'].get('memo_write'))
    dark = [s for s in kids if not s['injections']]
    spont = [a for s in tree for a in spont_alignment(s)]
    spont_n = sum(1 for x in spont if x[0] == 'SPONT')
    nudged_gaps = [x[1] for x in spont if x[1] is not None]
    write_lat = [x for s in tree for x in s['write_lat']]
    dur = (parent['last_ts'] - parent['created']) / 1000 if parent['last_ts'] and parent['created'] else None
    p_overlap = len(parent['injected_ids'] & parent['d_mentioned'])
    t_overlap = len(set().union(*[s['injected_ids'] for s in tree]) &
                    set().union(*[s['d_mentioned'] for s in tree])) if tree else 0
    t_inj_ids = len(set().union(*[s['injected_ids'] for s in tree])) if tree else 0

    print(f"=== 会话树 {root_sid} ==="
          + (f"（快照 ≤ {args.until}）" if until_ms else '（含活会话最新事件）'))
    print(f"父 1 + 子代理 {len(kids)} = {len(tree)} 会话 | bucket={bucket} preset={parent['preset']} "
          f"cwd={parent['cwd']} | {fmt_t(parent['created'])} → {fmt_t(parent['last_ts'])}"
          + (f"（{dur/3600:.1f}h）" if dur else ''))
    if kids:
        print(f"{'子id':9s} {'开始':8s} {'时长':>5s} {'注入':>3s} {'写':>3s} {'recall':>5s} {'错':>2s} {'SPONT/NUDGED':>12s}  label")
        for s in sorted(kids, key=lambda x: x['created'] or 0):
            sp = spont_alignment(s)
            kdur = (s['last_ts'] - s['created']) / 1000 if s['last_ts'] and s['created'] else 0
            print(f"{(s['sid'] or '?')[:8]:9s} {datetime.fromtimestamp((s['created'] or 0)/1000, CST).strftime('%H:%M:%S')} "
                  f"{int(kdur):5d}s {s['injections']:3d} {s['memo_calls'].get('memo_write',0):3d} "
                  f"{s['memo_calls'].get('memo_recall',0):5d} {s['memo_err']:2d} "
                  f"{sum(1 for x in sp if x[0]=='SPONT')}/{sum(1 for x in sp if x[0]=='NUDGED'):>2d}       {s['label'] or ''}")
    print(f"--- 八项指标 ---")
    print(f"[1 写入覆盖] 注入会话 {inj_sessions}/{len(tree)}（父 {parent['injections']} + 子 {inj_total - parent['injections']}）"
          f" | 写入会话 {write_sessions}/{len(tree)} | 暗会话（零注入子代理）{len(dark)}")
    print(f"[2 写入纪律] memo_write {writes_total}（父 {parent['memo_calls'].get('memo_write',0)} + 子 {writes_total - parent['memo_calls'].get('memo_write',0)}）"
          f" | memo_update {updates_total} | memo_* 错误 {err_total}")
    da = roles.get('direct_answer', 0)
    print(f"[3 注入精度] 注入（会话流侧）{inj_total}（父 {parent['injections']}+子 {inj_total - parent['injections']}）"
          + (f" | 桶日志树内 inject {bl['tree_injects']}、桶全量 {bl['injects']}" if bl else '')
          + f" | direct_answer {da}/{inj_total} | k截标记 {k_limit}"
          + (f" | gate 拦=0 全过 {bl['tree_gate_pass']}/{bl['tree_injects']} | dropped 累计 {bl['tree_dropped']}"
             f" 单次候选峰值 {bl['tree_max_candidates']}" if bl else ''))
    print(f"[4 主动补证] memo_recall {recall_total}（父 {parent['memo_calls'].get('memo_recall',0)} + 子 {recall_total - parent['memo_calls'].get('memo_recall',0)}）")
    print(f"[5 使用效果] 父引用 {p_overlap}/{len(parent['injected_ids'])}"
          + (f"={p_overlap*100//max(len(parent['injected_ids']),1)}%" if parent['injected_ids'] else '')
          + f" | 树引用 {t_overlap}/{t_inj_ids}"
          + (f" | 桶 used {health['used']}={health['used_pct']}%" if health and health.get('used') else ''))
    if health:
        print(f"[6 语料健康] components={health.get('components')} | hub {health.get('hub')}"
              + (f"={health['hub_pct']}%" if health.get('hub_pct') is not None else '')
              + f" | uncovered {health.get('uncovered')} | Ω mean {health.get('omegaMean')}(N={health.get('omegaN')})"
              f" | topUsed {health.get('topUsed')}")
    else:
        print(f"[6 语料健康] （无 health.log）")
    print(f"[7 遗忘落地] pending 草稿 {pending_md_count(h) if h else '-'} 篇（当前口径）"
          f" | approve/discard/merge 调用 "
          f"{sum(s['memo_calls'].get('memo_approve',0)+s['memo_calls'].get('memo_discard',0)+s['memo_calls'].get('memo_merge',0) for s in tree)}")
    perf = []
    if bl and bl['tree_ms']: perf.append(f"inject（桶日志树内）{dist(bl['tree_ms'])}")
    if bl and bl['all_ms']: perf.append(f"inject（桶全量）{dist(bl['all_ms'])}")
    if write_lat: perf.append(f"memo_write（会话侧）{dist(write_lat)}")
    print("[8 性能] " + ' | '.join(perf) if perf else '[8 性能] （无数据）')
    print(f"[写入自发性] {len(spont)} 写 = SPONT {spont_n} / NUDGED {len(spont)-spont_n}"
          + (f" | nudge→write 间隔 p50={sorted(nudged_gaps)[len(nudged_gaps)//2]:.0f}s "
             f"max={max(nudged_gaps):.0f}s min={min(nudged_gaps):.0f}s" if nudged_gaps else ''))
    for s in [parent] + kids:
        sp = spont_alignment(s)
        if not sp: continue
        detail = ', '.join(f"{x[0]}{'(' + fmt_gap(x[1]) + ')' if x[1] is not None else ''}" for x in sp)
        who = '父' if s is parent else (s['sid'] or '?')[:8]
        print(f"    {who}: {detail}")

    out = {'mode': 'session', 'session': root_sid, 'bucket': bucket, 'hash': h,
           'tree_size': len(tree), 'window': {'start': fmt_t(parent['created']), 'end': fmt_t(parent['last_ts'])},
           'metrics': {
               'coverage': {'sessions_with_inject': inj_sessions, 'sessions_with_write': write_sessions,
                            'dark_children': len(dark), 'injections_parent': parent['injections'],
                            'injections_children': inj_total - parent['injections']},
               'discipline': {'writes': writes_total, 'updates': updates_total, 'memo_errors': err_total},
               'precision': {'injections_stream': inj_total, 'roles': dict(roles), 'k_limit': k_limit,
                             'bucket_tree_injects': bl['tree_injects'] if bl else None,
                             'bucket_total_injects': bl['injects'] if bl else None,
                             'tree_dropped_total': bl['tree_dropped'] if bl else None},
               'recall': recall_total,
               'usage': {'parent': [p_overlap, len(parent['injected_ids'])], 'tree': [t_overlap, t_inj_ids],
                         'bucket_used': (health or {}).get('used')},
               'health': health,
               'forgetting': {'pending': pending_md_count(h) if h else None},
               'performance': {'inject_tree': dist(bl['tree_ms']) if bl and bl['tree_ms'] else {},
                               'inject_bucket_all': dist(bl['all_ms']) if bl and bl['all_ms'] else {},
                               'memo_write': dist(write_lat)}},
           'spontaneity': {'spont': spont_n, 'nudged': len(spont) - spont_n,
                           'gaps_s': sorted(nudged_gaps)},
           'children': [{'sid': s['sid'], 'label': s['label'], 'injections': s['injections'],
                         'writes': s['memo_calls'].get('memo_write', 0),
                         'recall': s['memo_calls'].get('memo_recall', 0),
                         'errors': s['memo_err'], 'roles': dict(s['roles'])} for s in kids]}
    out_path = args.out or f"/tmp/mr-eval/session-{root_sid[:19].replace('session-', '')}" \
               + ("-until" if until_ms else "") + ".json"
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    json.dump(out, open(out_path, 'w'), ensure_ascii=False, indent=1, default=str)
    print(f"→ {out_path}")

def fmt_gap(sec):
    return f"{sec/60:.0f}m" if sec >= 120 else f"{sec:.0f}s"

def report_bucket(args):
    name = args.bucket
    buckets = discover_buckets()
    matches = [hh for hh, bb in buckets.items() if bb == name]
    if not matches:
        print(f"!! 找不到桶：{name}（候选：{sorted(set(buckets.values()))}）"); sys.exit(2)
    h = matches[0]
    until_ms = parse_until(getattr(args, 'until', None))
    health = health_snapshot(h, until_ms)
    bl = bucket_log_alltime(h, None, until_ms)
    print(f"=== 桶 {name}（{h}）===" + (f"（快照 ≤ {args.until}）" if until_ms else ''))
    if health:
        print(f"[体检] round={health.get('round')} components={health.get('components')} "
              f"hub={health.get('hub')}" + (f"={health['hub_pct']}%" if health.get('hub_pct') is not None else '')
              + f" uncovered={health.get('uncovered')} used={health.get('used')}"
              + (f"={health.get('used_pct')}%" if health.get('used_pct') is not None else '')
              + f" Ωmean={health.get('omegaMean')}(N={health.get('omegaN')}) topUsed={health.get('topUsed')} "
              f"mergeCandidates={health.get('mergeCandidates')} warnings={health.get('warnings')}")
    else:
        print('[体检] （无 health.log）')
    d = dist(bl['all_ms'])
    print(f"[日志{'≤截止' if until_ms else '全量'}] inject n={bl['injects']} mean={d.get('mean','-')}ms p50={d.get('p50','-')}ms "
          f"p95={d.get('p95','-')}ms max={d.get('max','-')}ms | gate拦={bl['gate_block']} "
          f"identical={bl['identical']} 其他skip={bl['other_skip']} | writes={bl['writes']} "
          f"updates={bl['updates']} nudges={bl['nudges']}")
    print(f"[草稿] pending {pending_md_count(h)} 篇（.md 口径）")
    dn = os.path.join(MR, h, 'dailynote', name)
    if os.path.isdir(dn):
        print(f"[语料] dailynote {len(glob.glob(os.path.join(dn, '*.md')))} 篇 .md")
    out = {'mode': 'bucket', 'bucket': name, 'hash': h, 'health': health,
           'log_alltime': {k: v for k, v in bl.items() if k != 'tree_inject_sessions'},
           'pending_md': pending_md_count(h)}
    out_path = args.out or f"/tmp/mr-eval/bucket-{name}" + ("-until" if until_ms else "") + ".json"
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    json.dump(out, open(out_path, 'w'), ensure_ascii=False, indent=1, default=str)
    print(f"→ {out_path}")

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--since-hours', type=int, default=48)
    ap.add_argument('--out', default=None, help='输出 JSON 路径（缺省 /tmp/mr-eval/ 按模式命名）')
    ap.add_argument('--baseline', default=None, help='旧基线 JSON，打印关键指标 Δ')
    ap.add_argument('--session', default=None,
                    help='单会话深评：id 或唯一前缀，聚合该会话+子代理树八项指标')
    ap.add_argument('--bucket', default=None, help='单桶健康：桶名（diaryName），输出体检+日志全量')
    ap.add_argument('--until', default=None,
                    help='快照截止（--session/--bucket 模式）：CST 本地时间或 UTC ISO，复现历史深评读数')
    args = ap.parse_args()
    if args.session:
        report_session(args); return
    if args.bucket:
        report_bucket(args); return
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
    out_path = args.out or '/tmp/mr-eval/summary.json'
    summary = {'since': since.isoformat(), 'generated': datetime.now(CST).isoformat(),
               'since_hours': args.since_hours, 'buckets': r_logs,
               'sessions': r_sessions, 'tool_stats': tool_stats,
               'plugin_funnel': dict(funnel)}
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    json.dump(summary, open(out_path, 'w'), ensure_ascii=False, indent=1, default=str)

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
    print(f"→ {out_path}")

if __name__ == '__main__':
    main()
