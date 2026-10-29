"""Validate attribution (b): context delta between the call that emitted a tool_use and the next call, vs tool_result chars."""
import sys,os,json,glob,statistics as st
sys.path.insert(0,os.path.dirname(os.path.abspath(__file__))); from tx import parse; from pricing import last_ctx
inv=json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)),'inventory.json')))
root=os.path.expanduser('~/.claude/projects/')
files=[root+o['f'] for o in inv if o['ghx'] or o['gh']]
rows=[]
for f in files:
    calls,tools,ev=parse(f)
    # mark calls that have human/attachment events between them and next call -> skip
    for c in calls:
        tus=c['tool_uses']
        if len(tus)!=1 or c['stop']!='tool_use': continue
        tu=tus[0]
        if tu.get('next_call') is None or tu['next_call']!=c['idx']+1: continue
        n=calls[tu['next_call']]
        if n['model']!=c['model']: continue
        d=last_ctx(n['usage'])-last_ctx(c['usage'])
        rows.append(dict(f=f[len(root):],kind=tu['kind'] or tu['name'],name=tu['name'],d=d,out=c['usage'].get('output_tokens') or 0,
            think=(c['usage'].get('output_tokens_details') or {}).get('thinking_tokens'),res=tu.get('res_chars',0),inp=tu['in_chars'],model=c['model'],
            res_ascii=sum(1 for ch in tu.get('res_text','') if ord(ch)<128),gap=(n['seq']-tu.get('res_seq',0)),json=tu.get('res_text','')[:1] in '{['))
json.dump(rows,open(sys.argv[1],'w'))
print(len(rows))
