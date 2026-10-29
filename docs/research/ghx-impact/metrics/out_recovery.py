"""Subagent output_tokens are stream-start snapshots. Recover: out_k ~= ctx(k+1)-ctx(k) - sum(result chars/2.2+70). Validate on main threads."""
import json,os,sys
sys.path.insert(0,'.'); from tx import parse; from pricing import last_ctx
from lsq import ols
inv=json.load(open('inventory.json')); root=os.path.expanduser('~/.claude/projects/')
def q(xs,p): xs=sorted(xs); return xs[int(round(p*(len(xs)-1)))]
main=[];sub=[]
for o in inv:
    if not(o['gh'] or o['ghx']): continue
    calls,tools,_=parse(root+o['f'])
    for c,nx in zip(calls,calls[1:]):
        tus=c['tool_uses']
        if not tus or c['stop']!='tool_use' or nx['model']!=c['model']: continue
        if any(t.get('next_call')!=c['idx']+1 for t in tus): continue
        if any(t.get('res_text','').startswith('<tool_use_error>') for t in tus): pass
        d=last_ctx(nx['usage'])-last_ctx(c['usage'])
        if d<0: continue
        rec=sum((t.get('res_chars') or 0)/2.2+70 for t in tus)
        row=(c['usage'].get('output_tokens') or 0, d-rec, sum(t['in_chars'] for t in tus)+c['out_chars'])
        (sub if 'subagents' in o['f'] else main).append(row)
# main: recovered vs actual
err=[abs(r[1]-r[0]) for r in main]; rel=[abs(r[1]-r[0])/max(r[0],1) for r in main if r[0]>200]
coef,R2,mae,_=ols([[r[0]] for r in main],[r[1] for r in main])
print('main n=%d recovered=a+b*actual: a=%.0f b=%.3f R2=%.3f med abs err=%d p90=%d; med rel err (out>200)=%.2f'%(len(main),coef[0],coef[1],R2,q(err,.5),q(err,.9),q(rel,.5)))
print('main actual out med/p90',q([r[0] for r in main],.5),q([r[0] for r in main],.9),' | subagent logged out med',q([r[0] for r in sub],.5),' recovered med/p90',round(q([r[1] for r in sub],.5)),round(q([r[1] for r in sub],.9)))
vis=[r[1]/max(1,r[2]/2.2) for r in sub if r[2]>400]; print('subagent recovered/visible-chars-estimate med',round(q(vis,.5),2))
