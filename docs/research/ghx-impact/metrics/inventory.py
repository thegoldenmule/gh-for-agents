import json,os,glob,re,collections,sys
root=os.path.expanduser('~/.claude/projects')
files=glob.glob(root+'/**/*.jsonl',recursive=True)
rx_ghx=re.compile(r'(^|[\s;&|(`])ghx\s'); rx_gh=re.compile(r'(^|[\s;&|(`]|\$\()gh\s+[a-z]')
out=[]
for f in files:
    ghx=gh=0; models=collections.Counter(); first=last=None
    try:
        for line in open(f,errors='replace'):
            if '"tool_use"' not in line and '"timestamp"' not in line: continue
            try: r=json.loads(line)
            except: continue
            ts=r.get('timestamp');
            if ts: first=first or ts; last=ts
            m=r.get('message') or {}
            if r.get('type')=='assistant':
                models[m.get('model')]+=1
                for c in m.get('content') or []:
                    if isinstance(c,dict) and c.get('type')=='tool_use' and c.get('name')=='Bash':
                        cmd=c['input'].get('command','')
                        if rx_ghx.search(cmd): ghx+=1
                        elif rx_gh.search(cmd): gh+=1
    except Exception as e: print(e,file=sys.stderr)
    out.append(dict(f=f[len(root)+1:],size=os.path.getsize(f),ghx=ghx,gh=gh,models=dict(models),first=first,last=last))
json.dump(out,open(sys.argv[1],'w'))
print(len(out),'files; with ghx',sum(1 for o in out if o['ghx']),'with gh',sum(1 for o in out if o['gh']))
print('ghx cmds',sum(o['ghx'] for o in out),'gh cmds',sum(o['gh'] for o in out))
mc=collections.Counter()
for o in out:
  for k,v in o['models'].items(): mc[k]+=v
print(mc.most_common(12))
