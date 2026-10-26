#!/usr/bin/env python3
"""F gates 1-3: rusthrc front on hrc.sock, Bun behind on hrc-bun.sock, one scratch state.

Failure modes written down first:
- Bun still binds, guards or unlinks the public socket, or refuses to start
  because the front answers on it; brokers get Bun's private socket as
  HRC_MAIL_STOP_SOCKET instead of the public one.
- The front starts without a reachable Bun, beside a live owner on hrc.sock,
  or twice; it fails to restart after SIGKILL (stale lock or socket).
- The front serves a non-front-safe route natively (a write, status,
  GET /v1/runtimes), drops method/query/body/headers/status, buffers a
  stream, or answers a front-safe read differently from Bun.
- The front writes the store, reattaches brokers or mints request IDs.
- The installed CLI, the kernel, the mail injector or a real turn break
  through the front.
- Logs: a request missing from rusthrc-server-*, a forwarded one missing from
  server-* or counted twice, a client ID that does not join, or one file
  written by both processes.
- Rollback leaves the seat unreachable or the broker unattached.

No production rows are copied. Run from a clean ghostmux terminal; every
owner is a foreground child of this driver.
"""
import argparse
from http.client import HTTPException
import json
import os
from pathlib import Path
import shutil
import signal
import socket
import sqlite3
import subprocess
import sys
import time
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parent))
from foundation import UnixHTTP  # noqa: E402

PROMPT = 'Reply with exactly the word OK and nothing else. No tools.'


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--rusthrc', type=Path, required=True)
    p.add_argument('--kernel', type=Path, required=True)
    p.add_argument('--bun-release', type=Path, required=True)
    p.add_argument('--installed-hrc', type=Path, default=Path.home() / '.bun/bin/hrc')
    p.add_argument('--injector', default='', help='hrc-mail-injector version; empty skips')
    p.add_argument('--aspd-socket', type=Path, required=True)
    p.add_argument('--scratch-root', type=Path, required=True)
    p.add_argument('--artifacts', type=Path, required=True)
    p.add_argument('--pending', action='append', default=[],
                   help='check-name prefix recorded but not asserted (work owned elsewhere, not landed)')
    args = p.parse_args()
    args.rusthrc, args.kernel = args.rusthrc.resolve(), args.kernel.resolve()
    if any(os.environ.get(k) for k in ('CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CODEX_SANDBOX')):
        raise RuntimeError('run this workflow from a clean ghostmux terminal')
    root = args.scratch_root.absolute()
    if root.exists():
        raise RuntimeError('scratch root must be fresh: ' + str(root))
    root.mkdir(parents=True)
    art = args.artifacts.absolute()
    art.mkdir(parents=True, exist_ok=True)
    release = args.bun_release.resolve()
    assert release.parent.name != 'hrc-runtime-releases'
    run_dir, state_dir = root / 'run', root / 'state'
    run_dir.mkdir()
    state_dir.mkdir()
    public, private = run_dir / 'hrc.sock', run_dir / 'hrc-bun.sock'
    project_id = 'f-t11822-' + uuid.uuid4().hex[:6]
    project = root / project_id
    project.mkdir()
    config = root / 'federation.json'
    config.write_text(json.dumps({'nodeId': project_id, 'peers': {}}))
    config.chmod(0o600)
    env = dict(os.environ)
    for k in ('HRC_SESSION_REF', 'HRC_RUNTIME_ID', 'HRC_RUN_ID', 'HRC_HOST_SESSION_ID',
              'HRC_EVENT_FORWARD_URL', 'HRC_EVENT_INGEST_TCP_PORT', 'HRC_EVENT_FORWARD_SOURCE_REF',
              'WRKQ_DB_PATH', 'WRKQ_DB_PATH_FILE', 'WRKQD_NODE_TOKENS', 'WRKQD_NODE_TOKENS_FILE',
              'WRKQD_UNIX', 'HRC_BUN_PASSTHROUGH_SOCKET', 'HRC_METRICS'):
        env.pop(k, None)
    env.update(HRC_RUNTIME_DIR=str(run_dir), HRC_STATE_DIR=str(state_dir),
               ASP_PROJECT_ROOT_OVERRIDE=str(project), HRC_PROJECT_SEARCH_ROOTS=str(project),
               HRC_WRKQ_DB=str(root / 'wrkq.db'), WRKQ_DB=str(root / 'wrkq.db'),
               WRKQ_PRINCIPAL_REF='agent:clod',
               HRC_WRKQD_TOKEN_FILE='', WRKQD_TOKEN_FILE='', WRKQD_TOKEN='',
               HRC_PEER_CONFIG_FILE=str(config), HRC_EVENT_INGEST_SOCKET=str(run_dir / 'ingest.sock'),
               HRC_ACP_WEBHOOK_URL='', HRC_ASPD_SOCKET=str(args.aspd_socket.resolve()),
               HRC_BROKER_DURABLE_IPC_ENABLED='1', HRC_HEADLESS_CODEX_BROKER_ENABLED='1',
               HRC_CLAUDE_CODE_TMUX_BROKER_ENABLED='1')
    db_path = state_dir / 'state.sqlite'
    scope = f'agent:tabularasa:project:{project_id}:task:front-{time.time_ns()}'
    hrc = str(args.installed_hrc)
    gates, steps, owners, logs, checks = {}, [], {}, [], []

    def check(name, ok, **detail):
        pending = any(name.startswith(prefix) for prefix in args.pending)
        checks.append({'name': name, 'pass': bool(ok), **({'pending': True} if pending else {}), **detail})
        assert ok or pending, (name, detail)

    def command(name, argv, timeout=180, ok=True):
        r = subprocess.run([str(v) for v in argv], env=env, cwd=project, capture_output=True,
                           text=True, timeout=timeout)
        steps.append({'name': name, 'argv': [str(v) for v in argv], 'exit': r.returncode,
                      'stdout': r.stdout[-20000:], 'stderr': r.stderr[-20000:]})
        if ok:
            assert r.returncode == 0, (name, r.returncode, r.stdout[-2000:], r.stderr[-2000:])
        out = r.stdout.strip()
        return (json.loads(out) if out.startswith(('{', '[')) else out) if ok else r

    def rows(sql, params=()):
        with sqlite3.connect(f'file:{db_path}?mode=ro', uri=True) as db:
            db.row_factory = sqlite3.Row
            return [dict(row) for row in db.execute(sql, params)]

    def request(sock, method, path, body=None, headers=None, stream=False, timeout=10):
        c = UnixHTTP(sock)
        c.timeout = timeout
        c.request(method, path, body, {'Content-Type': 'application/json', **(headers or {})})
        res = c.getresponse()
        raw = (res.readline() if stream else res.read()).decode()
        hdrs = {k.lower(): v for k, v in res.getheaders()}
        c.close()
        return {'status': res.status, 'body': raw, 'headers': hdrs}

    def responsive(sock):
        try:
            s = socket.socket(socket.AF_UNIX)
            s.settimeout(1)
            s.connect(str(sock))
            s.close()
            return True
        except OSError:
            return False

    def spawn(name, argv):
        log = (art / f'{name}.log').open('w')
        logs.append(log)
        proc = subprocess.Popen([str(a) for a in argv], env=env, cwd=project, stdout=log, stderr=log)
        owners[name] = proc
        return proc

    def wait_health(proc, sock, name):
        for _ in range(300):
            assert proc.poll() is None, (name, 'exited', proc.returncode, (art / f'{name}.log').read_text()[-3000:])
            try:
                if request(sock, 'GET', '/v1/health')['status'] == 200:
                    return
            except (OSError, HTTPException):
                pass
            time.sleep(.1)
        raise AssertionError(name + ' not ready')

    def bun(name, listen=None):
        argv = ['bun', release / 'packages/hrc-cli/src/cli.ts', 'server', 'serve']
        if listen:
            argv += ['--listen-socket', listen]
        proc = spawn(name, argv)
        wait_health(proc, listen or public, name)
        return proc

    def front(name):
        proc = spawn(name, [args.rusthrc.resolve(), 'server', '--front', '--bun-socket', private])
        wait_health(proc, public, name)
        return proc

    def refused(name, argv, needle):
        r = command(name, argv, timeout=30, ok=False)
        check(name, r.returncode != 0 and needle in (r.stdout + r.stderr), exit=r.returncode,
              output=(r.stdout + r.stderr)[-500:])

    def stop(name, sig=signal.SIGTERM):
        proc = owners.pop(name)
        proc.send_signal(sig)
        proc.wait(timeout=30)
        steps.append({'name': f'stop-{name}', 'signal': int(sig), 'exit': proc.returncode})
        return proc.returncode

    def wait_completed(run_id, limit=1800):
        for _ in range(limit):
            if rows("SELECT 1 FROM hrc_events WHERE run_id=? AND event_kind='turn.completed'", (run_id,)):
                return
            time.sleep(.1)
        raise AssertionError('turn did not complete: ' + run_id)

    def turn(name):
        out = command(name, [hrc, 'start', scope, '--project-id', project_id, '--project-root', project,
                             '--cwd', project, '-p', PROMPT, '--json'])
        wait_completed(out['runtime']['runId'])
        return out['runtime']

    def metrics(prefix):
        day = time.strftime('%Y-%m-%d', time.gmtime())
        f = state_dir / 'metrics' / f'{prefix}-{day}.ndjson'
        return [json.loads(l) for l in f.read_text().splitlines() if l.strip()] if f.exists() else []

    try:
        command('project-init', ['git', 'init', '-q'])
        command('wrkq-migrate', ['wrkqadm', 'migrate'])
        command('wrkq-project', ['wrkq', 'mkdir', '/' + project_id, '--kind', 'project', '--json'])
        command('wrkq-root', ['wrkq', 'set', '/' + project_id, '--root', project, '--json'])

        # Bun on its private socket; nothing on the public one yet.
        bun('bun-1', private)
        check('bun-private-listener', responsive(private) and not public.exists())
        st = json.loads(request(private, 'GET', '/v1/status')['body'])
        check('bun-status-sockets', st['socketPath'] == str(public) and st['listenSocketPath'] == str(private),
              socketPath=st['socketPath'], listenSocketPath=st.get('listenSocketPath'))
        refused('bun-relative-listen', ['bun', release / 'packages/hrc-cli/src/cli.ts', 'server', 'serve',
                                        '--listen-socket', 'rel.sock'], 'absolute')

        # Front startup refusals.
        refused('front-unreachable-bun', [args.rusthrc, 'server', '--front', '--bun-socket', run_dir / 'none.sock'],
                'unreachable')
        check('front-unreachable-left-no-socket', not public.exists())
        refused('front-missing-bun-socket', [args.rusthrc, 'server', '--front'], '--bun-socket')
        refused('native-private-listen', [args.rusthrc, 'server', 'serve', '--listen-socket', private], 'unsupported')

        front('front-1')
        refused('front-twice', [args.rusthrc, 'server', '--front', '--bun-socket', private], 'already running')
        refused('bun-on-public-while-fronted', ['bun', release / 'packages/hrc-cli/src/cli.ts', 'server', 'serve'],
                'already running')
        gates['startup'] = {'pass': True}

        # The unchanged installed CLI and a real model turn through the front.
        status = command('cli-status', [hrc, 'server', 'status', '--json'])
        check('cli-status-through-front', status['running'] and status['api']['socketPath'] == str(public),
              api=status.get('api'))
        mine = command('release-cli-status', ['bun', release / 'packages/hrc-cli/src/cli.ts', 'server', 'status'])
        check('release-cli-shows-listen', f'listen:       {private} (behind front door)' in mine)
        first = turn('turn-1')
        listed = command('cli-runtime-list', [hrc, 'runtime', 'list', '--json'])
        check('cli-runtime-list', any(r['runtimeId'] == first['runtimeId'] for r in listed))
        record = rows('SELECT * FROM runtimes WHERE runtime_id=?', (first['runtimeId'],))[0]
        broker_pid = json.loads(record['runtime_state_json'])['broker']['brokerPid']
        # aspd hands the dispatch env to the harness under the broker, so scan
        # every process rooted in this scratch run dir.
        stops = set()
        for line in subprocess.run(['ps', 'eww', '-ax', '-o', 'command='], capture_output=True,
                                   text=True).stdout.splitlines():
            for word in line.split():
                if word.startswith('HRC_MAIL_STOP_SOCKET=') and str(run_dir) in word:
                    stops.add(word.split('=', 1)[1])
        check('broker-mail-stop-is-public', stops == {str(public)}, seen=sorted(stops), brokerPid=broker_pid)
        captured = command('cli-capture', [hrc, 'capture', scope], ok=False)
        steps[-1]['note'] = 'capture is informative, not gated'

        # Front-safe reads natively; everything else verbatim from Bun. Seed more
        # than one session so ordering and the recency window are exercised:
        # three created through Bun, one of them backdated past every window.
        seeded = []
        for i in range(3):
            r = request(private, 'POST', '/v1/sessions/resolve', json.dumps(
                {'sessionRef': f'agent:tabularasa:project:{project_id}:task:seed-{i}/lane:main',
                 'create': True, 'summonIntent': 'explicit_local'}))
            seeded.append(json.loads(r['body'])['hostSessionId'])
        with sqlite3.connect(db_path) as w:
            w.execute("UPDATE sessions SET created_at='2026-01-01T00:00:00.000Z', updated_at='2026-01-01T00:00:00.000Z'"
                      ' WHERE host_session_id=?', (seeded[0],))
        since = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(time.time() - 86400))
        for path in [f'/v1/sessions?updatedSince={since}&latestGeneration=true',
                     f'/v1/sessions?scopeRef={scope}&laneRef=main&latestGeneration=true',
                     '/v1/sessions?all=true', '/v1/sessions?limit=0']:
            d, f = request(private, 'GET', path), request(public, 'GET', path)
            # JSON equality: key order is not part of the contract any client reads.
            same = d['status'] == f['status'] and json.loads(d['body']) == json.loads(f['body']) and all(
                d['headers'].get(h) == f['headers'].get(h) for h in d['headers'] if h.startswith('x-hrc-'))
            check('front-safe ' + path, same, direct=d, front=f)
        page = json.loads(request(private, 'GET', '/v1/events/page?afterSeq=0&limit=1')['body'])
        forwarded = [('GET', '/v1/runtimes', None), ('GET', '/v1/events/page?afterSeq=0&limit=5', None),
                     ('GET', '/v1/presentation/runtimes', None), ('POST', '/v1/sessions/resolve', '{'),
                     ('POST', '/v1/runtimes/ensure', '{"hostSessionId":"hsid-front-forwarded"}'),
                     ('DELETE', '/v1/not-a-route?x=1', 'payload'), ('GET', '/v1/server/subscribers', None)]
        for method, path, body in forwarded:
            d = request(private, method, path, body, {'x-front-test': 'kept'})
            f = request(public, method, path, body, {'x-front-test': 'kept'})
            check(f'forward {method} {path}', (d['status'], d['body']) == (f['status'], f['body']),
                  direct=d, front=f)
        host = record['host_session_id']
        stream = (f'/v1/events/bounded-stream?hostSessionId={host}&generation=1&afterSeq=0'
                  f'&ledgerIncarnationId={page["ledgerIncarnationId"]}&follow=true')
        t0 = time.monotonic()
        s = request(public, 'GET', stream, stream=True)
        check('stream-forwarded-live', s['status'] == 200 and json.loads(s['body'])['type'] == 'ready'
              and time.monotonic() - t0 < 5, front=s)
        sessions_before = rows('SELECT count(*) AS n FROM sessions')[0]['n']
        native_write = request(public, 'POST', '/v1/sessions/resolve',
                               json.dumps({'sessionRef': f'agent:tabularasa:project:{project_id}:task:fwd/lane:main',
                                           'create': True, 'summonIntent': 'explicit_local'}))
        check('write-forwarded-to-bun', native_write['status'] == 200
              and rows('SELECT count(*) AS n FROM sessions')[0]['n'] == sessions_before + 1, front=native_write)
        gates['1-routes'] = {'pass': True}

        # Kernel through the front.
        kroot = root / 'k'
        kroot.mkdir()
        kernel = spawn('kernel', [args.kernel.resolve(), '--runtime-root', kroot, '--hrc-socket', public])
        ksock = kroot / 'hrc-kernel.sock'
        seats = []
        for _ in range(300):
            assert kernel.poll() is None, (art / 'kernel.log').read_text()[-3000:]
            if responsive(ksock):
                w = socket.socket(socket.AF_UNIX)
                w.settimeout(10)
                w.connect(str(ksock))
                fh = w.makefile('rwb', buffering=0)
                fh.write((json.dumps({'id': 'q', 'op': 'document.query',
                                      'args': {'document_id': 'hrc', 'type': 'hrc.seat'}}) + '\n').encode())
                reply = json.loads(fh.readline())
                w.close()
                seats = json.dumps(reply)
                if scope in seats:
                    break
            time.sleep(.2)
        check('kernel-projects-seat-through-front', scope in seats)

        # Mail injector (scratch instance) through the front.
        if args.injector:
            env_inj = dict(env, HRC_SOCKET_PATH=str(public), HRC_NODE_ID=project_id,
                           HRC_MAIL_INJECTOR_STATE_PATH=str(state_dir / 'injector.sqlite'))
            # A scratch node has no kicker store to import. The injector creates
            # its schema, then refuses for want of a marker; record that there was
            # nothing to import and start it for real.
            unmarked = subprocess.run(['bunx', '--bun', '--silent', f'hrc-mail-injector@{args.injector}'],
                                   env=env_inj, cwd=project, capture_output=True, text=True, timeout=120)
            check('injector-refuses-without-marker', unmarked.returncode != 0 and 'import marker' in unmarked.stderr)
            with sqlite3.connect(state_dir / 'injector.sqlite') as inj:
                inj.execute('INSERT INTO injector_store_imports (source_path, imported_at) VALUES (?, ?)',
                            ('scratch:none', time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())))
            log = (art / 'injector.log').open('w')
            logs.append(log)
            owners['injector'] = subprocess.Popen(['bunx', '--bun', '--silent', f'hrc-mail-injector@{args.injector}'],
                                                  env=env_inj, cwd=project, stdout=log, stderr=log)
            seat = scope.split(':', 1)[1]
            agent, rest = seat.split(':project:', 1)
            proj, task = rest.split(':task:', 1)
            address = f'{agent}@{proj}:{task}'
            runs_before = {r['run_id'] for r in rows("SELECT run_id FROM hrc_events WHERE event_kind='turn.completed'")}
            said = command('wrkc-say', ['wrkc', 'say', f'/{project_id}', '--to', address, '--fyi', '-m', PROMPT,
                                        '--as', 'agent:clod', '--json'])
            delivered = False
            for _ in range(1800):
                assert owners['injector'].poll() is None, (art / 'injector.log').read_text()[-3000:]
                done = {r['run_id'] for r in rows("SELECT run_id FROM hrc_events WHERE event_kind='turn.completed'")}
                if done - runs_before:
                    delivered = True
                    break
                time.sleep(.2)
            check('injector-delivers-through-front', delivered, envelope=said.get('envelopes', [{}])[0].get('id'))

        # Gate 2: low-rate log reconciliation (<=10/route/minute, so every record is weight 1).
        time.sleep(61 - time.time() % 60)
        marks = {'native': [], 'bun': []}
        for i in range(4):
            rid = f'front-{uuid.uuid4()}'
            request(public, 'GET', f'/v1/sessions?scopeRef={scope}', headers={'x-hrc-request-id': rid})
            marks['native'].append(rid)
            rid = f'front-{uuid.uuid4()}'
            request(public, 'GET', '/v1/presentation/runtimes', headers={'x-hrc-request-id': rid})
            marks['bun'].append(rid)
            request(public, 'GET', '/v1/sessions?all=true')
            request(public, 'GET', '/v1/events/page?afterSeq=0&limit=1')
        time.sleep(4)
        rust, bunm = metrics('rusthrc-server'), metrics('server')
        rust_ids = {r.get('reqId'): r for r in rust if r.get('reqId')}
        bun_ids = {r.get('reqId'): r for r in bunm if r.get('reqId')}
        check('log-native-ids-once', all(sum(1 for r in rust if r.get('reqId') == i) == 1
                                          and rust_ids[i].get('servedBy') == 'native' and i not in bun_ids
                                          for i in marks['native']))
        check('log-forwarded-ids-join', all(sum(1 for r in rust if r.get('reqId') == i) == 1
                                             and rust_ids[i].get('servedBy') == 'bun'
                                             and sum(1 for r in bunm if r.get('reqId') == i) == 1
                                             for i in marks['bun']))
        def count(rs, route, served=None):
            return sum(r.get('sampleWeight', 1) for r in rs if r.get('route') == route and not r.get('reqId')
                       and (served is None or r.get('servedBy') == served))
        check('log-no-id-forwarded-counts', count(rust, '/v1/events/page', 'bun') >= 4
              and count(rust, '/v1/events/page', 'bun') == count(bunm, '/v1/events/page'),
              rust=count(rust, '/v1/events/page', 'bun'), bun=count(bunm, '/v1/events/page'))
        check('log-no-id-native-absent-from-bun', count(rust, '/v1/sessions', 'native') >= 4
              and not any(r.get('route') == '/v1/sessions' and r.get('client', '').startswith('python')
                          for r in bunm))
        check('log-files-disjoint', not any('servedBy' in r for r in bunm) and rust and bunm)
        gates['2'] = {'pass': True, 'rustRecords': len(rust), 'bunRecords': len(bunm)}

        # Front crash recovery: SIGKILL, then a fresh front takes over.
        stop('front-1', signal.SIGKILL)
        check('front-killed-leaves-bun', responsive(private) and not responsive(public))
        front('front-2')
        check('front-restart-after-kill', responsive(public))

        # Gate 3: rollback -- stop the front, Bun back on hrc.sock, brokers reattach.
        stop('kernel')
        check('front-clean-stop', stop('front-2') == 0 and not public.exists()
              and not (run_dir / 'rusthrc-front.pid').exists())
        check('bun-clean-stop', stop('bun-1') == 0)
        os.kill(broker_pid, 0)
        bun('bun-2')
        second = turn('turn-after-rollback')
        check('rollback-same-runtime', second['runtimeId'] == first['runtimeId'],
              first=first['runtimeId'], second=second['runtimeId'])
        reattach = [json.loads(l) for l in (art / 'bun-2.log').read_text().splitlines()
                    if 'broker.warmup.complete' in l]
        gates['3'] = {'pass': True, 'warmup': reattach[-1:] if reattach else None}
        gates['1'] = {'pass': True, 'runtimeId': first['runtimeId'], 'scope': scope}
    finally:
        try:
            for record in rows('SELECT scope_ref,runtime_state_json FROM runtimes'):
                st = json.loads(record['runtime_state_json'] or '{}')
                path = st.get('tmux', {}).get('socketPath')
                if path and Path(path).resolve().is_relative_to(run_dir.resolve()):
                    subprocess.run(['tmux', '-S', path, 'kill-server'], capture_output=True, timeout=5)
        except Exception as error:  # noqa: BLE001
            steps.append({'name': 'cleanup-error', 'error': str(error)})
        for name in list(owners):
            if owners[name].poll() is None:
                owners[name].terminate()
                try:
                    owners[name].wait(timeout=30)
                except subprocess.TimeoutExpired:
                    owners[name].kill()
        for log in logs:
            log.close()
        for prefix in ('rusthrc-server', 'server'):
            day = time.strftime('%Y-%m-%d', time.gmtime())
            src = state_dir / 'metrics' / f'{prefix}-{day}.ndjson'
            if src.exists():
                shutil.copy(src, art / src.name)
        (art / 'results.json').write_text(json.dumps({'gates': gates, 'checks': checks, 'steps': steps,
                                                       'scratchRoot': str(root)}, indent=2) + '\n')
    print(json.dumps({'pass': sorted(gates), 'checks': len(checks),
                      'failedPending': [c['name'] for c in checks if not c['pass']], 'artifacts': str(art)}))


if __name__ == '__main__':
    main()
