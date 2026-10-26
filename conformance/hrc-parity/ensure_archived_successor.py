"""Require actual successor effects as well as full response/key-order parity."""
import datetime
import json
from pathlib import Path
import uuid


def compare(args, checks):
    subjects = {}
    expected_cases = ['persist','repeat','inherit','inherit-repeat']
    for kind, directory in [('bun',args.baseline),('native',args.candidate)]:
        rows = json.loads((Path(directory)/'observations.json').read_text())
        def check(name, passed):
            checks.append({'id':kind+':'+name,'pass':bool(passed),
                           'reason':'archived ensure must mint once with exact continuation, intent and creation fact', 'failureCode':1})
        check('cases', [r['case'] for r in rows] == expected_cases)
        aliases = {}
        stamps = {}
        for row in rows:
            lane = row['request']['sessionRef'].rsplit(':',1)[1]
            sessions = [s for s in row['sessions'] if s['lane_ref']==lane]
            priors = [s for s in sessions if s['generation']==1]
            successors = [s for s in sessions if s['generation']==2]
            check(row['case']+':status',row['response']['status']==200)
            check(row['case']+':successor',len(priors)==len(successors)==1 and len(sessions)==2)
            if len(priors)!=1 or len(successors)!=1: continue
            prior, successor = priors[0],successors[0]
            host = successor['host_session_id']
            check(row['case']+':uuid',uuid.UUID(host.removeprefix('hsid-')).version==4)
            check(row['case']+':lineage',prior['status']=='archived' and successor['status']=='active' and successor['prior_host_session_id']==prior['host_session_id'])
            check(row['case']+':continuation',json.loads(successor['continuation_json'])==json.loads(prior['continuation_json'])=={'provider':'claude','key':'ensure-scratch-key'})
            check(row['case']+':intent',json.loads(successor['last_applied_intent_json'])=={'probe':'replacement' if lane=='main' else 'inherited'})
            check(row['case']+':continuity',any(c['lane_ref']==lane and c['active_host_session_id']==host for c in row['continuities']))
            events = [e for e in row['events'] if e['host_session_id']==host]
            check(row['case']+':event',len(events)==1 and events[0]['generation']==2 and json.loads(events[0]['payload_json'])=={'created':True,'summon':True,'priorHostSessionId':prior['host_session_id'],'reason':'successor-from-continuation'})
            check(row['case']+':view',row['response']['body'].get('activeHostSessionId')==host and row['response']['body'].get('state')=='summoned')
            if host not in aliases:
                aliases[host]='successor:'+lane
                for s in (prior,successor):
                    for key in ('created_at','updated_at'):
                        value=s[key]
                        if s is successor or key=='updated_at':
                            at=datetime.datetime.fromisoformat(value.replace('Z','+00:00')).timestamp()
                            check(row['case']+':time:'+key,row['before']-.01<=at<=row['after']+.01)
                            stamps[value]='mint-time:'+lane
        def normalize(value):
            if isinstance(value,dict):return {k:normalize(v) for k,v in value.items()}
            if isinstance(value,list):return [normalize(v) for v in value]
            if isinstance(value,str):
                if value in aliases:return aliases[value]
                if value in stamps:return stamps[value]
                if value.startswith('{'):
                    try:return normalize(json.loads(value))
                    except json.JSONDecodeError:pass
            return value
        subjects[kind]=[{k:normalize(v) for k,v in r.items() if k not in ('before','after')} for r in rows]
    def key_order(value):
        if isinstance(value,dict):return [(k,key_order(v)) for k,v in value.items()]
        if isinstance(value,list):return [key_order(v) for v in value]
        return None
    cases=[]
    for a,b in zip(subjects['bun'],subjects['native']):
        passed=a==b and key_order(a['response']['body'])==key_order(b['response']['body'])
        case={'id':a['case'],'pass':passed};cases.append(case)
        checks.append({**case,'reason':'full wire values/key order and durable session/continuity/event effects must agree','failureCode':1})
    return {'suite':'ensure-archived-successor','cases':cases,'behaviorQualified':len(cases)==4 and all(c['pass'] for c in checks)}
