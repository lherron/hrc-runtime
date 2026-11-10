#!/usr/bin/env python3
"""The lease sweep never takes a reused pid for an hrc-pty supervisor (T-12536).

One isolated rusthrc on a fresh short root, the fake aspd and stub release of
hrcpty_substrate.py. Two codex-hrcpty seats are born and terminated, so their
supervisors are gone. With the daemon down, each terminated row's recorded
supervisor pid is rewritten to an unrelated live process this driver starts
(`sleep`), the state a reboot leaves when the OS hands those pids to other
programs:
  A  the seat's bipc directory is gone (no pid file, no socket);
  B  a stale `hrcpty.pid` naming the sleep's pid survives, with no socket.
The daemon restarts (startup lease sweep), then the driver waits for the first
recurring lease GC tick (one 300 s cadence after boot).

Fixed: both sleeps survive, no `broker.hrcpty_orphan_ended` names either row,
each row is settled once (`broker.substrate.endedReason` supervisor_gone, row
status unchanged), and the recurring tick reports killedLiveLeaseServers 0
and settledGoneSupervisors 0. Pre-fix: both rows are "ended" at startup, the
stale pid file gets B's unrelated process SIGKILLed, and every tick re-selects
A and counts it in killedLiveLeaseServers.

Every daemon log, the fake aspd log, a rows dump and summary.json land in
--artifacts. Never touches the live daemon or aspd.
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import signal
import sqlite3
import subprocess
import sys
import time
import uuid

from hrcpty_substrate import AGENT, LEAK, PROJECT, FakeAspd, Run, alive, descendants_of

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--binary', type=Path, default=REPO / 'crates/target/debug/rusthrc')
    p.add_argument('--root', type=Path, default=Path(f'/tmp/h12536-{os.getpid()}'))
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
    release = {'releaseId': 'stub-broker-t12536', 'sourceCommit': '1' * 40, 'builtAt': '2026-11-01T00:00:00.000Z',
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
    config.write_text(json.dumps({'nodeId': 'h12536', 'peers': {}, 'gate': {'mode': 'off'}}))
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
               HRC_BROKER_ORPHAN_SWEEP_GRACE_MS='0')
    r.env = env
    print(f'root {root}\nbinary {binary}\nartifacts {args.artifacts}', flush=True)
    intent = {'placement': {'agentRoot': str(root / PROJECT), 'projectRoot': str(root / PROJECT), 'cwd': str(root / PROJECT),
                            'runMode': 'task', 'bundle': {'kind': 'compose', 'compose': []}, 'dryRun': False},
              'harness': {'provider': 'openai', 'interactive': True}}
    sleeps = []
    failure = None
    timings = {}
    try:
        daemon = r.up('1')

        def born_and_terminated():
            ref = f'agent:{AGENT}:project:{PROJECT}:task:codex-{uuid.uuid4().hex[:8]}/lane:main'
            status, out = r.http('POST', '/v1/sessions/resolve', {'sessionRef': ref, 'create': True, 'summonIntent': 'explicit_local'})
            assert status == 200, (status, out)
            status, born = r.http('POST', '/v1/turns', {'hostSessionId': out['hostSessionId'], 'prompt': 'CONT first turn',
                                                        'runtimeIntent': intent})
            assert status in (200, 202), ('birth', status, born)
            rid = born['runtimeId']
            r.wait(lambda: r.rows("SELECT 1 FROM runs WHERE run_id=? AND status='completed'", (born['runId'],)), 60, 'first turn')
            sub = r.runtime(rid)['state']['broker']['substrate']
            status, term = r.http('POST', '/v1/terminate', {'runtimeId': rid})
            assert status == 200, ('terminate', status, term)
            r.wait(lambda: r.runtime(rid)['status'] == 'terminated', 20, 'terminated')
            r.wait(lambda: not alive(sub['pid']), 20, 'supervisor gone')
            return rid, sub

        a, sub_a = born_and_terminated()
        b, sub_b = born_and_terminated()
        r.down(daemon)

        # Unrelated live programs now hold the recorded pids.
        for _ in range(2):
            sleeps.append(subprocess.Popen(['sleep', '900'], start_new_session=True))
        pa, pb = sleeps[0].pid, sleeps[1].pid
        dir_a, dir_b = Path(sub_a['socketPath']).parent, Path(sub_b['socketPath']).parent
        shutil.rmtree(dir_a, ignore_errors=True)
        dir_b.mkdir(parents=True, exist_ok=True)
        (dir_b / 'hrcpty.sock').unlink(missing_ok=True)
        (dir_b / 'hrcpty.pid').write_text(f'{pb}\n')
        with sqlite3.connect(r.db_path) as db:
            for rid, pid in ((a, pa), (b, pb)):
                db.execute("UPDATE runtimes SET runtime_state_json=json_remove(json_set(runtime_state_json,'$.broker.substrate.pid',?),"
                           "'$.broker.substrate.endedAt','$.broker.substrate.endedReason') WHERE runtime_id=?", (pid, rid))
        planted = {'A': {'runtimeId': a, 'pid': pa, 'dir': str(dir_a), 'dirExists': dir_a.exists()},
                   'B': {'runtimeId': b, 'pid': pb, 'dir': str(dir_b), 'pidFile': (dir_b / 'hrcpty.pid').read_text().strip()}}
        r.notes.append({'planted': planted})

        booted = time.time()
        daemon = r.up('2')
        r.wait(lambda: [e for e in r.daemon_log('2') if e.get('event') == 'broker.warmup.complete'], 60, 'warmup complete')
        time.sleep(2)

        def ended():
            return [e for e in r.daemon_log('2') if e.get('event') == 'broker.hrcpty_orphan_ended'
                    and e['data'].get('runtimeId') in (a, b)]

        def substrate(rid):
            row = r.runtime(rid)
            return row['status'], row['state']['broker']['substrate']

        def running():
            # poll(), not kill(pid, 0): a SIGKILLed child stays a zombie until reaped.
            return {'A': sleeps[0].poll() is None, 'B': sleeps[1].poll() is None,
                    'exit': [s.returncode for s in sleeps]}

        startup_ended = ended()
        rows = {rid: substrate(rid) for rid in (a, b)}
        live = running()
        r.check('R.startup-unrelated-processes-survive', live['A'] and live['B'], **live)
        r.check('R.startup-no-orphan-ended', not startup_ended, ended=startup_ended)
        r.check('R.rows-settled-once', all(s.get('endedReason') == 'supervisor_gone' and s.get('endedAt') for _, s in rows.values()),
                substrates=rows)
        r.check('R.row-status-unchanged', all(st == 'terminated' for st, _ in rows.values()),
                statuses={rid: st for rid, (st, _) in rows.items()})

        # The first recurring lease GC tick: one cadence (300 s) after boot.
        boot = [e for e in r.daemon_log('2') if e.get('event') == 'broker.lease_gc_sweep_complete'
                and (e.get('data') or {}).get('cadence') == 'startup']
        r.notes.append({'startupSweep': boot})
        tick = r.wait(lambda: [e for e in r.daemon_log('2') if e.get('event') in ('broker.lease_gc_sweep_complete',
                                                                                 'broker.lease_gc_sweep_failed')
                               and (e.get('data') or {}).get('cadence') != 'startup'], 420, 'lease GC tick')
        timings['tickAfterBootS'] = round(time.time() - booted, 1)
        first = tick[0]
        broker = (first.get('data') or {}).get('broker') or {}
        r.check('R.second-sweep-zero', first.get('event') == 'broker.lease_gc_sweep_complete'
                and broker.get('killedLiveLeaseServers') == 0 and broker.get('settledGoneSupervisors', 0) == 0,
                tick=first)
        live = running()
        r.check('R.processes-survive-tick', live['A'] and live['B'] and not ended(), ended=ended(), **live)
        r.notes.append({'rowsAfterTick': {rid: substrate(rid) for rid in (a, b)}})
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
        for proc in sleeps:
            if proc.poll() is None:
                proc.kill()
            proc.wait()
        for pid, _ in descendants_of([str(root), root.name]):
            if pid != os.getpid():
                try:
                    os.kill(pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
        aspd.close()
        for log in r.logs:
            log.close()
        if r.db_path.exists():
            dump = {t: r.rows(f'SELECT * FROM {t}') for t in ('runtimes', 'runs', 'broker_invocations')}
            (args.artifacts / 'rows.json').write_text(json.dumps(dump, indent=1, default=str) + '\n')
        remaining = [l for pid, l in descendants_of([str(root), root.name]) if pid != os.getpid()]
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
