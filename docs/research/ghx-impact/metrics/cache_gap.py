"""Cache behaviour vs idle gap between consecutive API calls (main vs subagent; 5m vs 1h TTL)."""
import json,os,sys,collections
from datetime import datetime
sys.path.insert(0,'.'); from tx import parse; from pricing import last_ctx
inv=json.load(open('inventory.json')); root=os.path.expanduser('~/.claude/projects/')
def t(s): return datetime.fromisoformat(s.replace('Z','+00:00')).timestamp()
b=collections.defaultdict(list); ttl=collections.Counter()
for o in inv:
    if not(o['gh'] or o['ghx']): continue
    calls,_,_=parse(root+o['f']); sub='subagents' in o['f']
    for p,c in zip(calls,calls[1:]):
        if not p.get('last_ts') or not c['ts']: continue
        gap=t(c['ts'])-t(p['last_ts']); u=c['usage']; cc=u.get('cache_creation') or {}
        ttl[(sub,'1h' if cc.get('ephemeral_1h_input_tokens') else ('5m' if cc.get('ephemeral_5m_input_tokens') else '-'))]+=1
        ctx=last_ctx(u)
        if ctx<5000: continue
        bucket='<1m' if gap<60 else '1-5m' if gap<300 else '5-60m' if gap<3600 else '>1h'
        b[(sub,bucket)].append((u.get('cache_creation_input_tokens') or 0)/ctx)
print(ttl)
for k in sorted(b):
    xs=sorted(b[k]); n=len(xs); print(k,n,'median cache_write/ctx=%.3f'%xs[n//2],'share>50%%=%.2f'%(sum(1 for x in xs if x>.5)/n))
