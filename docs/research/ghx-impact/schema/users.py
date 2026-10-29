import json,glob,os,collections,re
R=os.path.expanduser('~/.claude/projects')
C=collections.Counter(); ex={}
for f in glob.glob(R+'/*/*.jsonl')+glob.glob(R+'/*/*/subagents/*.jsonl'):
    kind='sub' if '/subagents/' in f else 'main'
    for l in open(f,'rb'):
        r=json.loads(l)
        if r.get('type')!='user': continue
        c=r['message']['content']
        if isinstance(c,list) and all(b.get('type')=='tool_result' for b in c): continue
        txt=c if isinstance(c,str) else ' '.join(b.get('text','') for b in c if b.get('type')=='text')
        tag=re.match(r'\s*(<[a-z-]+>?|\[[A-Za-z ]+|This session is being continued)?',txt).group(1) or 'plain'
        o=(r.get('origin') or {}).get('kind')
        k=(kind,'list' if isinstance(c,list) else 'str',bool(r.get('isMeta')),bool(r.get('isCompactSummary')),r.get('promptSource'),r.get('turnOrigin'),o,tag)
        C[k]+=1; ex.setdefault(k,txt[:160].replace('\n',' '))
for k,v in sorted(C.items(),key=lambda x:(x[0][0],-x[1])):
    if v>=2 or k[0]=='main': print(v,k,'|',ex[k][:110])
