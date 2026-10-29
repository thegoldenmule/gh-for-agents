import json,glob,os,collections,re
from datetime import datetime
R=os.path.expanduser('~/.claude/projects')
ts=lambda s: datetime.fromisoformat(s.replace('Z','+00:00')).timestamp()
C=collections.Counter(); lat=collections.defaultdict(list)
for f in glob.glob(R+'/*/*.jsonl')+glob.glob(R+'/*/*/subagents/*.jsonl'):
    bg={}; notes=collections.defaultdict(list); bgid2tu={}
    for l in open(f,'rb'):
        r=json.loads(l); m=r.get('message') if isinstance(r.get('message'),dict) else None
        if r.get('type')=='assistant' and m:
            for b in m.get('content') or []:
                if b.get('type')=='tool_use' and b['name']=='Bash' and (b.get('input') or {}).get('run_in_background'):
                    bg[b['id']]=(ts(r['timestamp']),'ghx ci wait' in b['input'].get('command',''))
        tur=r.get('toolUseResult')
        if isinstance(tur,dict) and tur.get('backgroundTaskId'):
            for b in m['content']:
                if b.get('type')=='tool_result': bgid2tu[tur['backgroundTaskId']]=b['tool_use_id']
        texts=[]
        if r.get('type')=='queue-operation' and r.get('content'): texts.append(('queue-'+r['operation'],r['content']))
        if r.get('type')=='attachment' and r['attachment'].get('type')=='queued_command' and isinstance(r['attachment'].get('prompt'),str): texts.append(('attach',r['attachment']['prompt']))
        if r.get('type')=='user' and m and isinstance(m['content'],str): texts.append(('user',m['content']))
        for src,t in texts:
            if '<task-notification>' not in t: continue
            mm=re.search(r'<tool-use-id>(\S+?)</tool-use-id>',t); tid=re.search(r'<task-id>(\w+)',t)
            key=mm.group(1) if mm else bgid2tu.get(tid.group(1) if tid else None)
            if key and '<event>' not in t: notes[key].append((src,ts(r['timestamp']) if 'timestamp' in r else None, re.search(r'<status>(\w+)',t).group(1) if '<status>' in t else None, re.search(r'exit code (\d+)',t)))
    for tu,(t0,isghx) in bg.items():
        n=notes.get(tu)
        srcs=tuple(sorted(set(x[0] for x in n))) if n else None
        C[('main' if '/subagents/' not in f else 'sub', srcs)]+=1
        if n:
            first=min(x[1] for x in n if x[1]); lat['ghx' if isghx else 'other'].append(first-t0)
            C[('has exit code in summary', any(x[3] for x in n))]+=1
for k,v in C.most_common(): print(v,k)
for k,v in lat.items(): v.sort(); print(k,len(v),'p50 %.0fs'%v[len(v)//2])
