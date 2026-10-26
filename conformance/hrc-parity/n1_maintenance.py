"""Runtime maintenance compares: complete wire and durable effects, with live safety."""
import datetime
import json
import re
from pathlib import Path

CASES = ('prune-dry','prune-no-confirm','prune-ready-refusal','prune-apply','prune-repeat','sweep-dry','sweep-busy-refusal','sweep-live-refusal','sweep-apply','prune-swept','sweep-no-matches','prune-duration-invalid','sweep-duration-invalid','prune-status-invalid','sweep-status-invalid','prune-transport-invalid','sweep-bool-invalid','prune-empty-manifest','prune-unpaired-manifest','prune-live-safety','prune-wrong-shape','sweep-wrong-shape','prune-duplicate-manifest','prune-unallowlisted-manifest','prune-filtered-manifest','prune-missing-disposition-reason','prune-no-held-evidence-disposition')


def stamp(value):
    if not isinstance(value,str) or not re.fullmatch(r'\d{4}-\d\d-\d\dT.*Z',value):return None
    try:return datetime.datetime.fromisoformat(value.replace('Z','+00:00')).timestamp()
    except ValueError:return None


def compare(args,checks):
    subjects={}
    def check(id,ok,reason):checks.append({'id':id,'pass':bool(ok),'reason':reason,'failureCode':1})
    for kind,directory in [('bun',args.baseline),('native',args.candidate)]:
        values=json.loads((Path(directory)/'observations.json').read_text())
        names=[r['case'] for r in values]
        check(kind+':required',names==list(CASES),'all ordered dry/destructive, live-safety, and error cases must exist exactly once')
        known_times={};seqs={};first=values[0]['initial'] if values else {}
        def walk(v):
            if isinstance(v,dict):
                for k,item in v.items():
                    if k.endswith('_json') and isinstance(item,str):
                        yield from walk(json.loads(item))
                    else:yield from walk(item)
            elif isinstance(v,list):
                for item in v:yield from walk(item)
            elif stamp(v) is not None:yield v
        for at in walk(first):known_times[at]=at
        for ev in first.get('events',[]):
            seqs[ev['hrc_seq']]=ev['hrc_seq']
        last_seq=max(seqs,default=0)
        normalized={}
        for row in values:
            name=row['case'];initial=row.get('initial',{});durable=row.get('durable',{})
            body=row['body'] if isinstance(row['body'],dict) else {}
            check(kind+':'+name+':capture',bool(initial) and bool(durable),'both snapshots must be captured')
            # Novel timestamps must come from this request; later snapshots may
            # reuse only previously validated clocks. No global time stripping.
            for at in set(walk(durable))-set(known_times):
                check(kind+':'+name+':clock:'+at,row['before']-.01<=stamp(at)<=row['after']+.01,'every new durable clock must be bounded by this request')
                known_times[at]='request:'+name
            for ev in durable.get('events',[]):
                seq=ev['hrc_seq']
                if seq not in seqs:
                    check(kind+':'+name+':sequence:'+str(seq),isinstance(seq,int) and seq>last_seq and ev['stream_seq']==seq,'new lifecycle rows must advance both canonical sequence cursors')
                    seqs[seq]='event:'+str(len(seqs));last_seq=seq
            def norm(v,key=''):
                if isinstance(v,str):
                    if key.endswith('_json'):return norm(json.loads(v))
                    return known_times.get(v,v)
                if isinstance(v,list):return [norm(x) for x in v]
                if isinstance(v,dict):return {k:(seqs.get(x,x) if k in ('hrc_seq','stream_seq') else norm(x,k)) for k,x in v.items()}
                return v
            readonly = row['status']>=400 or name in ('prune-dry','prune-no-confirm','prune-ready-refusal','prune-repeat','sweep-dry','sweep-busy-refusal','sweep-live-refusal','prune-live-safety','prune-wrong-shape')
            if readonly:check(kind+':'+name+':no-write',initial==durable,'dry, refused, repeated, and parser-error requests cannot change captured rows/events')
            check(kind+':'+name+':live-guard',initial.get('liveGuard')==durable.get('liveGuard') and bool(durable.get('liveGuard')),'the real completed seat must survive every request unchanged')
            if name=='prune-apply':
                target=next((r['runtimeId'] for r in body.get('results',[]) if r['runtimeId'].endswith('-gc-prune')),None)
                check(kind+':cascade:positive',target and any(r['runtime_id']==target for r in initial.get('runtime_buffers',[])) and any(r['runtime_id']==target for r in initial.get('surface_bindings',[])),'destructive prune must begin with real row satellites')
                check(kind+':cascade:removed',target and all(not any(r.get('runtime_id')==target for r in durable.get(t,[])) for t in ('runtimes','runs','runtime_buffers','surface_bindings')),'destructive prune removes runtime/run/buffer/surface in dependency order')
            if name=='sweep-apply':
                target=next((r for r in durable.get('runtimes',[]) if r['runtime_id'].endswith('-gc-sweep')),None)
                if target:
                    state=json.loads(target['runtime_state_json'] or '{}');events=[e for e in durable['events'] if e['runtime_id']==target['runtime_id'] and e['event_kind']=='runtime.stale']
                    check(kind+':aging:clock',target['status']=='stale' and state.get('updatedAt')==target['updated_at'] and len(events)==1 and events[0]['ts']==target['updated_at'],'stale runtime state and lifecycle fact share the mutation clock')
                check(kind+':aging:positive',target is not None and any(s.get('continuation_reuse_disabled')==1 for s in durable.get('sessions',[])),'apply must age the orphan and disable continuation reuse')
                check(kind+':aging:events',[e['event_kind'] for e in durable.get('events',[]) if e not in initial.get('events',[])]==['runtime.stale','runtime.sweep_completed'],'apply emits one stale fact then one summary')
            if name=='sweep-no-matches':
                new=[e for e in durable.get('events',[]) if e not in initial.get('events',[])]
                check(kind+':empty-summary',body.get('summary',{}).get('matched')==0 and len(new)==1 and new[0]['host_session_id']=='hrc-sweep-summary' and new[0]['event_kind']=='runtime.sweep_completed','even empty apply appends a summary under the canonical system session')
            normalized[name]=norm({k:row[k] for k in ('method','path','request','status','body','headers','initial','durable')})
        subjects[kind]=normalized
    cases=[]
    for name in CASES:
        ok=name in subjects['bun'] and name in subjects['native'] and subjects['bun'][name]==subjects['native'][name]
        check('compare:'+name,ok,'complete HTTP request/status/body/headers and all captured durable rows must agree after validated clocks and sequence identities')
        cases.append({'id':name,'pass':ok})
    return {'suite':'n1-maintenance','cases':cases,'behaviorQualified':all(c['pass'] for c in checks)}
