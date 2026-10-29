"""Prototype episode extractor (metric defs v0.1). One transcript file = one agent context.

Usage: python3 episodes.py OUT.jsonl  -> one JSON record per GitHub episode.
Definitions are documented in FINDINGS.md section 3.
"""
import json, os, re, sys, bisect, hashlib
from datetime import datetime
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from tx import parse, classify
from pricing import cost, last_ctx, P, input_cost

METRIC_VERSION = "0.1"
GAP_CALLS = 3          # max consecutive non-GitHub API calls inside one episode
CHARS_PER_TOKEN = 2.2  # fitted on this corpus (gh/ghx/Bash results, Opus 5.x tokenizer)
RESULT_OVERHEAD = 70   # fitted intercept: tool_result framing etc.
REF_CTX = 50_000       # reference context for context-normalised cost

RX_PIPE_GLUE = re.compile(r'\|\s*(head|tail|grep|sed|awk|cut|sort|uniq|tr|wc|jq|python3?|column|xargs)\b')
RX_JQ = re.compile(r'--jq\b|\s-q\s|\|\s*jq\b')
RX_SLEEP = re.compile(r'\bsleep\s+\d|\buntil\b|\bwhile\b')
RX_WATCH = re.compile(r'--watch\b|\brun\s+watch\b')
RX_REDIRECT = re.compile(r'>\s*/(tmp|private|var)/')

def ts(s):
    return datetime.fromisoformat(s.replace('Z', '+00:00')).timestamp() if s else None

def gh_invocations(cmd):
    return len(re.findall(r'(?:^|[\s;&|(`]|\$\()(ghx|gh)\s+([a-z][\w-]*)(?:\s+([a-z][\w-]*))?', cmd))

def signature(cmd):
    """Normalised command for 'distinct commands' and retry detection: subcommand words only."""
    m = re.findall(r'(?:^|[\s;&|(`]|\$\()(ghx|gh)\s+([a-z][\w-]*)(?:\s+([a-z][\w-]*))?', cmd)
    return ' ; '.join(' '.join(x for x in t if x) for t in m)

def intent(cmd):
    c = cmd
    if re.search(r'ghx\s+ci\s+wait|--watch|run\s+watch', c) or RX_SLEEP.search(c): return 'ci-wait'
    if re.search(r'ghx\s+ci\s+why|--log|/logs\b|--log-failed', c): return 'ci-diagnose'
    if re.search(r'(ghx|gh)\s+(ci|run)\s+re(run|trigger)', c): return 'ci-rerun'
    if re.search(r'(ghx|gh)\s+pr\s+merge', c): return 'merge'
    if re.search(r'(ghx|gh)\s+pr\s+(create|edit|comment|review|close|ready|resolve)', c): return 'pr-write'
    if re.search(r'pr\s+checks|run\s+(list|view)|ghx\s+pr\s+status', c): return 'ci-status'
    if re.search(r'pr\s+(view|feedback|diff|list)|api\s+.*(comments|reviews)', c): return 'pr-read'
    return 'other'

PRIORITY = ['merge', 'pr-write', 'ci-diagnose', 'ci-rerun', 'ci-wait', 'ci-status', 'pr-read', 'other']

def ghx_outcome(res):
    """ghx: separate real errors from outcome exits (10/11 CI red etc.)."""
    m = re.search(r'"error"\s*:\s*\{\s*"code"\s*:\s*"([A-Z_]+)"', res or '')
    return m.group(1) if m else None

def real_error(tu):
    r = tu.get('res_text', '') or ''
    if not tu.get('is_error'): return False
    if tu['kind'] == 'ghx':
        return bool(ghx_outcome(r)) or 'tool_use_error' in r or 'denied' in r
    return True

def refusal(tu):
    r = tu.get('res_text', '') or ''
    if re.search(r'too complex to verify', r): return 'worktree-guard'
    if re.search(r'auto mode classifier', r): return 'classifier'
    if re.search(r'Blocked: sleep', r): return 'sleep-block'
    if re.search(r'PreToolUse:\w+ hook error', r): return 'hook'
    if re.search(r"user doesn't want to proceed", r): return 'user-reject'
    return None

def episodes_for(path, rel):
    calls, tools, events = parse(path)
    if not calls: return []
    n = len(calls); seqs = [c['seq'] for c in calls]
    # compaction boundaries and human turns -> call index of the next call
    # events don't carry seq; re-scan the file cheaply for the three record kinds
    human_seq = []; compact_seq = []; notif = []
    s = 0
    for line in open(path, errors='replace'):
        s += 1
        if '"compact_boundary"' in line: compact_seq.append(s)
        elif '"origin":{"kind":"human"}' in line or ('"type":"user"' in line and '"origin"' not in line and '"tool_result"' not in line and '"isMeta":true' not in line and '"promptSource":"typed"' in line):
            human_seq.append(s)
        elif '"origin":{"kind":"task-notification"}' in line:
            m = re.search(r'<tool-use-id>(\w+)', line); notif.append((s, m.group(1) if m else None))
    comp_idx = sorted(set(bisect.bisect_right(seqs, x) for x in compact_seq))
    human_idx = sorted(bisect.bisect_right(seqs, x) for x in human_seq)
    def next_boundary(i):
        j = bisect.bisect_right(comp_idx, i)
        return comp_idx[j] if j < len(comp_idx) else n
    # mark GitHub calls
    def is_gh_tool(tu):
        if tu['kind'] in ('gh', 'ghx'): return True
        if tu['name'] == 'Monitor' and classify(tu['input'].get('command', '') or ''): return True
        return False
    gh_call = [any(is_gh_tool(t) for t in c['tool_uses']) for c in calls]
    bg_gh_ids = {t['id'] for c in calls for t in c['tool_uses'] if is_gh_tool(t) and (t['bg'] or t['name'] == 'Monitor')}
    # paths GitHub output was written to: redirect targets, bg task output files, ghx logPath values
    gh_paths = set(); path_origin = {}
    RX_PATH = re.compile(r'(/(?:private/)?(?:tmp|var)/[^\s"\'`)>|;,]+)')
    for c in calls:
        for t in c['tool_uses']:
            if is_gh_tool(t):
                outs = re.findall(r'(?:>>?|\btee\s+(?:-a\s+)?)\s*(/(?:private/)?(?:tmp|var)/[^\s"\'`)>|;,]+)', t.get('cmd') or '')
                for p in outs + RX_PATH.findall(t.get('res_text') or ''):
                    p = p.rstrip('.:')
                    if len(p) > 12 and not p.endswith('/') and '.' in p.rsplit('/', 1)[-1]:
                        gh_paths.add(p); path_origin.setdefault(p, t)
    def reads_gh_output(t):
        if t['name'] == 'Read': return (t['input'].get('file_path') or '') in gh_paths
        if t['name'] == 'Bash' and not t['kind']:
            toks = set(re.findall(r'/[^\s"\'`)>|;,]+', t.get('cmd') or ''))
            return bool(toks & gh_paths)
        return False
    linked = [any(reads_gh_output(t) for t in c['tool_uses']) for c in calls]
    by_id = {t['id']: t for c in calls for t in c['tool_uses']}
    origin = [[] for _ in calls]
    for i, c in enumerate(calls):
        for t in c['tool_uses']:
            if reads_gh_output(t):
                src = t['input'].get('file_path') if t['name'] == 'Read' else (t.get('cmd') or '')
                toks = {src} if t['name'] == 'Read' else set(re.findall(r'/[^\s"\'`)>|;,]+', src))
                origin[i] += [path_origin[p] for p in toks if p in path_origin][:1]
    notif_calls = {}
    for sq, tid in notif:
        if tid in bg_gh_ids: notif_calls.setdefault(bisect.bisect_right(seqs, sq), []).append(tid)
    for k, ids in notif_calls.items():
        if k < n: linked[k] = True; origin[k] += [by_id[x] for x in ids if x in by_id]
    gh_call = [g or l for g, l in zip(gh_call, linked)]
    # segment
    eps = []; cur = None; last_gh = None
    for i in range(n):
        if not gh_call[i]: continue
        human_between = last_gh is not None and any(last_gh < h <= i for h in human_idx)
        if cur and (i - last_gh - 1) <= GAP_CALLS and not human_between and next_boundary(last_gh) > i:
            cur.append(i)
        else:
            if cur: eps.append(cur)
            cur = [i]
        last_gh = i
    if cur: eps.append(cur)
    out = []
    for gi, ep in enumerate(eps):
        first, last = ep[0], ep[-1]
        end = min(last + 1, n - 1)  # the call that reads the last GH result
        span = range(first, end + 1)
        ghtus = [t for i in ep for t in calls[i]['tool_uses'] if is_gh_tool(t)]
        origins = ghtus + [o for i in ep for o in origin[i] if o not in ghtus]
        kinds = {t['kind'] or 'monitor' for t in origins}
        model = calls[first]['model']; pr = P.get(model)
        cr = pr[2] / 1e6 if pr else None
        C0 = last_ctx(calls[first]['usage'])
        tot_cost = sum(cost(calls[i]['model'], calls[i]['usage']) for i in span)
        out_tok = sum(calls[i]['usage'].get('output_tokens') or 0 for i in span)
        cache_read = sum(calls[i]['usage'].get('cache_read_input_tokens') or 0 for i in span)
        cache_write = sum(calls[i]['usage'].get('cache_creation_input_tokens') or 0 for i in span)
        follow = [t for i in span for t in calls[i]['tool_uses'] if reads_gh_output(t)]
        res_chars = sum(t.get('res_chars') or 0 for t in ghtus + follow)
        res_tok_est = sum((t.get('res_chars') or 0) / CHARS_PER_TOKEN + RESULT_OVERHEAD for t in ghtus + follow)
        rewrites = [i for i in span if last_ctx(calls[i]['usage']) > 5000 and (calls[i]['usage'].get('cache_creation_input_tokens') or 0) / last_ctx(calls[i]['usage']) > 0.5]
        cost_norm = 0.0
        for i in span:
            u = calls[i]['usage']; cx = last_ctx(u) or 1; ic = input_cost(calls[i]['model'], u)
            cost_norm += (cost(calls[i]['model'], u) - ic) + ic * max(0, cx - C0 + REF_CTX) / cx
        # carry-forward: result tokens x API calls that still carry it (until compaction/end of file)
        carry_tc = 0; carry_tc_h50 = 0
        for t in ghtus + follow:
            nc = t.get('next_call')
            if nc is None: continue
            after = next_boundary(nc) - nc
            rt = (t.get('res_chars') or 0) / CHARS_PER_TOKEN + RESULT_OVERHEAD
            if t in ghtus:  # the emitting call's output (command + thinking) is carried too (b_out ~ 1.0)
                c_ = calls[t['call']]; tot_in = sum(x['in_chars'] for x in c_['tool_uses']) or 1
                rt += (c_['usage'].get('output_tokens') or 0) * t['in_chars'] / tot_in
            carry_tc += rt * after; carry_tc_h50 += rt * min(after, 50)
        # write cost share: output tokens of emitting calls allocated by tool-input size
        write_tok = 0
        for i in ep:
            tus = calls[i]['tool_uses']; tot_in = sum(t['in_chars'] for t in tus) or 1
            write_tok += (calls[i]['usage'].get('output_tokens') or 0) * sum(t['in_chars'] for t in tus if is_gh_tool(t)) / tot_in
        cmds = [(t.get('cmd') or t['input'].get('command', '') or '') for t in ghtus]
        ocmds = [(t.get('cmd') or t['input'].get('command', '') or '') for t in origins]
        intents = [intent(c) for c in ocmds]
        cat = min(intents, key=PRIORITY.index) if intents else 'other'
        sigs = [signature(c) for c in cmds]
        retries = sum(1 for a, b, t in zip(sigs, sigs[1:], ghtus) if a == b and real_error(t))
        repeats = len(sigs) - len(set(sigs))
        notif_n = sum(len(v) for k, v in notif_calls.items() if first <= k <= end + 5)
        t0 = ts(calls[first]['ts']); t1 = ts(calls[end].get('last_ts') or calls[end]['ts'])
        blocked = sum(max(0, (ts(t.get('res_ts')) or 0) - (ts(t['ts']) or 0)) for t in ghtus if t.get('res_ts') and not t['bg'])
        out.append(dict(
            v=METRIC_VERSION, file=rel, ep=gi, model=model, sidechain='subagents' in rel,
            session=rel.split('/subagents/')[0].replace('.jsonl', ''),
            stratum=('dogfood-dev' if 'gh-for-agents' in rel.split('/')[0] else 'use'),
            effort=calls[first].get('effort'), version=calls[first].get('version'),
            prs=sorted(set(re.findall(r'(?:\bpr\s+[a-z]+\s+|\bci\s+[a-z]+\s+|#)(\d{2,5})\b', ' '.join(ocmds)))),
            follow_reads=len(follow), cache_rewrites=len(rewrites),
            project=rel.split('/')[0], start=calls[first]['ts'],
            tool=('none' if not kinds else 'ghx' if kinds == {'ghx'} else 'gh' if kinds <= {'gh', 'monitor'} else 'mixed'),
            origin_ids=sorted({t['id'] for t in origins}), emit_ids=sorted({t['id'] for t in ghtus}), wait_ids=sorted({t['id'] for t in origins if t['bg'] or t['name'] == 'Monitor'}),
            continuation=not ghtus,
            category=cat, intents=sorted(set(intents)),
            gh_tool_calls=len(ghtus), gh_invocations=sum(gh_invocations(c) for c in cmds),
            gh_round_trips=sum(1 for i in ep if any(is_gh_tool(t) for t in calls[i]['tool_uses'])), linked_calls=len(ep), span_calls=len(span), glue_calls=len(span) - len(ep) - 1,
            distinct_cmds=len(set(sigs)), repeats=repeats, retries=retries,
            errors=sum(1 for t in ghtus if real_error(t)),
            refusals=sum(1 for t in ghtus if refusal(t)),
            pipes=sum(1 for c in cmds if RX_PIPE_GLUE.search(c)), jq=sum(1 for c in cmds if RX_JQ.search(c)),
            sleep_loops=sum(1 for c in cmds if RX_SLEEP.search(c)), watch=sum(1 for c in cmds if RX_WATCH.search(c)),
            redirects=sum(1 for c in cmds if RX_REDIRECT.search(c)),
            bg=sum(1 for t in ghtus if t['bg']), monitor=sum(1 for t in ghtus if t['name'] == 'Monitor'),
            notifications=notif_n,
            cmd_chars=sum(len(c) for c in cmds), write_tok=round(write_tok),
            out_tok=out_tok, res_chars=res_chars, res_tok_est=round(res_tok_est),
            cache_read=cache_read, cache_write=cache_write, C0=C0,
            cost=round(tot_cost, 5),
            cost_norm=round(cost_norm, 5),
            carry_token_calls=round(carry_tc), carry_cost=round(carry_tc * cr, 5) if cr else None,
            carry_cost_h50=round(carry_tc_h50 * cr, 5) if cr else None,
            wall_s=round((t1 - t0) if t0 and t1 else 0), blocked_s=round(blocked),
        ))
    return out

if __name__ == '__main__':
    root = os.path.expanduser('~/.claude/projects/')
    inv = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'inventory.json')))
    with open(sys.argv[1], 'w') as fo:
        k = 0
        for o in sorted(inv, key=lambda o: o['f']):
            if not (o['gh'] or o['ghx']): continue
            for e in episodes_for(root + o['f'], o['f']):
                fo.write(json.dumps(e) + '\n'); k += 1
    print(k, 'episodes')
