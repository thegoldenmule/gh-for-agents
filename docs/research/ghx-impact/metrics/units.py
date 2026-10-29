"""Merge episodes that share an originating GH tool_use (launch + notification/read continuations) into task units; add adoption era."""
import json,collections
from episodes import PRIORITY
ADD=['gh_round_trips','span_calls','linked_calls','glue_calls','gh_tool_calls','gh_invocations','errors','refusals','pipes','jq','sleep_loops','watch','bg','monitor',
     'notifications','cmd_chars','write_tok','out_tok','res_chars','res_tok_est','cache_read','cache_write','cost','cost_norm','carry_token_calls','carry_cost','carry_cost_h50',
     'wall_s','blocked_s','cache_rewrites','follow_reads','repeats','retries']
def first_ghx_by_project():
    f={}
    for l in open('gh_calls.jsonl'):
        r=json.loads(l)
        if r['kind']=='ghx' and 'gh-for-agents' not in r['f'].split('/')[0]:
            p=r['f'].split('/')[0]; f[p]=min(f.get(p,r['ts']),r['ts'])
    return f
def load():
    E=[json.loads(l) for l in open('episodes.jsonl')]
    parent=list(range(len(E)))
    def find(i):
        while parent[i]!=i: parent[i]=parent[parent[i]]; i=parent[i]
        return i
    owner={(e['file'],t):i for i,e in enumerate(E) for t in e['emit_ids']}
    for i,e in enumerate(E):  # attach reads/notifications to the episode that emitted their origin tool call
        for oid in set(e['origin_ids'])-set(e['emit_ids']):
            j=owner.get((e['file'],oid))
            if j is not None: parent[find(i)]=find(j)
    groups=collections.defaultdict(list)
    for i in range(len(E)): groups[find(i)].append(E[i])
    fg=first_ghx_by_project(); U=[]
    for es in groups.values():
        es.sort(key=lambda e:e['ep']); u=dict(es[0])
        for m in ADD: u[m]=sum((e.get(m) or 0) for e in es)
        u['episodes']=len(es); u['intents']=sorted({x for e in es for x in e['intents']})
        u['category']=min(u['intents'],key=PRIORITY.index) if u['intents'] else 'other'
        tools={e['tool'] for e in es}-{'none'}
        u['tool']=tools.pop() if len(tools)==1 else 'mixed'
        u['prs']=sorted({p for e in es for p in e['prs']}); u['wait_ids']=sorted({w for e in es for w in e['wait_ids']})
        fx=fg.get(u['project'])
        u['era']=('never' if not fx else 'post' if u['start']>=fx else 'pre')
        u['arm']=f"{u['tool']}-{u['era']}"
        U.append(u)
    return U
if __name__=='__main__':
    U=load(); print(len(U),'units', collections.Counter(u['arm'] for u in U if u['stratum']=='use'))
