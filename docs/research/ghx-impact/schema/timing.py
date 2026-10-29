import json,glob,os,collections,re,statistics
from datetime import datetime
R=os.path.expanduser('~/.claude/projects')
ts=lambda s: datetime.fromisoformat(s.replace('Z','+00:00')).timestamp()
C=collections.Counter(); dts=collections.defaultdict(list); ex={}
mono=collections.Counter()
for f in glob.glob(R+'/*/*.jsonl')+glob.glob(R+'/*/*/subagents/*.jsonl'):
    uses={}; prev=None
    for l in open(f,'rb'):
        r=json.loads(l)
        if 'timestamp' in r:
            t=ts(r['timestamp'])
            if prev is not None: mono['nondecr' if t>=prev else 'decreasing']+=1
            prev=t
        m=r.get('message') if isinstance(r.get('message'),dict) else None
        if r.get('type')=='assistant' and m:
            for b in m.get('content') or []:
                if b.get('type')=='tool_use': uses[b['id']]=(ts(r['timestamp']),b['name'],bool((b.get('input') or {}).get('run_in_background')),(b.get('input') or {}).get('command',''))
                if 'wireToolInputs' in r and 'wire' not in ex: ex['wire']=json.dumps(r['wireToolInputs'])[:300]
        if r.get('type')=='user' and m:
            c=m['content']
            if isinstance(c,list):
                for b in c:
                    if b.get('type')=='tool_result' and b['tool_use_id'] in uses:
                        u=uses[b['tool_use_id']]; dts[(u[1],u[2])].append(ts(r['timestamp'])-u[0])
                        if u[1]=='Bash' and b.get('is_error'):
                            s=b['content'] if isinstance(b['content'],str) else json.dumps(b['content'])
                            mm=re.match(r'Exit code (\d+)',s); C[('bash err starts Exit code',bool(mm))]+=1
                            if not mm: ex.setdefault('errnoexit'+s[:20],s[:150])
            elif isinstance(c,str) and c.startswith('<task-notification>'):
                mm=re.search(r'<tool-use-id>(\S+)</tool-use-id>',c)
                if mm and mm.group(1) in uses:
                    u=uses[mm.group(1)]; dts[('NOTIF:'+u[1],u[2])].append(ts(r['timestamp'])-u[0])
                    if 'ghx ci wait' in u[3]: dts[('NOTIF ghx ci wait',True)].append(ts(r['timestamp'])-u[0])
for k,v in [x for x in dts.items() if "NOTIF" in str(x[0])]:
    v=sorted(v); print(k,len(v),'p50=%.1fs p90=%.1fs max=%.0fs min=%.2f'%(v[len(v)//2],v[int(len(v)*.9)],v[-1],v[0]))
print(C, mono)
for k,v in ex.items(): print(k,'=>',v)
