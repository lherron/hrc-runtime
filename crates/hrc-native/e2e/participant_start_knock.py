#!/usr/bin/env python3
"""T-13190 exact-claim acceptance on a real private daemon; outside verify.

Run once with --expect-before before changing start.rs, then without it on
the built fix. A real participant broker becomes ACTIVE and is externally
parked. Only placement authority is seeded in the private store.
"""
import argparse
import json
import sqlite3
import time
import uuid
from pathlib import Path

from n2_scratch import Scratch
from n2_participant import register, attach
from n4_federation import local_tailnet_address, free_port

p = argparse.ArgumentParser(description=__doc__)
for key in ('binary', 'scratch-root', 'artifacts', 'aspd-socket'):
    p.add_argument('--' + key, type=Path, required=True)
p.add_argument('--expect-before', action='store_true')
a = p.parse_args()
a.owner = 'native'
s = Scratch(a.scratch_root, None, a.aspd_socket, a.binary, a.artifacts,
            project_id='n2-t13190')
s.env['HRC_METRICS'] = '0'
prefix = 'agent:tabularasa:project:n2-t13190:task:'
scope = prefix + 'host'
report, held = {'expectBefore': a.expect_before, 'cases': {}}, {}
log = (s.artifacts / 'broker.log').open('w')


def sql(statement, params=()):
    with sqlite3.connect(s.db_path) as db:
        db.execute(statement, params)


def authority(address):
    sql("INSERT INTO placement_ledger(scope_ref,home_node_id,state,created_at,updated_at) "
        "VALUES (?,?,'active',?,?)", (address, s.project_id, '2026-11-10T00:00:00Z',
                                     '2026-11-10T00:00:00Z'))


def knocks():
    return s.rows("SELECT * FROM hrc_events WHERE event_kind='participant.host_requested' ORDER BY hrc_seq")


def start(name, address, policy='reject', intent=None):
    body = {'conflictPolicy': policy, 'summonIntent': 'implicit',
            'idempotencyKey': str(uuid.uuid4()),
            'runtimeIntent': intent or {'harness': {'id': 'claude-code', 'interactive': False}},
            'sessionRef' if policy == 'reject' else 'baseSessionRef': address + '/lane:main'}
    result = s.http('POST', '/v1/runtimes/start', body)
    report['cases'][name] = {'request': body, 'response': result, 'knocks': knocks()}
    return result


def occupied(result):
    assert result[0] == 409, result
    error = result[1]['error']
    assert error['code'] == 'session_scope_occupied', result
    assert error['detail']['retryable'] is False, result


try:
    s.init_substrate()
    (s.root / 'run/btmux').mkdir()
    ip = local_tailnet_address()
    (s.root / 'federation.json').write_text(json.dumps({
        'nodeId': s.project_id, 'peers': {},
        'registry': {'bind': f'http://{ip}:{free_port(ip)}'},
        'gate': {'mode': 'enforce', 'registryHost': s.project_id}}))
    s.up('native', 'start-knock')
    case = report['participant'] = {}
    joined = register(s, scope, case)
    authority(scope)
    # Pending establishment is occupied, never a knock.
    occupied(start('pending', scope))
    assert not knocks()
    _, broker, _, _, _, _ = attach(s, a, scope, joined, case, log, held)
    rid = joined['identity']['runtimeId']
    s.wait(lambda: s.rows("SELECT 1 FROM hrc_events WHERE runtime_id=? AND event_kind='turn.completed'",
                         (rid,)), 180, 'participant initial turn')
    occupied(start('serving', scope))
    assert not knocks()
    report['retire'] = s.http('POST', '/v1/terminate', {
        'runtimeId': rid, 'dropContinuation': False, 'disposition': 'parked'})
    assert report['retire'][0] == 200, report['retire']
    reservation = s.rows('SELECT * FROM participant_address_reservations WHERE scope_ref=?', (scope,))[0]
    report['parkedReservation'] = reservation
    assert reservation['state'] == 'held' and reservation['disposition'] == 'parked', reservation
    assert s.rows('SELECT state FROM participant_host_bindings WHERE runtime_id=?', (rid,)) == [{'state': 'BOUND'}]
    assert s.rows('SELECT state FROM participant_registration_attempts WHERE attempt_id=?',
                  (joined['identity']['attemptId'],)) == [{'state': 'ABANDONED'}]
    # The suffix path must skip the held base and birth the next slot, without
    # knocking even when the base host is not serving.
    ordinary = prefix + 'ordinary'
    for address in (scope + '-nova', ordinary):
        authority(address)
    status, placement = s.http('POST', '/v1/placements/resolve', {
        'scopeRef': ordinary, 'cwd': str(s.project), 'projectRoot': str(s.project)})
    assert status == 200, placement
    status, declaration = s.http('POST', '/v1/declarations/resolve', {
        'agentId': 'tabularasa', 'agentRoot': placement['agentRoot'],
        'projectId': s.project_id, 'projectRoot': str(s.project), 'cwd': str(s.project),
        'preferredMode': 'headless', 'interactive': False})
    assert status == 200, declaration
    intent = declaration['intent']
    intent.pop('initialPrompt', None)
    intent['harness']['id'] = 'claude-code'
    n = len(knocks())
    # Seed the unused slots too: the implicit suffix preflight checks every home.
    for token in ('comet', 'pulsar', 'quasar', 'meteor', 'aurora', 'zenith', 'eclipse', 'orbit', 'cosmos'):
        authority(scope + '-' + token)
    result = start('suffix-skips-parked', scope, 'suffix', intent)
    assert result[0] == 200 and result[1]['claim']['slot'] == 'host-nova', result
    assert len(knocks()) == n
    assert not s.rows('SELECT 1 FROM participant_address_reservations WHERE scope_ref=?', (ordinary,))
    result = start('ordinary-birth', ordinary, intent=intent)
    assert result[0] == 200, result
    occupied(start('ordinary-occupied', ordinary, intent=intent))
    assert len(knocks()) == n
    before = s.rows('SELECT * FROM sessions WHERE scope_ref=? ORDER BY host_session_id', (scope,))
    started_at = time.monotonic()
    for name in ('parked-first', 'parked-rate-limited'):
        result = start(name, scope)
        if a.expect_before:
            occupied(result)
            assert not knocks()
        else:
            assert result[0] == 409, result
            error = result[1]['error']
            assert error['code'] == 'stale_context', result
            assert error['detail']['reason'] == 'host_absent' and error['detail']['retryable'] is True, result
            assert error['message'].endswith('; the participant host is parked'), result
            assert len(knocks()) == 1, knocks()
            row = knocks()[0]
            assert row['host_session_id'] == 'hrc-participant' and row['generation'] == 0 and row['runtime_id'] is None, row
            assert row['scope_ref'] == scope and row['lane_ref'] == 'main', row
            assert json.loads(row['payload_json']) == {
                'scopeRef': scope, 'laneRef': 'main', 'reservationId': reservation['reservation_id'],
                'door': 'start', 'requestedAt': row['ts']}, row
        assert s.rows('SELECT * FROM sessions WHERE scope_ref=? ORDER BY host_session_id', (scope,)) == before
    report['summonPairSeconds'] = time.monotonic() - started_at
    assert report['summonPairSeconds'] < 30, report['summonPairSeconds']
    report['pass'] = True
finally:
    (s.artifacts / 'result.json').write_text(json.dumps(report, indent=2) + '\n')
    (s.artifacts / 'steps.json').write_text(json.dumps(s.steps, indent=2) + '\n')
    s.cleanup(prefix)
    log.close()
print(json.dumps({'pass': True, 'artifacts': str(s.artifacts)}))
