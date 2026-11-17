#!/usr/bin/env python3
"""T-13670: isolated daemon zombie/withdraw ordering. Run with --binary and --artifacts.
Uses the existing stub release and fake aspd; no shared service is touched.
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import socket
import sqlite3
from urllib.parse import urlencode
import subprocess
import sys
import time
import uuid

from n2_scratch import reap_root
from hrcpty_substrate import AGENT, LEAK, PROJECT, FakeAspd, Run

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
CLIENT_TIMEOUT_S = 20


# Inject only task-specific broker behavior into a private copy of the stub.
STUB = r'''    if method in ('submission.steer', 'submission.enqueue') and str(params.get('body','')).startswith('ZOMBIE-'):
        mode = params['body'].split('-',1)[1]
        sub = 'sub-' + mode.lower()
        emit('admission.admitted', {'submissionId':sub, 'class':'steer'})
        if mode == 'WRITE':
            emit('input.accepted', {'inputId':sub}, sub)
        if mode == 'TERMINAL':
            emit('queue.cancelled', {'submissionId':sub})
        return {'submissionId':sub, 'inputId':sub, 'admission':'admitted'}
    if method == 'submission.withdraw':
        sub = params['submissionId']
        if sub == 'sub-timeout':
            time.sleep(15)
            return {'outcome':'unknown'}
        if sub == 'sub-error':
            raise RuntimeError('withdraw fixture refusal')
        if sub == 'sub-noevent':
            return {'outcome':'withdrawn'}
        if sub == 'sub-refuse':
            return {'outcome':'not_held', 'state':'accepted'}
        # Delay publication beyond the RPC response to exercise projection ordering.
        def publish():
            time.sleep(.3)
            emit('queue.withdrawn', {'submissionId':sub, 'reason':params['reason']})
            emit('submission.withdrawn', {'submissionId':sub, 'reason':params['reason']})
        threading.Thread(target=publish, daemon=True).start()
        return {'outcome':'withdrawn'}
'''

def main():
    p = argparse.ArgumentParser()
    p.add_argument('--binary', type=Path, default=REPO / 'crates/target/debug/rusthrc')
    p.add_argument('--root', type=Path, default=Path(f'/tmp/h13670-{os.getpid()}'))
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
    stub.write_text(stub.read_text().replace('def handle(conn, method, params):', 'def handle(conn, method, params):\n' + STUB))
    stub.chmod(0o755)
    drivers = ['claude-code-hrcpty', 'claude-code-tmux', 'codex-app-server']
    release = {'releaseId': 'stub-broker-t13670', 'sourceCommit': '1' * 40, 'builtAt': '2026-11-01T00:00:00.000Z',
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
    config.write_text(json.dumps({'nodeId': 'h13670', 'peers': {}, 'gate': {'mode': 'off'}}))
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

        # Each input is admitted by the broker. Only WRITE gets input.accepted.
        cases = {}
        for mode in ('HELD', 'WRITE', 'TERMINAL', 'REFUSE', 'ERROR', 'NOEVENT', 'TIMEOUT'):
            status, out, elapsed = steer('ZOMBIE-' + mode)
            assert status in (200, 202), (status, out)
            run = out['runId']
            row = r.wait(lambda: r.rows('SELECT * FROM runs WHERE run_id=? AND broker_submission_id IS NOT NULL', (run,)), 5)[0]
            sub = row['broker_submission_id']
            r.wait(lambda: r.rows("SELECT 1 FROM broker_invocation_events WHERE runtime_id=? AND type='admission.admitted' AND json_extract(broker_event_json,'$.submissionId')=?", (rid,sub)), 5)
            if mode == 'WRITE':
                r.wait(lambda: r.rows("SELECT 1 FROM broker_invocation_events WHERE runtime_id=? AND type='input.accepted' AND json_extract(broker_event_json,'$.inputId')=?", (rid,sub)), 5)
            if mode == 'TERMINAL':
                r.wait(lambda: r.rows("SELECT 1 FROM broker_invocation_events WHERE runtime_id=? AND type='queue.cancelled' AND json_extract(broker_event_json,'$.submissionId')=?", (rid,sub)), 5)
            cases[mode] = {'run': run, 'sub': sub}
        # A DB trigger observes the exact instant turn.zombied is inserted.
        # Different ledgers have independent sequence numbers; this proves order.
        with sqlite3.connect(r.db_path) as db:
            db.executescript("""CREATE TABLE zombie_order(run_id TEXT, withdrawal_present INTEGER);
            CREATE TRIGGER observe_zombie AFTER INSERT ON hrc_events WHEN NEW.event_kind='turn.zombied'
            BEGIN INSERT INTO zombie_order SELECT NEW.run_id, EXISTS(
              SELECT 1 FROM broker_invocation_events e JOIN runs r ON r.run_id=NEW.run_id
              WHERE e.invocation_id=r.invocation_id AND e.type='queue.withdrawn'
                AND json_extract(e.broker_event_json,'$.submissionId')=r.broker_submission_id); END;""")
        status, dry = r.http('POST', '/v1/runs/sweep-zombies', {'olderThan':'0ms','dryRun':True})
        assert status == 200, dry
        r.check('dry-run.no-withdraw', not r.rows("SELECT 1 FROM broker_invocation_events WHERE type='queue.withdrawn'"))
        started = time.monotonic()
        status, swept = r.http('POST', '/v1/runs/sweep-zombies', {'olderThan':'0ms'})
        elapsed = time.monotonic() - started
        r.check('sweep.bounded', status == 200 and elapsed < 10, elapsed=elapsed, response=swept)
        for mode, case in cases.items():
            row = r.rows('SELECT * FROM runs WHERE run_id=?', (case['run'],))[0]
            r.check(mode + '.zombied', row['status'] == 'zombie', status=row['status'])
            query = urlencode({'op':'input-rejection-evidence','runtimeId':rid,'submissionId':case['sub']})
            status, evidence = r.http('GET', '/v1/broker-events/query?' + query)
            expected = {'op':'input-rejection-evidence','deliveryEvidence':'not_written'} if mode in ('HELD','TERMINAL') else None
            r.check(mode + '.evidence', status == 200 and evidence['result'] == expected, response=evidence)
            order = r.rows('SELECT * FROM zombie_order WHERE run_id=?', (case['run'],))
            if mode == 'HELD':
                r.check('HELD.withdraw-before-zombie', len(order)==1 and order[0]['withdrawal_present']==1, observed=order)
        requests = [json.loads(line) for f in (root/'run/bipc').glob('*/stub.ndjson') for line in f.read_text().splitlines()]
        withdrawals = [e['params']['submissionId'] for e in requests if e.get('kind')=='request' and e.get('method')=='submission.withdraw']
        for mode, case in cases.items():
            r.check(mode + '.withdraw-count', withdrawals.count(case['sub']) == (0 if mode in ('WRITE','TERMINAL') else 1), withdrawals=withdrawals)
        status, accepted = r.http('GET', '/v1/broker-events/query?' + urlencode(
            {'op':'input-accepted','runtimeId':rid,'inputId':cases['WRITE']['sub']}))
        r.check('WRITE.acceptance-preserved', status == 200 and accepted['result'] == {'op':'input-accepted','accepted':True}, response=accepted)
        attempts = [json.loads(line)['data'] for line in (args.artifacts/'daemon-1.log').read_text().splitlines()
                    if '"broker.zombie_withdraw"' in line]
        expected_attempts = {case['sub'] for mode, case in cases.items() if mode not in ('WRITE','TERMINAL')}
        r.check('logs.one-per-attempt', len(attempts)==len(expected_attempts)
                and {a['submissionId'] for a in attempts}==expected_attempts
                and all(a.get('runId') and a.get('outcome') and a.get('reason') for a in attempts), attempts=attempts)
        r.notes.append({'cases':cases,'sweep':swept})
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
            dump = {t: r.rows(f'SELECT * FROM {t}') for t in ('runtimes', 'runs', 'sessions', 'broker_invocation_events', 'hrc_events', 'zombie_order')}
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
