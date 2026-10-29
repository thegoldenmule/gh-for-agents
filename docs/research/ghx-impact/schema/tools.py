import json,glob,os,collections,re,pickle
R=os.path.expanduser('~/.claude/projects')
files=glob.glob(R+'/*/*.jsonl')+glob.glob(R+'/*/*/subagents/*.jsonl')
C=collections.Counter
names=C(); bash_in=C(); tur_keys=collections.defaultdict(C); samples={}
res_err=C(); res_ctype=C(); persisted=C(); prefix=C(); prefix_main=collections.defaultdict(C); notif=[]
ghcmd=C(); ex_user={}; compact=[]; interrupted=C(); tur_vs_name=C(); sizes=collections.defaultdict(list)
for f in files:
    kind='sub' if '/subagents/' in f else 'main'
    id2name={}
    for l in open(f,'rb'):
        r=json.loads(l); m=r.get('message') if isinstance(r.get('message'),dict) else None
        if r.get('type')=='assistant' and m:
            for b in m.get('content') or []:
                if b.get('type') in('tool_use','server_tool_use'):
                    n=b.get('name'); names[(b['type'],n)]+=1; id2name[b.get('id')]=n
                    inp=b.get('input') or {}
                    if n=='Bash':
                        bash_in.update(inp.keys())
                        cmd=inp.get('command','')
                        for mm in re.findall(r'(?:^|[;&|(]\s*|\s)(ghx|gh)\s+([a-z-]+)',cmd): ghcmd[mm[0]]+=1
        if r.get('type')=='user' and m:
            c=m.get('content'); tur=r.get('toolUseResult')
            if isinstance(c,str):
                p=re.match(r'\s*(<[a-zA-Z-]+|\[[A-Za-z ]+|Caveat|This session is being continued|[A-Za-z]+)',c)
                key=(p.group(1) if p else c[:15])[:40]
                prefix[(kind,key,bool(r.get('isMeta')),r.get('promptSource'),r.get('turnOrigin'))]+=1
                ex_user.setdefault((kind,key,bool(r.get('isMeta'))),(f,c[:300]))
                if r.get('isCompactSummary'): compact.append((f,r.get('uuid'),r.get('parentUuid'),r.get('logicalParentUuid'),c[:100]))
            else:
                for b in c:
                    if b.get('type')=='tool_result':
                        n=id2name.get(b.get('tool_use_id'),'?'); res_err[(n,b.get('is_error'))]+=1
                        bc=b.get('content'); res_ctype[(type(bc).__name__, tuple(sorted(set(x.get('type') for x in bc))) if isinstance(bc,list) else None)]+=1
                        s=json.dumps(bc,ensure_ascii=False) if not isinstance(bc,str) else bc
                        if '<persisted-output>' in s or 'tool-results/' in s: persisted[(n,'<persisted-output>' in s)]+=1; samples.setdefault('persist_'+n,s[:500])
                        sizes[n].append(len(s.encode()))
                        if isinstance(tur,dict): tur_keys[n].update(tur.keys()); samples.setdefault(('tur',n,tuple(sorted(tur))),json.dumps(tur)[:700])
                        elif tur is not None: tur_vs_name[(n,type(tur).__name__)]+=1; samples.setdefault(('turx',n,type(tur).__name__),json.dumps(tur)[:300])
                    elif b.get('type')=='text':
                        t=b.get('text','');p=re.match(r'\s*(<[a-zA-Z-]+|\[[A-Za-z ]+|[A-Za-z]+)',t); prefix[(kind,'LISTTEXT:'+(p.group(1) if p else t[:15]),bool(r.get('isMeta')),r.get('promptSource'),r.get('turnOrigin'))]+=1
                        ex_user.setdefault((kind,'LISTTEXT:'+(p.group(1) if p else t[:15])),(f,t[:300]))
pickle.dump(dict(names=names,bash_in=bash_in,tur_keys=dict(tur_keys),samples=samples,res_err=res_err,res_ctype=res_ctype,persisted=persisted,prefix=prefix,ghcmd=ghcmd,ex_user=ex_user,compact=compact,tur_vs_name=tur_vs_name,sizes=dict(sizes)),open(os.path.dirname(os.path.abspath(__file__))+'/tools.pkl','wb'))
print('ok')
