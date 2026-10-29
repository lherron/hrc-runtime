#!/usr/bin/env python3
"""Target-list parity against a real Bun-created store and both HTTP owners.

Failure modes: missing route, app leakage, historical/archived leakage, lost
identity/intent, wrong lane aliases, wrong ordering/deduplication, and ignored
project/lane/dormancy filters. Reads must not change session/continuity rows.
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
db.sessions.updateIntent(s.hostSessionId,{probe:'target-list'},s.updatedAt);
const alternate=db.sessions.listByScopeRef(s.scopeRef,'alternate')[0];
db.sessions.updateContinuation(alternate.hostSessionId,{provider:'claude',key:'target-list-key'},alternate.updatedAt);
db.sessions.updateStatus(alternate.hostSessionId,'archived',alternate.updatedAt);
db.close();
'''.replace('DATABASE', json.dumps(str(release/'packages/hrc-store-sqlite/src/database.ts')))
    subprocess.run(['bun', '-e', script, str(dbpath), host], env=env, check=True, capture_output=True)
    with sqlite3.connect(dbpath) as db:
        # Real max3 history includes continuities whose stored lane still
        # includes lane:. Native convenience identity reads normalize it and
        # fail; target listing must retain the exact ledger key.
        db.execute("UPDATE sessions SET lane_ref='lane:alternate' WHERE scope_ref=? AND lane_ref='alternate'",(scope,))
        db.execute("UPDATE continuities SET lane_ref='lane:alternate' WHERE scope_ref=? AND lane_ref='alternate'",(scope,))
        # Historical active incarnation: continuity must exclude it. The
        # legacy default spelling deliberately collides with canonical main.
        columns=[r[1] for r in db.execute('PRAGMA table_info(sessions)')]
        row=dict(zip(columns,db.execute('SELECT * FROM sessions WHERE host_session_id=?',(host,)).fetchone()))
        for suffix, lane, status in [('old','main','active'),('alias','default','active'),('broken','broken','archived')]:
            extra={**row,'host_session_id':host+'-'+suffix,'lane_ref':lane,'generation':0,'status':status}
            db.execute('INSERT INTO sessions ('+','.join(columns)+') VALUES ('+','.join('?' for _ in columns)+')',list(extra.values()))
        app={**row,'host_session_id':host+'-app','scope_ref':'app:target-list'}
        db.execute('INSERT INTO sessions ('+','.join(columns)+') VALUES ('+','.join('?' for _ in columns)+')',list(app.values()))


def cases(scope, host):
    return [(name,'GET',path,None) for name,path in [
        ('default','/v1/targets'),
        ('dormant','/v1/targets?includeDormant=true'),
        ('project','/v1/targets?projectId=n1-t11818'),
        ('wrong-project','/v1/targets?projectId=absent'),
        ('main','/v1/targets?lane=main'),
        ('default-alias','/v1/targets?lane=default'),
        ('alternate-active','/v1/targets?lane=lane:alternate'),
        ('alternate-dormant','/v1/targets?lane=lane:alternate&includeDormant=true'),
        ('empty-filters','/v1/targets?projectId=%20&lane=%20'),
    ]]


def observe(dbpath):
    with sqlite3.connect(f'file:{dbpath}?mode=ro',uri=True) as db:
        return {'sessions':db.execute('SELECT host_session_id,status,generation FROM sessions ORDER BY host_session_id').fetchall(),
                'continuities':db.execute('SELECT scope_ref,lane_ref,active_host_session_id FROM continuities ORDER BY scope_ref,lane_ref').fetchall()}


def compare(results):
    for baseline, candidate in zip(results['bun'],results['native'],strict=True):
        assert baseline['response']['status']==200, baseline
        for key in ('response','sessions','continuities'):
            assert baseline[key]==candidate[key], (baseline['case'],key,baseline[key],candidate[key])
    bodies={r['case']:r['response']['body'] for r in results['native']}
    assert len(bodies['default'])==1, bodies
    assert len(bodies['dormant'])==2, bodies
    assert bodies['wrong-project']==[], bodies
    assert bodies['main']==bodies['default-alias']==bodies['default'], bodies
    assert bodies['alternate-active']==[], bodies
    assert len(bodies['alternate-dormant'])==1, bodies
    assert bodies['default'][0]['lastAppliedIntentJson']=={'probe':'target-list'}, bodies
    assert len(bodies['default'][0]['ambiguityCandidates'])==2, bodies
    assert all(r['sessions']==results['native'][0]['sessions'] and r['continuities']==results['native'][0]['continuities'] for r in results['native'])


if __name__ == '__main__':
    main(prepare=prepare,case_factory=cases,observe=observe,suite='target-list',compare=compare)
