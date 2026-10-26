"""Native attach and surface fences, retaining SQL/event effects in comparison."""
import datetime
import json
from pathlib import Path

CASES=('attach','attach-trimmed','attach-missing','attach-unknown','attach-sdk','bind','bind-repeat','bind-tty-displaced','bind-rebound','bind-missing','bind-unknown','bind-stale-host','bind-stale-generation','bind-negative-generation','bind-null-tty','bind-dead-runtime')


def compare(args,checks):
    subjects={}
    for kind,directory in [('bun',args.baseline),('native',args.candidate)]:
        rows=json.loads((Path(directory)/'observations.json').read_text())
        by_name={row['case']:row for row in rows}
        def check(name,valid,reason):checks.append({'id':kind+':'+name,'pass':bool(valid),'reason':reason,'failureCode':1})
        check('required',len(rows)==len(by_name) and set(by_name)==set(CASES),'all attach and binding cases must be present exactly once')
        initial={(r['surface_kind'],r['surface_id']):dict(r) for r in rows[0]['surfaceRows']} if rows else {}
        event_origins={};field_origins={};previous_events=[]
        for row in rows:
            raw_events=row['surfaceEvents'];raw_rows=row['surfaceRows']
            seqs=[e['hrc_seq'] for e in raw_events]
            check(row['case']+':event-order',all(isinstance(s,int) and s>0 for s in seqs) and seqs==sorted(set(seqs)) and seqs[:len(previous_events)]==previous_events,'committed event order must be monotone and retain the prior prefix')
            previous_events=seqs
            for event in raw_events:
                seq=event['hrc_seq'];payload=event['payload']
                if seq not in event_origins:
                    at=datetime.datetime.fromisoformat(event['ts'].replace('Z','+00:00')).timestamp()
                    valid=row['before']-.01<=at<=row['after']+.01
                    check(row['case']+':new-event-time',valid,'new surface events must be committed during the request')
                    event_origins[seq]=row['case']
                    key='unboundAt' if event['event_kind']=='surface.unbound' else 'boundAt'
                    check(row['case']+':payload-time',payload.get(key)==event['ts'],'event and binding payload must use the same instant')
                    field='unbound_at' if key=='unboundAt' else 'bound_at'
                    field_origins[(payload['surfaceKind'],payload['surfaceId'],field)]=row['case']
                origin=event_origins[seq]
                for key in ('boundAt','unboundAt'):
                    if key in payload:payload[key]='request-time:'+origin
                event['ts']='request-time:'+origin
                event['hrc_seq']='surface-event-'+str(seqs.index(seq))
            body=row['body']
            if row['status']==200 and row['case'].startswith('bind'):
                stored=next((r for r in raw_rows if r['surface_kind']==body.get('surfaceKind') and r['surface_id']==body.get('surfaceId')),None)
                check(row['case']+':committed-response',stored is not None and stored['bound_at']==body.get('boundAt'),'successful bind must return its actual committed row instant')
                if stored is not None:
                    origin=field_origins.get((stored['surface_kind'],stored['surface_id'],'bound_at'))
                    body['boundAt']='request-time:'+str(origin)
            for stored in raw_rows:
                for field in ('bound_at','unbound_at'):
                    if stored[field] is not None:
                        origin=field_origins.get((stored['surface_kind'],stored['surface_id'],field))
                        if origin is None and initial.get((stored['surface_kind'],stored['surface_id']),{}).get(field)==stored[field]:continue
                        check(row['case']+':row-time-origin',origin is not None,'every stored instant must come from an observed binding event')
                        stored[field]='request-time:'+str(origin)
        if set(CASES)<=set(by_name):
            attached=by_name['attach']['body'];first=by_name['bind'];repeat=by_name['bind-repeat'];displaced=by_name['bind-tty-displaced'];rebound=by_name['bind-rebound']
            check('actual-attach',isinstance(attached,dict) and attached.get('transport')=='tmux' and len(attached.get('argv',[]))==6 and attached.get('bindingFence',{}).get('paneId')=='%1','attach must name the realized tmux target and fence')
            check('idempotency',first['status']==repeat['status']==200 and first['body']==repeat['body'] and len(first['surfaceEvents'])==len(repeat['surfaceEvents'])==1,'retry must retain row and emit no second event')
            active=[r for r in displaced['surfaceRows'] if r['surface_kind']=='ghostty' and r['client_tty']=='/dev/n1-t11818-a' and r['unbound_at'] is None]
            check('tty-displacement',len(active)==1 and active[0]['surface_id']=='n1-surface-b' and len(displaced['surfaceEvents'])==3 and any(r['reason']=='client_tty_rebound' for r in displaced['surfaceRows']),'one tty authorizes exactly its newest surface with retirement recorded')
            check('rebound',len(rebound['surfaceEvents'])==4 and rebound['surfaceEvents'][-1]['event_kind']=='surface.rebound' and rebound['surfaceEvents'][-1]['payload'].get('previousClientTty')=='/dev/n1-t11818-a','rebound retains the displaced prior fence')
        subjects[kind]=by_name
    cases=[]
    for name in CASES:
        a,b=subjects['bun'].get(name),subjects['native'].get(name)
        passed=a is not None and b is not None and all(a[k]==b[k] for k in ('method','path','request','status','body','headers','surfaceRows','surfaceEvents'))
        checks.append({'id':name,'pass':passed,'reason':'wire, bindings and full surface event payloads must agree','failureCode':1});cases.append({'id':name,'pass':passed})
    return {'suite':'n1-surfaces','cases':cases,'behaviorQualified':all(c['pass'] for c in checks)}
