import json,glob,os,sys,collections
sys.path.insert(0,os.path.dirname(__file__)); from tx import parse; from pricing import cost,P
root=os.path.expanduser('~/.claude/projects')
rows=[]
for f in glob.glob(root+'/*/*.jsonl'):
    cs=None
    for line in open(f,errors='replace'):
        if '"cost-state"' in line:
            try:
                r=json.loads(line)
                if r.get('type')=='cost-state': cs=r
            except: pass
    if not cs: continue
    calls,_,_=parse(f)
    main=collections.Counter(); allc=collections.Counter()
    for c in calls: main[c['model']]+=cost(c['model'],c['usage']) or 0
    sub=glob.glob(f[:-6]+'/subagents/**/*.jsonl',recursive=True)
    allc.update(main)
    for s in sub:
        for c in parse(s)[0]: allc[c['model']]+=cost(c['model'],c['usage']) or 0
    for m,mu in cs['modelUsage'].items():
        rows.append((os.path.basename(f)[:8],m,mu['costUSD'],main.get(m,0),allc.get(m,0),len(sub)))
for r in sorted(rows,key=lambda r:-r[2])[:25]: print('%s %-26s cs=%8.2f main=%8.2f main+sub=%8.2f nsub=%d'%r)
print(len(rows))
