#!/usr/bin/env python3
"""A steer to an hrcpty seat answers on admission, never on run end (T-12243).

The steer door's "answer at admission" exemption used to live only on the tmux
(interactive) branch of route.rs. An hrcpty seat took the headless branch, and
because submissions always ask the route to wait for completion, a steer that
started a turn held its HTTP response until that run ended (600 s cap). The
mail injector drives one delivery per target at a time, so every later message
to that seat waited behind the hung request (EN-40669/EN-40672, 2026-11-01).

One isolated rusthrc on a fresh short root, the fake aspd and stub release of
hrcpty_substrate.py, a codex-hrcpty seat (stub driver codex-app-server). The
stub's `HOLD` control keeps a turn open until `invocation.interrupt` (or 120 s).

Legs (run both binaries; the pre-fix binary is the discriminator):
  A  the seat is idle; a `HOLD` steer starts a turn that stays open. Fixed:
     2xx within a few seconds, admission admitted, and the steer's run is
     still active. Pre-fix: no response before the 20 s client timeout.
  B  a second steer while that turn is open. Fixed: 2xx within a few seconds.

Daemon logs, the stub broker logs, the fake aspd log, a rows dump and
summary.json land in --artifacts. Never touches the live daemon or aspd.
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import time
import uuid

from n2_scratch import reap_root
from hrcpty_substrate import AGENT, LEAK, PROJECT, FakeAspd, Run

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
CLIENT_TIMEOUT_S = 20
PROMPT_S = 5


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--binary', type=Path, default=REPO / 'crates/target/debug/rusthrc')
    p.add_argument('--root', type=Path, default=Path(f'/tmp/h12243-{os.getpid()}'))
    p.add_argument('--artifacts', type=Path, required=True)
    p.add_argument('--keep', action='store_true')
    args = p.parse_args()
    binary = args.binary.resolve()
    assert (binary.parent / 'hrc-pty').is_file(), 'build hrc-pty beside rusthrc'
    root = args.root.absolute()
    if root.exists():
        raise SystemExit('root must be fresh: ' + str(root))
    root.mkdir(parents=True)
    args.artifacts.mkdir(parents=True, exist_ok=True)
    r = Run(root, args.artifacts, binary)

    release_root = root / 'release'
    (release_root / 'bin').mkdir(parents=True)
    stub = release_root / 'bin/stub-broker'
    shutil.copy(HERE / 'hrcpty_stub_broker.py', stub)
    stub.chmod(0o755)
    drivers = ['claude-code-hrcpty', 'claude-code-tmux', 'codex-app-server']
    release = {'releaseId': 'stub-broker-t12243', 'sourceCommit': '1' * 40, 'builtAt': '2026-11-01T00:00:00.000Z',
               'releaseRoot': str(release_root),
               'worker': {'protocol': 'harness-broker/0.2', 'executable': str(stub), 'argvPrefix': [], 'hostedDrivers': drivers}}
    (release_root / 'release.json').write_text(json.dumps({**{k: release[k] for k in ('releaseId', 'sourceCommit', 'builtAt')},
                                                           'protocol': 'harness-broker/0.2', 'hostedDrivers': drivers}))
    for d in ('run', 'state', PROJECT):
        (root / d).mkdir()
    clean = {k: v for k, v in os.environ.items() if not k.startswith(LEAK)}
    subprocess.run(['git', 'init', '-q'], cwd=root / PROJECT, check=True, env=clean)
    subprocess.run([str(binary), 'store', 'migrate', str(r.db_path)], cwd=REPO, check=True, capture_output=True, env=clean)
    config = root / 'federation.json'
    config.write_text(json.dumps({'nodeId': 'h12243', 'peers': {}, 'gate': {'mode': 'off'}}))
    config.chmod(0o600)
    aspd_socket = root / 'aspd.sock'
    aspd = FakeAspd(aspd_socket, release, args.artifacts / 'fake-aspd.ndjson')
    env = dict(clean)
    env.update(HRC_RUNTIME_DIR=str(root / 'run'), HRC_STATE_DIR=str(root / 'state'), HRC_ASPD_SOCKET=str(aspd_socket),
               ASP_PROJECT_ROOT_OVERRIDE=str(root / PROJECT), HRC_PROJECT_SEARCH_ROOTS=str(root / PROJECT),
               HRC_WRKQ_DB=str(root / 'wrkq.db'), WRKQ_DB=str(root / 'wrkq.db'), HRC_WRKQD_TOKEN_FILE='',
               WRKQD_TOKEN_FILE='', WRKQD_TOKEN='', HRC_PEER_CONFIG_FILE=str(config),
               HRC_EVENT_INGEST_SOCKET=str(root / 'run/ingest.sock'), HRC_ACP_WEBHOOK_URL='',
               HRC_BROKER_DURABLE_IPC_ENABLED='1', ASP_HOME=str(root / 'asp-home'))
    r.env = env
    print(f'root {root}\nbinary {binary}\nartifacts {args.artifacts}', flush=True)
    intent = {'placement': {'agentRoot': str(root / PROJECT), 'projectRoot': str(root / PROJECT), 'cwd': str(root / PROJECT),
                            'runMode': 'task', 'bundle': {'kind': 'compose', 'compose': []}, 'dryRun': False},
              'harness': {'provider': 'openai', 'interactive': True}}
    failure = None
    timings = {}
    try:
        daemon = r.up('1')
        ref = f'agent:{AGENT}:project:{PROJECT}:task:codex-steer-{uuid.uuid4().hex[:8]}/lane:main'
        status, out = r.http('POST', '/v1/sessions/resolve', {'sessionRef': ref, 'create': True, 'summonIntent': 'explicit_local'})
        assert status == 200, (status, out)
        host = out['hostSessionId']

        def steer(body):
            # The injector's call shape: no wait, as a reply-required mail.
            started = time.time()
            try:
                status, out = r.http('POST', '/v1/submissions/steer',
                                     {'target': ref, 'body': body, 'origin': {'principalRef': 'agent:mable'}},
                                     timeout=CLIENT_TIMEOUT_S)
            except (socket.timeout, TimeoutError) as error:
                status, out = None, {'clientTimeout': repr(error)}
            return status, out, round(time.time() - started, 2)

        status, born = r.http('POST', '/v1/turns', {'hostSessionId': host, 'prompt': 'first turn', 'runtimeIntent': intent})
        assert status in (200, 202), ('birth', status, born)
        rid = born['runtimeId']
        r.wait(lambda: r.rows("SELECT 1 FROM runs WHERE run_id=? AND status='completed'", (born['runId'],)), 60, 'first turn')
        transport = r.runtime(rid)['transport']
        r.check('setup.seat-is-hrcpty', transport == 'hrcpty', transport=transport)

        # == A. a steer that starts a long turn on an idle seat ================
        status, a, elapsed = steer('HOLD steer EN-a')
        timings['steerIdleS'] = elapsed
        run_a = a.get('runId') if isinstance(a, dict) else None
        r.check('A.answers-on-admission', status in (200, 202) and elapsed < PROMPT_S and a.get('admission') == 'admitted',
                status=status, elapsedS=elapsed, response=a)
        active = r.rows('SELECT status FROM runs WHERE run_id=?', (run_a,)) if run_a else []
        r.check('A.run-still-active', active and active[0]['status'] not in ('completed', 'failed', 'cancelled'), run=active)

        # == B. a steer into the open turn ======================================
        status, b, elapsed = steer('second steer EN-b')
        timings['steerBusyS'] = elapsed
        r.check('B.answers-on-admission', status in (200, 202) and elapsed < PROMPT_S
                and isinstance(b, dict) and b.get('admission') == 'admitted',
                status=status, elapsedS=elapsed, response=b)
        r.notes.append({'A': a, 'B': b})
        r.http('POST', '/v1/interrupt', {'runtimeId': rid})
        r.down(daemon)
    except Exception as error:  # noqa: BLE001 - recorded as a failed check
        import traceback
        failure = traceback.format_exc()
        print(failure, flush=True)
        r.check('harness-completed', False, error=repr(error)[:3000])
    finally:
        for proc in r.owners:
            if proc.poll() is None:
                proc.terminate()
                try:
                    proc.wait(timeout=20)
                except subprocess.TimeoutExpired:
                    proc.kill()
        cleanup = reap_root(root, args.artifacts)
        aspd.close()
        for log in r.logs:
            log.close()
        for f in sorted((root / 'run/bipc').glob('*/stub.ndjson')) if (root / 'run/bipc').exists() else []:
            (args.artifacts / f'bipc-{f.parent.name}-stub.ndjson').write_text(f.read_text()[-200000:])
        if r.db_path.exists():
            dump = {t: r.rows(f'SELECT * FROM {t}') for t in ('runtimes', 'runs', 'sessions')}
            (args.artifacts / 'rows.json').write_text(json.dumps(dump, indent=1, default=str) + '\n')
        remaining = cleanup['remaining']
        r.check('cleanup.no-leftover-processes', not remaining, remaining=remaining)
        if not args.keep:
            shutil.rmtree(root, ignore_errors=True)
        summary = {'pass': all(c['pass'] for c in r.checks), 'binary': str(binary), 'timings': timings,
                   'checks': r.checks, 'notes': r.notes, 'failure': failure}
        (args.artifacts / 'summary.json').write_text(json.dumps(summary, indent=1, default=str) + '\n')
        print('\n'.join(f"{'PASS' if c['pass'] else 'FAIL'}  {c['check']}" for c in r.checks))
        print(json.dumps({'pass': summary['pass'], 'failed': [c['check'] for c in r.checks if not c['pass']]}))
    sys.exit(0 if summary['pass'] else 1)


if __name__ == '__main__':
    main()
