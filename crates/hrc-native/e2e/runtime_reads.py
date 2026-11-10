#!/usr/bin/env python3
"""Runtime reads against one native owner and one real deterministic seat.

The seat is a public birth (POST /v1/sessions/resolve then /v1/turns) on the
CLI lifecycle fixture (crates/hrc-cli/e2e/native_seat.py): private authority
and compiler, a leased hrc-pty substrate and the deterministic broker, no
model. Two historical runtimes (terminated, failed) on the same session are a
SQL fixture with no broker endpoint. Both are read back through the owner
before any case runs.

Failure modes: absent/empty seat, ignored filters or cursors, lost identity,
wrong refusal message/detail/precedence, stale owner diagnostics, fabricated
live probes, and accidental event ACK. Expectations are read off
placement/runtimes.rs (`query`, `list`, `seat`), runtime_views.rs (`inspect`,
`target`) and the server.rs route table; no comparison owner.

`main` is shared: maintenance.py passes its own cases, seed and judge.
"""
import argparse
import datetime
import json
from pathlib import Path
import sqlite3
import sys
import time
from urllib.parse import quote, urlencode

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'hrc-cli/e2e'))
from native_seat import Fixture  # noqa: E402
from metrics_isolation import isolated_suite  # noqa: E402
from n2_scratch import UnixHTTP  # noqa: E402

OLD = '2026-01-01T00:00:00.000Z'
HISTORY = (('old-a', 'terminated'), ('old-b', 'failed'))
INSERT_RUNTIME = ('INSERT INTO runtimes (runtime_id,host_session_id,scope_ref,lane_ref,generation,transport,status,'
                  'supports_inflight_input,created_at,updated_at) VALUES (?,?,?,?,?,?,?,0,?,?)')


def stamp(value):
    return datetime.datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp()


def arguments():
    p = argparse.ArgumentParser()
    p.add_argument('--binary', type=Path, required=True)
    p.add_argument('--artifacts', type=Path, required=True)
    p.add_argument('--scratch-root', type=Path, help='accepted and ignored: the seat fixture makes its own short /tmp root')
    return p


def seed_history(f, runtime, suffixes=HISTORY, transport='sdk'):
    """Historical rows on the live seat's session, through one store write; returns their ids."""
    live = f.s.rows('SELECT * FROM runtimes WHERE runtime_id=?', (runtime,))[0]
    with sqlite3.connect(f.s.db_path, timeout=30) as db:
        for suffix, status in suffixes:
            db.execute(INSERT_RUNTIME, (runtime + '-' + suffix, live['host_session_id'], live['scope_ref'], live['lane_ref'],
                                        live['generation'], transport, status, OLD, OLD))
    return [runtime + '-' + s for s, _ in suffixes]


def http(f, method, path, body=None):
    c = UnixHTTP(f.s.socket, 60)
    c.request(method, path, json.dumps(body) if body is not None else None, {'Content-Type': 'application/json'})
    res = c.getresponse()
    raw = res.read().decode()
    headers = {k.lower(): v for k, v in res.getheaders() if k.lower() == 'x-hrc-next-cursor'}
    c.close()
    try:
        return res.status, json.loads(raw), headers
    except json.JSONDecodeError:
        return res.status, raw, headers


def main(case_factory=None, judge=None, seed=None, observe=None, paginate=True):
    args = arguments().parse_args()
    args.artifacts.mkdir(parents=True, exist_ok=True)
    observations, failures = [], []
    with Fixture(args) as f:
        seat = f.birth(prompt='runtime reads fixture turn')
        runtime, host, scope = seat['runtimeId'], seat['hostSessionId'], seat['sessionRef'].split('/lane:')[0]
        context = {'runtime': runtime, 'host': host, 'scope': scope, 'fixture': f}
        context['history'] = seed_history(f, runtime)
        if seed:
            seed(context)
        # Owner readback before any case: the live seat and every historical row.
        status, listed, _ = http(f, 'GET', '/v1/runtimes?all=true')
        assert status == 200 and runtime in [r['runtimeId'] for r in listed], listed
        assert set(context['history']) <= {r['runtimeId'] for r in listed}, listed
        q = lambda **kw: '/v1/runtimes?' + urlencode(kw)
        cases = case_factory(context) if case_factory else read_cases(context, q)
        for name, method, path, body in cases:
            initial = observe(context) if observe else None
            before = time.time()
            status, value, headers = http(f, method, path, body)
            record = {'case': name, 'method': method, 'path': path, 'request': body, 'status': status, 'body': value,
                      'headers': headers, 'before': before, 'after': time.time(), 'ownerPid': f.s.owners[-1].pid}
            if name.startswith('seat') and status == 200:
                state = f.s.rows('SELECT runtime_state_json FROM runtimes WHERE runtime_id=?', (value['runtimeId'],))[0]['runtime_state_json']
                record['persistedProbe'] = json.loads(state or '{}').get('brokerDispatchDiagnostics', {}).get('liveSeatProbe')
            if observe:
                record.update(initial=initial, durable=observe(context))
            observations.append(record)
        if paginate:
            page = next(r for r in observations if r['case'] == 'runtimes-page')
            cursor = page['headers'].get('x-hrc-next-cursor', 'missing')
            path = q(all='true', limit='1', cursor=cursor)
            before = time.time()
            status, value, headers = http(f, 'GET', path)
            observations.append({'case': 'runtimes-next', 'method': 'GET', 'path': path, 'request': None, 'status': status,
                                 'body': value, 'headers': headers, 'before': before, 'after': time.time()})
        (args.artifacts / 'observations.json').write_text(json.dumps({'context': {k: v for k, v in context.items() if k != 'fixture'},
                                                                      'observations': observations}, indent=2) + '\n')
        failures = (judge or judge_reads)(observations, context)
        (args.artifacts / 'failures.json').write_text(json.dumps(failures, indent=2, default=str) + '\n')
    assert not failures, failures
    print(json.dumps({'pass': True, 'cases': len(observations), 'artifacts': str(args.artifacts)}))


def read_cases(c, q):
    runtime, host, scope = c['runtime'], c['host'], c['scope']
    old_a = c['history'][0]
    return [('runtimes', 'GET', '/v1/runtimes', None),
            ('runtimes-all', 'GET', q(all='true'), None),
            ('runtimes-page', 'GET', q(all='true', limit='1'), None),
            ('runtimes-terminal', 'GET', q(all='true', status='stale,terminated'), None),
            ('runtimes-terminal-hidden', 'GET', q(status='terminated'), None),
            ('runtimes-host', 'GET', q(hostSessionId=host), None),
            ('runtimes-scope', 'GET', q(scope=scope), None),
            ('runtimes-agent', 'GET', q(agent='tabularasa'), None),
            ('runtimes-task', 'GET', q(task=scope.rsplit(':', 1)[1]), None),
            ('runtimes-other-agent', 'GET', q(agent='absent'), None),
            ('runtimes-other-host', 'GET', q(hostSessionId='absent'), None),
            ('runtimes-status', 'GET', q(status='ready,busy'), None),
            ('runtimes-unknown-status', 'GET', q(status='absent'), None),
            ('runtimes-transport', 'GET', q(transport='headless'), None),
            ('runtimes-transport-live', 'GET', q(transport='hrcpty'), None),
            ('runtimes-stale', 'GET', q(stale='true', olderThan='24h'), None),
            ('runtimes-bool', 'GET', q(all='yes'), None),
            ('runtimes-transport-invalid', 'GET', q(transport='bad'), None),
            ('runtimes-limit-zero', 'GET', q(limit='0'), None),
            ('runtimes-limit-negative', 'GET', q(limit='-1'), None),
            ('runtimes-limit-fraction', 'GET', q(limit='1.2'), None),
            ('runtimes-limit-overflow', 'GET', q(limit='501'), None),
            ('runtimes-cursor', 'GET', q(cursor='bad'), None),
            ('runtimes-duration', 'GET', q(olderThan='24'), None),
            ('inspect', 'POST', '/v1/runtimes/inspect', {'runtimeId': runtime}),
            ('inspect-array', 'POST', '/v1/runtimes/inspect', []),
            ('inspect-number', 'POST', '/v1/runtimes/inspect', 1),
            ('inspect-owner-null', 'POST', '/v1/runtimes/inspect', {'runtimeId': runtime, 'ownerRunId': None}),
            ('inspect-owner-empty', 'POST', '/v1/runtimes/inspect', {'runtimeId': runtime, 'ownerRunId': ''}),
            ('inspect-trimmed', 'POST', '/v1/runtimes/inspect', {'runtimeId': ' ' + runtime + ' '}),
            ('inspect-missing', 'POST', '/v1/runtimes/inspect', {}),
            ('inspect-unknown', 'POST', '/v1/runtimes/inspect', {'runtimeId': 'absent'}),
            ('seat', 'GET', '/v1/runtimes/' + runtime + '/seat', None),
            ('seat-encoded', 'GET', '/v1/runtimes/' + quote(runtime[0], safe='').replace(runtime[0], '%%%02X' % ord(runtime[0])) + runtime[1:] + '/seat', None),
            ('seat-inactive', 'GET', '/v1/runtimes/' + old_a + '/seat', None),
            ('inspect-inactive', 'POST', '/v1/runtimes/inspect', {'runtimeId': old_a}),
            ('seat-unknown', 'GET', '/v1/runtimes/absent/seat', None),
            ('target', 'GET', '/v1/targets/by-session-ref?' + urlencode({'sessionRef': scope + '/lane:main'}), None),
            ('target-default', 'GET', '/v1/targets/by-session-ref?' + urlencode({'sessionRef': scope + '/lane:default'}), None),
            ('target-invalid', 'GET', '/v1/targets/by-session-ref?sessionRef=bad', None),
            ('target-missing', 'GET', '/v1/targets/by-session-ref', None),
            ('target-unknown', 'GET', '/v1/targets/by-session-ref?' + urlencode({'sessionRef': scope + '-absent/lane:main'}), None)]


def judge_reads(rows, c):
    failures = []
    by = {r['case']: r for r in rows}
    runtime, (old_a, old_b) = c['runtime'], c['history']

    def fail(name, what, value=None):
        failures.append((name, what, value if value is not None else {k: by[name].get(k) for k in ('status', 'body', 'headers')}))

    def bounded(name, at, start=None):
        return isinstance(at, str) and (start or by[name]['before']) - .01 <= stamp(at) <= by[name]['after'] + .01

    def unchanged_probe(name, probe):
        # controller/seat.rs record: an idle probe that changes nothing is not persisted, so the
        # retained observation is still the binding's, from before this request.
        return ((probe.get('availability'), probe.get('state'), probe.get('cause'), probe.get('invocationId')) ==
                ('current', 'idle', 'binding-established', by['seat']['body'].get('invocationId'))
                and isinstance(probe.get('observedAt'), str) and stamp(probe['observedAt']) < by[name]['before'])

    def listed(name, ids, cursor=False):
        r = by[name]
        got = [x['runtimeId'] for x in r['body']] if r['status'] == 200 and isinstance(r['body'], list) else None
        if got != ids:
            return fail(name, 'runtime ids')
        if ('x-hrc-next-cursor' in r['headers']) != cursor:
            fail(name, 'cursor header')
        for x in r['body']:
            want_status = {runtime: x['status'], old_a: 'terminated', old_b: 'failed'}[x['runtimeId']]
            if (x.get('hostSessionId'), x.get('scopeRef'), x.get('laneRef'), x.get('status')) != (c['host'], c['scope'], 'main', want_status) \
                    or x.get('identity', {}).get('agentId') != 'tabularasa':
                fail(name, 'row identity', x)
            if x['runtimeId'] == runtime and (x.get('transport'), x.get('controllerKind')) != ('hrcpty', 'harness-broker'):
                fail(name, 'live row', x)

    def refusal(name, status, code, message, detail):
        r = by[name]
        error = r['body'].get('error', {}) if isinstance(r['body'], dict) else {}
        if r['status'] != status or error.get('code') != code or error.get('message') != message or error.get('detail') != detail:
            fail(name, 'refusal')

    names = [r['case'] for r in rows]
    if len(names) != len(set(names)) or len(names) != 43:
        failures.append(('matrix', names))
    # Live runtimes only by default; terminal history only with all=true, ordered (statusRank, createdAt, runtimeId).
    for name in ('runtimes', 'runtimes-host', 'runtimes-scope', 'runtimes-agent', 'runtimes-task', 'runtimes-status', 'runtimes-transport-live'):
        listed(name, [runtime])
    listed('runtimes-all', [old_a, old_b, runtime])
    listed('runtimes-page', [old_a], cursor=True)
    listed('runtimes-next', [old_b], cursor=True)
    listed('runtimes-terminal', [old_a])  # the failed row is neither stale nor terminated
    for name in ('runtimes-terminal-hidden', 'runtimes-other-agent', 'runtimes-other-host', 'runtimes-unknown-status',
                 'runtimes-transport', 'runtimes-stale'):
        listed(name, [])
    if by['runtimes']['status'] == 200 and by['runtimes']['body'] and by['runtimes']['body'][0]['status'] != 'ready':
        fail('runtimes', 'completed deterministic seat is ready')
    refusal('runtimes-bool', 400, 'malformed_request', 'all must be a boolean', {'field': 'all', 'value': 'yes'})
    refusal('runtimes-transport-invalid', 400, 'malformed_request', 'transport must be one of: tmux, headless, sdk, hrcpty', {'field': 'transport', 'value': 'bad'})
    refusal('runtimes-limit-zero', 400, 'malformed_request', 'limit must be between 1 and 500', {'field': 'limit', 'value': 0})
    refusal('runtimes-limit-overflow', 400, 'malformed_request', 'limit must be between 1 and 500', {'field': 'limit', 'value': 501})
    refusal('runtimes-limit-negative', 400, 'malformed_request', 'limit must be a non-negative integer', {'field': 'limit', 'value': '-1'})
    refusal('runtimes-limit-fraction', 400, 'malformed_request', 'limit must be a non-negative integer', {'field': 'limit', 'value': '1.2'})
    refusal('runtimes-cursor', 400, 'malformed_request', 'cursor must be a runtime-list cursor returned by the server', {'field': 'cursor'})
    refusal('runtimes-duration', 400, 'malformed_request', 'olderThan must be a duration like 30m, 2h, or 24h', {'field': 'olderThan', 'value': '24'})
    refusal('inspect-array', 400, 'malformed_request', 'runtimeId is required', {'field': 'runtimeId'})
    refusal('inspect-missing', 400, 'malformed_request', 'runtimeId is required', {'field': 'runtimeId'})
    refusal('inspect-number', 400, 'malformed_request', 'request body must be an object', {})
    refusal('inspect-owner-null', 400, 'malformed_request', 'ownerRunId must be a string', {'field': 'ownerRunId'})
    refusal('inspect-owner-empty', 400, 'malformed_request', 'ownerRunId must be a string', {'field': 'ownerRunId'})
    refusal('inspect-unknown', 404, 'unknown_runtime', 'unknown runtime "absent"', {'runtimeId': 'absent'})
    refusal('seat-unknown', 404, 'unknown_runtime', 'unknown runtime "absent"', {'runtimeId': 'absent'})
    refusal('target-missing', 400, 'malformed_request', 'sessionRef is required', {'field': 'sessionRef'})
    unknown = c['scope'] + '-absent/lane:main'
    refusal('target-unknown', 404, 'unknown_session', f'unknown session "{unknown}"', {'sessionRef': unknown})
    # Inspect the live seat: identity, a probe of the actual broker during this request, attached control, bounded ages.
    for name in ('inspect', 'inspect-trimmed'):
        r = by[name]; b = r['body'] if isinstance(r['body'], dict) else {}
        probe = b.get('brokerDispatch', {}).get('liveSeatProbe', {})
        ok = (r['status'] == 200 and b.get('runtimeId') == runtime and b.get('hostSessionId') == c['host'] and b.get('transport') == 'hrcpty'
              and b.get('controllerKind') == 'harness-broker' and b.get('status') == 'ready'
              and b.get('brokerDispatch', {}).get('agreement') == 'agree' and probe.get('state') == 'idle'
              and unchanged_probe(name, probe)
              and (b.get('control') or {}).get('brokerAttached') is True)
        if not ok:
            fail(name, 'live inspect', b)
        for key, source in (('createdAgeSec', 'createdAt'), ('lastActivityAgeSec', 'lastActivityAt')):
            at = b.get(source)
            age = b.get(key)
            if at is None and source == 'lastActivityAt':
                ok = age is None
            else:
                ok = isinstance(age, int) and max(0, int(r['before'] - stamp(at))) <= age <= max(0, int(r['after'] - stamp(at)) + 1)
            if not ok:
                fail(name, key, (age, at))
    r = by['inspect-inactive']; b = r['body'] if isinstance(r['body'], dict) else {}
    if r['status'] != 200 or (b.get('runtimeId'), b.get('status'), b.get('transport')) != (old_a, 'terminated', 'sdk') or 'brokerDispatch' in b:
        fail('inspect-inactive', 'historical inspect')
    # Seat: the real broker answers idle on the live invocation, alongside its committed sequence.
    for name in ('seat', 'seat-encoded'):
        r = by[name]; b = r['body'] if isinstance(r['body'], dict) else {}
        inv = b.get('invocationId')
        ok = (r['status'] == 200 and b.get('runtimeId') == runtime and isinstance(inv, str) and inv
              and isinstance(b.get('currentBrokerSeq'), int) and b['currentBrokerSeq'] > 0 and b.get('probeError') is None
              and (b.get('probe') or {}).get('invocationId') == inv and (b.get('probe') or {}).get('seat') == {'state': 'idle'})
        if not ok:
            fail(name, 'live seat')
        if not unchanged_probe(name, r.get('persistedProbe') or {}):
            fail(name, 'an unchanged idle probe leaves the retained observation', r.get('persistedProbe'))
    r = by['seat-inactive']; b = r['body'] if isinstance(r['body'], dict) else {}
    if r['status'] != 200 or (b.get('runtimeId'), b.get('invocationId'), b.get('currentBrokerSeq'), b.get('probe')) != (old_a, None, None, None) or not b.get('probeError'):
        fail('seat-inactive', 'no invocation: no sequence, no probe, a probe error')
    # A failed probe is a change: recorded unavailable, during this request.
    persisted = r.get('persistedProbe') or {}
    if (persisted.get('availability'), persisted.get('cause'), persisted.get('invocationId')) != ('unavailable', 'explicit-probe', None) \
            or not bounded('seat-inactive', persisted.get('observedAt')) or b.get('probeError', {}).get('code') != 'broker_runtime_not_active':
        fail('seat-inactive', 'unavailable probe recorded', persisted)
    # Target: the session's main lane is bound to the live runtime; default is main.
    for name in ('target', 'target-default'):
        r = by[name]; b = r['body'] if isinstance(r['body'], dict) else {}
        if r['status'] != 200 or b.get('state') != 'bound' or (b.get('runtime') or {}).get('runtimeId') != runtime:
            fail(name, 'bound target')
    refusal('target-invalid', 400, 'invalid_selector', 'sessionRef must use "<scopeRef>/lane:<laneRef>" format', {'sessionRef': 'bad'})
    return failures


if __name__ == '__main__':
    isolated_suite(main)()
