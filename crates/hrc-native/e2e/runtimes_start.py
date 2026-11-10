#!/usr/bin/env python3
"""Native exact/suffix claim, replay, refusal and ensure/reuse contracts.

Expected hashes independently implement broker/start.rs Claim::parse: sorted
JSON keys, no timestamp elision, null absent restartStyle, implicit summonIntent
included for exact and implicit suffix only. No producer executable is an oracle.
"""
import copy
import hashlib
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'crates/hrc-cli/e2e'))
from native_seat import Fixture, arguments
from metrics_isolation import isolated_suite
from n4_federation import local_tailnet_address, free_port

PROJECT = 'n5-t11819'
AGENT = 'tabularasa'


def scope(task):
    return f'agent:{AGENT}:project:{PROJECT}:task:{task}'


def claim_hash(body):
    policy = body['conflictPolicy']
    field = 'sessionRef' if policy == 'reject' else 'baseSessionRef'
    hashed = {field: body[field], 'conflictPolicy': policy,
              'runtimeIntent': body['runtimeIntent'], 'restartStyle': body.get('restartStyle')}
    if policy == 'reject' or body.get('summonIntent') == 'implicit':
        hashed['summonIntent'] = 'implicit'
    return hashlib.sha256(json.dumps(hashed, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()).hexdigest()


def expectations(side):
    """Independent native statuses, identities, replay and claim hash contract."""
    c, failures = side['cases'], []

    def want(name, status, code=None):
        got = c.get(name)
        if got is None:
            return failures.append(f'{name}: case not run')
        body = got['body'] if isinstance(got['body'], dict) else {}
        err = body.get('error', {}) if isinstance(body.get('error'), dict) else {}
        if err.get('code') == 'route.not_served' or 'not_served' in json.dumps(body):
            failures.append(f'{name}: route not served ({got["status"]} {body})')
        elif got['status'] != status or (code and err.get('code') != code):
            failures.append(f'{name}: want {status} {code or ""}, got {got["status"]} {err.get("code")}')

    want('exact.claim', 200)
    want('exact.replay', 200)
    want('exact.occupied', 409, 'session_scope_occupied')
    want('exact.key-conflict', 409, 'idempotency_key_conflict')
    want('suffix.base', 200)
    want('suffix.next', 200)
    want('suffix.replay', 200)
    want('suffix.explicit-local', 200)
    want('ensure.start', 200)
    want('ensure.reuse', 200)
    for name in ('ensure.allow-stale', 'ensure.default-style', 'ensure.claimed-seat'):
        want(name, 200)
    want('ensure.unknown-host', 404, 'unknown_host_session')
    want('ensure.no-intent', 422, 'missing_runtime_intent')
    want('exact.explicit-local-refused', 400, 'malformed_request')
    for name in ('bad.policy', 'bad.suffix-host', 'bad.suffix-no-key'):
        want(name, 400, 'malformed_request')
    want('bad.exact-no-intent', 422, 'missing_runtime_intent')
    if failures:
        return failures
    claim = lambda n: c[n]['body'].get('claim', {})
    if claim('exact.claim').get('replayed') is not False or claim('exact.replay').get('replayed') is not True:
        failures.append('exact replay flag')
    if c['exact.claim']['body']['hostSessionId'] != c['exact.replay']['body']['hostSessionId']:
        failures.append('exact replay changed hostSessionId')
    for name, result in c.items():
        if result['status'] >= 400 and result['mutated']:
            failures.append(name + ': refusal mutated rows')
    if [claim(n).get('slot') for n in ('suffix.base', 'suffix.next', 'suffix.replay')] != ['sx1', 'sx1-nova', 'sx1']:
        failures.append('suffix slots: ' + str([claim(n).get('slot') for n in ('suffix.base', 'suffix.next', 'suffix.replay')]))
    if any(c['ensure.start']['body'].get('runtimeId') != c[name]['body'].get('runtimeId')
           for name in ('ensure.reuse', 'ensure.allow-stale', 'ensure.default-style')):
        failures.append('ensure reuse birthed a second runtime')
    for k, ok in side['hashMatchesSpec'].items():
        if not ok:
            failures.append(f'roster_claims.request_hash for {k} differs from the canonical claim hash')
    return failures


@isolated_suite
def main():
    args = arguments().parse_args()
    with Fixture(args) as f:
        s = f.s
        s.down(s.owners[-1])
        config = s.root / 'federation.json'
        config.write_text(json.dumps({'nodeId': 'max3', 'peers': {},
            'registry': {'bind': f'http://{local_tailnet_address()}:{free_port()}'},
            'gate': {'mode': 'enforce', 'registryHost': 'max3'}}))
        config.chmod(0o600)
        s.up('native', 'claims')
        cases, hashes = {}, {}
        def snapshot(scopes):
            marks = ','.join('?' * len(scopes))
            rows = {
                'sessions': s.rows(f'SELECT scope_ref,lane_ref,generation,status,host_session_id,prior_host_session_id '
                                   f'FROM sessions WHERE scope_ref IN ({marks}) ORDER BY created_at,host_session_id', scopes),
                'continuities': s.rows(f'SELECT scope_ref,lane_ref,active_host_session_id FROM continuities '
                                       f'WHERE scope_ref IN ({marks}) ORDER BY scope_ref', scopes),
                'runtimes': s.rows(f'SELECT scope_ref,host_session_id,runtime_id,transport,harness,provider,status,'
                                   f'controller_kind FROM runtimes WHERE scope_ref IN ({marks}) '
                                   f'ORDER BY created_at,runtime_id', scopes),
                'rosterClaims': s.rows(f'SELECT idempotency_key,base_scope,claimed_scope,successor_host_session_id '
                                       f'FROM roster_claims WHERE claimed_scope IN ({marks}) OR base_scope IN ({marks}) '
                                       f'ORDER BY created_at,idempotency_key', scopes + scopes),
            }
            return rows

        def events_since(seq, scopes):
            marks = ','.join('?' * len(scopes))
            out = []
            for e in s.rows(f'SELECT event_kind,scope_ref,payload_json FROM hrc_events WHERE hrc_seq>? '
                            f'AND scope_ref IN ({marks}) ORDER BY hrc_seq', (seq, *scopes)):
                payload = json.loads(e['payload_json'] or '{}')
                keep = {k: payload[k] for k in ('reason', 'created', 'trigger', 'exactScope', 'baseScope',
                                                'dropContinuation', 'relaunch') if k in payload}
                out.append({'kind': e['event_kind'], 'scope': e['scope_ref'], **keep})
            # Broker/turn lifecycle kinds are covered by the birth suites; count claim-path kinds exactly.
            return [e for e in out if e['kind'].startswith(('session.', 'runtime.created', 'runtime.started'))]

        def seq():
            return s.rows('SELECT COALESCE(MAX(hrc_seq),0) AS m FROM hrc_events')[0]['m']

        def case(name, body, scopes, path='/v1/runtimes/start'):
            before, mark = snapshot(scopes), seq()
            status, value = s.http('POST', path, body, timeout=240)
            after = snapshot(scopes)
            cases[name] = {'request': body, 'status': status, 'body': value, 'rows': after,
                           'mutated': before != after, 'events': events_since(mark, scopes)}
            return status, value

        def intent_for(task, kernel=True):
            intent = copy.deepcopy(f.intent)
            if kernel:
                intent['placement'].setdefault('correlation', {})['sessionRef'] = scope(task) + '/lane:main'
            return intent

        # A: exact claim (kernel summon / iOS reject / force-primary create).
        ex = scope('ex1')
        exact = {'sessionRef': ex + '/lane:main', 'runtimeIntent': intent_for('ex1'), 'conflictPolicy': 'reject',
                 'summonIntent': 'implicit', 'idempotencyKey': f'rs-native-exact-1', 'restartStyle': 'reuse_pty'}
        hashes['exact'] = claim_hash(exact)
        case('exact.claim', exact, [ex])
        case('exact.replay', exact, [ex])
        case('exact.occupied', {**exact, 'idempotencyKey': f'rs-native-exact-2'}, [ex])
        case('exact.key-conflict', {**exact, 'restartStyle': 'fresh_pty'}, [ex])
        case('exact.explicit-local-refused', {**exact, 'summonIntent': 'explicit_local',
                                              'idempotencyKey': f'rs-native-exact-3'}, [ex])

        # B: suffix roster, implicit (kernel --fresh / iOS roster) then explicit_local (hrc start --on-conflict suffix).
        sx = [scope('sx1'), scope('sx1-nova'), scope('sx1-comet')]
        suffix = {'baseSessionRef': sx[0] + '/lane:main', 'runtimeIntent': intent_for('sx1'), 'conflictPolicy': 'suffix',
                  'summonIntent': 'implicit', 'idempotencyKey': f'rs-native-suffix-1', 'restartStyle': 'reuse_pty'}
        hashes['suffix'] = claim_hash(suffix)
        case('suffix.base', suffix, sx)
        case('suffix.next', {**suffix, 'idempotencyKey': f'rs-native-suffix-2'}, sx)
        case('suffix.replay', suffix, sx)
        sy = [scope('sy1'), scope('sy1-nova')]
        local = {'baseSessionRef': sy[0] + '/lane:main', 'runtimeIntent': intent_for('sy1'), 'conflictPolicy': 'suffix',
                 'summonIntent': 'explicit_local', 'idempotencyKey': f'rs-native-local-1', 'restartStyle': 'reuse_pty'}
        hashes['suffixLocal'] = claim_hash(local)
        case('suffix.explicit-local', local, sy)

        # C: ensure shape on an existing session (workflow interact, launch successor, hrc start/resume no prompt).
        en = scope('en1')
        en_intent = intent_for('en1', kernel=False)
        status, resolved = s.http('POST', '/v1/sessions/resolve', {
            'sessionRef': en + '/lane:main', 'runtimeIntent': en_intent, 'create': True})
        assert status == 200 and resolved.get('hostSessionId'), resolved
        host = resolved['hostSessionId']
        case('ensure.start', {'hostSessionId': host, 'intent': en_intent, 'restartStyle': 'reuse_pty'}, [en])
        case('ensure.reuse', {'hostSessionId': host, 'intent': en_intent, 'restartStyle': 'reuse_pty'}, [en])
        case('ensure.allow-stale', {'hostSessionId': host, 'intent': en_intent, 'restartStyle': 'reuse_pty',
                                    'allowStaleGeneration': True}, [en])
        case('ensure.default-style', {'hostSessionId': host, 'intent': en_intent}, [en])
        claimed = cases['exact.claim']['body'].get('hostSessionId') if isinstance(cases['exact.claim']['body'], dict) else None
        if claimed:
            # Force-primary launch successor: ensure on the exact-claimed seat reuses its runtime.
            case('ensure.claimed-seat', {'hostSessionId': claimed, 'intent': exact['runtimeIntent'],
                                         'restartStyle': 'reuse_pty', 'allowStaleGeneration': True}, [ex])
        case('ensure.unknown-host', {'hostSessionId': 'hsid-00000000-0000-0000-0000-000000000000',
                                     'intent': en_intent}, [en])
        case('ensure.no-intent', {'hostSessionId': host}, [en])

        # Malformed shapes: parser refusals before any routing.
        case('bad.policy', {**exact, 'conflictPolicy': 'bogus'}, [ex])
        case('bad.suffix-host', {**suffix, 'hostSessionId': host}, sx)
        case('bad.suffix-no-key', {k: v for k, v in suffix.items() if k != 'idempotencyKey'}, sx)
        case('bad.exact-no-intent', {k: v for k, v in exact.items() if k != 'runtimeIntent'}, [ex])

        # Claim-bound initial messages are delivered only by the pinned turn.
        # This retains the former deferred-message qualification deterministically.
        for policy in ('reject', 'suffix'):
            task = 'deferred-' + policy
            target = scope(task)
            launch = intent_for(task)
            bound = {**launch, 'initialPrompt': 'fixture deferred CONT ' + policy}
            key = 'deferred-' + policy
            request = {'runtimeIntent': bound, 'conflictPolicy': policy, 'idempotencyKey': key,
                       'restartStyle': 'reuse_pty', 'summonIntent': 'implicit',
                       'sessionRef' if policy == 'reject' else 'baseSessionRef': target + '/lane:main'}
            code, claimed = case(policy + '.deferred-claim', request, [target])
            assert code == 200, (code, claimed)
            host = claimed['hostSessionId']
            assert not s.rows('SELECT * FROM inputs WHERE host_session_id=?', (host,)), 'claim delivered initial message'
            turn = {'hostSessionId': host, 'idempotencyKey': key, 'prompt': bound['initialPrompt'],
                    'runtimeIntent': launch, 'waitFor': 'accepted', 'waitForCompletion': False}
            code, dispatched = case(policy + '.pinned-turn', turn, [target], '/v1/turns')
            assert code in (200, 202) and dispatched.get('runId'), (code, dispatched)
            s.wait_completed(dispatched['runId'], 30)
            code, repeated = case(policy + '.claim-replay', request, [target])
            assert code == 200 and repeated['hostSessionId'] == host and repeated['claim']['replayed'] is True
            code, replay = case(policy + '.turn-replay', turn, [target], '/v1/turns')
            runs = s.rows('SELECT run_id FROM runs WHERE host_session_id=? AND dispatch_idempotency_key=?', (host, key))
            assert code in (200, 202) and replay['runId'] == dispatched['runId'] and len(runs) == 1, (code, replay, runs)
            code, changed = case(policy + '.changed-message', {**request, 'runtimeIntent': {**bound, 'initialPrompt': 'changed'}}, [target])
            assert code == 409 and changed['error']['code'] == 'idempotency_key_conflict'
            code, refused = case(policy + '.ensure-prompt', {'hostSessionId': host, 'intent': bound}, [target])
            assert code == 503 and refused['error']['detail']['reason'] == 'start-prompt-not-ported', (code, refused)

        stored = {r['idempotency_key']: r['request_hash'] for r in s.rows('SELECT * FROM roster_claims')}
        hash_check = {name: stored.get(request['idempotencyKey']) == hashes[name]
                      for name, request in [('exact', exact), ('suffix', suffix), ('suffixLocal', local)]}
        side = {'cases': cases, 'hashMatchesSpec': hash_check}
        failures = expectations(side)
        value = dict(cases=side['cases'], hashMatchesSpec=hash_check, failures=failures, **{'pass': not failures})
        (args.artifacts / 'results.json').write_text(json.dumps(value, indent=2) + '\n')
        assert not failures, failures
        print(json.dumps({'pass': True, 'cases': len(cases)}))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
