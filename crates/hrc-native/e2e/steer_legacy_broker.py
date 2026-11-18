#!/usr/bin/env python3
"""A broker below agent-spaces 8ce36a9d still takes HRC submissions (T-13727).

HRC mints `submissionId` on every submission.* call (T-13704). A broker built
before T-13689 refuses that param: Foundry's pinned spaces-harness-broker
0.1.1-dev.20261104 answers -32602 Invalid params with the issue
{path: params.submissionId, code: unexpected_key}, so every Foundry steer
failed runtime_unavailable from the 2026-11-17 23:31Z deploy on, and its
idempotent retry replayed that failed run as a 200.

One isolated rusthrc on a fresh short root, the fake aspd and stub release of
hrcpty_substrate.py, a codex-hrcpty seat whose first prompt carries the stub's
`LEGACYPARAMS` control. Foundry's call shape: POST /v1/submissions/enqueue
with an idempotencyKey, then the same request again.

Legs (run both binaries; the pre-fix binary is the discriminator):
  A  the enqueue answers 2xx with admission admitted; its run completes;
     the daemon logs broker.submission_id_unsupported once.
  B  the same request again replays that run (replayed true, run completed).

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
    p.add_argument('--root', type=Path, default=Path(f'/tmp/h13727-{os.getpid()}'))
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
    release = {'releaseId': 'stub-broker-t13727', 'sourceCommit': '1' * 40, 'builtAt': '2026-11-01T00:00:00.000Z',
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
    config.write_text(json.dumps({'nodeId': 'h13727', 'peers': {}, 'gate': {'mode': 'off'}}))
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
        ref = f'agent:{AGENT}:project:{PROJECT}:task:codex-legacy-{uuid.uuid4().hex[:8]}/lane:main'
        status, out = r.http('POST', '/v1/sessions/resolve', {'sessionRef': ref, 'create': True, 'summonIntent': 'explicit_local'})
        assert status == 200, (status, out)
        host = out['hostSessionId']

        key = 'foundry-' + uuid.uuid4().hex

        def enqueue(body):
            # Foundry host/src/hrc.ts enqueue: target, body, origin, idempotencyKey.
            started = time.time()
            try:
                status, out = r.http('POST', '/v1/submissions/enqueue',
                                     {'target': ref, 'body': body, 'origin': {'principalRef': 'agent:foundry'},
                                      'idempotencyKey': key}, timeout=CLIENT_TIMEOUT_S)
            except (socket.timeout, TimeoutError) as error:
                status, out = None, {'clientTimeout': repr(error)}
            return status, out, round(time.time() - started, 2)

        status, born = r.http('POST', '/v1/turns', {'hostSessionId': host, 'prompt': 'first turn LEGACYPARAMS', 'runtimeIntent': intent})
        assert status in (200, 202), ('birth', status, born)
        rid = born['runtimeId']
        r.wait(lambda: r.rows("SELECT 1 FROM runs WHERE run_id=? AND status='completed'", (born['runId'],)), 60, 'first turn')
        transport = r.runtime(rid)['transport']
        r.check('setup.seat-is-hrcpty', transport == 'hrcpty', transport=transport)

        # == A. a submission into a broker that refuses submissionId ===========
        status, a, elapsed = enqueue('legacy steer EN-a')
        timings['enqueueS'] = elapsed
        run_a = a.get('runId') if isinstance(a, dict) else None
        r.check('A.admitted', status in (200, 202) and isinstance(a, dict) and a.get('admission') == 'admitted',
                status=status, response=a)
        if run_a:
            r.wait(lambda: r.rows("SELECT 1 FROM runs WHERE run_id=? AND completed_at IS NOT NULL", (run_a,)), 30, 'run A ends')
        row = r.rows('SELECT status, error_code, broker_submission_id FROM runs WHERE run_id=?', (run_a,)) if run_a else []
        r.check('A.run-completed', bool(row) and row[0]['status'] == 'completed', run=row)
        logged = [json.loads(l) for l in (args.artifacts / 'daemon-1.log').read_text().splitlines()
                  if '"broker.submission_id_unsupported"' in l]
        r.check('A.fallback-logged-once', len(logged) == 1, logged=logged)

        # == B. Foundry's retry with the same idempotencyKey ====================
        status, b, elapsed = enqueue('legacy steer EN-a')
        r.check('B.replays-the-completed-run', status in (200, 202) and isinstance(b, dict) and b.get('replayed') is True
                and b.get('runId') == run_a and b.get('status') == 'completed', status=status, response=b)
        r.notes.append({'A': a, 'B': b})
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
