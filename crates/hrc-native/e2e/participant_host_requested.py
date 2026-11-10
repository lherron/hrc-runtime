#!/usr/bin/env python3
"""T-13086 scratch acceptance, deliberately outside the verify gate.

Written before implementation: catch binding-based eligibility, missed retained
turn/lazy/ensure/resume doors, pending/ACTIVE false knocks, flooding, append
failure replacing a refusal, lost filtered replay, parked leakage and ordinary
terminate side effects. Uses a real ASP-compiled participant broker. Only the
lazy-routing, placement, continuation, released/absent and append-failure controls
edit private scratch state; the subject parks through Foundry's HTTP request.
"""
import argparse
import json
import sqlite3
import time
from pathlib import Path
from urllib.parse import urlencode
from n2_scratch import Scratch
from n2_participant import register, attach, Rpc
from events_kind_filter import Follow

p = argparse.ArgumentParser(description=__doc__)
for key in ('binary', 'scratch-root', 'artifacts', 'aspd-socket'):
    p.add_argument('--'+key, type=Path, required=True)
a = p.parse_args(); a.owner = 'native'
s = Scratch(a.scratch_root, None, a.aspd_socket, a.binary, a.artifacts, project_id='n2-t13086')
prefix = 'agent:tabularasa:project:n2-t13086:task:'
report, held = {'cases': []}, {}
log = (s.artifacts/'broker.log').open('w')

def sql(statement, params=()):
    with sqlite3.connect(s.db_path) as db: db.execute(statement, params)

def knocks():
    return s.rows("SELECT * FROM hrc_events WHERE event_kind='participant.host_requested' ORDER BY hrc_seq")

def reservation():
    return s.rows('SELECT * FROM participant_address_reservations WHERE scope_ref=?', (scope,))[0]

def activity():
    return s.rows('SELECT host_session_id,last_activity_at FROM session_index ORDER BY host_session_id')

def door(name):
    if name == 'turn':
        return s.http('POST', '/v1/turns', {'hostSessionId':joined['hostSessionId'], 'prompt':'Reply OK. No tools.', 'waitFor':'terminal'})
    if name == 'turn-lazy':
        # Force the public handoff's no-session branch at this same held address.
        sql('UPDATE sessions SET scope_ref=? WHERE scope_ref=?', (scope+'-hidden', scope))
        try:
            return s.http('POST', '/v1/messages/turn-handoff', {'from':{'kind':'session','sessionRef':scope+'/lane:main'},'to':{'kind':'session','sessionRef':scope+'/lane:main'},'body':'knock','runtimeIntent':{'placement':{}}})
        finally: sql('UPDATE sessions SET scope_ref=? WHERE scope_ref=?', (scope, scope+'-hidden'))
    if name == 'ensure':
        return s.http('POST', '/v1/targets/ensure', {'sessionRef':scope+'/lane:main', 'runtimeIntent':{}})
    return s.http('POST', '/v1/sessions/resume-continuation', {'sessionRef':scope+'/lane:main'})

def refused(name, expected_knock, parked=False):
    before, clock = len(knocks()), activity()
    result = door(name)
    report['cases'].append({'door':name,'knockExpected':expected_knock,'parked':parked,'response':result})
    assert result[0] == (503 if name in ('turn','turn-lazy') else 409), result
    error = result[1]['error']
    assert error['code'] == ('runtime_unavailable' if name in ('turn','turn-lazy') else 'stale_context'), result
    assert error['detail']['reason'] == {'turn':'participant_attempt_absorbing','turn-lazy':'participant_substitution','ensure':'host_absent','resume':'host_absent'}[name], result
    assert ('parked' in error['message']) == parked, result
    after = knocks()
    assert len(after) == before + int(expected_knock), (name,before,after)
    if name in ('ensure','resume'):
        assert activity() == clock, 'knock moved session activity'
    else:
        report['cases'][-1]['activityBefore'] = clock
        report['cases'][-1]['activityAfter'] = activity()
        # Existing submission.admission is deliberately session-attributed.
        # The knock's distinct attribution is asserted below.
    if expected_knock:
        row = after[-1]; payload = json.loads(row['payload_json'])
        assert row['host_session_id'] == 'hrc-participant' and row['runtime_id'] is None and row['generation'] == 0, row
        assert payload == {'scopeRef':scope,'laneRef':'main','reservationId':reservation()['reservation_id'],'door':name,'requestedAt':row['ts']}, payload
    return result

try:
    s.init_substrate(); (s.root/'run/btmux').mkdir()
    owner = s.up('native', 'initial')
    scope = prefix+'host'; case = report['participant'] = {}
    joined = register(s, scope, case)
    # Local placement authority for scope-filtered reads; no peer registry in scratch.
    sql("INSERT INTO placement_ledger(scope_ref,home_node_id,state,created_at,updated_at) VALUES (?,?,'active',?,?)", (scope,s.project_id,'2026-11-10T00:00:00Z','2026-11-10T00:00:00Z'))
    rid = joined['identity']['runtimeId']; aid = joined['identity']['attemptId']
    # Joined, not attached: no knock at any reached refusal point.
    for name in ('turn','turn-lazy','ensure'):
        n = len(knocks()); result = door(name)
        assert result[0] == (503 if name in ('turn','turn-lazy') else 409) and len(knocks()) == n, (name,result)
    identity, broker, endpoint, ledger, body, snapshot = attach(s,a,scope,joined,case,log,held)
    s.wait(lambda: s.rows("SELECT 1 FROM hrc_events WHERE runtime_id=? AND event_kind='turn.completed'",(rid,)),180,'initial turn')
    # ACTIVE control: a real turn succeeds; birth refusals must not knock.
    assert door('turn')[0] == 200
    for name in ('turn-lazy','ensure','resume'):
        n = len(knocks()); result = door(name); assert result[0] >= 400 and len(knocks()) == n, (name,result)
    # Continuation stays captured across Foundry's retire (no drop).
    sql('UPDATE sessions SET continuation_json=? WHERE host_session_id=?', (json.dumps({'provider':'claude','key':'scratch-host'}),joined['hostSessionId']))
    retire = {'runtimeId':rid,'dropContinuation':False,'disposition':'parked'}
    report['retire'] = s.http('POST','/v1/terminate',retire)
    assert report['retire'][0] == 200, report['retire']
    report['parkedReservation'] = parked = reservation()
    assert parked['disposition'] == 'parked' and parked['disposition_at'], parked
    binding = s.rows('SELECT * FROM participant_host_bindings WHERE runtime_id=?',(rid,))[0]
    report['bindingBeforeDoors'] = binding
    assert binding['state'] == 'BOUND' and parked['state'] == 'held', binding
    assert s.rows('SELECT state FROM participant_registration_attempts WHERE attempt_id=?',(aid,)) == [{'state':'ABANDONED'}]
    assert s.http('POST','/v1/terminate',retire)[0] == 200 and reservation() == parked
    target = s.http('GET','/v1/targets/by-session-ref?'+urlencode({'sessionRef':scope+'/lane:main'}))
    report['target'] = target
    assert target[0] == 200 and target[1]['disposition'] == 'parked' and target[1]['dispositionAt'] == parked['disposition_at'], target
    page = s.http('GET','/v1/events/page?afterSeq=0&limit=1')[1]
    incarnation = page['ledgerIncarnationId']
    def follow(cursor):
        return Follow(s,'/v1/events/bounded-stream?'+urlencode({'follow':'true','afterSeq':cursor,'ledgerIncarnationId':incarnation,'eventKind':'participant.host_requested','scopeRef':scope}))
    f = follow(page['head'])
    f.wait(lambda rows: any(r['type']=='ready' for r in rows))
    refused('turn', True, True); refused('turn', False, True)
    live = f.wait(lambda rows: any(r['type']=='event' for r in rows))
    report['liveFollow'] = live; f.close()
    cursor = knocks()[-1]['hrc_seq']
    # Real 30 s expiry; no test-only timing knob in the daemon.
    for name in ('turn-lazy','ensure','resume'):
        time.sleep(30.1); refused(name, True, True)
    missed = [r['hrc_seq'] for r in knocks() if r['hrc_seq'] > cursor]
    s.down(owner); owner = s.up('native','restart')
    f = follow(cursor)
    replay = f.wait(lambda rows: len([r for r in rows if r['type']=='event']) == len(missed))
    report['replay'] = replay; f.close()
    assert [r['event']['hrcSeq'] for r in replay if r['type']=='event'] == missed, replay
    # Append failure remains a courtesy; unchanged refusal, logged failure.
    sql("CREATE TRIGGER reject_knock BEFORE INSERT ON hrc_events WHEN NEW.event_kind='participant.host_requested' BEGIN SELECT RAISE(FAIL,'scratch append refusal'); END")
    refused('ensure',False,True)
    sql('DROP TRIGGER reject_knock')
    # Failure must not consume the limit; the immediately retried append works.
    refused('ensure',True,True)
    # Released/absent address controls through every public door. Release
    # metadata honors the store's existing explicit-release constraints.
    report['reservationControls'] = []
    for state in ('released','absent'):
        if state == 'released':
            sql("UPDATE participant_address_reservations SET state='released',released_at='2026-11-10T00:00:00Z',released_by='scratch',release_reason='negative control' WHERE scope_ref=?",(scope,))
        else:
            sql('UPDATE participant_address_reservations SET scope_ref=? WHERE scope_ref=?',(scope+'-absent',scope))
        try:
            for name in ('turn','turn-lazy','ensure','resume'):
                n = len(knocks()); result = door(name)
                report['reservationControls'].append({'state':state,'door':name,'response':result})
                assert len(knocks()) == n, (state,name,result)
        finally:
            if state == 'released':
                sql("UPDATE participant_address_reservations SET state='held',released_at=NULL,released_by=NULL,release_reason=NULL WHERE scope_ref=?",(scope,))
            else:
                sql('UPDATE participant_address_reservations SET scope_ref=? WHERE scope_ref=?',(scope,scope+'-absent'))
    other = prefix+'pending'; pending = register(s,other,{},single=False)
    # Pending resume reaches the birth door with a captured continuation.
    sql('UPDATE sessions SET continuation_json=? WHERE host_session_id=?',(json.dumps({'provider':'claude','key':'pending'}),pending['hostSessionId']))
    n = len(knocks())
    assert s.http('POST','/v1/sessions/resume-continuation',{'sessionRef':other+'/lane:main'})[0] == 409
    assert len(knocks()) == n
    # New attempt admission clears parked; repeated old join does not.
    assert s.http('POST','/v1/participants/register',{'registrationMode':'direct','requestedSessionRef':scope,'hostIncarnationId':case['hostIncarnationId']})[0] == 200
    assert reservation() == parked
    request = {'registrationMode':'direct','requestedSessionRef':scope,'hostIncarnationId':'successor-host','continuation':'fresh','expectedPredecessor':{'hostIncarnationId':case['hostIncarnationId'],'runtimeId':rid,'generation':joined['generation']}}
    broker.terminate(); broker.wait(timeout=20)
    report['successor'] = s.http('POST','/v1/participants/register',request)
    assert report['successor'][0] == 200 and report['successor'][1]['status']=='registered', report['successor']
    assert reservation()['disposition'] is None and reservation()['disposition_at'] is None
    cleared = reservation()
    report['oldEvictionAfterSuccessor'] = s.http('POST','/v1/terminate',retire)
    assert report['oldEvictionAfterSuccessor'][0] == 200 and reservation() == cleared
    # External invocation exit without terminate: stopped runtime, TERMINAL
    # attempt, held address. The attempt predicate still reports demand.
    stopped_scope = prefix+'external-exit'; stopped_case = report['externalExit'] = {}
    stopped_join = register(s, stopped_scope, stopped_case, single=False)
    st_identity, st_broker, st_endpoint, _, _, _ = attach(s,a,stopped_scope,stopped_join,stopped_case,log,held,endpoint_name='exit.sock',single=False)
    st_rid = stopped_join['identity']['runtimeId']
    s.wait(lambda: s.rows("SELECT 1 FROM hrc_events WHERE runtime_id=? AND event_kind='turn.completed'",(st_rid,)),180,'external initial turn')
    rpc = Rpc(st_endpoint); stopped_case['stop'] = rpc.call('invocation.stop',{'invocationId':st_identity['invocationId'],'reason':'host stopped its seat'}); rpc.close()
    # Live terminal delivery can lag even though the external broker accepted
    # stop and wrote invocation.exited. Record that unchanged owner behavior.
    time.sleep(2)
    stopped_case['beforeReplayRuntime'] = s.rows('SELECT status FROM runtimes WHERE runtime_id=?',(st_rid,))
    stopped_case['beforeReplayAttempt'] = s.rows('SELECT state FROM participant_registration_attempts WHERE attempt_id=?',(stopped_join['identity']['attemptId'],))
    n = len(knocks()); stopped_case['beforeReplayEnsure'] = s.http('POST','/v1/targets/ensure',{'sessionRef':stopped_scope+'/lane:main','runtimeIntent':{}})
    assert len(knocks()) == n + int(stopped_case['beforeReplayAttempt'][0]['state'] in ('ABANDONED','SUPERSEDED','TERMINAL'))
    # Existing participant driver proves external exit by replay on reconnect.
    s.down(owner); owner = s.up('native','external-replay')
    s.wait(lambda: s.rows("SELECT 1 FROM runtimes WHERE runtime_id=? AND status='stopped'",(st_rid,)),30,'external stopped after replay')
    stopped_case['runtime'] = s.rows('SELECT status FROM runtimes WHERE runtime_id=?',(st_rid,))
    stopped_case['attempt'] = s.rows('SELECT state FROM participant_registration_attempts WHERE attempt_id=?',(stopped_join['identity']['attemptId'],))
    assert stopped_case['attempt'] == [{'state':'TERMINAL'}], stopped_case
    n = len(knocks()); stopped_case['ensure'] = s.http('POST','/v1/targets/ensure',{'sessionRef':stopped_scope+'/lane:main','runtimeIntent':{}})
    assert stopped_case['ensure'][0] == 409 and len(knocks()) == n+1, stopped_case
    stopped_case['terminateWithoutDisposition'] = s.http('POST','/v1/terminate',{'runtimeId':st_rid,'dropContinuation':False})
    assert stopped_case['terminateWithoutDisposition'][0] == 200
    empty = s.rows('SELECT disposition,disposition_at FROM participant_address_reservations WHERE scope_ref=?',(stopped_scope,))
    assert empty == [{'disposition':None,'disposition_at':None}], empty
    # A real HRC-owned runtime remains available after the invalid field.
    cold = s.command('ordinary-start',['hrc','start',prefix+'ordinary','--project-id',s.project_id,'--project-root',s.project,'--cwd',s.project,'--json','-p','Reply exactly OK. No tools.'])
    ordinary = cold['runtime']['runtimeId']; s.wait_completed(cold['runtime']['runId'])
    before = s.rows('SELECT * FROM runtimes WHERE runtime_id=?',(ordinary,))
    report['ordinaryTerminate'] = s.http('POST','/v1/terminate',{'runtimeId':ordinary,'disposition':'parked'})
    assert report['ordinaryTerminate'][0] == 400, report['ordinaryTerminate']
    assert s.rows('SELECT * FROM runtimes WHERE runtime_id=?',(ordinary,)) == before
    report['ordinaryStillAvailable'] = before[0]['status']
    assert before[0]['status'] in ('ready','busy'), before
    report['pass'] = True
finally:
    (s.artifacts/'result.json').write_text(json.dumps(report,indent=2)+'\n')
    (s.artifacts/'steps.json').write_text(json.dumps(s.steps,indent=2)+'\n')
    s.cleanup(prefix)
    log.close()
print(json.dumps({'pass':True,'artifacts':str(s.artifacts)}))
