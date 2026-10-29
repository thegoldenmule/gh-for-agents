"""Per (context, PR) sum of all ci-wait/ci-status units: fair polling cost. powerhouse gh-pre vs ghx-post."""
import collections,units
U=[u for u in units.load() if u['stratum']=='use' and 'powerhouse-powerhouse' in u['project'] and set(u['intents'])&{'ci-wait','ci-status'} and len(u['prs'])==1 and u['arm'] in('gh-pre','ghx-post')]
g=collections.defaultdict(list)
for u in U: g[(u['file'],u['prs'][0],u['arm'])].append(u)
def q(xs,p): xs=sorted(xs); return xs[int(round(p*(len(xs)-1)))]
rows=collections.defaultdict(list)
for (f,pr,arm),us in g.items():
    rows[(arm,'sub' if us[0]['sidechain'] else 'main')].append({m:sum(u[m] for u in us) for m in('gh_round_trips','span_calls','cache_rewrites','cost','cost_norm','res_tok_est')}|{'units':len(us)})
print('arm       ctx  n | med units round_trips span_calls rewrites cost cost_norm res_tok | p90 cost_norm')
for k in sorted(rows):
    s=rows[k]; m=lambda x,p=.5: q([r[x] for r in s],p)
    print(f"{k[0]:9s} {k[1]:4s} {len(s):3d} | {m('units')} {m('gh_round_trips')} {m('span_calls')} {m('cache_rewrites')} ${m('cost'):.3f} ${m('cost_norm'):.3f} {round(m('res_tok_est'))} | ${m('cost_norm',.9):.3f}")
