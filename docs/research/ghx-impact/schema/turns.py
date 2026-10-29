import json,glob,os,collections
R=os.path.expanduser('~/.claude/projects')
C=collections.Counter(); ex={}
for f in glob.glob(R+'/*/*.jsonl')+glob.glob(R+'/*/*/subagents/*.jsonl'):
    kind='sub' if '/subagents/' in f else 'main'
    seen=set(); last=None; tdur=0; starters=0
    for l in open(f,'rb'):
        r=json.loads(l)
        if r.get('type')=='system' and r.get('subtype')=='turn_duration': tdur+=1
        if r.get('type')!='user': continue
        p=r.get('promptId'); c=r['message']['content']
        istr=isinstance(c,list) and any(b.get('type')=='tool_result' for b in c)
        if p is None: C[(kind,'no promptId', 'tool_result' if istr else 'text', bool(r.get('isMeta')), bool(r.get('isCompactSummary')))]+=1; continue
        if p!=last:
            if p in seen: C[(kind,'promptId reappears non-contiguously')]+=1
            C[(kind,'new promptId first record', 'tool_result' if istr else 'text', r.get('turnOrigin') or (r.get('origin') or {}).get('kind'), bool(r.get('isMeta')))]+=1
            if not istr: starters+=1
            seen.add(p); last=p
    if kind=='main': C[('main turn_duration vs text-starters', 'eq' if tdur==starters else ('td<' if tdur<starters else 'td>'))]+=1
for k,v in C.most_common(30): print(v,k)
