"""Compare real-seat runtime reads, validating every volatile fact before normalization."""
import datetime
import json
import math
from pathlib import Path


CASES = ('runtimes', 'runtimes-all', 'runtimes-page', 'runtimes-terminal', 'runtimes-terminal-hidden', 'runtimes-host', 'runtimes-scope', 'runtimes-agent', 'runtimes-task', 'runtimes-other-agent', 'runtimes-other-host', 'runtimes-status', 'runtimes-unknown-status', 'runtimes-transport', 'runtimes-stale', 'runtimes-bool', 'runtimes-transport-invalid', 'runtimes-limit-zero', 'runtimes-limit-negative', 'runtimes-limit-fraction', 'runtimes-limit-overflow', 'runtimes-cursor', 'runtimes-duration', 'inspect', 'inspect-array', 'inspect-number', 'inspect-owner-null', 'inspect-owner-empty', 'inspect-trimmed', 'inspect-missing', 'inspect-unknown', 'seat', 'seat-encoded', 'seat-inactive', 'inspect-inactive', 'seat-unknown', 'target', 'target-default', 'target-invalid', 'target-missing', 'target-unknown', 'runtimes-next')

def stamp(value):
    return datetime.datetime.fromisoformat(value.replace('Z','+00:00')).timestamp()


def compare(args, checks):
    subjects={}
    for kind,directory in [('bun',args.baseline),('native',args.candidate)]:
        rows=json.loads((Path(directory)/'observations.json').read_text())
        by_name={r['case']:r for r in rows}
        checks.append({'id':kind+':unique','pass':len(rows)==len(by_name) and set(by_name)==set(CASES),'reason':'all real-seat and error cases are required','failureCode':1})
        def check(name,ok,reason):checks.append({'id':kind+':'+name,'pass':ok,'reason':reason,'failureCode':1})
        for row in rows:
            body=row['body']
            retained=row.get('persistedProbe')
            if row['case'].startswith('seat') and row['status']==200:
                valid=isinstance(retained,dict)
                check(row['case']+':durable-probe',valid,'live and unavailable probe observations must be persisted')
                if valid:
                    for field in ('observedAt','attemptedAt'):
                        if field in retained:
                            bounded=row['before']-.01<=stamp(retained[field])<=row['after']+.01
                            check(row['case']+':'+field,bounded,'new probe timestamp must be bounded by the request')
                            if bounded:retained[field]='request-time'
            if row['case'].startswith('runtimes') and isinstance(body,list):
                for runtime in body:
                    if runtime.get('controllerKind')!='harness-broker':continue
                    state=runtime.get('runtimeStateJson',{})
                    for obj,key in [(runtime,'updatedAt'),(state,'updatedAt'),(state.get('brokerDispatchDiagnostics',{}).get('liveSeatProbe',{}),'observedAt')]:
                        if key in obj:
                            valid=row['ownerBefore']-.01<=stamp(obj[key])<=row['after']+.01
                            check(row['case']+':'+key,valid,'reattach must refresh diagnostics during this owner lifetime')
                            if valid:obj[key]='owner-time'
                    replay=state.get('brokerReplay',{})
                    if 'activeControllerInstanceId' in replay:
                        valid=replay['activeControllerInstanceId']==f"hrc-server:{row['ownerPid']}"
                        check(row['case']+':controller',valid,'replay owner must identify the running subject')
                        if valid:replay['activeControllerInstanceId']='current-owner'
            if row['case'].startswith('inspect') and isinstance(body,dict) and row['status']==200:
                for key,source in [('createdAgeSec','createdAt'),('lastActivityAgeSec','lastActivityAt')]:
                    age=body.get(key);at=body.get(source)
                    valid=age is None if at is None else isinstance(age,int) and max(0,math.floor(row['before']-stamp(at)))<=age<=max(0,math.floor(row['after']-stamp(at)))
                    check('inspect:'+key,valid,'reported age must match the source timestamp and request interval')
                    if valid and age is not None:body[key]='request-age'
                live=body.get('brokerDispatch',{}).get('liveSeatProbe',{})
                if 'observedAt' in live:
                    valid=row['before']-.01<=stamp(live['observedAt'])<=row['after']+.01
                    check('inspect:live-time',valid,'inspection must probe the actual worker during the request')
                    if valid:live['observedAt']='request-time'
        if 'runtimes' in by_name:
            body=by_name['runtimes']['body']
            check('positive',isinstance(body,list) and len(body)>=1 and any(r.get('identity',{}).get('agentId')=='tabularasa' and r.get('status')=='ready' for r in body),'a real completed blank seat must be returned with canonical identity')
        if set(CASES)<=set(by_name):
            seat=by_name['seat']['body'];inspect=by_name['inspect']['body'];target=by_name['target']['body']
            check('live-seat',isinstance(seat,dict) and (seat.get('probe') or {}).get('seat',{}).get('state')=='idle' and seat.get('currentBrokerSeq',0)>0 and seat.get('probeError') is None,'the actual broker must answer, alongside a nonzero committed sequence')
            check('inspect-model',isinstance(inspect,dict) and (inspect.get('reportedModel') or {}).get('source')=='provider-response' and (inspect.get('control') or {}).get('brokerAttached') is True,'inspection must carry the real completed prompt model and attached control')
            check('bound-target',isinstance(target,dict) and target.get('state')=='bound' and target.get('runtime',{}).get('runtimeId')==seat.get('runtimeId') if isinstance(seat,dict) else False,'target and live seat must name the same realized runtime')
            check('terminal-pagination',len(by_name['runtimes-all']['body'])==3 and len(by_name['runtimes-page']['body'])==1 and bool(by_name['runtimes-page']['headers'].get('x-hrc-next-cursor')) and len(by_name['runtimes-next']['body'])==1 and by_name['runtimes-terminal-hidden']['body']==[],'terminal history must be opt-in and traversable with real cursors')
        subjects[kind]=by_name
    cases=[]
    for name in CASES:
        a,b=subjects['bun'].get(name),subjects['native'].get(name)
        passed=a is not None and b is not None and all(a[k]==b[k] for k in ('method','path','request','status','body','headers','persistedProbe'))
        checks.append({'id':name,'pass':passed,'reason':'complete wire response must agree after validated owner/request-time facts','failureCode':1})
        cases.append({'id':name,'pass':passed})
    return {'suite':'n1-runtime-reads','cases':cases,'behaviorQualified':all(c['pass'] for c in checks)}
