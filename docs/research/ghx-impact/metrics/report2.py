"""gh-pre vs ghx-post within powerhouse, per category x sidechain; medians + bootstrap 95% CI (seed 42, B=1000)."""
import json,random,collections,units
U=[u for u in units.load() if u['stratum']=='use' and 'powerhouse-powerhouse' in u['project']]
def q(xs,p):
    xs=sorted(xs); return xs[int(round(p*(len(xs)-1)))] if xs else None
def boot(xs,B=1000,seed=42):
    if len(xs)<5: return (None,None)
    r=random.Random(seed); ms=sorted(q([r.choice(xs) for _ in xs],.5) for _ in range(B)); return ms[25],ms[974]
f=lambda v: '-' if v is None else ('%.3f'%v if isinstance(v,float) and v<10 else str(round(v)))
print('== confounders (powerhouse units)')
for arm in ('gh-pre','ghx-post','gh-post'):
    s=[u for u in U if u['arm']==arm]
    if s: print(arm,len(s),'sidechain=%.2f'%(sum(u['sidechain'] for u in s)/len(s)),dict(collections.Counter(u['model'] for u in s)),dict(collections.Counter(u['effort'] for u in s)),dict(collections.Counter(u['version'] for u in s).most_common(3)),min(u['start'] for u in s)[:10],max(u['start'] for u in s)[:10])
M=['gh_round_trips','span_calls','gh_invocations','out_tok','res_tok_est','cmd_chars','cost_norm','cost','carry_cost_h50','wall_s']
R=['errors','refusals','pipes','jq','cache_rewrites','sleep_loops']
for cat in ['ci-diagnose','ci-wait','ci-status','pr-read','pr-write','merge','ci-rerun']:
  for side in (False,True):
    a=[u for u in U if u['category']==cat and u['sidechain']==side and u['arm']=='gh-pre']
    b=[u for u in U if u['category']==cat and u['sidechain']==side and u['arm']=='ghx-post']
    if len(a)<5 or len(b)<5: continue
    print(f'\n== {cat} {"subagent" if side else "main"}  n gh-pre={len(a)} ghx-post={len(b)}   median [95% CI] p90')
    for m in M:
        xa=[u[m] or 0 for u in a]; xb=[u[m] or 0 for u in b]; ca=boot(xa); cb=boot(xb)
        print(f'  {m:15s} gh {f(q(xa,.5))} [{f(ca[0])},{f(ca[1])}] p90 {f(q(xa,.9))} | ghx {f(q(xb,.5))} [{f(cb[0])},{f(cb[1])}] p90 {f(q(xb,.9))}')
    for m in R:
        xa=[u[m] or 0 for u in a]; xb=[u[m] or 0 for u in b]
        print(f'  {m:15s} gh mean {sum(xa)/len(xa):.2f} any {sum(1 for x in xa if x)/len(xa):.2f} | ghx mean {sum(xb)/len(xb):.2f} any {sum(1 for x in xb if x)/len(xb):.2f}')
