#!/usr/bin/env python3
"""Retire only disposable scopes on private Bun/native registry stores.

Failure modes: retiring foreign/live scope; releasing registry before fencing;
losing continuation fences; duplicate retry changing reason/timestamps; registry
conflict reported as success. Store and registry must agree after each request.
"""
import json
from datetime import datetime
from pathlib import Path
import sqlite3
import subprocess
from n4_federation import TAILNET,free_port
from routes import main

SCOPE=None
REGISTRY=None


def prepare(release, dbpath, scope, host, env):
    global SCOPE,REGISTRY
    SCOPE=scope
    REGISTRY=dbpath.parent.parent/'federation/binding-registry.sqlite'
    config=Path(env['HRC_PEER_CONFIG_FILE'])
    config.write_text(json.dumps({'nodeId':'operator-test','peers':{},'registry':{'bind':f'http://{TAILNET}:{free_port()}'},'gate':{'mode':'off','registryHost':'operator-test'}}))
    config.chmod(0o600)
    script='''
import {openHrcDatabase,createPlacementLedgerRepository} from DATABASE;
const db=openHrcDatabase(process.argv[1]);const l=createPlacementLedgerRepository(db.sqlite);
for(const [s,h] of [[process.argv[2],'operator-test'],[process.argv[2]+'-conflict','operator-test'],[process.argv[2]+'-foreign','other'],[process.argv[2]+'-live','operator-test'],[process.argv[2]+'-fence-error','operator-test']])l.installActive({scopeRef:s,homeNodeId:h,updatedAt:'2026-10-01T00:00:00.000Z'});
const s=db.sessions.getByHostSessionId(process.argv[3]);
db.runtimes.insert({runtimeId:'retirement-live',hostSessionId:s.hostSessionId,scopeRef:process.argv[2]+'-live',laneRef:s.laneRef,generation:s.generation,transport:'sdk',status:'ready',runtimeStateJson:{lifecycleOwner:'external'},supportsInflightInput:false,createdAt:s.createdAt,updatedAt:s.updatedAt});
db.close();
'''.replace('DATABASE',json.dumps(str(release/'packages/hrc-store-sqlite/src/index.ts')))
    r=subprocess.run(['bun','-e',script,str(dbpath),scope,host],env=env,capture_output=True,text=True)
    assert r.returncode==0,r.stderr
    with sqlite3.connect(dbpath) as db:
        db.row_factory=sqlite3.Row
        row=dict(db.execute('SELECT * FROM sessions WHERE host_session_id=?',(host,)).fetchone())
        row.update(host_session_id='hsid-retire-fault',scope_ref=scope+'-fence-error')
        db.execute('INSERT INTO sessions('+','.join(row)+') VALUES('+','.join('?' for _ in row)+')',list(row.values()))
        row=dict(db.execute("SELECT * FROM continuities WHERE scope_ref=? AND lane_ref='main'",(scope,)).fetchone())
        row.update(scope_ref=scope+'-fence-error',active_host_session_id='hsid-retire-fault',task_id=row['task_id']+'-fence-error')
        db.execute('INSERT INTO continuities('+','.join(row)+') VALUES('+','.join('?' for _ in row)+')',list(row.values()))
        db.execute("CREATE TRIGGER fail_fence BEFORE UPDATE OF continuation_reuse_disabled ON sessions WHEN NEW.host_session_id='hsid-retire-fault' BEGIN SELECT RAISE(ABORT,'injected fencer failure'); END")



def settle(dbpath,name):
    if name is not None:return
    with sqlite3.connect(REGISTRY) as db:
        db.execute('DELETE FROM binding_registry')
        db.execute('DELETE FROM binding_retirement_audit')
        for scope,home in [(SCOPE,'operator-test'),(SCOPE+'-conflict','other'),(SCOPE+'-fence-error','operator-test')]:
            db.execute('INSERT INTO binding_registry(scope_ref,home_node_id,created_at,updated_at) VALUES(?,?,?,?)',(scope,home,'2026-10-01T00:00:00.000Z','2026-10-01T00:00:00.000Z'))


def cases(scope,host):
    return [(name,'POST','/v1/federation/retire',{'scopeRef':s,'reason':reason}) for name,s,reason in [
        ('unknown',scope+'-unknown','test'),('foreign',scope+'-foreign','test'),('live',scope+'-live','test'),
        ('retire',scope,' first reason '),('retry',scope,'different reason'),('registry-conflict',scope+'-conflict','conflict'),('fencer-failure',scope+'-fence-error','fault'),
    ]]


def observe(dbpath):
    with sqlite3.connect(dbpath) as db:
        ledger=list(db.execute('SELECT scope_ref,state,retirement_reason FROM placement_ledger ORDER BY scope_ref'))
        continuities=list(db.execute('SELECT scope_ref,lane_ref FROM continuities ORDER BY scope_ref,lane_ref'))
        sessions=list(db.execute('SELECT host_session_id,continuation_reuse_disabled FROM sessions ORDER BY host_session_id'))
    with sqlite3.connect(REGISTRY) as db:
        registry=list(db.execute('SELECT scope_ref,home_node_id FROM binding_registry ORDER BY scope_ref'))
    return {'ledger':ledger,'continuities':continuities,'sessions':sessions,'registry':registry}


def compare(results):
    def normalize(v):
        if isinstance(v,dict):return {k:('<time>' if k in ('updatedAt','requestId') else normalize(x)) for k,x in v.items()}
        if isinstance(v,list):return [normalize(x) for x in v]
        return v
    for a,b in zip(results['bun'],results['native'],strict=True):
        assert normalize(a['response'])==normalize(b['response']),(a['case'],a['response'],b['response'])
        for key in ('ledger','continuities','sessions','registry'):assert a[key]==b[key],(a['case'],key,a[key],b[key])
    for owner in ('bun','native'):
        by_case={r['case']:r for r in results[owner]}
        for case in ('retire','registry-conflict'):
            row=by_case[case]
            stamp=row['response']['body']['ledger']['record']['updatedAt']
            assert row['before']-.001 <= datetime.fromisoformat(stamp.replace('Z','+00:00')).timestamp() <= row['after']+.001
        assert by_case['retire']['response']['body']['ledger']==by_case['retry']['response']['body']['ledger']
    rows={r['case']:r for r in results['native']}
    assert rows['retire']['response']['body']['outcome']=='retired'
    assert rows['retry']['response']['body']['outcome']=='idempotent'
    assert rows['registry-conflict']['response']['body']['state']=='fenced-registry-pending'
    assert rows['fencer-failure']['response']['status']==500
    assert [r[1] for r in rows['fencer-failure']['ledger'] if r[0]==SCOPE+'-fence-error']==['retired']
    assert [r[1] for r in rows['fencer-failure']['registry'] if r[0]==SCOPE+'-fence-error']==['operator-test']
    assert rows['live']['response']['body']['outcome']=='live-runtime-present'
    assert len(rows['retire']['continuities'])==len(rows['unknown']['continuities'])-2
    assert sum(x[1] for x in rows['retire']['sessions'])==2


if __name__=='__main__':main(prepare=prepare,case_factory=cases,settle=settle,observe=observe,compare=compare,suite='retirement-parity')
