"""Collect every gh/ghx Bash tool call with its result, attribution fields and context; -> gh_calls.jsonl"""
import json,os,sys
sys.path.insert(0,os.path.dirname(os.path.abspath(__file__))); from tx import parse; from pricing import last_ctx,cost
inv=json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)),'inventory.json'))); root=os.path.expanduser('~/.claude/projects/')
out=open(sys.argv[1],'w'); n=0
for o in inv:
    if not(o['gh'] or o['ghx']): continue
    calls,tools,ev=parse(root+o['f'])
    for tu in tools.values():
        if tu['kind'] not in('gh','ghx'): continue
        c=calls[tu['call']]
        rec=dict(f=o['f'],id=tu['id'],kind=tu['kind'],cmd=tu['cmd'],bg=tu['bg'],ts=tu['ts'],res_ts=tu.get('res_ts'),
                 res=tu.get('res_text','')[:4000],res_chars=tu.get('res_chars'),is_error=tu.get('is_error'),
                 call_out=c['usage'].get('output_tokens'),call_ntools=len(c['tool_uses']),ctx=last_ctx(c['usage']),model=c['model'],
                 in_chars=tu['in_chars'],tur_keys=sorted((tu.get('tur') or {}).keys()))
        out.write(json.dumps(rec)+'\n'); n+=1
print(n)
