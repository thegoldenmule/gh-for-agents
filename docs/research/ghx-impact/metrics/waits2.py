"""CI waits by mechanism (units incl. notification/read continuations), all non-dogfood repos."""
import collections,units
U=[u for u in units.load() if u['stratum']=='use' and 'ci-wait' in u['intents']]
def mech(u):
    if u['monitor']: return 'monitor'
    if u['bg']: return f"bg-{u['tool']}"
    if u['watch']: return 'fg-watch'
    if u['sleep_loops']: return 'fg-sleep-loop'
    return f"fg-{u['tool']}"
def q(xs,p): xs=sorted(xs); return xs[int(round(p*(len(xs)-1)))]
g=collections.defaultdict(list)
for u in U: g[(mech(u),'sub' if u['sidechain'] else 'main')].append(u)
print('mechanism      ctx   n | med span_calls  rewrites/wait  cost  cost_norm  res_tok  wall_s  notif')
for k in sorted(g):
    s=g[k]
    if len(s)<4: continue
    print(f"{k[0]:14s} {k[1]:4s} {len(s):3d} | {q([u['span_calls'] for u in s],.5):3d} {sum(u['cache_rewrites'] for u in s)/len(s):5.2f} ${q([u['cost'] for u in s],.5):.3f} ${q([u['cost_norm'] for u in s],.5):.3f} {q([u['res_tok_est'] for u in s],.5):6d} {q([u['wall_s'] for u in s],.5):6d} {sum(u['notifications'] for u in s)/len(s):.2f}")
