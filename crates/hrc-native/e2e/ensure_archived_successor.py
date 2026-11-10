#!/usr/bin/env python3
"""Archived ensure succession on a native-created store.

Failure modes: 404 instead of succession; lost continuation or inherited intent;
wrong generation/parent; stale continuity; duplicate/missing creation fact; repeat
birth; identity timing or wire key-order divergence. No harness birth is needed.
"""
import json
import sqlite3
from routes import main


def prepare(release, dbpath, scope, host, env):
    with sqlite3.connect(dbpath) as db:
        db.execute("UPDATE sessions SET last_applied_intent_json=?,continuation_json=?,status='archived' WHERE scope_ref=?",
                   (json.dumps({'probe':'inherited'}),json.dumps({'provider':'claude','key':'ensure-scratch-key'}),scope))


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


def compare(results):
    rows=results['native']
    assert len(rows)==4
    for r in rows:
        assert r['response']['status']==200,r
    for a,b in ((rows[0],rows[1]),(rows[2],rows[3])):
        assert a['response']['body']['activeHostSessionId']==b['response']['body']['activeHostSessionId'],(a,b)
    sessions=rows[-1]['sessions']
    assert len(sessions)==4,sessions
    assert len(rows[-1]['events'])==4,rows[-1]['events']
    for lane in ('main','alternate'):
        old,new=sorted((s for s in sessions if s['lane_ref']==lane),key=lambda s:s['generation'])
        assert old['status']=='archived' and new['status']=='active' and new['generation']==old['generation']+1,(old,new)
        assert new['prior_host_session_id']==old['host_session_id'],(old,new)
        facts=[e for e in rows[-1]['events'] if e['host_session_id']==new['host_session_id']]
        assert len(facts)==1 and facts[0]['generation']==new['generation'],facts
        assert json.loads(facts[0]['payload_json'])['priorHostSessionId']==old['host_session_id'],facts
        assert json.loads(new['continuation_json'])=={'provider':'claude','key':'ensure-scratch-key'},new
        assert json.loads(new['last_applied_intent_json'])=={'probe':'replacement' if lane=='main' else 'inherited'},new
        assert any(c['active_host_session_id']==new['host_session_id'] for c in rows[-1]['continuities']),new


if __name__ == '__main__':
    main(prepare=prepare, case_factory=cases, observe=observe, suite='ensure-archived-successor',compare=compare)
