#!/usr/bin/env python3
"""Surface reads and explicit capture recovery through real owner HTTP APIs.

Failure modes: 404 doors; missing confirmation; writes on dry run/refusal;
wrong unknown-runtime mapping; leaked inactive/unbound surfaces; wrong recovery
eligibility/capability. Real Bun repositories create the shared snapshot.
"""
import json
import sqlite3
import subprocess
from routes import main


def prepare(release, dbpath, scope, host, env):
    script = '''
import {openHrcDatabase} from DATABASE;
const db=openHrcDatabase(process.argv[1]);
const s=db.sessions.getByHostSessionId(process.argv[2]);
for(const [id,status] of [['route-live','ready'],['route-dead','terminated']]) {
  db.runtimes.insert({runtimeId:id,hostSessionId:s.hostSessionId,scopeRef:s.scopeRef,laneRef:s.laneRef,generation:s.generation,transport:'sdk',status,runtimeStateJson:id==='route-live'?{lifecycleOwner:'external'}:{},supportsInflightInput:false,createdAt:s.createdAt,updatedAt:s.updatedAt});
  db.surfaceBindings.bind({surfaceKind:'ghostty',surfaceId:id,hostSessionId:s.hostSessionId,runtimeId:id,generation:s.generation,boundAt:s.createdAt});
}
db.surfaceBindings.bind({surfaceKind:'ghostty',surfaceId:'unbound',hostSessionId:s.hostSessionId,runtimeId:'route-live',generation:s.generation,boundAt:s.createdAt});
db.surfaceBindings.unbind('ghostty','unbound',s.createdAt,'test');
db.close();
'''.replace('DATABASE',json.dumps(str(release/'packages/hrc-store-sqlite/src/database.ts')))
    result=subprocess.run(['bun','-e',script,str(dbpath),host],env=env,capture_output=True,text=True)
    assert result.returncode==0,result.stderr
    with sqlite3.connect(dbpath) as db:
        db.execute("INSERT INTO broker_invocations(invocation_id,operation_id,runtime_id,broker_protocol,broker_driver,invocation_state,capabilities_json,spec_hash,start_request_hash,selected_profile_hash,created_at,updated_at) VALUES ('route-invocation','route-operation','route-dead','test','test','terminated','{}','test','test','test','2026-10-01T00:00:00Z','2026-10-01T00:00:00Z')")


def cases(scope, host):
    return [(name,'GET',path,None) for name,path in [
        ('surface-missing','/v1/surfaces'),
        ('surface-blank','/v1/surfaces?runtimeId=%20'),
        ('surface-unknown','/v1/surfaces?runtimeId=absent'),
        ('surface-live','/v1/surfaces?runtimeId=route-live'),
        ('surface-dead','/v1/surfaces?runtimeId=route-dead'),
    ]]+[(name,'POST','/v1/capture/recover',body) for name,body in [
        ('recover-missing',{}),
        ('recover-confirm',{'runtimeId':'absent'}),
        ('recover-unknown',{'runtimeId':'absent','dryRun':True}),
        ('recover-no-invocation',{'runtimeId':'route-live','dryRun':True}),
        ('recover-dry',{'runtimeId':'route-dead','dryRun':True}),
        ('recover-refused',{'runtimeId':'route-dead','yes':True}),
    ]]


def observe(dbpath):
    with sqlite3.connect(f'file:{dbpath}?mode=ro',uri=True) as db:
        return {'outcomes':db.execute('SELECT count(*) FROM retained_evidence_outcomes').fetchone()[0]}


def compare(results):
    for baseline,candidate in zip(results['bun'],results['native'],strict=True):
        assert baseline['response']==candidate['response'],(baseline['case'],baseline['response'],candidate['response'])
        assert candidate['outcomes']==0,candidate
    rows={r['case']:r['response'] for r in results['native']}
    assert rows['surface-missing']['status']==400,rows
    assert len(rows['surface-live']['body'])==1,rows
    assert rows['surface-dead']['body']==[],rows
    assert rows['recover-unknown']['status']==404,rows
    assert rows['recover-confirm']['body']['error']['code']=='confirmation_required',rows
    assert rows['recover-dry']['body']['eligibility']=={'eligible':False,'reason':'offline_read_not_harness_broker'},rows
    assert rows['recover-no-invocation']['body']['outcome']=='offline_read_no_invocation',rows
    assert rows['recover-refused']['body']['recorded'] is False,rows


if __name__=='__main__':
    main(prepare=prepare,case_factory=cases,observe=observe,suite='operator-route-parity',compare=compare)
