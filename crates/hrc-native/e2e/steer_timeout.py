#!/usr/bin/env python3
"""A slow steer must not retire a live seat or mint a duplicate (T-12228).

One isolated rusthrc on a fresh short root, the fake aspd and stub release of
hrcpty_substrate.py, codex-hrcpty seats (stub driver codex-app-server). The
stub's T-12228 controls: a steer body with `STALL` answers after 25 s (past
the daemon's 20 s ACTIVE_RPC_TIMEOUT) while the broker keeps answering other
RPCs; an initial prompt with `NOLAUNCH` never runs its turn; a prompt with
`CONT` records a continuation on the scope.

Legs (every check runs on both binaries; the pre-fix binary is the
discriminator and fails the fix's checks):
  S  seat S1 born (`CONT`), a HOLD turn makes it turn-active, then a `STALL`
     steer times out. Fixed: 503 runtime_unavailable with reason
     submission_timeout, the binding is kept, the runtime is not stale.
     Pre-fix: binding retired, runtime stale.
  D  the next delivery to S1's scope. Fixed: it lands on S1. Pre-fix: a new
     runtime is minted on the same host session (gen 1 again), resuming the
     scope's continuation.
  O  S1 is stale while its broker answers (the pre-fix leg gets there by
     itself; the fixed leg writes the stale row with the daemon down, the
     state a pre-fix daemon or any other stale path leaves behind), then the
     daemon restarts, which runs the orphan lease sweep. Fixed: the sweep
     preserves the answering broker and a delivery fails closed with reason
     continuation_held_by_live_broker, with no birth. Pre-fix: the sweep ends
     the supervisor (the live harness dies), and the delivery births.
  T  scope S2 with a continuation; a runtime born there that never launched
     (`NOLAUNCH`) is terminated with the default options. Fixed:
     droppedContinuation false, continuation_reuse_disabled unchanged.
     Pre-fix: droppedContinuation true, reuse disabled.

Every daemon log, the stub broker logs, the fake aspd log, a rows dump and
summary.json land in --artifacts. Never touches the live daemon or aspd.
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import time
import uuid

from hrcpty_substrate import AGENT, LEAK, PROJECT, FakeAspd, Run, alive, descendants_of, ops

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
TERMINAL = ('terminated', 'dead', 'crashed', 'failed')


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--binary', type=Path, default=REPO / 'crates/target/debug/rusthrc')
    p.add_argument('--root', type=Path, default=Path(f'/tmp/h12228-{os.getpid()}'))
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
    release = {'releaseId': 'stub-broker-t12228', 'sourceCommit': '1' * 40, 'builtAt': '2026-11-01T00:00:00.000Z',
               'releaseRoot': str(release_root),
               'worker': {'protocol': 'harness-broker/0.2', 'executable': str(stub), 'argvPrefix': [], 'hostedDrivers': drivers}}
    (release_root / 'release.json').write_text(json.dumps({**{k: release[k] for k in ('releaseId', 'sourceCommit', 'builtAt')},
                                                           'protocol': 'harness-broker/0.2', 'hostedDrivers': drivers}))
    for d in ('run', 'state', PROJECT):
        (root / d).mkdir()
    clean = {k: v for k, v in os.environ.items() if not k.startswith(LEAK)}
    subprocess.run(['git', 'init', '-q'], cwd=root / PROJECT, check=True, env=clean)
    subprocess.run(['bun', '-e', 'import {openHrcDatabase} from "./packages/hrc-store-sqlite/src/database.ts";'
                    'openHrcDatabase(process.argv[1]).close()', str(r.db_path)], cwd=REPO, check=True, capture_output=True, env=clean)
    config = root / 'federation.json'
    config.write_text(json.dumps({'nodeId': 'h12228', 'peers': {}, 'gate': {'mode': 'off'}}))
    config.chmod(0o600)
    aspd_socket = root / 'aspd.sock'
    aspd = FakeAspd(aspd_socket, release, args.artifacts / 'fake-aspd.ndjson')
    env = dict(clean)
    env.update(HRC_RUNTIME_DIR=str(root / 'run'), HRC_STATE_DIR=str(root / 'state'), HRC_ASPD_SOCKET=str(aspd_socket),
               ASP_PROJECT_ROOT_OVERRIDE=str(root / PROJECT), HRC_PROJECT_SEARCH_ROOTS=str(root / PROJECT),
               HRC_WRKQ_DB=str(root / 'wrkq.db'), WRKQ_DB=str(root / 'wrkq.db'), HRC_WRKQD_TOKEN_FILE='',
               WRKQD_TOKEN_FILE='', WRKQD_TOKEN='', HRC_PEER_CONFIG_FILE=str(config),
               HRC_EVENT_INGEST_SOCKET=str(root / 'run/ingest.sock'), HRC_ACP_WEBHOOK_URL='',
               HRC_BROKER_DURABLE_IPC_ENABLED='1', ASP_HOME=str(root / 'asp-home'),
               # The restart's orphan sweep must see S1's seat at once.
               HRC_BROKER_ORPHAN_SWEEP_GRACE_MS='0')
    r.env = env
    print(f'root {root}\nbinary {binary}\nartifacts {args.artifacts}', flush=True)
    intent = {'placement': {'agentRoot': str(root / PROJECT), 'projectRoot': str(root / PROJECT), 'cwd': str(root / PROJECT),
                            'runMode': 'task', 'bundle': {'kind': 'compose', 'compose': []}, 'dryRun': False},
              'harness': {'provider': 'openai', 'interactive': True}}
    pids = []
    failure = None
    timings = {}
    try:
        daemon = r.up('1')

        def session(task):
            ref = f'agent:{AGENT}:project:{PROJECT}:task:{task}/lane:main'
            status, out = r.http('POST', '/v1/sessions/resolve', {'sessionRef': ref, 'create': True, 'summonIntent': 'explicit_local'})
            assert status == 200, (status, out)
            return ref, out['hostSessionId']

        def turn(host, prompt):
            return r.http('POST', '/v1/turns', {'hostSessionId': host, 'prompt': prompt, 'runtimeIntent': intent})

        def steer(ref, body):
            started = time.time()
            status, out = r.http('POST', '/v1/submissions/steer',
                                 {'target': ref, 'body': body, 'origin': {'principalRef': 'agent:mable'}}, timeout=180)
            return status, out, round(time.time() - started, 2)

        def runtimes(host):
            return r.rows('SELECT runtime_id,generation,status,created_at,active_invocation_id FROM runtimes '
                          'WHERE host_session_id=? ORDER BY created_at', (host,))

        def seat(rid):
            sub = r.runtime(rid)['state'].get('broker', {}).get('substrate', {})
            sock = Path(sub.get('socketPath') or '/nonexistent')
            st = ops(sock, sock.parent / 'attach.token', 'status') if sock.is_socket() else {}
            broker = ((st.get('status') or {}).get('broker') or {})
            return {'socket': sock, 'supervisor': sub.get('pid'), 'broker': broker.get('pid'), 'brokerState': broker.get('state'),
                    'b': sock.parent / 'b.sock'}

        def stub_log(s):
            f = s['socket'].parent / 'stub.ndjson'
            return [json.loads(l) for l in f.read_text().splitlines()] if f.exists() else []

        # == S. a stalled steer into a turn-active seat ========================
        ref1, host1 = session('codex-' + uuid.uuid4().hex[:8])
        status, born = turn(host1, 'CONT first turn')
        assert status in (200, 202), ('birth', status, born)
        s1 = born['runtimeId']
        r.wait(lambda: r.rows("SELECT 1 FROM runs WHERE run_id=? AND status='completed'", (born['runId'],)), 60, 'S1 first turn')
        cont = r.rows('SELECT continuation_json,continuation_reuse_disabled FROM sessions WHERE host_session_id=?', (host1,))[0]
        r.check('S.continuation-recorded', cont['continuation_json'] and cont['continuation_reuse_disabled'] == 0, session=cont)
        seat1 = seat(s1)
        pids += [seat1['supervisor'], seat1['broker']]
        status, held = turn(host1, 'HOLD the seat turn-active')
        assert status in (200, 202), ('hold', status, held)
        r.wait(lambda: r.runtime(s1)['active_run_id'] == held['runId'], 30, 'held turn active')
        status, stalled, elapsed = steer(ref1, 'STALL steer EN-stall')
        timings['stalledSteerS'] = elapsed
        row = r.runtime(s1)
        log1 = r.daemon_log('1')
        retired = [e for e in log1 if e.get('event') == 'broker active binding retired after timeout']
        err = (stalled.get('error') or {}) if isinstance(stalled, dict) else {}
        r.check('S.steer-fails-named', status == 503 and err.get('code') == 'runtime_unavailable'
                and (err.get('detail') or {}).get('reason') == 'submission_timeout', status=status, response=stalled, elapsedS=elapsed)
        r.check('S.binding-kept', not retired and row['state'].get('control', {}).get('brokerAttached') is not False,
                retiredLines=retired, control=row['state'].get('control'))
        r.check('S.runtime-not-stale', row['status'] not in ('stale',) + TERMINAL, status=row['status'],
                statusChangedAt=row['status_changed_at'])
        health = [e for e in stub_log(seat1) if e['kind'] == 'request' and e['method'] == 'broker.health']
        r.notes.append({'S': {'steerStatus': status, 'steerResponse': stalled, 'elapsedS': elapsed, 'runtimeStatus': row['status'],
                              'retired': retired, 'healthRequests': len(health)}})

        # == D. the next delivery ==============================================
        status, nxt, elapsed = steer(ref1, 'NOLAUNCH next delivery EN-next')
        rts = runtimes(host1)
        run = r.rows('SELECT runtime_id,status FROM runs WHERE run_id=?', (nxt.get('runId'),)) if isinstance(nxt, dict) and nxt.get('runId') else []
        r.check('D.next-delivery-lands-on-same-runtime', status in (200, 202) and run and run[0]['runtime_id'] == s1,
                status=status, response=nxt, run=run)
        r.check('D.no-duplicate-birth', len(rts) == 1, runtimes=rts)
        r.notes.append({'D': {'status': status, 'response': nxt, 'runtimes': rts}})
        if len(rts) > 1:
            # The pre-fix duplicate: terminate it with default options (item 5).
            dup = rts[-1]['runtime_id']
            compiles = [json.loads(l) for l in (args.artifacts / 'fake-aspd.ndjson').read_text().splitlines()]
            reqs = [c['request']['params']['compileRequest'] for c in compiles
                    if 'request' in c and c['request'].get('method') == 'aspc.compileHarnessInvocation'
                    and c['request']['params']['compileRequest']['identity'].get('runtimeId') == dup]
            status, term = r.http('POST', '/v1/terminate', {'runtimeId': dup})
            after = r.rows('SELECT continuation_json,continuation_reuse_disabled FROM sessions WHERE host_session_id=?', (host1,))[0]
            r.notes.append({'D.duplicate': {'runtime': rts[-1], 'compileContinuation': [q.get('continuation') for q in reqs],
                                            'terminate': [status, term], 'sessionAfter': after}})
        # Release the held turn so S1 is idle.
        r.http('POST', '/v1/interrupt', {'runtimeId': s1})

        # == O. a stale row whose broker still answers ==========================
        r.down(daemon)
        if r.runtime(s1)['status'] != 'stale':
            import sqlite3
            with sqlite3.connect(r.db_path) as db:
                db.execute("UPDATE runtimes SET status='stale', status_changed_at=? WHERE runtime_id=?",
                           (time.strftime('%Y-%m-%dT%H:%M:%S.000Z', time.gmtime()), s1))
            r.notes.append({'O': 'S1 written stale with the daemon down (fixed leg)'})
        seat1 = seat(s1)
        before_restart = {'supervisor': alive(seat1['supervisor']), 'broker': alive(seat1['broker']), 'brokerState': seat1['brokerState']}
        daemon = r.up('2')
        r.wait(lambda: [e for e in r.daemon_log('2') if e.get('event') == 'broker.warmup.complete'], 60, 'warmup complete')
        time.sleep(2)
        log2 = r.daemon_log('2')
        ended = [e for e in log2 if e.get('event') == 'broker.hrcpty_orphan_ended' and e['data'].get('runtimeId') == s1]
        kept = [e for e in log2 if e.get('event') == 'broker.hrcpty_orphan_preserved' and e['data'].get('runtimeId') == s1]
        r.check('O.sweep-preserves-answering-broker', before_restart['broker'] and not ended and kept
                and alive(seat1['supervisor']) and alive(seat1['broker']),
                beforeRestart=before_restart, ended=ended, preserved=kept,
                after={'supervisor': alive(seat1['supervisor']), 'broker': alive(seat1['broker'])})
        before = runtimes(host1)
        status, guarded = turn(host1, 'NOLAUNCH delivery to a stale seat with a live broker')
        after = runtimes(host1)
        err = (guarded.get('error') or {}) if isinstance(guarded, dict) else {}
        r.check('O.delivery-fails-closed', status == 503 and (err.get('detail') or {}).get('reason') == 'continuation_held_by_live_broker'
                and (err.get('detail') or {}).get('runtimeId') == s1, status=status, response=guarded)
        r.check('O.no-birth', len(after) == len(before), before=before, after=after)
        r.notes.append({'O': {'beforeRestart': before_restart, 'ended': ended, 'preserved': kept, 'delivery': [status, guarded],
                              'runtimes': after}})

        # == T. terminate a never-launched runtime =============================
        ref2, host2 = session('codex-' + uuid.uuid4().hex[:8])
        status, b2 = turn(host2, 'CONT S2 first turn')
        assert status in (200, 202), ('S2 birth', status, b2)
        r.wait(lambda: r.rows("SELECT 1 FROM runs WHERE run_id=? AND status='completed'", (b2['runId'],)), 60, 'S2 first turn')
        pids += [seat(b2['runtimeId'])['supervisor'], seat(b2['runtimeId'])['broker']]
        status, t2 = r.http('POST', '/v1/terminate', {'runtimeId': b2['runtimeId'], 'dropContinuation': False})
        r.wait(lambda: r.runtime(b2['runtimeId'])['status'] == 'terminated', 20, 'S2 terminated')
        kept2 = r.rows('SELECT continuation_json,continuation_reuse_disabled FROM sessions WHERE host_session_id=?', (host2,))[0]
        status, b3 = turn(host2, 'NOLAUNCH a seat that never launches')
        r.check('T.never-launched-born', status in (200, 202) and b3.get('runtimeId') != b2['runtimeId'], status=status, response=b3)
        time.sleep(1)
        never = r.rows('SELECT run_id,status,started_at FROM runs WHERE run_id=?', (b3.get('runId'),))
        pids += [seat(b3['runtimeId'])['supervisor'], seat(b3['runtimeId'])['broker']]
        status, t3 = r.http('POST', '/v1/terminate', {'runtimeId': b3['runtimeId']})
        after2 = r.rows('SELECT continuation_json,continuation_reuse_disabled FROM sessions WHERE host_session_id=?', (host2,))[0]
        r.check('T.continuation-unchanged', status == 200 and t3.get('droppedContinuation') is False
                and after2 == kept2 and kept2['continuation_reuse_disabled'] == 0,
                status=status, response=t3, before=kept2, after=after2, run=never, keptTerminate=t2)
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
        for pid in pids:
            if pid and alive(pid):
                os.kill(pid, signal.SIGKILL)
        for pid, _ in descendants_of([str(root), root.name]):
            if pid != os.getpid():
                try:
                    os.kill(pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
        aspd.close()
        for log in r.logs:
            log.close()
        for f in sorted((root / 'run/bipc').glob('*/stub.ndjson')) if (root / 'run/bipc').exists() else []:
            (args.artifacts / f'bipc-{f.parent.name}-stub.ndjson').write_text(f.read_text()[-200000:])
        if r.db_path.exists():
            dump = {t: r.rows(f'SELECT * FROM {t}') for t in ('runtimes', 'runs', 'broker_invocations', 'sessions')}
            dump['hrc_events'] = r.rows('SELECT hrc_seq,ts,event_kind,runtime_id,run_id,generation,payload_json FROM hrc_events ORDER BY hrc_seq')
            (args.artifacts / 'rows.json').write_text(json.dumps(dump, indent=1, default=str) + '\n')
        remaining = [l for _, l in descendants_of([str(root), root.name])]
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
