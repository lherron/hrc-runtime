#!/usr/bin/env python3
"""Idle broker regression (T-12503), on a private native daemon and stub broker.

Failure modes: repeated equal seat probes rewrite state or notify observers;
probes stop; an empty watchdog keeps querying; an earlier deadline fails to wake
an armed timer; a disarmed watch trips; deadline trips early, late or twice.
SQLite telemetry at threshold zero measures reads; a trigger counts writes.
Run unchanged against the before and after binaries; keep summary.json/logs:
  python3 crates/hrc-native/e2e/idle_broker.py --binary <rusthrc> --artifacts <dir>
The hrc-pty sibling binary and the substrate's captured aspc fixture are required.
"""
import argparse
import datetime
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
    p.add_argument('--root', type=Path, default=Path(f'/tmp/h12503-{os.getpid()}'))
    p.add_argument('--artifacts', type=Path, required=True)
    p.add_argument('--keep', action='store_true')
    p.add_argument('--empty-pass-seconds', type=float, default=305,
                   help='observe the actual 300s retirement pass before birthing a seat')
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
    control = root / 'probe.json'
    stub.write_text(stub.read_text().replace(
        'def handle(conn, method, params):',
        'def handle(conn, method, params):\n'
        f'    if method == "seat.probe" and Path({str(control)!r}).exists():\n'
        f'        response = json.loads(Path({str(control)!r}).read_text())\n'
        '        if "error" in response:\n'
        '            raise RuntimeError(response["error"])\n'
        '        return response'))
    stub.chmod(0o755)
    drivers = ['claude-code-hrcpty', 'claude-code-tmux', 'codex-app-server']
    release = {'releaseId': 'stub-broker-t12503', 'sourceCommit': '1' * 40, 'builtAt': '2026-11-01T00:00:00.000Z',
               'releaseRoot': str(release_root),
               'worker': {'protocol': 'harness-broker/0.2', 'executable': str(stub), 'argvPrefix': ['--ops-only', '1'], 'hostedDrivers': drivers}}
    (release_root / 'release.json').write_text(json.dumps({**{k: release[k] for k in ('releaseId', 'sourceCommit', 'builtAt')},
                                                           'protocol': 'harness-broker/0.2', 'hostedDrivers': drivers}))
    for d in ('run', 'state', PROJECT):
        (root / d).mkdir()
    clean = {k: v for k, v in os.environ.items() if not k.startswith(LEAK)}
    subprocess.run(['git', 'init', '-q'], cwd=root / PROJECT, check=True, env=clean)
    subprocess.run([str(binary), 'store', 'migrate', str(r.db_path)], cwd=REPO, check=True, capture_output=True, env=clean)
    config = root / 'federation.json'
    config.write_text(json.dumps({'nodeId': 'h12503', 'peers': {}, 'gate': {'mode': 'off'}}))
    config.chmod(0o600)
    aspd_socket = root / 'aspd.sock'
    aspd = FakeAspd(aspd_socket, release, args.artifacts / 'fake-aspd.ndjson')
    env = dict(clean)
    env.update(HRC_RUNTIME_DIR=str(root / 'run'), HRC_STATE_DIR=str(root / 'state'), HRC_ASPD_SOCKET=str(aspd_socket),
               ASP_PROJECT_ROOT_OVERRIDE=str(root / PROJECT), HRC_PROJECT_SEARCH_ROOTS=str(root / PROJECT),
               HRC_WRKQ_DB=str(root / 'wrkq.db'), WRKQ_DB=str(root / 'wrkq.db'), HRC_WRKQD_TOKEN_FILE='',
               WRKQD_TOKEN_FILE='', WRKQD_TOKEN='', HRC_PEER_CONFIG_FILE=str(config),
               HRC_EVENT_INGEST_SOCKET=str(root / 'run/ingest.sock'), HRC_ACP_WEBHOOK_URL='',
               HRC_BROKER_DURABLE_IPC_ENABLED='1', HRC_SQLITE_SLOW_STATEMENT_MS='0', HRC_FIRST_TURN_EVAL_INTERVAL_SECONDS='1', ASP_HOME=str(root / 'asp-home'))
    r.env = env
    print(f'root {root}\nbinary {binary}\nartifacts {args.artifacts}', flush=True)
    intent = {'placement': {'agentRoot': str(root / PROJECT), 'projectRoot': str(root / PROJECT), 'cwd': str(root / PROJECT),
                            'runMode': 'task', 'bundle': {'kind': 'compose', 'compose': []}, 'dryRun': False},
              'harness': {'provider': 'openai', 'interactive': True}}
    failure = None
    timings = {}
    try:
        empty_started = time.monotonic()
        daemon = r.up('1')
        def statements():
            lines = (args.artifacts / 'daemon-1.log').read_text().splitlines()
            rows = []
            for line in lines:
                try:
                    row = json.loads(line)
                except ValueError:
                    continue
                if row.get('event') == 'sqlite.slow_statement':
                    rows.append(row['data']['sql'])
            return rows

        # No armed watches or writes: threshold=0 traces every SQL execution.
        baseline = len(statements())
        time.sleep(4.2)
        idle_queries = [q for q in statements()[baseline:] if 'FROM runtime_first_turn_watch' in q]
        timings['emptyWatchSeconds'] = 4.2
        timings['emptyWatchQueries'] = len(idle_queries)
        r.check('watchdog.no-empty-scans', not idle_queries, queries=idle_queries)

        # Stay completely empty across the real 300s maintenance boundary.
        # Do not shorten production's timer or create a test-only feature flag.
        time.sleep(max(0, args.empty_pass_seconds - (time.monotonic() - empty_started)))
        traced = []
        for line in (args.artifacts / 'daemon-1.log').read_text().splitlines():
            try:
                traced.append(json.loads(line))
            except ValueError:
                pass
        passes = [row for row in traced if row.get('event') == 'runtime.seat_retirement_complete']
        r.check('retirement.empty-pass-observed', bool(passes) and all(
            row['data']['scanned'] == 0 and row['data']['retired'] == 0 for row in passes), passes=passes)
        if passes:
            stamp = datetime.datetime.fromisoformat(passes[0]['ts'].replace('Z', '+00:00')).timestamp()
            window = [row for row in traced if abs(datetime.datetime.fromisoformat(
                row['ts'].replace('Z', '+00:00')).timestamp() - stamp) < 2]
            watch_reads = [row for row in window if row.get('event') == 'sqlite.slow_statement'
                           and 'FROM runtime_first_turn_watch' in row['data']['sql']]
            timings['emptyRetirementWatchQueries'] = len(watch_reads)
            (args.artifacts / 'empty-retirement-window.json').write_text(json.dumps(window, indent=1) + '\n')
            # A nonzero result needs producer attribution, even when the
            # producer belongs to another task and is left unchanged here.
            r.check('retirement.no-idle-wake', not watch_reads, reads=watch_reads)

        ref = f'agent:{AGENT}:project:{PROJECT}:task:codex-idle-{uuid.uuid4().hex[:8]}/lane:main'
        status, out = r.http('POST', '/v1/sessions/resolve', {'sessionRef': ref, 'create': True, 'summonIntent': 'explicit_local'})
        assert status == 200, (status, out)
        host = out['hostSessionId']
        status, born = r.http('POST', '/v1/turns', {'hostSessionId': host, 'prompt': 'first turn', 'runtimeIntent': intent})
        assert status in (200, 202), ('birth', status, born)
        rid = born['runtimeId']
        r.wait(lambda: r.rows("SELECT 1 FROM runs WHERE run_id=? AND status='completed'", (born['runId'],)), 60, 'first turn')
        r.wait(lambda: r.runtime(rid)['state'].get('brokerDispatchDiagnostics', {}).get('liveSeatProbe', {}).get('state') == 'idle', 15, 'idle probe')
        # Let the final broker acknowledgements and projection wake settle.
        time.sleep(2)
        # Count actual updates, including writes that would restore identical JSON.
        with sqlite3.connect(r.db_path) as db:
            db.executescript("CREATE TABLE probe_updates (at TEXT); CREATE TRIGGER count_probe_updates AFTER UPDATE OF runtime_state_json ON runtimes BEGIN INSERT INTO probe_updates VALUES (NEW.updated_at); END;")
        probe_before = r.runtime(rid)['state']['brokerDispatchDiagnostics']['liveSeatProbe']
        def probes():
            return sum(1 for f in (root / 'run/bipc').glob('*/stub.ndjson') for line in f.read_text().splitlines()
                       if json.loads(line).get('kind') == 'request' and json.loads(line).get('method') == 'seat.probe')
        count = probes()
        sql_before = len(statements())
        time.sleep(15.5)
        writes = len(r.rows('SELECT * FROM probe_updates'))
        timings.update(idleSeatSeconds=15.5, idleSeatWrites=writes, idleProbes=probes() - count)
        r.check('seat.probes-retained', timings['idleProbes'] >= 3, probes=timings['idleProbes'])
        r.check('seat.no-unchanged-writes', writes == 0, writes=writes, before=probe_before,
                after=r.runtime(rid)['state']['brokerDispatchDiagnostics']['liveSeatProbe'])

        idle_wakes = [q for q in statements()[sql_before:] if 'FROM runtime_first_turn_watch' in q]
        timings['idleSeatWatchQueries'] = len(idle_wakes)
        r.check('seat.no-idle-ledger-wakes', not idle_wakes, queries=idle_wakes)

        def inspect_probe(response=None):
            if response is None:
                control.unlink(missing_ok=True)
            else:
                control.write_text(json.dumps(response))
            status, out = r.http('POST', '/v1/runtimes/inspect', {'runtimeId': rid})
            assert status == 200, (status, out)
            return r.runtime(rid)['state']['brokerDispatchDiagnostics']['liveSeatProbe']

        seen = inspect_probe({'seat': {'state': 'turn-observed', 'turnId': 'turn-one'}, 'brokerHeldDepth': 1})
        r.check('seat.transition-persists', seen['state'] == 'turn-observed' and seen['turnId'] == 'turn-one')
        response = {'seat': {'state': 'turn-observed', 'turnId': 'turn-two'}, 'brokerHeldDepth': 2}
        seen = inspect_probe(response)
        r.check('seat.turn-and-depth-persist', seen['turnId'] == 'turn-two' and seen['brokerHeldDepth'] == 2)
        seen = inspect_probe({'error': 'fixture probe unavailable'})
        r.check('seat.failure-is-stale', seen['availability'] == 'stale' and seen['turnId'] == 'turn-two')
        seen = inspect_probe(response)
        r.check('seat.recovery-persists', seen['availability'] == 'current' and 'error' not in seen)
        # An equal probe must still issue its single 60s stall warning.
        with sqlite3.connect(r.db_path) as db:
            state = r.runtime(rid)['state']
            state['brokerDispatchDiagnostics']['seatTransitions'][-1]['transitionedAt'] = '2020-01-01T00:00:00.000Z'
            db.execute('UPDATE runtimes SET runtime_state_json=? WHERE runtime_id=?', (json.dumps(state), rid))
        inspect_probe(response)
        inspect_probe(response)
        r.check('seat.stall-once', len(r.events(rid, 'broker.seat.stalled')) == 1)
        inspect_probe()
        # A completed run left busy must settle even though its idle probe is equal.
        with sqlite3.connect(r.db_path) as db:
            db.execute("UPDATE runtimes SET status='busy',active_run_id=? WHERE runtime_id=?", (born['runId'], rid))
        inspect_probe()
        r.check('seat.equal-idle-settles', r.runtime(rid)['active_run_id'] is None
                and len(r.events(rid, 'runtime.settled')) == 1)

        def notify():
            status, out = r.http('POST', '/v1/sessions/resolve', {'sessionRef': ref, 'create': True, 'summonIntent': 'explicit_local'})
            assert status == 200, (status, out)

        def arm(name, seconds):
            now = datetime.datetime.now(datetime.timezone.utc)
            deadline = now + datetime.timedelta(seconds=seconds)
            iso = lambda d: d.isoformat(timespec='milliseconds').replace('+00:00', 'Z')
            with sqlite3.connect(r.db_path) as db:
                db.execute("INSERT INTO runtime_first_turn_watch (runtime_id,generation,host_session_id,scope_ref,lane_ref,transport,priming_dispatched_at,first_turn_deadline_at,created_at,updated_at) VALUES (?,1,?,?,'main','tmux',?,?,?,?)",
                           (name,host,ref,iso(now),iso(deadline),iso(now),iso(now)))
            notify()
            return deadline.timestamp()

        late = arm('watch-later', 6)
        time.sleep(.3)
        early = arm('watch-earlier', 1.3)
        arm('watch-disarmed', .8)
        with sqlite3.connect(r.db_path) as db:
            db.execute("UPDATE runtime_first_turn_watch SET disarmed_at=updated_at WHERE runtime_id='watch-disarmed'")
        notify()
        for name, deadline in [('watch-earlier', early), ('watch-later', late)]:
            rows = r.wait(lambda: r.rows("SELECT first_turn_missing_tripped_at FROM runtime_first_turn_watch WHERE runtime_id=? AND first_turn_missing_tripped_at IS NOT NULL", (name,)), 12, name)
            tripped = datetime.datetime.fromisoformat(rows[0]['first_turn_missing_tripped_at'].replace('Z', '+00:00')).timestamp()
            lag = tripped - deadline
            timings[name + 'LagSeconds'] = lag
            r.check(name + '.deadline', 0 <= lag < .5, lagSeconds=lag)
        r.check('watchdog.disarm-respected', not r.rows("SELECT 1 FROM hrc_events WHERE runtime_id='watch-disarmed' AND event_kind='first_turn_missing'"))
        r.check('watchdog.exactly-once', len(r.rows("SELECT 1 FROM hrc_events WHERE runtime_id IN ('watch-earlier','watch-later') AND event_kind='first_turn_missing'")) == 2)
        # A failed trip retries at a bounded cadence, then recovers. A trigger
        # aborts only this watch's stamp, rolling back its transaction's event.
        with sqlite3.connect(r.db_path) as db:
            db.execute("CREATE TRIGGER reject_trip BEFORE UPDATE OF first_turn_missing_tripped_at ON runtime_first_turn_watch WHEN NEW.runtime_id='watch-retry' BEGIN SELECT RAISE(ABORT, 'fixture retry'); END")
        arm('watch-retry', -.1)
        time.sleep(2.3)
        failures = sum('runtime.first_turn_missing_trip_failed' in line for line in (args.artifacts / 'daemon-1.log').read_text().splitlines())
        r.check('watchdog.retry-bounded', 2 <= failures <= 4, attempts=failures)
        r.check('watchdog.failed-trip-atomic', not r.rows("SELECT 1 FROM hrc_events WHERE runtime_id='watch-retry' AND event_kind='first_turn_missing'"))
        with sqlite3.connect(r.db_path) as db:
            db.execute('DROP TRIGGER reject_trip')
        notify()
        r.wait(lambda: r.rows("SELECT 1 FROM hrc_events WHERE runtime_id='watch-retry' AND event_kind='first_turn_missing'"), 5, 'retry recovers')
        r.check('watchdog.retry-recovers', True)
        r.down(daemon)
        # The next owner must catch up a deadline missed while it was stopped.
        now = datetime.datetime.now(datetime.timezone.utc)
        old = (now - datetime.timedelta(seconds=1)).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
        with sqlite3.connect(r.db_path) as db:
            db.execute("INSERT INTO runtime_first_turn_watch (runtime_id,generation,host_session_id,scope_ref,lane_ref,transport,first_turn_deadline_at,created_at,updated_at) VALUES ('watch-startup',1,?,?,'main','tmux',?,?,?)",
                       (host,ref,old,old,old))
        # Reconciliation must still commit and publish a real abandoned-run
        # repair after its empty-pass notification is suppressed. Use a tmux
        # run so the independent headless zombie sweep cannot claim it first.
        with sqlite3.connect(r.db_path) as db:
            db.execute("UPDATE runtimes SET last_activity_at='2020-01-01T00:00:00.000Z' WHERE runtime_id=?", (rid,))
            db.execute("INSERT INTO runs (run_id,host_session_id,runtime_id,scope_ref,lane_ref,generation,transport,status,accepted_at,updated_at) VALUES ('run-abandoned',?,?,?,'main',1,'tmux','running',?,?)",
                       (host,rid,ref.split('/lane:')[0],'2020-01-01T00:00:00.000Z','2020-01-01T00:00:00.000Z'))
        daemon = r.up('2')
        r.wait(lambda: r.rows("SELECT 1 FROM runs WHERE run_id='run-abandoned' AND status='failed' AND error_code='run_abandoned_by_runtime'"), 12, 'reconcile real write')
        r.check('reconcile.real-write-preserved', len(r.rows("SELECT 1 FROM hrc_events WHERE run_id='run-abandoned' AND event_kind='turn.reaped'")) == 1)
        r.wait(lambda: r.rows("SELECT 1 FROM hrc_events WHERE runtime_id='watch-startup' AND event_kind='first_turn_missing'"), 12, 'startup catch-up')
        r.check('watchdog.startup-catchup', len(r.rows("SELECT 1 FROM hrc_events WHERE runtime_id='watch-startup' AND event_kind='first_turn_missing'")) == 1)
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
        for pid, _ in descendants_of([str(root), root.name]):
            if pid != os.getpid() and alive(pid):
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
            dump = {t: r.rows(f'SELECT * FROM {t}') for t in ('runtimes', 'runs', 'sessions')}
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
