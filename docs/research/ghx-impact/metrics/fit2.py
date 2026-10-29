import json,statistics as st
from lsq import ols
rows=[r for r in json.load(open('delta_rows.json')) if r['d']>=0]
def q(xs,p): xs=sorted(xs); return xs[int(p*(len(xs)-1))]
# per-row implied chars/token for results > 2000 chars, taking residual after out + fixed overhead 150
for name,sub in [('Bash',[r for r in rows if r['name']=='Bash']),('gh',[r for r in rows if r['kind']=='gh']),('ghx',[r for r in rows if r['kind']=='ghx']),('Read',[r for r in rows if r['name']=='Read'])]:
    big=[r for r in sub if 2000<r['res']<30000]
    rat=[r['res']/max(1,r['d']-r['out']) for r in big]
    if rat: print(f"{name:5s} n_big={len(big)} implied chars/tok p10={q(rat,.1):.2f} p50={q(rat,.5):.2f} p90={q(rat,.9):.2f}")
    small=[r for r in sub if r['res']<200]
    if small: 
        ov=[r['d']-r['out'] for r in small]; print(f"      overhead (res<200 chars) n={len(small)} p10={q(ov,.1)} p50={q(ov,.5)} p90={q(ov,.9)}")
    clean=[r for r in sub if r['res']<30000]
    coef,R2,mae,res=ols([[r['out'],r['res']] for r in clean],[r['d'] for r in clean])
    print(f"      clean(<30k) n={len(clean)} a={coef[0]:.0f} b_out={coef[1]:.3f} chars/tok={1/coef[2]:.2f} R2={R2:.3f} medAbsErr={mae:.0f} p90AbsErr={q([abs(x) for x in res],.9):.0f}")
# biggest residual outliers
coef,R2,mae,res=ols([[r['out'],r['res']] for r in rows],[r['d'] for r in rows])
o=sorted(zip(res,rows),key=lambda t:-abs(t[0]))[:8]
for e,r in o: print(int(e),r['name'],r['kind'],r['d'],r['out'],r['res'],r['gap'],r['f'][-60:])
