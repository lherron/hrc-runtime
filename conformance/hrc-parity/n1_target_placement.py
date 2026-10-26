"""Target intent/creation effects and ASP placement on the same scratch snapshot."""
import datetime
import json
from pathlib import Path
import uuid

CASES=('placement-scope','placement-explicit','placement-empty','placement-bad-mode','ensure-no-persist','ensure-persist','ensure-repeat','ensure-default','ensure-missing','ensure-missing-intent','ensure-bad-selector','ensure-invalid-scope','ensure-empty-lane','target-invalid-scope','target-empty-lane','ensure-bad-persist','ensure-bad-cause','ensure-fresh','ensure-fresh-repeat','ensure-fresh-no-persist','ensure-task-role','ensure-project-role')


def stamp(value):return datetime.datetime.fromisoformat(value.replace('Z','+00:00')).timestamp()


def compare(args,checks):
    subjects={}
    for kind,directory in [('bun',args.baseline),('native',args.candidate)]:
        rows=json.loads((Path(directory)/'observations.json').read_text());by_name={r['case']:r for r in rows}
        def check(name,ok,reason):checks.append({'id':kind+':'+name,'pass':bool(ok),'reason':reason,'failureCode':1})
        check('required',len(rows)==len(by_name) and set(by_name)==set(CASES),'every target/placement case must be present once')
        initial={r['host_session_id']:dict(r) for r in rows[0]['sessions']} if rows else {}
        initial_events={e['hrc_seq']:dict(e) for e in rows[0]['sessionEvents']} if rows else {}
        hosts={};origins={};last_updated={};created_at={};event_seq={}
        def replace(value):
            if isinstance(value,dict):return {k:replace(v) for k,v in value.items()}
            if isinstance(value,list):return [replace(v) for v in value]
            return hosts.get(value,value) if isinstance(value,str) else value
        for row in rows:
            body=row['body'];session_by_host={s['host_session_id']:s for s in row['sessions']}
            for session in row['sessions']:
                host=session['host_session_id'];new=host not in initial
                if new and host not in hosts:
                    try:valid=uuid.UUID(host.removeprefix('hsid-')).version==4
                    except ValueError:valid=False
                    check(row['case']+':new-id',valid and host.startswith('hsid-'),'new host identity must be an actual UUID')
                    alias='fresh-host:'+session['scope_ref']+'/lane:'+session['lane_ref']
                    check(row['case']+':bijection',alias not in hosts.values(),'new host mapping must remain one-to-one')
                    hosts[host]=alias;origins[host]=row['case'];created_at[host]=session['created_at']
                    matching=[e for e in row['sessionEvents'] if e['host_session_id']==host]
                    expected={'created':True,'summon':True}
                    if 'birthCause' in row['request']:expected['birthCause']=row['request']['birthCause']
                    check(row['case']+':mint-fact',len(matching)==1 and json.loads(matching[0]['payload_json'])==expected,'one exact summon creation fact must accompany the new row')
                    check(row['case']+':mint-address',row['request']['sessionRef']==session['scope_ref']+'/lane:'+session['lane_ref'] and session['status']=='active' and session['generation']==1 and any(c['active_host_session_id']==host and c['scope_ref']==session['scope_ref'] and c['lane_ref']==session['lane_ref'] for c in row['continuities']),'session and continuity must mint the requested address together')
                    check(row['case']+':created-time',row['before']-.01<=stamp(session['created_at'])<=row['after']+.01,'new session creation must fall within the minting request')
                if session['last_applied_intent_json'] is not None:session['last_applied_intent_json']=json.loads(session['last_applied_intent_json'])
                persists=row['case'].startswith('ensure') and row['status']==200 and row['request'].get('persistIntent') is not False and isinstance(body,dict) and body.get('activeHostSessionId')==host
                if persists or new and host not in last_updated:
                    check(row['case']+':updated-time',row['before']-.01<=stamp(session['updated_at'])<=row['after']+.01,'persisted target updates must use the actual request time')
                    last_updated[host]=(session['updated_at'],'request-time:'+row['case'])
                if host in last_updated:
                    raw,normalized=last_updated[host]
                    check(row['case']+':retained-update',session['updated_at']==raw,'reads and persistIntent=false must retain the last update')
                    session['updated_at']=normalized
                if new:
                    check(row['case']+':stable-created',session['created_at']==created_at[host],'creation time must remain immutable')
                    session['created_at']='request-time:'+origins[host]
            for continuity in row['continuities']:
                host=continuity['active_host_session_id']
                if host in hosts:
                    # Its row and session are created by one mint transaction.
                    created=created_at[host]
                    check(row['case']+':continuity-time',continuity['updated_at']==created,'fresh continuity and session must share the mint time')
                    continuity['updated_at']='request-time:'+origins[host]
            for event in row['sessionEvents']:
                event['payload']=json.loads(event.pop('payload_json'))
                host=event['host_session_id']
                if host in hosts:
                    if host not in event_seq:event_seq[host]=event['hrc_seq']
                    check(row['case']+':mint-sequence',isinstance(event['hrc_seq'],int) and event['hrc_seq']>max(initial_events,default=0) and event['hrc_seq']==event_seq[host],'new creation event must retain a positive sequence beyond the snapshot')
                    valid=row['before']-.01<=stamp(event['ts'])<=row['after']+.01 if row['case']==origins[host] else True
                    check(row['case']+':created-event-time',valid,'fresh session event must occur during its mint')
                    event['ts']='request-time:'+origins[host];event['hrc_seq']='created-event:'+hosts[host]
                elif event['hrc_seq'] not in initial_events:
                    check(row['case']+':unexpected-event',False,'intent persistence must not append session.created')
            for key in ('body','sessions','continuities','sessionEvents'):row[key]=replace(row[key])
        if set(CASES)<=set(by_name):
            fresh=by_name['ensure-fresh'];repeat=by_name['ensure-fresh-repeat'];ephemeral=by_name['ensure-fresh-no-persist']
            check('placement-positive',by_name['placement-scope']['status']==200 and by_name['placement-scope']['body'].get('agentRoot','').endswith('/tabularasa') and by_name['placement-scope']['body'].get('projectId')=='n1-t11818','real ASP profile and private project must resolve')
            check('existing-intent',by_name['ensure-persist']['status']==200 and by_name['ensure-persist']['body'].get('lastAppliedIntentJson')=={'n1Probe':'stored'} and by_name['ensure-repeat']['body']==by_name['ensure-persist']['body'],'intent persistence and repeat must agree')
            check('fresh-positive',fresh['status']==repeat['status']==200 and fresh['body'].get('state')=='summoned' and fresh['body'].get('activeHostSessionId')==repeat['body'].get('activeHostSessionId') and 'identity' not in fresh['body'] and repeat['body'].get('identity',{}).get('agentId')=='tabularasa','first mint and reread preserve Bun identity timing')
            check('no-persist-positive',ephemeral['status']==200 and ephemeral['body'].get('state')=='summoned' and 'lastAppliedIntentJson' not in ephemeral['body'],'persistIntent=false must create an address without intent')
            roles=[c for c in by_name['ensure-project-role']['continuities'] if c['role_name'] is not None]
            check('role-identities',{c['scope_kind'] for c in roles}=={'project-role','project-task-role'} and all(c['agent_id']=='tabularasa' and c['project_id']=='n1-t11818' for c in roles),'role identities must retain canonical kind, agent, project, task and role fields')
        subjects[kind]=by_name
    cases=[]
    for name in CASES:
        a,b=subjects['bun'].get(name),subjects['native'].get(name)
        ok=a is not None and b is not None and all(a[k]==b[k] for k in ('method','path','request','status','body','headers','sessions','continuities','sessionEvents'))
        checks.append({'id':name,'pass':ok,'reason':'wire, canonical target/continuity rows and creation facts must agree','failureCode':1});cases.append({'id':name,'pass':ok})
    return {'suite':'n1-target-placement','cases':cases,'behaviorQualified':all(c['pass'] for c in checks)}
