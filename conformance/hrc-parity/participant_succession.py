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
        seen_clocks=set()
        def clocks(value):
            if isinstance(value,dict): return set().union(*(clocks(v) for v in value.values())) if value else set()
            if isinstance(value,list): return set().union(*(clocks(v) for v in value)) if value else set()
            return set(CLOCK.findall(value)) if isinstance(value,str) else set()
        expected_names=['foundry-continue','foundry-fresh','wrong-predecessor','missing-predecessor']
        check('required-cases',all(n in [r['case'] for r in rows] for n in expected_names),'core outage cases cannot be absent')
        for row in rows:
            name=row['case'].removesuffix('-retry')
            refused=name in ('wrong-predecessor','missing-predecessor') or row['case']=='declaration-mismatch-retry'
            pending=name in ('no-durable-endpoint','retired-only')
            own=name=='pre-attach-own'
            bridge=name in ('bridge','legacy-arris')
            success=not refused and not pending
            d=row['durable']; body=row['body']
            check(row['case']+':status',row['status']==(409 if refused else 200),'typed HTTP status follows the replacement gate')
            check(row['case']+':typed',isinstance(body,dict) and body.get('status')==('rejected' if refused else 'pending' if pending else 'registered'),'every branch returns the join envelope')
            expected_attempts=2 if (success and not own) or row['case']=='declaration-mismatch-retry' else 1
            check(row['case']+':cardinality',len(d['participant_registration_attempts'])==expected_attempts and len(d['participant_registrations'])==1,'one successor at most, including on retry')
            if success and not own:
                check(row['case']+':sessions',len(d['sessions'])==(1 if bridge else 2),'bridge retains its session; host replacement increments generation')
                if not bridge:
                    check(row['case']+':lineage',d['sessions'][0]['status']=='archived' and d['sessions'][1]['prior_host_session_id']==d['sessions'][0]['host_session_id'],'session lineage survives retirement')
                    check(row['case']+':retirement',d['participant_host_bindings'][0]['state']=='RETIRED' and d['participant_registration_attempts'][0]['recovery_disposition']=='abandoned','predecessor is durably retired before successor')
                reason=body.get('continuation',{}).get('reason') if isinstance(body,dict) else None
                expected_reason={'foundry-continue':'carried','foundry-fresh':'participant_fresh','legacy-arris':'continuation_invalidated','reuse-disabled':'reuse_disabled','continuation-invalidated':'continuation_invalidated'}.get(name)
                if expected_reason:check(row['case']+':selection',reason==expected_reason,'continuation selection follows the declaration and durable barriers')
            new_clocks=clocks(d)|clocks(body)
            seed_clocks=clocks(row['seed'])
            for clock in new_clocks-seen_clocks-seed_clocks:
                at=datetime.datetime.fromisoformat(clock.replace('Z','+00:00')).timestamp()
                check(row['case']+':clock:'+clock,row['before']-.01<=at<=row['after']+.01,'new durable clocks must be written within the request')
            seen_clocks.update(new_clocks)
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
