#!/usr/bin/env python3
"""Paired real-owner HTTP operator doors.

Failure modes: missing routes; destructive writes on refusals; duplicate unbind
facts; loss of stored generation/lane; malformed bodies; ensure
response drift. Seed via the real Bun repository, with a persisted lane:impl
shape observed in T-12061's live ledger.
"""
import json
from datetime import datetime
import sqlite3
import subprocess
from routes import main


def prepare(release, dbpath, scope, host, env):
    script = '''
import {openHrcDatabase} from DATABASE;
const db=openHrcDatabase(process.argv[1]);
const s=db.sessions.getByHostSessionId(process.argv[2]);
db.runtimes.insert({runtimeId:'operator-live',hostSessionId:s.hostSessionId,scopeRef:s.scopeRef,laneRef:s.laneRef,generation:s.generation,transport:'sdk',status:'ready',runtimeStateJson:{lifecycleOwner:'external'},tmuxJson:{socketPath:'/private/test.sock',sessionName:'test',sessionId:'$1',windowId:'@1',paneId:'%1'},supportsInflightInput:false,createdAt:s.createdAt,updatedAt:s.updatedAt});
db.surfaceBindings.bind({surfaceKind:'ghostty',surfaceId:'operator-surface',hostSessionId:s.hostSessionId,runtimeId:'operator-live',generation:s.generation,clientTty:'/dev/ttys-test',boundAt:s.createdAt});
for(const [id,status] of [['operator-terminal','completed'],['operator-accepted','accepted']]) {
 db.runs.insert({runId:id,hostSessionId:s.hostSessionId,runtimeId:'operator-live',scopeRef:s.scopeRef,laneRef:s.laneRef,generation:s.generation,transport:'sdk',status,acceptedAt:s.createdAt,updatedAt:s.updatedAt,...(status==='completed'?{completedAt:s.createdAt}:{})});
}
db.close();
'''.replace('DATABASE',json.dumps(str(release/'packages/hrc-store-sqlite/src/database.ts')))
    p=subprocess.run(['bun','-e',script,str(dbpath),host],env=env,capture_output=True,text=True)
    assert p.returncode==0,p.stderr
    with sqlite3.connect(dbpath) as db:
        db.execute("UPDATE sessions SET lane_ref='lane:impl' WHERE host_session_id=?",(host,))
        db.execute("UPDATE continuities SET lane_ref='lane:impl' WHERE active_host_session_id=?",(host,))
        db.execute("UPDATE runtimes SET lane_ref='lane:impl' WHERE runtime_id='operator-live'")


def cases(scope,host):
    result=[]
    def add(name,path,body): result.append((name,'POST','/v1/'+path,body))
    for path in ['federation/retire','runtimes/ensure','runs/recover-unstarted','surfaces/unbind']:
        add(path+'-missing',path,{})
        add(path+'-array',path,[])
        add(path+'-primitive',path,3)
    add('retire-unconfigured','federation/retire',{'scopeRef':scope,'reason':'test'})
    add('recover-unknown','runs/recover-unstarted',{'runId':'absent','dryRun':True})
    add('ensure-unknown','runtimes/ensure',{'hostSessionId':'absent','intent':{'harness':{'interactive':True,'provider':'anthropic'}}})
    intent={'harness':{'interactive':True,'provider':'anthropic'}}
    add('ensure-reuse','runtimes/ensure',{'hostSessionId':host,'intent':intent})
    add('ensure-selection-conflict','runtimes/ensure',{'hostSessionId':host,'intent':intent|{'selection':{'model':'other'}}})
    for run in ['operator-terminal','operator-accepted']:
        add('recover-'+run,'runs/recover-unstarted',{'runId':run,'dryRun':True})
    add('ensure-bad-provider','runtimes/ensure',{'hostSessionId':host,'intent':{'harness':{'interactive':True,'provider':'invalid'}}})
    add('ensure-bad-style','runtimes/ensure',{'hostSessionId':host,'intent':intent,'restartStyle':'invalid'})
    add('recover-bad-boolean','runs/recover-unstarted',{'runId':'absent','dryRun':'yes'})
    add('ensure-bad-harness','runtimes/ensure',{'hostSessionId':host,'intent':{'harness':{}}})
    add('unbind-unknown','surfaces/unbind',{'surfaceKind':'ghostty','surfaceId':'absent'})
    add('unbind-bad-reason','surfaces/unbind',{'surfaceKind':'ghostty','surfaceId':'operator-surface','reason':2})
    add('unbind-live','surfaces/unbind',{'surfaceKind':'ghostty','surfaceId':'operator-surface','reason':' operator done '})
    add('unbind-repeat','surfaces/unbind',{'surfaceKind':'ghostty','surfaceId':'operator-surface','reason':'changed'})
    return result


def observe(dbpath):
    with sqlite3.connect(dbpath) as db:
        return {'unbindEvents':db.execute("SELECT count(*) FROM hrc_events WHERE event_kind='surface.unbound'").fetchone()[0]}


def compare(results):
    def normalize(v):
        if isinstance(v,dict): return {k:('<time>' if k=='unboundAt' else normalize(x)) for k,x in v.items()}
        if isinstance(v,list):return [normalize(x) for x in v]
        return v
    for a,b in zip(results['bun'],results['native'],strict=True):
        assert normalize(a['response'])==normalize(b['response']),(a['case'],a['response'],b['response'])
        assert a['unbindEvents']==b['unbindEvents'],(a,b)
    for owner in ('bun','native'):
        by_case={r['case']:r for r in results[owner]}
        first=by_case['unbind-live'];repeat=by_case['unbind-repeat']
        stamp=first['response']['body']['unboundAt']
        assert first['before']-.001 <= datetime.fromisoformat(stamp.replace('Z','+00:00')).timestamp() <= first['after']+.001
        assert repeat['response']['body']['unboundAt']==stamp
    rows={r['case']:r for r in results['native']}
    assert rows['unbind-live']['response']['status']==200
    assert rows['unbind-live']['unbindEvents']==rows['unbind-repeat']['unbindEvents']==1
    assert rows['recover-unknown']['response']['body']['reason']=='unknown_run'
    assert rows['ensure-reuse']['response']['status']==200
    assert rows['ensure-reuse']['response']['body']['runtimeId']=='operator-live'


if __name__=='__main__':main(prepare=prepare,case_factory=cases,observe=observe,compare=compare,suite='deferred-operator-routes')
