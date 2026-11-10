#!/usr/bin/env python3
"""Session projection on one native owner: recency, liveness, ordering and parsing.

Failures: housekeeping warms history, old live seats withheld, wrong lane or
scope selection, collapse performed before the window, ignored boolean aliases,
wrong error precedence, count headers that do not count, or reads mutating
durable rows. Expectations are read off server/projection/sessions.rs `list`
and hrc-store index.rs (`sessions_for_projection`, `recent_sessions`,
`retain_latest_generation`); an empty result is never success on its own.

Seed: the sessions/continuities/runtimes INSERTs below, on a schema the native
`store migrate` created, read back through GET /v1/sessions before any case.
"""
import argparse, datetime, json, os, shutil, signal, sqlite3, subprocess, time
from pathlib import Path
from http.client import HTTPException
from urllib.parse import urlencode
from foundation import daemon_env, UnixHTTP

stamp = lambda t: datetime.datetime.fromtimestamp(t, datetime.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
OLD = '2026-01-01T00:00:00.000Z'
# host, scope suffix, lane, generation, created, status. A cold head with a warm
# predecessor proves selection precedes generation collapse.
FIXTURES = [('cold', 'z', 'main', 1, 'old', 'active'), ('recent', 'a', 'main', 1, 'now', 'active'),
            ('index', 'b', 'main', 1, 'old', 'active'), ('runtime', 'c', 'main', 1, 'old', 'active'),
            ('live', 'd', 'main', 1, 'old', 'active'), ('active-run', 'e', 'main', 1, 'old', 'active'),
            ('prior', 'f', 'main', 1, 'now', 'archived'), ('head', 'f', 'main', 2, 'old', 'active'),
            ('alternate', 'f', 'alternate', 1, 'old', 'active')]
# ORDER BY scope_ref, lane_ref, generation: suffixes a..f, alternate < main, z, then system:.
ALL = ['recent', 'index', 'runtime', 'live', 'active-run', 'alternate', 'prior', 'head', 'cold', 'summary']
# Seven-day window: created/index/runtime activity now, an available runtime, an active run.
WINDOW = ['recent', 'index', 'runtime', 'live', 'active-run', 'prior']
SCOPE_F = ['alternate', 'prior', 'head']
# case -> host order (200) or (field, trimmed value, message) (400)
EXPECT = {
    'system-summary': ['summary'], 'default': WINDOW, 'kernel': WINDOW, 'all': ALL, 'yes': ALL,
    'all-invalid-since': ALL,  # all=1 drops the cutoff, so updatedSince is never parsed
    'scoped-history': SCOPE_F, 'scoped-invalid-since': SCOPE_F,  # scoped reads keep history; scopeRef is trimmed
    'lane': ['alternate'], 'latest-scoped': ['alternate', 'head'], 'latest-status': [],
    'status-trimmed': ['prior'], 'hex-limit': ['recent', 'index'],
    'invalid-since': ('updatedSince', 'bad', 'updatedSince must be an ISO-8601 timestamp'),
    'invalid-status-first': ('status', 'nope', 'status must be one of active, archived'),
    'invalid-limit-first': ('limit', '0', 'limit must be an integer >= 1'),
    'date-only': WINDOW, 'offset': WINDOW,
    'config-zero': ['live', 'active-run'],  # zero days: only liveness admits a seat
    'config-prefix': ALL,  # parseFloat('1000days') = 1000
    'config-invalid': WINDOW,  # negative falls back to seven days
}


def main():
    p = argparse.ArgumentParser()
    for key in ['binary', 'scratch-root', 'artifacts']:
        p.add_argument('--' + key, type=Path, required=True)
    a = p.parse_args()
    root = a.scratch_root.absolute(); assert not root.exists(); root.mkdir(parents=True)
    a.artifacts.mkdir(parents=True, exist_ok=True)
    assert not any(os.environ.get(k) for k in ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CODEX_SANDBOX'])
    env = dict(os.environ, HRC_RUNTIME_DIR=str(root / 'run'), HRC_STATE_DIR=str(root / 'state'), HRC_PEER_CONFIG_FILE=str(root / 'absent.json'),
               HRC_ACP_WEBHOOK_URL='', HRC_EVENT_INGEST_SOCKET=str(root / 'run/ingest.sock'), HRC_WRKQ_DB=str(root / 'wrkq.db'), WRKQ_DB=str(root / 'wrkq.db'), HRC_METRICS='0')
    for k in ['HRC_SESSION_REF', 'HRC_RUNTIME_ID', 'HRC_RUN_ID', 'HRC_HOST_SESSION_ID', 'HRC_EVENT_FORWARD_URL', 'HRC_EVENT_INGEST_TCP_PORT', 'HRC_EVENT_FORWARD_SOURCE_REF',
              'WRKQ_DB_PATH', 'WRKQ_DB_PATH_FILE', 'WRKQD_UNIX', 'WRKQD_TOKEN', 'WRKQD_TOKEN_FILE', 'WRKQD_NODE_TOKENS', 'WRKQD_NODE_TOKENS_FILE', 'HRC_SESSION_PROJECTION_DAYS']:
        env.pop(k, None)
    state = root / 'state/state.sqlite'
    now = stamp(time.time()); since = stamp(time.time() - 86400)
    clock = {'old': OLD, 'now': now}
    scope = 'agent:tabularasa:project:n1-t11818:task:projection-' + str(time.time_ns())
    proc = log = None

    def call(path):
        c = UnixHTTP(root / 'run/hrc.sock'); c.request('GET', path); r = c.getresponse(); body = json.loads(r.read())
        headers = {k.lower(): v for k, v in r.getheaders() if k.lower().startswith('x-hrc-session-')}; c.close()
        return {'status': r.status, 'body': body, 'headers': headers}

    def down():
        nonlocal proc, log
        if proc and proc.poll() is None:
            proc.send_signal(signal.SIGTERM); proc.wait(timeout=20)
        if log: log.close()
        proc = log = None

    def up(label):
        nonlocal proc, log
        log = (a.artifacts / (label + '.log')).open('w')
        # Third argument False: the daemon PATH gains no JS runtime directory.
        proc = subprocess.Popen([str(a.binary.resolve()), 'server'], env=daemon_env(env, (), False), cwd=root, stdout=log, stderr=log)
        for _ in range(300):
            assert proc.poll() is None, label + ' exited'
            try:
                if call('/v1/health')['status'] == 200: return
            except (OSError, HTTPException): pass
            time.sleep(.05)
        raise RuntimeError('not ready')

    def seed():
        with sqlite3.connect(state) as db:
            for host, suffix, lane, generation, created, status in FIXTURES:
                db.execute('INSERT INTO sessions(host_session_id,scope_ref,lane_ref,generation,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',
                           ('hsid-n1-' + host, scope + '-' + suffix, lane, generation, status, clock[created], now))
            for host, suffix, lane, generation, created, status in FIXTURES:
                db.execute('INSERT INTO continuities(scope_ref,lane_ref,active_host_session_id,updated_at,scope_kind,agent_id,project_id,task_id) VALUES(?,?,?,?,?,?,?,?) '
                           'ON CONFLICT(scope_ref,lane_ref) DO UPDATE SET active_host_session_id=excluded.active_host_session_id',
                           (scope + '-' + suffix, lane, 'hsid-n1-' + host, now, 'project-task', 'tabularasa', 'n1-t11818', scope.split(':task:')[1] + '-' + suffix))
            # The sweep summary session: a durable session without a continuity.
            db.execute('INSERT INTO sessions(host_session_id,scope_ref,lane_ref,generation,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',
                       ('hsid-n1-summary', 'system:hrc/sweep', 'default', 1, 'active', OLD, OLD))
            # updated_at is "now" everywhere: a cosmetic clock that must not warm cold sessions.
            for host, status, activity, run in [('runtime', 'terminated', now, None), ('live', 'awaiting_input', OLD, None), ('active-run', 'terminated', OLD, 'run-n1-placeholder')]:
                suffix = next(x[1] for x in FIXTURES if x[0] == host)
                db.execute('INSERT INTO runtimes(runtime_id,host_session_id,scope_ref,lane_ref,generation,transport,status,supports_inflight_input,last_activity_at,active_run_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
                           ('runtime-n1-' + host, 'hsid-n1-' + host, scope + '-' + suffix, 'main', 1, 'sdk', status, 0, activity, run, OLD, OLD))
            # Runtime inserts may advance session_index; restore each fixture's declared clock, then warm only `index`.
            for host, _, _, _, created, _ in FIXTURES:
                db.execute('UPDATE session_index SET last_activity_at=? WHERE host_session_id=?', (now if host == 'index' else clock[created], 'hsid-n1-' + host))

    def durable():
        with sqlite3.connect('file:' + str(state) + '?mode=ro', uri=True) as db:
            return {t: db.execute('SELECT * FROM ' + t + ' ORDER BY 1').fetchall() for t in ['sessions', 'runtimes', 'session_index']}

    q = lambda **kw: '/v1/sessions?' + urlencode(kw)
    cases = [('system-summary', q(scopeRef='system:hrc/sweep')), ('default', '/v1/sessions'), ('kernel', q(updatedSince=since, latestGeneration='true')),
             ('all', q(all='true')), ('yes', q(all=' YES ')), ('all-invalid-since', q(all='1', updatedSince='bad')),
             ('scoped-history', q(scopeRef=scope + '-f', updatedSince=since)), ('scoped-invalid-since', q(scopeRef=' ' + scope + '-f ', updatedSince='bad')),
             ('lane', q(scopeRef=scope + '-f', laneRef=' alternate ')), ('latest-scoped', q(scopeRef=scope + '-f', latestGeneration='YES')),
             ('latest-status', q(scopeRef=scope + '-f', latestGeneration='true', status='archived')), ('status-trimmed', q(all='true', status=' archived ')),
             ('hex-limit', q(all='true', limit='0x2')), ('invalid-since', q(updatedSince=' bad ')), ('invalid-status-first', q(status=' nope ', updatedSince='bad')),
             ('invalid-limit-first', q(limit='0', updatedSince='bad')), ('date-only', q(updatedSince=now[:10])), ('offset', q(updatedSince=since.replace('Z', '+00:00')))]
    rows, failures, unchanged = [], [], True
    try:
        subprocess.run([str(a.binary.resolve()), 'store', 'migrate', str(state)], env=env, check=True, capture_output=True)
        subprocess.run(['wrkqadm', 'migrate'], env=env, check=True, capture_output=True)
        with sqlite3.connect(state) as src, sqlite3.connect(root / 'empty.sqlite') as dst: src.backup(dst)
        runs = [('native', None, cases)] + [(name, value, [(name, '/v1/sessions')]) for name, value in [('config-zero', '0'), ('config-prefix', '1000days'), ('config-invalid', '-1')]]
        for label, days, subset in runs:
            with sqlite3.connect(root / 'empty.sqlite') as src, sqlite3.connect(state) as dst: src.backup(dst)
            if days is None: env.pop('HRC_SESSION_PROJECTION_DAYS', None)
            else: env['HRC_SESSION_PROJECTION_DAYS'] = days
            up(label); seed()
            # Owner readback of the seed before any case: every row the INSERTs wrote.
            seeded = call('/v1/sessions?all=true')
            if seeded['status'] != 200 or sorted(r['hostSessionId'] for r in seeded['body']) != sorted('hsid-n1-' + h for h in ALL):
                failures.append((label, 'seed readback', seeded))
            before = durable()
            for name, path in subset:
                rows.append({'case': name, 'path': path, 'response': call(path)})
            unchanged = unchanged and before == durable(); down()
        env.pop('HRC_SESSION_PROJECTION_DAYS', None)
        (a.artifacts / 'projection.json').write_text(json.dumps({'observations': rows, 'scope': scope, 'unchanged': unchanged}, indent=2) + '\n')
        failures += check(rows, scope, unchanged)
        (a.artifacts / 'failures.json').write_text(json.dumps(failures, indent=2) + '\n')
        assert not failures, failures
        print(json.dumps({'pass': True, 'cases': len(rows), 'artifacts': str(a.artifacts)}))
    finally:
        down()
        shutil.rmtree(root)


def wire_lane(lane):
    # hrc_store::canonical_lane: main stays bare, every other lane is lane:-prefixed.
    return 'main' if lane == 'main' else 'lane:' + lane


def check(rows, scope, unchanged):
    failures = []
    by = {r['case']: r['response'] for r in rows}
    if set(by) != set(EXPECT) or len(rows) != len(EXPECT):
        failures.append(('matrix', sorted(set(by) ^ set(EXPECT))))
    if not unchanged:
        failures.append(('reads wrote', 'sessions/runtimes/session_index changed'))
    for name, want in EXPECT.items():
        got = by.get(name)
        if got is None: continue
        if isinstance(want, list):
            hosts = [r.get('hostSessionId') for r in got['body']] if got['status'] == 200 and isinstance(got['body'], list) else None
            if hosts != ['hsid-n1-' + h for h in want]:
                failures.append((name, 'hosts', got['status'], hosts))
                continue
            # Every count header counts: total sessions in the store, returned, and the rest withheld.
            if got['headers'] != {'x-hrc-session-total': '10', 'x-hrc-session-returned': str(len(want)), 'x-hrc-session-withheld': str(10 - len(want))}:
                failures.append((name, 'headers', got['headers']))
            for r in got['body']:
                host = r['hostSessionId'][len('hsid-n1-'):]
                if host == 'summary':
                    shape = (r['scopeRef'], r['laneRef'], r['generation'], r['status']) == ('system:hrc/sweep', 'lane:default', 1, 'active')
                else:
                    _, suffix, lane, generation, _, status = next(f for f in FIXTURES if f[0] == host)
                    shape = (r['scopeRef'], r['laneRef'], r['generation'], r['status']) == (scope + '-' + suffix, wire_lane(lane), generation, status)
                    shape = shape and r.get('identity', {}).get('agentId') == 'tabularasa'
                if not shape:
                    failures.append((name, 'row', r))
        else:
            field, value, message = want
            error = got['body'].get('error', {}) if isinstance(got['body'], dict) else {}
            if got['status'] != 400 or error.get('message') != message or error.get('detail') != {'field': field, 'value': value}:
                failures.append((name, 'refusal', got))
    return failures


if __name__ == '__main__':
    main()
