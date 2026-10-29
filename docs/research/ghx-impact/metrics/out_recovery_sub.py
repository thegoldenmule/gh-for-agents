"""Validate recovery on subagent calls that DO have final usage (stop_reason set)."""
import json,os,sys
sys.path.insert(0,'.'); from tx import parse, recover_out
inv=json.load(open('inventory.json')); root=os.path.expanduser('~/.claude/projects/')
def q(xs,p): xs=sorted(xs); return xs[int(round(p*(len(xs)-1)))]
rows=[]; src={}
for o in inv:
    if not(o['gh'] or o['ghx']) or 'subagents' not in o['f']: continue
    calls,_,_=parse(root+o['f'])
    for c in calls: src[c['out_src']]=src.get(c['out_src'],0)+1
    for c,nx in zip(calls,calls[1:]):
        if c['stop'] is None or not c['tool_uses']: continue
        r=recover_out(c,nx)
        if r is not None: rows.append((c['out_logged'],r))
err=[abs(a-b) for a,b in rows]; rel=[abs(a-b)/a for a,b in rows if a>200]
print('subagent final-usage calls n=%d med abs err=%d p90=%d med rel err(out>200)=%.2f; sum recovered/sum actual=%.2f'%(len(rows),q(err,.5),q(err,.9),q(rel,.5),sum(b for a,b in rows)/sum(a for a,b in rows)))
print('out_src counts (subagents):',src)
