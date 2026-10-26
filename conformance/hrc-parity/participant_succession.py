"""Full response, key-order and durable-graph parity for direct succession."""
import datetime
import json
import re
from pathlib import Path

UUID = re.compile(r'[a-z][a-z-]*-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}')
CLOCK = re.compile(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z')


def compare(args, checks):
    subjects = {}
    for kind, directory in [('bun', args.baseline), ('native', args.candidate)]:
        rows = json.loads((Path(directory)/'observations.json').read_text())
        aliases = {}
        def check(name, passed, reason):
            checks.append({'id':kind+':'+name, 'pass':bool(passed), 'reason':reason, 'failureCode':1})
        # Anchor generated identities to their canonical row/column, not their
        # textual occurrence (receipt copies must retain the same identity).
        for row in rows:
            for table, values in row['durable'].items():
                if table == 'events': continue
                for index, value in enumerate(values):
                    for key in ('reservation_id','registration_id','binding_id','host_session_id','attempt_id','request_id','operation_id','invocation_id','runtime_id'):
                        v = value.get(key)
                        if isinstance(v,str) and UUID.fullmatch(v) and v not in aliases:
                            aliases[v] = f'{table}:{key}:{index}:{len(aliases)}'
        def normalize(value):
            if isinstance(value, dict): return {k:normalize(v) for k,v in value.items()}
            if isinstance(value, list): return [normalize(v) for v in value]
            if isinstance(value, str):
                if value.startswith(('{','[')):
                    try: return normalize(json.loads(value))
                    except json.JSONDecodeError: pass
                value = UUID.sub(lambda m:aliases.setdefault(m[0],f'intent:{len(aliases)}'),value)
                value = CLOCK.sub('<clock>',value)
            return value
        for row in rows:
            success = row['case'].startswith(('foundry-continue','foundry-fresh'))
            check(row['case']+':status',row['status']==(200 if success else 409), 'replacement succeeds only with the exact predecessor')
            if success:
                body=row['body']; d=row['durable']
                check(row['case']+':registered',isinstance(body,dict) and body.get('status')=='registered','typed join result')
                check(row['case']+':cardinality',len(d['sessions'])==2 and len(d['participant_registration_attempts'])==2 and len(d['participant_registrations'])==1,'one successor, including on retry')
                check(row['case']+':lineage',d['sessions'][0]['status']=='archived' and d['sessions'][1]['prior_host_session_id']==d['sessions'][0]['host_session_id'],'session lineage survives retirement')
                check(row['case']+':retirement',d['participant_host_bindings'][0]['state']=='RETIRED' and d['participant_registration_attempts'][0]['recovery_disposition']=='abandoned','predecessor is durably retired before successor')
            else:
                check(row['case']+':no-allocation',len(row['durable']['participant_registration_attempts'])==1,'failed fences never allocate')
        subjects[kind]=[{k:normalize(v) for k,v in r.items() if k not in ('before','after','seed')} for r in rows]
    def order(value):
        if isinstance(value,dict):return [(k,order(v)) for k,v in value.items()]
        if isinstance(value,list):return [order(v) for v in value]
        return None
    cases=[]
    for a,b in zip(subjects['bun'],subjects['native']):
        passed=a==b and order(a['body'])==order(b['body'])
        cases.append({'id':a['case'],'pass':passed})
        checks.append({'id':'compare:'+a['case'],'pass':passed,'reason':'full response/key order and durable rows must match','failureCode':1})
        if not passed:
            (Path(args.out)/(a['case']+'-diff.json')).write_text(json.dumps({'bun':a,'native':b},indent=2)+'\n')
    return {'suite':'participant-succession','cases':cases,'behaviorQualified':len(cases)>=8 and all(c['pass'] for c in checks)}
