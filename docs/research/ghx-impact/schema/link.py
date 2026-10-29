import json,glob,os,collections
R=os.path.expanduser('~/.claude/projects')
C=collections.Counter()
tooluse_loc={}  # tool_use id -> (file, name)
agent_result={} # agentId -> file where Agent toolUseResult has it
for f in glob.glob(R+'/*/*.jsonl')+glob.glob(R+'/*/*/subagents/*.jsonl'):
    for l in open(f,'rb'):
        if b'tool_use' not in l and b'agentId' not in l: continue
        r=json.loads(l); m=r.get('message') if isinstance(r.get('message'),dict) else None
        if r.get('type')=='assistant' and m:
            for b in m.get('content') or []:
                if b.get('type')=='tool_use': tooluse_loc.setdefault(b['id'],(f,b['name'],b.get('input',{}).get('subagent_type'),b.get('input',{}).get('run_in_background')))
        tur=r.get('toolUseResult')
        if isinstance(tur,dict) and 'agentId' in tur: agent_result.setdefault(tur['agentId'],(f,tur.get('status'),tur.get('isAsync')))
for mf in glob.glob(R+'/*/*/subagents/*.meta.json'):
    meta=json.load(open(mf)); aid=os.path.basename(mf)[6:-10]
    jf=mf.replace('.meta.json','.jsonl'); sess=mf.split('/')[-3]
    fs=os.path.exists(mf.replace('.meta.json','.forked-skill.json'))
    tid=meta.get('toolUseId')
    if tid:
        loc=tooluse_loc.get(tid)
        if not loc: C[('toolUseId not found',)]+=1; continue
        pf=loc[0]; kind='main' if '/subagents/' not in pf else 'sub'
        expected_parent = meta.get('parentAgentId')
        ok = (kind=='main' and not expected_parent) or (kind=='sub' and expected_parent and pf.endswith('agent-%s.jsonl'%expected_parent))
        C[('toolUseId found', loc[1], kind, 'parentAgentId-consistent' if ok else 'INCONSISTENT', 'same-session' if pf.split('/subagents/')[0].endswith(sess) or pf.endswith(sess+'.jsonl') else 'other-session')]+=1
    else:
        C[('no toolUseId', meta.get('agentType'), 'forked-skill' if fs else '', 'name' in meta, aid in agent_result)]+=1
    C[('agentId in some toolUseResult', aid in agent_result, agent_result.get(aid,(0,0))[1])]+=1
for k,v in C.most_common(): print(v,k)
