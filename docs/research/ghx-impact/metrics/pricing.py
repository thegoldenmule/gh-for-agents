# USD per MTok: input, output, cache_read; cache write = input*1.25 (5m) or *2 (1h).  Source: claude-api skill (cached 2026-06-24) + validated vs cost-state records.
P={'claude-opus-5-5[1m]':(4,20,0.20),'claude-opus-5-5':(4,20,0.20),'claude-opus-5':(5,25,0.50),'claude-sonnet-5':(2,10,0.20),'claude-fable-5-1':(10,50,0.25),'claude-fable-5':(10,50,1.0),'claude-haiku-4-5-20251001':(1,5,0.10),'claude-haiku-4-5':(1,5,0.10)}
def _cost(model,u):
    p=P.get(model)
    if not p: return None
    i,o,cr=p; cc=u.get('cache_creation') or {}
    c5=cc.get('ephemeral_5m_input_tokens'); c1=cc.get('ephemeral_1h_input_tokens')
    if c5 is None and c1 is None: c5=u.get('cache_creation_input_tokens') or 0; c1=0
    return ((u.get('input_tokens') or 0)*i+(u.get('output_tokens') or 0)*o+(u.get('cache_read_input_tokens') or 0)*cr+(c5 or 0)*i*1.25+(c1 or 0)*i*2)/1e6

def cost(model,u):
    """Executor usage (top-level = sum of 'message' iterations) + advisor iterations priced at their own model."""
    c=_cost(model,u) or 0.0
    for it in u.get('iterations') or []:
        if it.get('type')=='advisor_message': c+=_cost(it.get('model'),it) or 0.0
    return c
def last_ctx(u):
    its=[i for i in (u.get('iterations') or []) if i.get('type')=='message']
    x=its[-1] if its else u
    return (x.get('input_tokens') or 0)+(x.get('cache_creation_input_tokens') or 0)+(x.get('cache_read_input_tokens') or 0)

def input_cost(model,u):
    """Cost of the input side only (uncached + cache write + cache read) for this call."""
    p=P.get(model)
    if not p: return 0.0
    return (_cost(model,u) or 0)-(u.get('output_tokens') or 0)*p[1]/1e6
