#!/usr/bin/env python3
"""GitHub-episode extraction and segmentation over Claude Code transcripts.

Usage:
  python3 episodes.py extract   # one pass over ~/.claude/projects -> cache/*.jsonl
  python3 episodes.py analyze [--gap MIN]  # segmentation + report tables from the cache

Deterministic: no model calls, no randomness. Stage 1 (extract) streams every
*.jsonl transcript once and writes a compact event stream per file; stage 2
(analyze) classifies calls, segments episodes and prints the tables used in
FINDINGS.md.
"""
import collections, glob, json, os, re, statistics, sys
from datetime import datetime, timezone

ROOT = os.path.expanduser('~/.claude/projects')
HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, 'cache')
SELF_SESSIONS = {'141545cc-4632-45cd-b488-b19445987060'}  # this research session
DEV_PROJECT_MARKERS = ('gh-for-agents', 'ghx-spike', 'hookspike')  # sessions building ghx itself

# --------------------------------------------------------------------------- regexes
PRE = r'(?:^|(?<=[\s;&|(`{!]))'
GHX_HEAD = (r'(?:npx\s+(?:-y\s+|--yes\s+)?(?:@thegoldenmule/)?ghx'
            r'|pnpm\s+(?:exec\s+|dlx\s+)?(?:@thegoldenmule/)?ghx'
            r'|(?:node\s+)?[\'"]?[^\s\'";|&]*bin/ghx(?:\.js)?[\'"]?'
            r'|ghx)')
GHX_RE = re.compile(PRE + GHX_HEAD + r'(?=\s|$)((?:\s+[^\s;|&]+)*)', re.M)
GH_RE = re.compile(PRE + r'gh(?=\s)((?:\s+[^\s;|&]+)*)', re.M)
HEREDOC_RE = re.compile(r"<<-?\s*(['\"]?)(\w+)\1[^\n]*\n.*?\n\s*\2\b", re.S)
SQ_RE = re.compile(r"'[^']*'")
DQ_NOSUB_RE = re.compile(r'"[^"$`]*"')
REDIRECT_RE = re.compile(r'(?:>{1,2}|\btee\s+(?:-a\s+)?|\s-o\s+|--output[= ]|-D\s+)\s*([~/.$\w][^\s;|&)]*)')
PATH_IN_TEXT_RE = re.compile(r'(?:saved to|written to):?\s*(/[^\s"]+)')
EXIT_RE = re.compile(r'^Exit code (\d+)')
NOTIF_EXIT_RE = re.compile(r"exit code (\d+)")
ERRCODE_RE = re.compile(r'"error"\s*:\s*\{\s*"code"\s*:\s*"([A-Z_]+)"')
LOOP_RE = re.compile(r'\b(while|until)\b[^\n]*;?\s*do\b|\bfor\b[^\n]*;\s*do\b[\s\S]*\bsleep\b', re.S)
SLEEP_RE = re.compile(r'(?:^|[\s;&(])sleep\s+\d')
PUSH_RE = re.compile(r'\bgit\s+(?:-C\s+\S+\s+)?push\b')
HOOK_PATTERNS = [
    ('hook_replace', 'ghx replaces `'),
    ('hook_write_denied', 'Raw gh writes that ghx wraps are always denied'),
    ('hook_poll', "Don't poll CI."),
    ('hook_monitor', "Don't run ghx ci wait under Monitor"),
]


def strip_inert(cmd):
    """Drop text that is not executed: heredoc bodies, single-quoted strings, plain double-quoted strings."""
    cmd = HEREDOC_RE.sub(' ', cmd)
    cmd = SQ_RE.sub("''", cmd)
    cmd = DQ_NOSUB_RE.sub('""', cmd)
    return cmd


def words(argstr):
    return [w for w in argstr.split() if w]


def invocations(cmd):
    """[(tool, argv)] for each gh / ghx invocation in a shell command."""
    s = strip_inert(cmd)
    out = []
    for m in GHX_RE.finditer(s):
        out.append((m.start(), 'ghx', words(m.group(1))))
    for m in GH_RE.finditer(s):
        out.append((m.start(), 'gh', words(m.group(1))))
    out.sort()
    return [(t, a) for _, t, a in out]


# --------------------------------------------------------------------------- intent
PRIORITY = ['merge', 'create', 'edit', 'reply', 'other_write', 'diagnose', 'rerun', 'wait',
            'feedback', 'status', 'other_read', 'meta']
RANK = {k: i for i, k in enumerate(PRIORITY)}
STATUS_FIELDS = {'state', 'mergeable', 'mergestatestatus', 'statuscheckrollup', 'headrefoid', 'mergedat',
                 'mergecommit', 'reviewdecision', 'isdraft', 'closed', 'merged'}
FEEDBACK_FIELDS = {'comments', 'reviews', 'reviewthreads', 'latestreviews', 'reviewrequests'}
GHX_NATIVE = {('pr', 'create'): 'create', ('pr', 'edit'): 'edit', ('pr', 'merge'): 'merge',
              ('pr', 'comment'): 'reply', ('pr', 'review'): 'reply', ('pr', 'resolve'): 'reply',
              ('pr', 'feedback'): 'feedback', ('pr', 'status'): 'status', ('ci', 'wait'): 'wait',
              ('ci', 'why'): 'diagnose', ('ci', 'rerun'): 'rerun', ('ci', 'retrigger'): 'rerun'}
GHX_META = {'--help', '-h', 'help', 'schema', 'doctor', 'version', '--version', 'init', 'install',
            'uninstall', 'hook'}


def positional(argv):
    out, skip = [], False
    for w in argv:
        if skip:
            skip = False
            continue
        if w in ('-R', '--repo', '--json', '-q', '--jq', '-t', '--template', '--job', '-w', '--workflow',
                 '-b', '--branch', '-L', '--limit', '-X', '--method', '-f', '-F', '--interval', '-i', '-s',
                 '--state', '--search', '--head', '--base', '--author', '--title', '--body', '--body-file',
                 '--input', '--fields', '--until', '--timeout', '-H', '--header'):
            skip = True
            continue
        if w.startswith('-'):
            continue
        out.append(w)
    return out


def flagval(argv, *names):
    for i, w in enumerate(argv):
        for n in names:
            if w == n and i + 1 < len(argv):
                return argv[i + 1]
            if w.startswith(n + '='):
                return w[len(n) + 1:]
    return ''


def gh_intent(argv, raw=''):
    """Intent of one raw gh invocation (also used for ghx passthrough)."""
    pos = positional(argv)
    a0 = pos[0] if pos else ''
    a1 = pos[1] if len(pos) > 1 else ''
    flags = set(w.split('=')[0] for w in argv if w.startswith('-'))
    joined = ' '.join(argv) + ' ' + raw  # raw: unstripped command, for quoted graphql bodies
    fields = set(f.strip().lower() for f in flagval(argv, '--json').split(',') if f.strip())
    if a0 == 'pr':
        if a1 == 'create': return 'create'
        if a1 == 'merge': return 'merge'
        if a1 in ('edit', 'ready', 'close', 'reopen'): return 'edit'
        if a1 in ('comment', 'review'): return 'reply'
        if a1 == 'checks':
            return 'wait' if '--watch' in flags else 'status'
        if a1 == 'view':
            if '--comments' in flags or fields & FEEDBACK_FIELDS: return 'feedback'
            if fields & STATUS_FIELDS: return 'status'
            return 'other_read'
        return 'other_read'
    if a0 == 'run':
        if a1 == 'rerun' or a1 == 'cancel': return 'rerun'
        if a1 == 'watch': return 'wait'
        if a1 == 'download': return 'diagnose'
        if a1 == 'view':
            if flags & {'--log', '--log-failed'}: return 'diagnose'
            return 'status'
        if a1 == 'list': return 'status'
        return 'other_read'
    if a0 == 'workflow':
        return 'rerun' if a1 in ('run', 'enable') else 'other_read'
    if a0 == 'api':
        method = flagval(argv, '-X', '--method').upper()
        path = a1
        write = method in ('POST', 'PATCH', 'PUT', 'DELETE') or bool(flags & {'-f', '-F', '--field', '--raw-field', '--input'}) and path != 'graphql'
        if path == 'graphql':
            if 'mutation' in joined:
                return 'reply' if re.search(r'Review|Comment|resolve', joined) else 'other_write'
            if re.search(r'reviewThreads|comments|reviews', joined): return 'feedback'
            return 'other_read'
        if '/logs' in path: return 'diagnose'
        if '/rerun' in path: return 'rerun'
        if write:
            if re.search(r'/(comments|replies|reviews)', path): return 'reply'
            return 'other_write'
        if re.search(r'/pulls/\d+/(comments|reviews)|/issues/\d+/comments', path): return 'feedback'
        if re.search(r'check-runs|check-suites|actions/(runs|jobs)|/status\b|/statuses', path): return 'status'
        if re.search(r'/pulls/\d+$', path): return 'status'
        return 'other_read'
    if a0 == 'issue':
        return 'other_write' if a1 in ('create', 'comment', 'edit', 'close', 'reopen') else 'other_read'
    if a0 == 'release':
        return 'other_write' if a1 in ('create', 'edit', 'delete', 'upload') else 'other_read'
    if a0 == 'repo':
        return 'other_write' if a1 in ('create', 'edit', 'delete', 'fork') else 'other_read'
    return 'other_read'


def ghx_intent(argv, raw=''):
    """(intent, passthrough, meta) for one ghx invocation."""
    pos = positional(argv)
    a0 = pos[0] if pos else (argv[0] if argv else '')
    a1 = pos[1] if len(pos) > 1 else ''
    if not argv or argv[0] in GHX_META or a0 in GHX_META or '--help' in argv or '--schema' in argv:
        return 'meta', False, True
    if (a0, a1) in GHX_NATIVE:
        return GHX_NATIVE[(a0, a1)], False, False
    return gh_intent(argv, raw), True, False


PR_IN_ARGS = re.compile(r'(?:^|[\s#/])(\d{3,5})(?=$|[\s,)])')
API_PR = re.compile(r'/(?:pulls|issues)/(\d+)')


def pr_numbers(tool, argv):
    pos = positional(argv)
    nums = set()
    if not pos: return nums
    if pos[0] in ('pr', 'ci') or (tool == 'ghx' and pos[0] == 'pr'):
        for w in pos[2:]:
            for m in re.finditer(r'(?:^|#|pull/)(\d{2,6})$', w):
                nums.add(int(m.group(1)))
    if pos[0] == 'api':
        for w in pos[1:]:
            for m in API_PR.finditer(w): nums.add(int(m.group(1)))
    return nums


# --------------------------------------------------------------------------- stage 1: extract
def file_meta(path):
    rel = os.path.relpath(path, ROOT).split(os.sep)
    project = rel[0]
    if len(rel) >= 3 and rel[2] == 'subagents':
        return project, rel[1], True, os.path.splitext(rel[-1])[0]
    return project, os.path.splitext(rel[-1])[0], False, ''


def text_of(content):
    if isinstance(content, str): return content
    if isinstance(content, list):
        return '\n'.join(b.get('text', '') if isinstance(b, dict) else str(b) for b in content
                         if not (isinstance(b, dict) and b.get('type') == 'image'))
    return ''


def notif_event(txt, ts):
    tid = re.search(r'<task-id>([^<]+)</task-id>', txt)
    tuid = re.search(r'<tool-use-id>([^<]+)</tool-use-id>', txt)
    st = re.search(r'<status>([^<]+)</status>', txt)
    ex = NOTIF_EXIT_RE.search(txt)
    return {'k': 'notif', 'ts': ts, 'task': tid.group(1) if tid else '',
            'tuid': tuid.group(1) if tuid else '', 'status': st.group(1) if st else '',
            'exit': int(ex.group(1)) if ex else None, 'chars': len(txt),
            'event': '<event>' in txt, 'summary': txt[:240],
            'terminal': bool(re.search(r'stream ended</summary>|script failed \(exit|ended without producing output|" stopped</summary>|\[Monitor expired', txt))
                        or (st is not None and st.group(1) in ('completed', 'failed', 'killed', 'stopped'))}


def extract():
    os.makedirs(CACHE, exist_ok=True)
    out = open(os.path.join(CACHE, 'events.jsonl'), 'w')
    nfiles = 0
    for path in sorted(glob.glob(ROOT + '/**/*.jsonl', recursive=True)):
        project, session, is_sub, agent = file_meta(path)
        if session in SELF_SESSIONS: continue
        nfiles += 1
        events = []
        pending = {}  # tool_use_id -> event index
        hookmsg = {}  # tool_use_id -> hook decision reason
        seen_notif = set()
        try:
            fh = open(path, errors='replace')
        except OSError:
            continue
        for line in fh:
            try:
                d = json.loads(line)
            except ValueError:
                continue
            t = d.get('type')
            ts = d.get('timestamp')
            if t == 'system' and d.get('subtype') == 'compact_boundary':
                events.append({'k': 'compact', 'ts': ts})
                continue
            if t == 'attachment':
                a = d.get('attachment') or {}
                if a.get('hookEvent') == 'PreToolUse' and 'permissionDecision' in (a.get('stdout') or ''):
                    hookmsg[a.get('toolUseID')] = a.get('stdout', '')[:600]
                if a.get('type') == 'queued_command':
                    # delivered mid-turn: task notifications, or a prompt the human typed while the agent worked
                    txt = a.get('prompt') if isinstance(a.get('prompt'), str) else text_of(a.get('prompt'))
                    if '<task-notification>' in (txt or ''):
                        ev = notif_event(txt, ts)
                        key = (ev['task'], ev['summary'], ev['chars'])
                        if key not in seen_notif:
                            seen_notif.add(key)
                            events.append(ev)
                    elif txt:
                        events.append({'k': 'prompt', 'ts': ts, 'chars': len(txt), 'queued': True})
                continue
            if t not in ('user', 'assistant'): continue
            msg = d.get('message') or {}
            content = msg.get('content')
            if t == 'assistant':
                if not isinstance(content, list): continue
                for b in content:
                    if not isinstance(b, dict) or b.get('type') != 'tool_use': continue
                    inp = b.get('input') or {}
                    ev = {'k': 'tool', 'id': b.get('id'), 'name': b.get('name'), 'ts': ts,
                          'model': msg.get('model'), 'ver': d.get('version'), 'cwd': d.get('cwd'),
                          'branch': d.get('gitBranch'), 'bg_in': bool(inp.get('run_in_background'))}
                    if b.get('name') in ('Bash', 'Monitor'):
                        ev['cmd'] = inp.get('command', '')
                    elif b.get('name') == 'Read':
                        ev['path'] = inp.get('file_path', '')
                    elif b.get('name') in ('Write', 'Edit'):
                        ev['path'] = inp.get('file_path', '')
                        ev['wchars'] = len(inp.get('content') or inp.get('new_string') or '')
                    elif b.get('name') == 'TaskStop':
                        ev['task'] = inp.get('task_id') or inp.get('shell_id') or ''
                    pending[b.get('id')] = len(events)
                    events.append(ev)
                continue
            # user record
            origin = (d.get('origin') or {}).get('kind')
            if isinstance(content, list) and any(isinstance(b, dict) and b.get('type') == 'tool_result' for b in content):
                tur = d.get('toolUseResult')
                for b in content:
                    if not isinstance(b, dict) or b.get('type') != 'tool_result': continue
                    i = pending.get(b.get('tool_use_id'))
                    if i is None: continue
                    txt = text_of(b.get('content'))
                    ev = events[i]
                    ev['rts'] = ts
                    ev['rchars'] = len(txt)
                    ev['err'] = bool(b.get('is_error'))
                    m = EXIT_RE.match(txt)
                    ev['exit'] = int(m.group(1)) if m else (None if ev['err'] else 0)
                    if ev.get('cmd') is not None:
                        ev['rhead'] = txt[:1500]
                        ev['rcodes'] = sorted(set(ERRCODE_RE.findall(txt)))
                    else:
                        ev['rhead'] = txt[:300]
                    ev['paths'] = PATH_IN_TEXT_RE.findall(txt)[:3]
                    if isinstance(tur, dict):
                        tid = tur.get('backgroundTaskId') or tur.get('taskId')
                        if tid: ev['task'] = tid
                    elif isinstance(tur, str) and 'rejected' in tur:
                        ev['rejected'] = True
                    if b.get('tool_use_id') in hookmsg:
                        ev['hook'] = hookmsg[b.get('tool_use_id')]
                continue
            txt = text_of(content)
            if '<task-notification>' in txt:
                ev = notif_event(txt, ts)
                key = (ev['task'], ev['summary'], ev['chars'])
                if key not in seen_notif:
                    seen_notif.add(key)
                    events.append(ev)
                continue
            if origin == 'human' or (d.get('promptSource') == 'typed'):
                events.append({'k': 'prompt', 'ts': ts, 'chars': len(txt)})
            elif d.get('isCompactSummary'):
                events.append({'k': 'compact', 'ts': ts})
        if events:
            out.write(json.dumps({'file': os.path.relpath(path, ROOT), 'project': project, 'session': session,
                                  'sub': is_sub, 'agent': agent, 'events': events}) + '\n')
    out.close()
    print(f'extracted {nfiles} files -> {CACHE}/events.jsonl')


# --------------------------------------------------------------------------- stage 2: analyze
def pts(s):
    if not s: return None
    return datetime.fromisoformat(s.replace('Z', '+00:00'))


def pct(xs, p):
    if not xs: return float('nan')
    xs = sorted(xs)
    k = (len(xs) - 1) * p
    lo = int(k)
    hi = min(lo + 1, len(xs) - 1)
    return xs[lo] + (xs[hi] - xs[lo]) * (k - lo)


def short_project(p):
    p = p.replace('-Users-benjaminjordan-projects-', '')
    if p.startswith('-private'): p = 'tmp:' + p[-24:]
    return p


def classify_call(ev):
    """Annotate a Bash/Monitor tool event with gh/ghx facts. Returns None if no gh/ghx."""
    cmd = ev.get('cmd') or ''
    if 'gh' not in cmd: return None
    invs = invocations(cmd)
    if not invs: return None
    stripped = strip_inert(cmd)
    loop = bool(LOOP_RE.search(stripped)) or bool(SLEEP_RE.search(stripped))
    bg = bool(ev.get('task')) and ev['name'] == 'Bash' or ev['name'] == 'Monitor'
    tools, intents, prs, sub = set(), [], set(), []
    passthrough = meta = False
    for tool, argv in invs:
        if tool == 'ghx':
            it, pt, mt = ghx_intent(argv, cmd)
            passthrough |= pt
            meta |= mt
        else:
            it = gh_intent(argv, cmd)
        pos = positional(argv)
        sub.append(f"{tool} {' '.join(pos[:2])}".strip() if pos else f'{tool} {" ".join(argv[:1])}')
        tools.add(tool)
        intents.append(it)
        prs |= pr_numbers(tool, argv)
    # command-level modifiers: polling loops, background, Monitor all mean "wait"
    if (loop or bg) and any(i in ('status', 'wait', 'diagnose') for i in intents):
        if not any(RANK[i] < RANK['diagnose'] for i in intents):
            intents = [('wait' if i in ('status',) else i) for i in intents]
            if 'wait' not in intents: intents.append('wait')
    if 'create' in intents and not prs:
        # gh pr create / ghx pr create name the new PR only in their output
        prs |= set(int(n) for n in re.findall(r'/pull/(\d+)', ev.get('rhead') or '')[:1])
    intent = min(intents, key=lambda i: RANK[i])
    side = 'ghx' if tools == {'ghx'} else ('gh' if tools == {'gh'} else 'mixed')
    hook = None
    text = (ev.get('rhead') or '') + (ev.get('hook') or '')
    for name, pat in HOOK_PATTERNS:
        if pat in text: hook = name
    reds = set()
    for m in REDIRECT_RE.finditer(stripped):
        p = m.group(1)
        if p not in ('/dev/null', '&1', '&2') and not p.startswith('&'): reds.add(os.path.basename(p))
    return {'side': side, 'intent': intent, 'intents': intents, 'subs': sub, 'prs': sorted(prs),
            'loop': loop, 'bg': bg, 'passthrough': passthrough, 'meta_only': all(i == 'meta' for i in intents),
            'hook': hook, 'outfiles': sorted(reds), 'ninv': len(invs)}


def load():
    with open(os.path.join(CACHE, 'events.jsonl')) as fh:
        for line in fh:
            yield json.loads(line)


def is_dev(project):
    return any(m in project for m in DEV_PROJECT_MARKERS)


GLUE_BASH = re.compile(r'^\s*(?:cd\s+\S+\s*(?:&&|;)\s*)?(?:sleep\s+\d+\s*(?:;|&&)?\s*)*(?:cat|head|tail|grep|rg|jq|wc|sed|awk|less|python3?\s+-c)\b')


def segment(rec, gap_min=10):
    """Split one transcript's events into GitHub episodes. Returns (episodes, calls)."""
    evs = rec['events']
    episodes, calls = [], []
    cur = None
    waits = {}  # task id -> wait episode (background ghx ci wait / bg gh poll / Monitor)
    closed_waits = {}  # finished waits: a later read of their output is still their glue (until the next prompt)
    gap = gap_min * 60

    def new_ep(kind, ev):
        return {'file': rec['file'], 'project': rec['project'], 'session': rec['session'], 'sub': rec['sub'],
                'start': ev['ts'], 'end': ev.get('rts') or ev['ts'], 'calls': [], 'glue': [], 'kind': kind,
                'notifs': 0, 'notif_chars': 0, 'model': ev.get('model'), 'ver': ev.get('ver'),
                'cwd': ev.get('cwd'), 'closed_by': None, 'compact_inside': False}

    def close(reason):
        nonlocal cur
        if cur:
            cur['closed_by'] = reason
            episodes.append(cur)
        cur = None

    def ep_files(ep):
        s = set()
        for c in ep['calls']:
            s |= set(c['outfiles'])
            for p in c['ev'].get('paths') or []: s.add(os.path.basename(p))
            if c['ev'].get('task'): s.add(c['ev']['task'])
        return s

    prev_tool = prev_tool_for_ep = None
    for ev in evs:
        k = ev['k']
        if ev['k'] == 'tool':
            this_prev, prev_tool = prev_tool, ev
            prev_tool_for_ep = this_prev
        if k == 'prompt':
            close('prompt')
            closed_waits.clear()
            continue
        if k == 'compact':
            close('compact')
            for w in waits.values(): w['compact_inside'] = True
            continue
        if k == 'notif':
            w = waits.get(ev['task'])
            if w:
                w['notifs'] += 1
                w['notif_chars'] += ev['chars']
                w['end'] = ev['ts']
                if ev['exit'] is not None: w['exit'] = ev['exit']
                if ev.get('terminal'):
                    w['closed_by'] = 'notification:' + (ev['status'] or 'monitor-end')
                    episodes.append(w)
                    closed_waits[ev['task']] = w
                    del waits[ev['task']]
            continue
        # tool event
        c = classify_call(ev) if ev['name'] in ('Bash', 'Monitor') else None
        if c:
            c['ev'] = ev
            calls.append(c)
            if c['bg'] and c['intent'] == 'wait' and ev.get('task'):
                w = new_ep('wait_bg', ev)
                w['calls'].append(c)
                waits[ev['task']] = w
                continue
            if cur and (pts(ev['ts']) - pts(cur['end'])).total_seconds() > gap:
                close('gap')
            if not cur:
                cur = new_ep('contiguous', ev)
                pt = prev_tool_for_ep
                if pt and pt['name'] in ('Write', 'Edit') and pt.get('path') \
                        and os.path.basename(pt['path']) in (ev.get('cmd') or ''):
                    cur['glue'].append(pt)  # the body / input file this call sends
                    cur['start'] = pt['ts']
            cur['calls'].append(c)
            cur['end'] = ev.get('rts') or ev['ts']
            continue
        # non-GitHub tool: glue for an open wait or the current episode, otherwise a boundary
        target = None
        refs = (ev.get('path') or '') + ' ' + (ev.get('cmd') or '') + ' ' + (ev.get('task') or '')
        for tid, w in list(waits.items()) + list(closed_waits.items()):
            if tid and tid in refs:
                target = w
                break
        if not target and cur:
            files = ep_files(cur)
            if ev['name'] == 'Read' and os.path.basename(ev.get('path', '')) in files:
                target = cur
            elif ev['name'] == 'Bash':
                cmd = ev.get('cmd') or ''
                if re.fullmatch(r'\s*sleep\s+\d+\s*', cmd) or (
                        GLUE_BASH.match(cmd) and any(f and f in cmd for f in files)):
                    target = cur
            elif ev['name'] == 'ToolSearch':
                continue  # neutral: loading a tool schema
        if target is not None:
            target['glue'].append(ev)
            if target is cur or target in closed_waits.values():
                target['end'] = ev.get('rts') or ev['ts']
            if ev['name'] == 'TaskStop' and target is not cur and target in waits.values():
                target['closed_by'] = 'TaskStop'
                target['end'] = ev.get('rts') or ev['ts']
                episodes.append(target)
                waits = {t: w for t, w in waits.items() if w is not target}
            continue
        close('tool:' + ev['name'])
    close('eof')
    for w in waits.values():
        w['closed_by'] = 'censored'
        episodes.append(w)
    for ep in episodes:
        finish(ep)
    return episodes, calls


def finish(ep):
    cs = ep['calls']
    tools = set(c['side'] for c in cs if not c['meta_only'])
    ep['side'] = 'ghx' if tools == {'ghx'} else 'gh' if tools == {'gh'} else ('mixed' if tools else 'meta')
    non_meta = [c['intent'] for c in cs if c['intent'] != 'meta'] or ['meta']
    ep['intent'] = min(non_meta, key=lambda i: RANK[i])
    ep['flags'] = sorted(set(i for c in cs for i in c['intents']))
    ep['n_calls'] = len(cs) + len(ep['glue'])
    ep['n_gh_calls'] = len(cs)
    # chars the model authored for this episode: commands plus written body/input files
    ep['authored'] = sum(len(c['ev'].get('cmd') or '') for c in cs) + sum(len(g.get('cmd') or '') + (g.get('wchars') or 0) for g in ep['glue'])
    ep['err_calls'] = sum(1 for c in cs if c['ev'].get('rcodes') or (c['ev'].get('exit') not in (0, None) and not (c['intent'] == 'wait' and 10 <= (c['ev'].get('exit') or 0) <= 15)))
    ep['n_meta'] = sum(1 for c in cs if c['meta_only'])
    ep['chars'] = sum(c['ev'].get('rchars') or 0 for c in cs) + sum(g.get('rchars') or 0 for g in ep['glue']) + ep['notif_chars']
    ep['secs'] = max(0.0, (pts(ep['end']) - pts(ep['start'])).total_seconds())
    ep['prs'] = sorted(set(p for c in cs for p in c['prs']))
    ep['wakeups'] = ep['notifs']
    ep['passthrough'] = any(c['passthrough'] for c in cs)
    ep['errors'] = sum(1 for c in cs if c['ev'].get('err'))


def era_of(ep, adoption):
    a = adoption.get(ep['project'])
    return 'ghx-era' if a and ep['start'] >= a else 'gh-era'


def fmt(x, nd=0):
    if x != x: return '-'
    return f'{x:,.{nd}f}'


def analyze(gap_min=10):
    recs = list(load())
    all_eps, all_calls = [], []
    for rec in recs:
        eps, calls = segment(rec, gap_min)
        push, push_at = 0, {}
        for ev in rec['events']:
            if ev['k'] == 'tool' and ev['name'] == 'Bash' and PUSH_RE.search(strip_inert(ev.get('cmd') or '')):
                push += 1
            if ev['k'] == 'tool': push_at[ev['id']] = push
        for c in calls:
            c['push'] = push_at.get(c['ev']['id'], 0)
            c['project'] = rec['project']
            c['sub'] = rec['sub']
            c['file'] = rec['file']
        all_eps += eps
        all_calls += calls
    use_calls = [c for c in all_calls if not is_dev(c['project'])]
    # adoption: first non-meta ghx call per project
    adoption = {}
    for c in sorted(use_calls, key=lambda c: c['ev']['ts']):
        if c['side'] in ('ghx', 'mixed') and not c['meta_only'] and c['project'] not in adoption:
            adoption[c['project']] = c['ev']['ts']
    R = collections.OrderedDict()
    R['adoption'] = adoption
    # ---- 1. call counts
    by_proj = collections.Counter()
    by_week = collections.Counter()
    for c in all_calls:
        side = c['side']
        p = short_project(c['project']) + (' [dev]' if is_dev(c['project']) else '')
        by_proj[(p, side)] += 1
        wk = pts(c['ev']['ts']).strftime('%G-W%V')
        if not is_dev(c['project']): by_week[(wk, side)] += 1
    R['by_proj'] = by_proj
    R['by_week'] = by_week
    return R, all_eps, all_calls, use_calls, adoption


STAT_HDR = ['n', 'calls p50', 'calls p90', 'chars p50', 'chars p90', 'authored p50', 'secs p50', 'secs p90', '%w/ error', '%sub']


def stat_row(es):
    nc = [e['n_calls'] for e in es]; ch = [e['chars'] for e in es]; sc = [e['secs'] for e in es]
    au = [e['authored'] for e in es]
    return [len(es), fmt(pct(nc, .5), 1), fmt(pct(nc, .9), 1), fmt(pct(ch, .5)), fmt(pct(ch, .9)), fmt(pct(au, .5)),
            fmt(pct(sc, .5)), fmt(pct(sc, .9)), f"{sum(1 for e in es if e['err_calls']) / len(es):.0%}",
            f"{sum(1 for e in es if e['sub']) / len(es):.0%}"]


def table(rows, header):
    w = [max(len(str(r[i])) for r in rows + [header]) for i in range(len(header))]
    line = lambda r: '| ' + ' | '.join(str(x).ljust(w[i]) for i, x in enumerate(r)) + ' |'
    return '\n'.join([line(header), '|' + '|'.join('-' * (x + 2) for x in w) + '|'] + [line(r) for r in rows])


def report(gap_min=10, examples=True):
    R, eps, calls, use_calls, adoption = analyze(gap_min)
    out = []
    P = out.append
    P(f'# episodes.py report (gap={gap_min} min)\n')
    P('## Adoption (first non-meta ghx call, non-dev projects)')
    for p, t in sorted(adoption.items(), key=lambda x: x[1]): P(f'- {short_project(p)}: {t}')
    P('\n## Calls by project x side')
    projs = sorted(set(p for p, _ in R['by_proj']), key=lambda p: -sum(R['by_proj'][(p, s)] for s in ('gh', 'ghx', 'mixed')))
    P(table([[p, R['by_proj'][(p, 'gh')], R['by_proj'][(p, 'ghx')], R['by_proj'][(p, 'mixed')]] for p in projs],
            ['project', 'gh', 'ghx', 'mixed']))
    P('\n## Calls by ISO week x side (non-dev)')
    wks = sorted(set(w for w, _ in R['by_week']))
    P(table([[w, R['by_week'][(w, 'gh')], R['by_week'][(w, 'ghx')], R['by_week'][(w, 'mixed')]] for w in wks],
            ['week', 'gh', 'ghx', 'mixed']))
    # call-level breakdown of ghx by kind
    k = collections.Counter()
    for c in use_calls:
        if c['side'] == 'gh': continue
        k['meta' if c['meta_only'] else ('passthrough' if c['passthrough'] else 'native')] += 1
    P(f'\nghx calls (non-dev) by kind: {dict(k)}')
    sub = collections.Counter(s for c in use_calls for s in c['subs'] if s.startswith('ghx'))
    P('ghx subcommands (non-dev): ' + ', '.join(f'{s} {n}' for s, n in sub.most_common(25)))
    # ---- episodes
    ueps = [e for e in eps if not is_dev(e['project'])]
    P(f'\n## Episodes (non-dev): {len(ueps)} total; side: {dict(collections.Counter(e["side"] for e in ueps))}')
    P('closed_by: ' + str(collections.Counter(e['closed_by'].split(':')[0] if e['closed_by'] else None for e in ueps).most_common()))
    rows = []
    for intent in PRIORITY:
        for side in ('gh', 'ghx', 'mixed'):
            es = [e for e in ueps if e['intent'] == intent and e['side'] == side]
            if es: rows.append([intent, side] + stat_row(es))
    P(table(rows, ['intent', 'side'] + STAT_HDR))
    # same, restricted to the repo with both eras and the ghx era
    P('\n## Episodes in powerhouse-powerhouse, by era x side')
    rows = []
    pp = [e for e in ueps if e['project'].endswith('powerhouse-powerhouse')]
    for intent in PRIORITY:
        for era in ('gh-era', 'ghx-era'):
            for side in ('gh', 'ghx', 'mixed'):
                es = [e for e in pp if e['intent'] == intent and e['side'] == side and era_of(e, adoption) == era]
                if es: rows.append([intent, era, side] + stat_row(es))
    P(table(rows, ['intent', 'era', 'side'] + STAT_HDR))
    P('\n## Same, opus-5-5 only, powerhouse-powerhouse (model held constant)')
    rows = []
    for intent in PRIORITY:
        for side in ('gh', 'ghx'):
            es = [e for e in pp if e['intent'] == intent and e['side'] == side and e.get('model') == 'claude-opus-5-5']
            if es: rows.append([intent, side] + stat_row(es))
    P(table(rows, ['intent', 'side'] + STAT_HDR))
    # wait episodes: wakeups
    P('\n## Wait episodes (non-dev): kind, wakeups, glue')
    rows = []
    for side in ('gh', 'ghx', 'mixed'):
        for kind in ('wait_bg', 'contiguous'):
            es = [e for e in ueps if e['intent'] == 'wait' and e['side'] == side and e['kind'] == kind]
            if not es: continue
            rows.append([side, kind, len(es), fmt(pct([e['wakeups'] for e in es], .5), 1), fmt(pct([e['wakeups'] for e in es], .9), 1),
                         fmt(pct([e['notif_chars'] for e in es], .5)), fmt(pct([len(e['glue']) for e in es], .5), 1),
                         sum(1 for e in es if e['closed_by'] == 'censored'),
                         sum(1 for e in es if any(c['ev']['name'] == 'Monitor' for c in e['calls']))])
    P(table(rows, ['side', 'kind', 'n', 'wakeups p50', 'wakeups p90', 'notif chars p50', 'glue p50', 'censored', 'monitor']))
    # segmentation diagnostics
    P('\n## Segmentation diagnostics (non-dev)')
    multi = [e for e in ueps if len(e['prs']) > 1]
    P(f'- multi-PR episodes: {len(multi)} ({len(multi) / max(1, len(ueps)):.0%})')
    P(f'- episodes with no PR number: {sum(1 for e in ueps if not e["prs"])}')
    P(f'- single-call episodes: {sum(1 for e in ueps if e["n_calls"] == 1)}')
    P(f'- episodes with glue calls: {sum(1 for e in ueps if e["glue"])}; glue calls total {sum(len(e["glue"]) for e in ueps)}')
    P(f'- wait episodes spanning a compaction: {sum(1 for e in ueps if e["compact_inside"])}')
    P(f'- episodes containing ghx meta (help/schema) calls: {sum(1 for e in ueps if e["n_meta"])}')
    P(f'- mixed-side episodes: {sum(1 for e in ueps if e["side"] == "mixed")}')
    bound = collections.Counter(e['closed_by'] for e in ueps if e['kind'] == 'contiguous')
    P(f'- contiguous episodes closed by: {bound.most_common(8)}')
    # gh-only window check against prior report (<= 2026-10-22)
    old = [c for c in all_calls_upto(calls, '2026-10-23') if c['side'] in ('gh', 'mixed')]
    P(f'\n## Validation: gh-side Bash/Monitor calls with ts < 2026-10-23: {len(old)}; invocations: {sum(c["ninv"] for c in old)}')
    ci = [e for e in eps if e['side'] in ('gh',) and e['start'] < '2026-10-23' and set(e['flags']) & {'status', 'wait', 'diagnose', 'rerun'}]
    lg = [e for e in ci if 'diagnose' in e['flags']]
    P(f'- gh CI episodes before 10-23 (all projects): {len(ci)}, with log fetch {len(lg)}, median gh calls of those {fmt(pct([e["n_gh_calls"] for e in lg], .5), 1)}')
    # ---- friction
    P('\n## ghx friction (non-dev)')
    fr = friction(use_calls)
    for k2, v in fr.items():
        P(f'- {k2}: {v}')
    # ---- confounders
    P('\n## Confounders (non-dev episodes)')
    P(confounders(ueps, adoption))
    # ---- CI cycles
    P('\n## CI cycles (per transcript x PR, split at git push)')
    P(ci_cycles(recs_cache(), adoption))
    P('\n## PR lifecycles (per session incl. subagents x PR; all GitHub calls naming that PR)')
    P(pr_lifecycles(calls, eps, adoption))
    if examples:
        P('\n## Example episodes')
        P(examples_md(ueps))
    return '\n'.join(out)


_recs = None


def recs_cache():
    global _recs
    if _recs is None: _recs = list(load())
    return _recs


def all_calls_upto(calls, day):
    return [c for c in calls if c['ev']['ts'] < day]


def friction(use_calls):
    fr = collections.OrderedDict()
    ghx = [c for c in use_calls if c['side'] in ('ghx', 'mixed')]
    fr['ghx calls (any)'] = len(ghx)
    codes = collections.Counter()
    exits = collections.Counter()
    for c in ghx:
        ev = c['ev']
        if ev.get('exit') not in (0, None): exits[ev['exit']] += 1
        for code in ev.get('rcodes') or []: codes[code] += 1
    fr['ghx non-zero exit codes'] = dict(exits.most_common())
    fr['ghx error codes in results'] = dict(codes.most_common())
    fr['policy refusals (exit 6)'] = exits.get(6, 0)
    fr['user-rejected gh/ghx calls'] = collections.Counter(c['side'] for c in use_calls if c['ev'].get('rejected'))
    hooks = collections.Counter((c['hook'], c['side']) for c in use_calls if c['hook'])
    fr['hook nudges/denials (by reason, side of denied call)'] = dict(hooks)
    # what happened next after a hook nudge / ghx error, within the same transcript
    by_file = collections.defaultdict(list)
    for c in use_calls: by_file[c['file']].append(c)
    after = collections.Counter()
    fallback_examples = []
    for f, cs in by_file.items():
        cs.sort(key=lambda c: c['ev']['ts'])
        for i, c in enumerate(cs):
            failed_ghx = c['side'] == 'ghx' and not c['meta_only'] and (bool(c['ev'].get('rcodes')) or (c['ev'].get('exit') not in (0, None) and not (c['intent'] == 'wait' and 10 <= (c['ev'].get('exit') or 0) <= 15)))
            if not (c['hook'] or failed_ghx): continue
            nxt = [d for d in cs[i + 1:i + 4] if (pts(d['ev']['ts']) - pts(c['ev']['ts'])).total_seconds() < 600]
            key = 'hook' if c['hook'] else 'ghx-error'
            if not nxt:
                after[(key, 'no follow-up')] += 1
            else:
                n0 = nxt[0]
                same = n0['intent'] == c['intent'] or (c['intent'] in ('status', 'wait') and n0['intent'] in ('status', 'wait'))
                after[(key, f"next={n0['side']}{'/same-intent' if same else '/other-intent'}")] += 1
                if key == 'ghx-error' and n0['side'] in ('gh', 'mixed') and len(fallback_examples) < 8:
                    fallback_examples.append(f"{c['ev']['ts'][:16]} {' ; '.join(c['subs'])} (exit {c['ev'].get('exit')}, {c['ev'].get('rcodes')}) -> {' ; '.join(n0['subs'])}")
    fr['after hook / ghx error (next GitHub call within 10 min)'] = dict(after)
    fr['ghx-error -> raw gh fallback examples'] = fallback_examples
    # raw gh in ghx-era configured repo
    return fr


def confounders(ueps, adoption):
    lines = []
    for field in ('ver', 'model'):
        c = collections.Counter((era_of(e, adoption), e['side'], (e.get(field) or '?')) for e in ueps
                                if e['project'].endswith('powerhouse-powerhouse'))
        vals = sorted(set(k[2] for k in c))
        rows = [[v] + [c[(era, s, v)] for era in ('gh-era', 'ghx-era') for s in ('gh', 'ghx', 'mixed')] for v in vals]
        rows = [r for r in rows if sum(r[1:]) >= 3]
        lines.append(f'\npowerhouse-powerhouse episodes by {field} (rows with >=3):\n' +
                     table(rows, [field, 'gh-era gh', 'gh-era ghx', 'gh-era mixed', 'ghx-era gh', 'ghx-era ghx', 'ghx-era mixed']))
    c = collections.Counter((short_project(e['project']), era_of(e, adoption), e['side']) for e in ueps)
    projs = sorted(set(k[0] for k in c))
    rows = [[p] + [c[(p, era, s)] for era in ('gh-era', 'ghx-era') for s in ('gh', 'ghx', 'mixed')] for p in projs]
    lines.append('\nEpisodes by project x era x side:\n' + table(rows, ['project', 'gh-era gh', 'gh-era ghx', 'gh-era mixed', 'ghx-era gh', 'ghx-era ghx', 'ghx-era mixed']))
    c = collections.Counter((era_of(e, adoption), 'subagent' if e['sub'] else 'main', e['side']) for e in ueps)
    rows = [[era, who] + [c[(era, who, s)] for s in ('gh', 'ghx', 'mixed')] for era in ('gh-era', 'ghx-era') for who in ('main', 'subagent')]
    lines.append('\nEpisodes by era x main/subagent:\n' + table(rows, ['era', 'who', 'gh', 'ghx', 'mixed']))
    def wt(e):
        cmds = ' '.join(c['ev'].get('cmd') or '' for c in e['calls'])
        return 'worktree' if re.search(r'worktree', cmds + (e.get('cwd') or '')) else 'main-checkout/unknown'
    c = collections.Counter((era_of(e, adoption), wt(e), e['side'])
                            for e in ueps if e['project'].endswith('powerhouse-powerhouse'))
    rows = [[era, w] + [c[(era, w, s)] for s in ('gh', 'ghx', 'mixed')] for era in ('gh-era', 'ghx-era') for w in ('main-checkout/unknown', 'worktree')]
    lines.append('\npowerhouse-powerhouse episodes by cwd kind (ghx.json lived only in the main checkout at first):\n' + table(rows, ['era', 'cwd', 'gh', 'ghx', 'mixed']))
    # difficulty proxy: CI red seen in episode
    def red(e):
        for c in e['calls']:
            h = c['ev'].get('rhead') or ''
            if re.search(r'\bfail(ure|ed)?\b|"bucket":"fail"|conclusion":"failure"|\tfail\t', h): return True
            if c['intent'] == 'wait' and (e.get('exit') or 0) == 10: return True
        return False
    c = collections.Counter((era_of(e, adoption), e['side'], red(e)) for e in ueps if e['intent'] in ('status', 'wait', 'diagnose', 'rerun'))
    rows = [[era, s, c[(era, s, False)], c[(era, s, True)]] for era in ('gh-era', 'ghx-era') for s in ('gh', 'ghx', 'mixed')]
    lines.append('\nCI episodes: red-CI-seen proxy (difficulty):\n' + table(rows, ['era', 'side', 'green/unknown', 'red seen']))
    return '\n'.join(lines)


def ci_cycles(recs, adoption):
    """Secondary unit: all CI-intent GitHub calls per (transcript, PR), split at each git push in that transcript."""
    cyc = collections.defaultdict(lambda: {'calls': 0, 'chars': 0, 'wakeups': 0, 'start': None, 'end': None,
                                           'sides': set(), 'diag': False, 'merged': False, 'project': None, 'sub': False})
    for rec in recs:
        if is_dev(rec['project']): continue
        push = 0
        last_pr = None
        task_pr = {}
        for ev in rec['events']:
            if ev['k'] == 'notif':
                key = task_pr.get(ev['task'])
                if key:
                    cyc[key]['wakeups'] += 1
                    cyc[key]['chars'] += ev['chars']
                    cyc[key]['end'] = ev['ts']
                continue
            if ev['k'] != 'tool' or ev['name'] not in ('Bash', 'Monitor'): continue
            cmd = ev.get('cmd') or ''
            c = classify_call(ev)
            if PUSH_RE.search(strip_inert(cmd)): push += 1
            if not c: continue
            prs = c['prs'] or ([last_pr] if last_pr else [])
            if c['prs']: last_pr = c['prs'][0]
            if not set(c['intents']) & {'status', 'wait', 'diagnose', 'rerun', 'merge'}: continue
            for pr in prs:
                key = (rec['file'], pr, push)
                k = cyc[key]
                k['calls'] += 1
                k['chars'] += (ev.get('rchars') or 0) // max(1, len(prs))
                k['start'] = k['start'] or ev['ts']
                k['end'] = ev.get('rts') or ev['ts']
                if c['side'] != 'mixed' or True: k['sides'].add(c['side'])
                k['diag'] |= 'diagnose' in c['intents'] or (c['intent'] == 'wait' and c['side'] == 'ghx')
                k['merged'] |= 'merge' in c['intents']
                k['project'] = rec['project']; k['sub'] = rec['sub']
                if ev.get('task'): task_pr[ev['task']] = key
    rows = []
    for era in ('gh-era', 'ghx-era'):
        for side in ('gh', 'ghx', 'mixed'):
            ks = [v for v in cyc.values() if v['start'] and ('mixed' if len(v['sides']) > 1 or 'mixed' in v['sides'] else next(iter(v['sides']))) == side
                  and (('ghx-era' if adoption.get(v['project']) and v['start'] >= adoption[v['project']] else 'gh-era') == era)]
            if not ks: continue
            secs = [(pts(v['end']) - pts(v['start'])).total_seconds() for v in ks]
            rows.append([era, side, len(ks), fmt(pct([v['calls'] for v in ks], .5), 1), fmt(pct([v['calls'] for v in ks], .9), 1),
                         fmt(pct([v['chars'] for v in ks], .5)), fmt(pct([v['chars'] for v in ks], .9)), fmt(pct(secs, .5)),
                         fmt(pct([v['wakeups'] for v in ks], .5), 1), sum(v['merged'] for v in ks)])
    return table(rows, ['era', 'side', 'cycles', 'calls p50', 'calls p90', 'chars p50', 'chars p90', 'secs p50', 'wakeups p50', 'w/ merge'])


def pr_lifecycles(calls, eps, adoption):
    """Per (session, PR): every GitHub call that names the PR, across main + subagent transcripts."""
    L = collections.defaultdict(lambda: {'calls': 0, 'chars': 0, 'sides': set(), 'create': False, 'merge': False,
                                         'start': None, 'end': None, 'project': None, 'errs': 0, 'wakeups': 0,
                                         'rounds': set(), 'sub_calls': 0})
    task_key = {}
    last_pr = {}
    for c in calls:  # in transcript order, file by file
        if is_dev(c['project']): continue
        prs = c['prs']
        if prs:
            last_pr[c['file']] = prs[-1]
        elif c['intent'] in ('other_read',) and not c['meta_only']:
            continue  # unrelated reads (issues, other repos, file contents)
        else:
            # run ids, branch queries and ghx meta lookups carry no PR number: charge them to the PR this transcript last named
            prs = [last_pr[c['file']]] if c['file'] in last_pr else []
        for pr in prs:
            k = L[(c['file'].split('/')[0], c['file'].split('/')[1].split('.')[0], pr)]
            k['calls'] += 1
            k['sub_calls'] += 1 if c['sub'] else 0
            k['chars'] += (c['ev'].get('rchars') or 0) // len(prs)
            k['sides'].add(c['side'])
            k['create'] |= 'create' in c['intents']
            k['merge'] |= 'merge' in c['intents'] and not c['ev'].get('rcodes') and c['ev'].get('exit') == 0
            k['start'] = min(filter(None, [k['start'], c['ev']['ts']]))
            k['end'] = max(filter(None, [k['end'], c['ev'].get('rts') or c['ev']['ts']]))
            k['project'] = c['project']
            k['errs'] += 1 if c['ev'].get('rcodes') else 0
            if c['ev'].get('task'): task_key[c['ev']['task']] = k
    for e in eps:
        for c in e['calls']:
            t = c['ev'].get('task')
            if t in task_key:
                task_key[t]['wakeups'] += e['wakeups']
                task_key[t]['chars'] += e['notif_chars'] + sum(g.get('rchars') or 0 for g in e['glue'])
                task_key[t]['calls'] += len(e['glue'])
    pushes = collections.defaultdict(list)  # (project, session) -> push timestamps across main + subagent files
    for rec in recs_cache():
        for ev in rec['events']:
            if ev['k'] == 'tool' and ev['name'] == 'Bash' and PUSH_RE.search(strip_inert(ev.get('cmd') or '')):
                pushes[(rec['project'], rec['session'])].append(ev['ts'])
    for (proj, sess, pr), v in L.items():
        v['rounds'] = 1 + sum(1 for t in pushes[(proj, sess)] if v['start'] <= t <= v['end'])
    rows = []
    for scope in ('all', 'created+merged in session'):
        for side in ('gh', 'ghx', 'mixed'):
            ks = [v for v in L.values() if (('mixed' if len(v['sides']) > 1 else next(iter(v['sides']))) == side)
                  and (scope == 'all' or (v['create'] and v['merge']))]
            if not ks: continue
            rows.append([scope, side, len(ks), fmt(pct([v['calls'] for v in ks], .5), 1), fmt(pct([v['calls'] for v in ks], .9), 1),
                         fmt(pct([v['chars'] for v in ks], .5)), fmt(pct([v['chars'] for v in ks], .9)),
                         fmt(pct([v['wakeups'] for v in ks], .5), 1), fmt(pct([(pts(v['end']) - pts(v['start'])).total_seconds() / 3600 for v in ks], .5), 2),
                         fmt(pct([v['rounds'] for v in ks], .5), 1),
                         fmt(pct([v['calls'] / v['rounds'] for v in ks], .5), 1),
                         fmt(pct([v['chars'] / v['rounds'] for v in ks], .5)),
                         f"{sum(v['sub_calls'] for v in ks) / max(1, sum(v['calls'] for v in ks)):.0%}"])
    return table(rows, ['scope', 'side', 'PRs', 'calls p50', 'calls p90', 'chars p50', 'chars p90', 'wakeups p50', 'hours p50',
                        'CI rounds p50', 'calls/round p50', 'chars/round p50', '% calls in subagents'])


def abbreviate(c):
    cmd = re.sub(r'\s+', ' ', c['ev'].get('cmd') or '')
    return cmd[:110] + ('…' if len(cmd) > 110 else '')


def examples_md(ueps):
    lines = []
    want = [('diagnose', 'gh'), ('diagnose', 'ghx'), ('wait', 'gh'), ('wait', 'ghx'), ('status', 'gh'), ('status', 'ghx'),
            ('merge', 'gh'), ('merge', 'ghx'), ('create', 'gh'), ('create', 'ghx'), ('feedback', 'ghx'), ('reply', 'gh'), ('mixed_any', 'mixed')]
    for intent, side in want:
        es = [e for e in ueps if (e['intent'] == intent or intent == 'mixed_any') and e['side'] == side and e['n_calls'] >= 1]
        if not es: continue
        es.sort(key=lambda e: (e['start']))
        # deterministic pick: spread across the list
        picks = [es[int(i * (len(es) - 1) / 3)] for i in range(4)] if len(es) >= 4 else es
        seen = set()
        lines.append(f'\n### {intent} / {side} ({len(es)} episodes)')
        for e in picks:
            if id(e) in seen: continue
            seen.add(id(e))
            lines.append(f"- {e['start'][:16]} {short_project(e['project'])}{' (sub)' if e['sub'] else ''} kind={e['kind']} calls={e['n_calls']} chars={e['chars']} secs={e['secs']:.0f} wakeups={e['wakeups']} prs={e['prs']} closed_by={e['closed_by']}")
            for c in e['calls'][:6]:
                lines.append(f"    - [{c['intent']}{',bg' if c['bg'] else ''}{',loop' if c['loop'] else ''}] `{abbreviate(c)}` -> {c['ev'].get('rchars')} chars exit={c['ev'].get('exit')}")
            if len(e['calls']) > 6: lines.append(f"    - … {len(e['calls']) - 6} more gh calls")
            for g in e['glue'][:3]:
                lines.append(f"    - glue {g['name']}: `{(g.get('path') or g.get('cmd') or g.get('task') or '')[:90]}`")
    return '\n'.join(lines)


if __name__ == '__main__':
    if len(sys.argv) < 2 or sys.argv[1] not in ('extract', 'analyze', 'sensitivity'):
        print(__doc__)
        sys.exit(2)
    if sys.argv[1] == 'extract':
        extract()
    elif sys.argv[1] == 'analyze':
        gap = int(sys.argv[sys.argv.index('--gap') + 1]) if '--gap' in sys.argv else 10
        txt = report(gap)
        with open(os.path.join(HERE, f'report-gap{gap}.md'), 'w') as fh: fh.write(txt)
        print(f'wrote report-gap{gap}.md ({len(txt)} chars)')
    else:
        for gap in (5, 10, 30):
            R, eps, calls, use_calls, adoption = analyze(gap)
            ueps = [e for e in eps if not is_dev(e['project'])]
            c = collections.Counter((e['intent'], e['side']) for e in ueps)
            print(f'gap={gap}: episodes={len(ueps)} ' + ' '.join(f'{i}/{s}={n}' for (i, s), n in sorted(c.items()) if n >= 5))
