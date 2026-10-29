import json,glob,os,collections,sys,pickle
R=os.path.expanduser('~/.claude/projects')
files=glob.glob(R+'/*/*.jsonl')+glob.glob(R+'/*/*/subagents/*.jsonl')
C=collections.Counter
type_counts={'main':C(),'sub':C()}
sys_sub=C(); att_types=C(); topkeys=collections.defaultdict(C)
usage_keys=C(); usage_sub=C(); block_types=C(); user_content_kinds=C()
bad_lines=[]; uuid_files=collections.defaultdict(set)
msgid_records=collections.defaultdict(list)  # msgid -> list of (file,usage json,blocktype,reqid)
models=C(); versions=C(); entry=C(); origin=C(); promptSource=C(); turnOrigin=C()
tur_keys=collections.defaultdict(C); user_flags=C(); stop_reasons=C(); iter_types=C()
sess_in_file=collections.defaultdict(C)
for f in files:
    kind='sub' if '/subagents/' in f else 'main'
    with open(f,'rb') as fh: lines=fh.read().split(b'\n')
    if lines and lines[-1]==b'': lines=lines[:-1]
    for i,l in enumerate(lines):
        try: r=json.loads(l)
        except Exception as e: bad_lines.append((f,i,len(lines),str(e)[:60])); continue
        t=r.get('type'); type_counts[kind][t]+=1
        topkeys[t].update(r.keys())
        if r.get('sessionId'): sess_in_file[f][r['sessionId']]+=1
        if t=='system': sys_sub[r.get('subtype')]+=1
        if t=='attachment': att_types[(r.get('attachment') or {}).get('type')]+=1
        if 'uuid' in r and t in('user','assistant','system','attachment'): uuid_files[r['uuid']].add(f)
        if r.get('version'): versions[r['version']]+=1
        if r.get('entrypoint'): entry[r['entrypoint']]+=1
        m=r.get('message') if isinstance(r.get('message'),dict) else None
        if t=='assistant' and m:
            models[m.get('model')]+=1; stop_reasons[m.get('stop_reason')]+=1
            u=m.get('usage')
            if u:
                usage_keys.update(u.keys())
                for k,v in u.items():
                    if isinstance(v,dict): usage_sub.update(k+'.'+x for x in v)
                for it in u.get('iterations') or []: iter_types[it.get('type')]+=1
            bt=[b.get('type') for b in m.get('content') or [] if isinstance(b,dict)]
            block_types.update('A:'+x for x in bt)
            msgid_records[m.get('id')].append((f,i,json.dumps(u,sort_keys=True) if u else None,tuple(bt),r.get('requestId'),r.get('apiBlockIndex'),r.get('uuid'),r.get('timestamp')))
        if t=='user' and m:
            c=m.get('content')
            if isinstance(c,str): k='str'
            else: k='list:'+','.join(sorted(set(b.get('type','?') for b in c if isinstance(b,dict))))
            user_content_kinds[k]+=1
            for b in (c if isinstance(c,list) else []):
                if isinstance(b,dict): block_types.update(['U:'+b.get('type','?')])
            origin[json.dumps(r.get('origin'))[:80]]+=1; promptSource[r.get('promptSource')]+=1; turnOrigin[r.get('turnOrigin')]+=1
            for fl in ('isMeta','isCompactSummary','isVisibleInTranscriptOnly','toolUseResult','sourceToolAssistantUUID','sourceToolUseID','isSidechain','agentId','promptId','imagePasteIds','planContent','interruptedTurn'):
                if fl in r: user_flags[(fl, kind, type(r[fl]).__name__ if fl!='isMeta' and fl!='isSidechain' and fl!='isCompactSummary' else str(r[fl]))]+=1
pickle.dump(dict(files=files,type_counts=type_counts,sys_sub=sys_sub,att_types=att_types,topkeys=topkeys,usage_keys=usage_keys,usage_sub=usage_sub,block_types=block_types,user_content_kinds=user_content_kinds,bad_lines=bad_lines,uuid_files=dict(uuid_files),msgid_records=dict(msgid_records),models=models,versions=versions,entry=entry,origin=origin,promptSource=promptSource,turnOrigin=turnOrigin,user_flags=user_flags,stop_reasons=stop_reasons,iter_types=iter_types,sess_in_file=dict(sess_in_file)),open(os.path.dirname(__file__)+'/survey.pkl','wb'))
print('done',len(files))
