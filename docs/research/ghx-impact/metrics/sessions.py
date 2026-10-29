"""Session-level rollup (main file + its subagents): human turns, API calls, cost, share of cost in GitHub episodes."""
import json,os,glob,collections,sys
sys.path.insert(0,'.'); from tx import parse; from pricing import cost
root=os.path.expanduser('~/.claude/projects/')
E=[json.loads(l) for l in open('episodes.jsonl')]
byS=collections.defaultdict(list)
for e in E: byS[e['session']].append(e)
rows=[]
for s,es in byS.items():
    if es[0]['stratum']!='use': continue
    files=[root+s+'.jsonl']+glob.glob(root+s+'/subagents/**/*.jsonl',recursive=True)
    calls=0; c=0.0; human=0
    for f in files:
        if not os.path.exists(f): continue
        cs,_,_=parse(f); calls+=len(cs); c+=sum(cost(x['model'],x['usage']) for x in cs)
        if '/subagents/' not in f: human+=sum(1 for l in open(f,errors='replace') if '"origin":{"kind":"human"}' in l)
    arms=collections.Counter(e['tool'] for e in es)
    arm='ghx' if arms['ghx'] and not arms['gh'] else 'gh' if arms['gh'] and not arms['ghx'] else 'mixed'
    rows.append(dict(session=s,arm=arm,files=len(files),human=human,api_calls=calls,cost=c,gh_eps=len(es),gh_cost=sum(e['cost'] for e in es),gh_calls=sum(e['span_calls'] for e in es)))
json.dump(rows,open('sessions.json','w'))
def q(xs,p): xs=sorted(xs); return xs[int(round(p*(len(xs)-1)))]
for arm in('gh','ghx','mixed'):
    r=[x for x in rows if x['arm']==arm]
    if not r: continue
    print(arm,'n=%d'%len(r),'med human=%d api_calls=%d cost=$%.1f gh_eps=%d gh_share_of_calls=%.3f gh_share_of_cost=%.3f'%(q([x['human'] for x in r],.5),q([x['api_calls'] for x in r],.5),q([x['cost'] for x in r],.5),q([x['gh_eps'] for x in r],.5),q([x['gh_calls']/max(1,x['api_calls']) for x in r],.5),q([x['gh_cost']/max(1e-9,x['cost']) for x in r],.5)))
