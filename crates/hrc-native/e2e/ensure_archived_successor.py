#!/usr/bin/env python3
"""Archived ensure differential: real Bun repository snapshot, isolated owners.

Failure modes: 404 instead of succession; lost continuation or inherited intent;
wrong generation/parent; stale continuity; duplicate/missing creation fact; repeat
birth; identity timing or wire key-order divergence. No harness birth is needed.
"""
import json
import sqlite3
import subprocess
from routes import main


def prepare(release, dbpath, scope, host, env):
    # First observe the actual public resolve response (routes.main), then use
    # Bun's real repositories to archive both lanes with a continuation.
    script = '''
import {openHrcDatabase} from DATABASE;
const db=openHrcDatabase(process.argv[1]);
for (const session of db.sessions.listByScopeRef(process.argv[2])) {
  db.sessions.updateIntent(session.hostSessionId,{probe:'inherited'},'2026-10-25T12:00:00.000Z');
  db.sessions.updateContinuation(session.hostSessionId,{provider:'claude',key:'ensure-scratch-key'},'2026-10-25T12:00:00.000Z');
  db.sessions.updateStatus(session.hostSessionId,'archived','2026-10-25T12:00:00.000Z');
}
db.close();
'''.replace('DATABASE', json.dumps(str(release/'packages/hrc-store-sqlite/src/database.ts')))
    subprocess.run(['bun', '-e', script, str(dbpath), scope], env=env, check=True, capture_output=True)


def cases(scope, host):
    return [(name, 'POST', '/v1/targets/ensure', {'sessionRef': scope+'/lane:'+lane,
            'runtimeIntent': {'probe':'replacement'}, 'persistIntent': persist})
            for name,lane,persist in [('persist','main',True),('repeat','main',False),
                                      ('inherit','alternate',False),('inherit-repeat','alternate',False)]]


def observe(dbpath):
    with sqlite3.connect(f'file:{dbpath}?mode=ro', uri=True) as db:
        db.row_factory = sqlite3.Row
        return {key:[dict(r) for r in db.execute(sql)] for key,sql in {
            'sessions':'SELECT * FROM sessions ORDER BY lane_ref,generation',
            'continuities':'SELECT * FROM continuities ORDER BY lane_ref',
            'events':"SELECT host_session_id,generation,payload_json FROM hrc_events WHERE event_kind='session.created' ORDER BY hrc_seq",
        }.items()}


if __name__ == '__main__':
    main(prepare=prepare, case_factory=cases, observe=observe, suite='ensure-archived-successor')
