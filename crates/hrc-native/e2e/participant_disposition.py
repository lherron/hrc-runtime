#!/usr/bin/env python3
"""T-13153/T-13189 native scratch acceptance; standalone, outside the verify gate.

Discriminates missing keys from nulls, wrong lane joins, duplicate parks/clears,
non-atomic disposition events, and filtered live/restart observation gaps.
Uses a real ASP-compiled participant host; only rollback fault injection and
placement authority are written to the private scratch database.

T-13189 (--clear unpark, the default): the park is cleared by
POST /v1/participants/unpark before the successor registers, so the null event
comes from the route; a repeat is unchanged; the reservation, bindings and
attempts survive and the successor is still admitted; an unknown address, a
sibling lane and malformed bodies refuse without writing. --clear registration
reruns the T-13153 path where the successor admission clears the park.
"""
import argparse
import json
import sqlite3
import time
from pathlib import Path
from urllib.parse import urlencode
from n2_scratch import Scratch
from n2_participant import register, attach
from events_kind_filter import Follow

p = argparse.ArgumentParser(description=__doc__)
for key in ('binary', 'scratch-root', 'artifacts', 'aspd-socket'):
    p.add_argument('--'+key, type=Path, required=True)
p.add_argument('--clear', choices=('unpark','registration'), default='unpark')
a = p.parse_args(); a.owner = 'native'
s = Scratch(a.scratch_root, None, a.aspd_socket, a.binary, a.artifacts, project_id='n2-t13153')
prefix = 'agent:tabularasa:project:n2-t13153:task:'
scope = prefix+'host'
report, held = {'cases':{}}, {}
log = (s.artifacts/'broker.log').open('w')
f = None

def sql(statement, params=()):
    with sqlite3.connect(s.db_path) as db: db.execute(statement, params)

def events():
    return s.rows("SELECT * FROM hrc_events WHERE event_kind='participant.disposition_changed' ORDER BY hrc_seq")

def reservation():
    return s.rows('SELECT * FROM participant_address_reservations WHERE scope_ref=?',(scope,))[0]

def reads(address, expected, stamp, name, lane="main"):
    status, get = s.http('GET','/v1/sessions/get?'+urlencode({'scopeRef':address,'laneRef':lane}))
    assert status == 200, get
    status, page = s.http('GET','/v1/sessions/page?'+urlencode({'q':address,'nodes':'local','limit':200}))
    assert status == 200, page
    candidates = [r for r in page['items'] if r['scopeRef']==address and r['laneRef']==('main' if lane=='main' else 'lane:'+lane.removeprefix('lane:'))]
    assert len(candidates)==1, page
    row = candidates[0]
    report['cases'][name] = {'get':get,'page':row}
    for record in (get,row):
        assert 'disposition' in record and 'dispositionAt' in record, ('missing disposition keys',record)
        assert (record['disposition'],record['dispositionAt']) == (expected,stamp), record

def check_events(values):
    rows = events()
    assert len(rows)==len(values), rows
    for row, (value, stamp) in zip(rows,values):
        assert row['scope_ref']==scope and row['lane_ref']=='main', row
        assert row['host_session_id']=='hrc-participant' and row['generation']==0 and row['runtime_id'] is None, row
        assert row['category']=='participant', row
        assert json.loads(row['payload_json']) == {'disposition':value,'dispositionAt':stamp,'reservationId':reservation()['reservation_id']}, row
    return rows

def ledger_state():
    return {'head':s.rows('SELECT MAX(hrc_seq) AS seq FROM hrc_events')[0]['seq'],
            'reservations':s.rows('SELECT * FROM participant_address_reservations ORDER BY reservation_id'),
            'bindings':s.rows('SELECT * FROM participant_host_bindings ORDER BY binding_id'),
            'attempts':s.rows('SELECT * FROM participant_registration_attempts ORDER BY attempt_id')}

def unpark(rid):
    """T-13189 claims 1, 2 and 4; claim 3 is the successor admission that follows."""
    case = report['unpark'] = {}
    route = '/v1/participants/unpark'
    before = ledger_state()
    # Claim 4: refusals write nothing, including the exact-lane miss.
    refusals = {
        'unknownAddress': ({'scopeRef':prefix+'nobody'}, 404, 'unknown_session'),
        'siblingLane': ({'scopeRef':scope,'laneRef':'review'}, 404, 'unknown_session'),
        'missingScope': ({'laneRef':'main'}, 400, 'malformed_request'),
        'nonStringScope': ({'scopeRef':7}, 400, 'malformed_request'),
        'setDisposition': ({'scopeRef':scope,'disposition':'parked'}, 400, 'malformed_request'),
    }
    for name, (body, status, code) in refusals.items():
        reply = case[name] = s.http('POST', route, body)
        assert reply[0]==status and reply[1]['error']['code']==code, (name, reply)
        assert ledger_state()==before, (name, 'refusal wrote')
    assert case['unknownAddress'][1]['error']['detail']=={'scopeRef':prefix+'nobody','laneRef':'main'}, case['unknownAddress']
    assert reservation()['disposition']=='parked'
    # Claim 1: park then unpark gives null reads and exactly one null event.
    first = case['first'] = s.http('POST', route, {'scopeRef':scope,'laneRef':'main'})
    res_id = reservation()['reservation_id']
    assert first == (200, {'reservationId':res_id,'scopeRef':scope,'laneRef':'main','disposition':None,'dispositionAt':None,'changed':True}), first
    reads(scope,None,None,'unparked'); check_events([('parked',stamp),(None,None)])
    target = s.http('GET','/v1/targets/by-session-ref?'+urlencode({'sessionRef':scope+'/lane:main'}))
    assert target[0]==200 and (target[1]['disposition'],target[1]['dispositionAt'])==(None,None), target
    case['target'] = target
    # Claim 2: a repeat (lane defaulted) is unchanged and appends nothing.
    after = ledger_state()
    second = case['second'] = s.http('POST', route, {'scopeRef':scope})
    assert second == (200, dict(first[1], changed=False)), second
    assert ledger_state()==after, 'unchanged unpark wrote'
    # Claim 3 (first half): only the two disposition columns moved.
    assert after['head']==before['head']+1, (before['head'], after['head'])
    assert after['bindings']==before['bindings'] and after['attempts']==before['attempts']
    held = [r for r in after['reservations'] if r['reservation_id']==res_id][0]
    assert held['state']=='held' and held['released_at'] is None, held
    was = [r for r in before['reservations'] if r['reservation_id']==res_id][0]
    assert {k:v for k,v in held.items() if k not in ('disposition','disposition_at')}=={k:v for k,v in was.items() if k not in ('disposition','disposition_at')}, (was, held)
    case['reservation'] = held
    # The stale eviction replay still cannot re-park an unparked address.
    assert s.http('POST','/v1/terminate',{'runtimeId':rid,'dropContinuation':False,'disposition':'parked'})[0]==200
    assert ledger_state()==after, 'eviction replay re-parked'

try:
    s.init_substrate(); (s.root/'run/btmux').mkdir()
    owner = s.up('native','initial')
    # A genuine continuity created without a participant reservation or runtime.
    ordinary = prefix+'ordinary'
    response = s.http('POST','/v1/sessions/resolve',{'sessionRef':ordinary+'/lane:main','create':True})
    assert response[0]==200, response
    sql("INSERT INTO placement_ledger(scope_ref,home_node_id,state,created_at,updated_at) VALUES (?,?,'active',?,?)",(ordinary,s.project_id,'2026-11-10T00:00:00Z','2026-11-10T00:00:00Z'))
    reads(ordinary,None,None,'neverReserved')
    case = report['participant'] = {}
    joined = register(s,scope,case)
    sql("INSERT INTO placement_ledger(scope_ref,home_node_id,state,created_at,updated_at) VALUES (?,?,'active',?,?)",(scope,s.project_id,'2026-11-10T00:00:00Z','2026-11-10T00:00:00Z'))
    reads(scope,None,None,'registeredUnparked'); check_events([])
    sibling=s.http('POST','/v1/sessions/resolve',{'sessionRef':scope+'/lane:review','create':True})
    assert sibling[0]==200, sibling
    identity, broker, endpoint, ledger, body, snapshot = attach(s,a,scope,joined,case,log,held)
    rid = joined['identity']['runtimeId']
    s.wait(lambda:s.rows("SELECT 1 FROM hrc_events WHERE runtime_id=? AND event_kind='turn.completed'",(rid,)),180,'initial turn')
    start = s.http('GET','/v1/events/page?afterSeq=0&limit=1')[1]
    incarnation, cursor = start['ledgerIncarnationId'], start['head']
    def follow():
        return Follow(s,'/v1/events/bounded-stream?'+urlencode({'follow':'true','afterSeq':cursor,'ledgerIncarnationId':incarnation,'eventKind':'participant.disposition_changed','scopeRef':scope}))
    f = follow(); f.wait(lambda rows:any(r['type']=='ready' for r in rows))
    retire = {'runtimeId':rid,'dropContinuation':False,'disposition':'parked'}
    # Failed append rolls back both park and eviction, without consuming a seq.
    sql("CREATE TRIGGER reject_disposition BEFORE INSERT ON hrc_events WHEN NEW.event_kind='participant.disposition_changed' BEGIN SELECT RAISE(FAIL,'scratch append refusal'); END")
    report['failedPark'] = s.http('POST','/v1/terminate',retire)
    assert report['failedPark'][0]>=400, report['failedPark']
    assert reservation()['disposition'] is None and not events()
    assert s.rows('SELECT status FROM runtimes WHERE runtime_id=?',(rid,))[0]['status']!='terminated'
    sql('DROP TRIGGER reject_disposition')
    assert s.http('POST','/v1/terminate',retire)[0]==200
    parked = reservation(); stamp = parked['disposition_at']
    assert stamp and parked['disposition']=='parked', parked
    reads(scope,'parked',stamp,'parked')
    reads(scope,None,None,'siblingLaneWhileParked',lane='review')
    target = s.http('GET','/v1/targets/by-session-ref?'+urlencode({'sessionRef':scope+'/lane:main'}))
    assert target[0]==200 and (target[1]['disposition'],target[1]['dispositionAt'])==('parked',stamp), target
    report['target'] = target
    check_events([('parked',stamp)])
    assert s.http('POST','/v1/terminate',retire)[0]==200 and reservation()==parked
    reads(scope,'parked',stamp,'replayedPark'); check_events([('parked',stamp)])
    reads(ordinary,None,None,'ordinaryWhileOtherParked')
    if a.clear == 'unpark':
        unpark(rid)
    broker.terminate(); broker.wait(timeout=20)
    successor = {'registrationMode':'direct','requestedSessionRef':scope,'hostIncarnationId':'successor-host','continuation':'fresh','expectedPredecessor':{'hostIncarnationId':case['hostIncarnationId'],'runtimeId':rid,'generation':joined['generation']}}
    report['successor'] = s.http('POST','/v1/participants/register',successor)
    assert report['successor'][0]==200 and report['successor'][1]['status']=='registered', report['successor']
    reads(scope,None,None,'newAttempt'); rows = check_events([('parked',stamp),(None,None)])
    # Repeat the registration and the stale eviction; neither changes the value.
    assert s.http('POST','/v1/participants/register',successor)[0]==200
    assert s.http('POST','/v1/terminate',retire)[0]==200
    reads(scope,None,None,'registrationReplay'); check_events([('parked',stamp),(None,None)])
    live = f.wait(lambda r:len([x for x in r if x['type']=='event'])>=2)
    time.sleep(1.2); live=f.records(); f.close(); f=None
    seqs = [r['hrc_seq'] for r in rows]
    assert [r['event']['hrcSeq'] for r in live if r['type']=='event']==seqs, live
    report['liveFollow'] = live
    s.down(owner); owner=s.up('native','restart')
    reads(scope,None,None,'afterRestart')
    f=follow(); replay=f.wait(lambda r:len([x for x in r if x['type']=='event'])>=2)
    time.sleep(1.2); replay=f.records(); f.close(); f=None
    assert [r['event']['hrcSeq'] for r in replay if r['type']=='event']==seqs, replay
    assert [r['event'] for r in replay if r['type']=='event']==[r['event'] for r in live if r['type']=='event']
    report['replay'] = replay; report['events']=rows; report['pass']=True
finally:
    if f: f.close()
    (s.artifacts/'result.json').write_text(json.dumps(report,indent=2)+'\n')
    (s.artifacts/'steps.json').write_text(json.dumps(s.steps,indent=2)+'\n')
    s.cleanup(prefix); log.close()
print(json.dumps({'pass':True,'artifacts':str(s.artifacts)}))
