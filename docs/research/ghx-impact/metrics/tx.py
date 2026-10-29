"""Transcript parser: one Claude Code *.jsonl -> API calls (deduped by message.id) + tool calls."""
import json,re
RX_GHX=re.compile(r'(^|[\s;&|(`])ghx\s')
RX_GH=re.compile(r'(^|[\s;&|(`]|\$\()gh\s+[a-z]')
def classify(cmd):
    if RX_GHX.search(cmd): return 'ghx'
    if RX_GH.search(cmd): return 'gh'
    return None
def result_text(c):
    x=c.get('content')
    if isinstance(x,str): return x
    if isinstance(x,list):
        return ''.join(b.get('text','') if isinstance(b,dict) and b.get('type')=='text' else (json.dumps(b) if isinstance(b,dict) and b.get('type')!='image' else '') for b in x)
    return ''
def ctx(u): return (u.get('input_tokens') or 0)+(u.get('cache_creation_input_tokens') or 0)+(u.get('cache_read_input_tokens') or 0)
def parse(path):
    calls=[]; byid={}; tools={}; seq=0; events=[]
    for line in open(path,errors='replace'):
        try: r=json.loads(line)
        except: continue
        t=r.get('type'); seq+=1
        if t=='assistant':
            m=r.get('message') or {}; mid=m.get('id') or r.get('uuid')
            if m.get('model')=='<synthetic>': continue
            if mid not in byid:
                c=dict(id=mid,seq=seq,ts=r.get('timestamp'),model=m.get('model'),usage=m.get('usage') or {},tool_uses=[],out_chars=0,stop=m.get('stop_reason'),idx=len(calls),sidechain=r.get('isSidechain'),effort=r.get('effort'),version=r.get('version'))
                byid[mid]=c; calls.append(c); events.append(('call',c))
            c=byid[mid]; c['usage']=m.get('usage') or c['usage']; c['stop']=m.get('stop_reason') or c['stop']; c['last_ts']=r.get('timestamp')
            for b in m.get('content') or []:
                if not isinstance(b,dict): continue
                if b.get('type')=='tool_use':
                    inp=b.get('input') or {}
                    tu=dict(id=b['id'],name=b.get('name'),input=inp,call=c['idx'],ts=r.get('timestamp'),
                            cmd=inp.get('command') if b.get('name')=='Bash' else None,
                            bg=bool(inp.get('run_in_background')),in_chars=len(json.dumps(inp)))
                    tu['kind']=classify(tu['cmd'] or '') if tu['cmd'] else None
                    c['tool_uses'].append(tu); tools[b['id']]=tu
                elif b.get('type')=='text': c['out_chars']+=len(b.get('text',''))
        elif t=='user':
            m=r.get('message') or {}; cont=m.get('content')
            if isinstance(cont,list):
                hasres=False
                for b in cont:
                    if isinstance(b,dict) and b.get('type')=='tool_result':
                        hasres=True
                        tu=tools.get(b.get('tool_use_id'))
                        if tu is not None:
                            txt=result_text(b); tu['res_chars']=len(txt); tu['res_text']=txt; tu['is_error']=bool(b.get('is_error')); tu['res_ts']=r.get('timestamp'); tu['res_seq']=seq
                            tu['tur']=r.get('toolUseResult') if isinstance(r.get('toolUseResult'),dict) else None
                if not hasres: events.append(('human',r))
            else:
                events.append(('human',r))
        elif t in('system','attachment','queue-operation','cost-state'):
            events.append((t,r))
    # next call after each tool result (first API call whose seq > res_seq)
    seqs=[c['seq'] for c in calls]
    import bisect
    for tu in tools.values():
        if 'res_seq' in tu:
            i=bisect.bisect_right(seqs,tu['res_seq']); tu['next_call']=i if i<len(calls) else None
    fix_outputs(calls)
    return calls,tools,events
def _ctx_last(u):
    its=[i for i in (u.get('iterations') or []) if i.get('type')=='message']
    x=its[-1] if its else u
    return (x.get('input_tokens') or 0)+(x.get('cache_creation_input_tokens') or 0)+(x.get('cache_read_input_tokens') or 0)
def recover_out(c,nx):
    """Output tokens from the context delta to the next call: delta - tool results(chars/2.2+70). None if not usable."""
    if nx is None or nx['model']!=c['model']: return None
    if any(t.get('next_call')!=c['idx']+1 for t in c['tool_uses']): return None
    d=_ctx_last(nx['usage'])-_ctx_last(c['usage'])
    if d<0: return None
    return d-sum((t.get('res_chars') or 0)/2.2+70 for t in c['tool_uses'])
def fix_outputs(calls):
    """Subagent transcripts store a stream-start usage snapshot (stop_reason None, output_tokens ~1-20).
    Input-side fields are final at stream start; output_tokens is not. Replace it, keep the logged value."""
    for i,c in enumerate(calls):
        u=c['usage']; c['out_logged']=u.get('output_tokens') or 0
        if c['stop'] is not None: c['out_src']='final'; continue
        vis=(c['out_chars']+sum(t['in_chars'] for t in c['tool_uses']))/2.2
        r=recover_out(c,calls[i+1] if i+1<len(calls) else None)
        if r is not None and r>=vis*0.5: est,src=r,'recovered'
        else: est,src=vis,'visible_est'
        u=dict(u); u['output_tokens']=int(max(c['out_logged'],est)); c['usage']=u; c['out_src']=src
