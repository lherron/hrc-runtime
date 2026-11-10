#!/usr/bin/env python3
"""Native status probes against frozen Bun literals. All writable roots belong to this run.

Failure matrix: absent daemon/store, stale PID, malformed PID, conflicting root
files, missing migration ledger, partial/unknown schema, missing/stalled/noisy
tmux. Probe runs must not create/migrate the SQLite store or touch shared tmux.
Healthy daemon cases use an explicitly supplied isolated socket/state pair.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import tempfile
import socketserver
import threading

from metrics_isolation import isolated_suite
import frozen_oracle
from frozen_cases import load, compare, observation, roots

ROOT = Path(__file__).resolve().parents[3]
# Clock observations in optional daemon probes are normalized.
NORMALIZATION = {
    'timestamps': r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z',
    'uptime_json': r'("uptime": )\d+',
    'uptime_human': r'(uptime:       )\d+',
    'event_loop_max_json': r'("maxLagMs": )[\d.]+',
    'event_loop_max_human': r'(max lag )[\d.]+',
}


def normalized(item):
    item = frozen_oracle.project(item)  # the Rust forward registry (frozen_oracle.py)
    for stream in ('stdout', 'stderr'):
        for name, pattern in NORMALIZATION.items():
            item[stream] = re.sub(pattern, '<timestamp>' if name == 'timestamps' else r'\1<clock>', item[stream])
    return item


class FaultServer(socketserver.UnixStreamServer):
    allow_reuse_address = True


class FaultHandler(socketserver.StreamRequestHandler):
    def handle(self):
        line = self.rfile.readline()
        if not line:
            return  # local socket-connect probe
        path = line.split()[1]
        while self.rfile.readline() not in (b'\r\n', b'\n', b''):
            pass
        healthy = self.server.scenario == 'api-status-failed' and path == b'/v1/health'
        body = b'{"ok":true}' if healthy else (b'gateway unavailable' if self.server.scenario == 'api-html-failed' else b'{"error":{"code":"internal_error","message":"diagnostic fault","detail":{}}}')
        code = b'200 OK' if healthy else b'503 Service Unavailable'
        self.wfile.write(b'HTTP/1.1 ' + code + b'\r\nContent-Length: ' + str(len(body)).encode() + b'\r\nConnection: close\r\n\r\n' + body)


@isolated_suite
def main():
    p = argparse.ArgumentParser()
    p.add_argument('--binary', type=Path, required=True)
    p.add_argument('--fixtures', type=Path, default=Path(__file__).with_name('fixtures') / 'status.json')
    p.add_argument('--artifacts', type=Path, required=True)
    p.add_argument('--runtime-root', type=Path)
    p.add_argument('--state-root', type=Path)
    args = p.parse_args()
    args.artifacts.mkdir(parents=True, exist_ok=True)
    scenarios = ('api-health-failed', 'api-status-failed', 'api-html-failed', 'absent', 'stale-pid', 'partial-pid', 'runtime-file', 'state-file', 'no-ledger', 'empty-ledger', 'partial-schema', 'unknown-schema', 'checkpointed-wal', 'live-wal', 'tmux-missing', 'tmux-stalled', 'tmux-large')
    if args.runtime_root:
        scenarios += ('healthy',)
    frozen, literals = load(args.fixtures, [(scenario + (':json' if flags else ':human'), ['server', 'status'] + flags)
                                           for scenario in scenarios for flags in ([], ['--json'])])
    results = []
    with tempfile.TemporaryDirectory(prefix='n5-status-', dir='/tmp') as temp:
        scratch = Path(temp)
        # Frozen Bun ids create baseline/partial/ahead states, independently
        # of the native registry. Forward projection remains frozen_oracle's job.
        migrations = sorted(frozen['migrationIds'])
        assert migrations and migrations[-1] == frozen_oracle.BASELINE_HEAD
        for scenario in scenarios:
            base = scratch / scenario
            runtime, state = base / 'run', base / 'state'
            runtime.mkdir(parents=True)
            state.mkdir()
            env = dict(os.environ, HRC_RUNTIME_DIR=str(runtime), HRC_STATE_DIR=str(state), NO_COLOR='1', FORCE_COLOR='0', PATH='/nonexistent')
            if scenario == 'healthy':
                assert args.state_root and args.runtime_root.joinpath('hrc.sock').exists()
                assert not str(args.runtime_root.resolve()).startswith(str(Path.home() / 'praesidium/var'))
                env.update(HRC_RUNTIME_DIR=str(args.runtime_root), HRC_STATE_DIR=str(args.state_root))
            if scenario in ('stale-pid', 'partial-pid'):
                (runtime / 'server.pid').write_text('2147483647junk\n' if scenario == 'partial-pid' else '2147483647\n')
            if scenario in ('runtime-file', 'state-file'):
                path = runtime if scenario == 'runtime-file' else state
                path.rmdir()
                path.write_text('conflicting file')
            db_path = state / 'state.sqlite'
            if scenario in ('no-ledger', 'empty-ledger', 'partial-schema', 'unknown-schema'):
                with sqlite3.connect(db_path) as db:
                    if scenario == 'no-ledger':
                        db.execute('CREATE TABLE unrelated (id TEXT)')
                    else:
                        db.execute('CREATE TABLE hrc_migrations (id TEXT PRIMARY KEY)')
                        if scenario in ('partial-schema', 'unknown-schema'):
                            assert migrations, 'migration enumeration must be nonempty'
                            ids = migrations[:1] if scenario == 'partial-schema' else migrations + ['9999_unknown']
                            db.executemany('INSERT INTO hrc_migrations VALUES (?)', [(i,) for i in ids])
            wal_writer = None
            if scenario in ('checkpointed-wal', 'live-wal'):
                # A real native store, projected back to the frozen legacy
                # ledger so forward ids remain frozen_oracle's only concern.
                migrated = subprocess.run([str(args.binary.resolve()), 'store', 'migrate', str(db_path)],
                                          env=env, text=True, capture_output=True, timeout=20)
                assert migrated.returncode == 0, migrated.stderr
                wal_writer = sqlite3.connect(db_path)
                wal_writer.execute('PRAGMA journal_mode=WAL')
                wal_writer.execute('DELETE FROM hrc_migrations WHERE id NOT IN (' + ','.join('?' for _ in migrations) + ')', migrations)
                assert sorted(r[0] for r in wal_writer.execute('SELECT id FROM hrc_migrations')) == migrations
                wal_writer.commit()
                if scenario == 'checkpointed-wal':
                    wal_writer.close()
                    wal_writer = None
            def snapshot(path):
                return dict(bytes=path.stat().st_size, mtimeNs=path.stat().st_mtime_ns, sha256=hashlib.sha256(path.read_bytes()).hexdigest()) if path.is_file() else None
            wal_path = Path(str(db_path) + '-wal')
            shm_path = Path(str(db_path) + '-shm')
            controls = [runtime / name for name in ('server.pid', 'server.lock', 'hrc.sock')]
            if scenario.startswith('tmux-'):
                bin_dir = base / 'bin'
                bin_dir.mkdir()
                env['PATH'] = str(bin_dir)
                if scenario != 'tmux-missing':
                    body = '#!/bin/sh\n'
                    if scenario == 'tmux-stalled':
                        body += 'exec /bin/sleep 10\n'
                    else:
                        body += 'if [ "$1" = "-V" ]; then echo "tmux test"; else i=0; while [ "$i" -lt 12000 ]; do echo "session-$i"; i=$((i+1)); done; fi\n'
                    (bin_dir / 'tmux').write_text(body)
                    (bin_dir / 'tmux').chmod(0o755)
            server = None
            if scenario.startswith('api-'):
                server = FaultServer(str(runtime / 'hrc.sock'), FaultHandler)
                server.scenario = scenario
                thread = threading.Thread(target=server.serve_forever, daemon=True)
                thread.start()
            before = snapshot(db_path)
            wal_before, shm_before = snapshot(wal_path), snapshot(shm_path)
            if scenario == 'live-wal':
                assert wal_before and wal_before['bytes'] > 0, 'live WAL state was not built'
            control_before = {str(p): (p.stat().st_mtime_ns if p.exists() else None) for p in controls}
            for flags in ([], ['--json']):
                if scenario == 'checkpointed-wal':
                    # Each output mode sees the same stopped-node state. All
                    # owners are gone; these are suite-owned empty sidecars.
                    wal_path.unlink(missing_ok=True)
                    shm_path.unlink(missing_ok=True)
                child = subprocess.run([str(args.binary.resolve()), 'server', 'status'] + flags,
                                       cwd=ROOT, env=env, text=True, capture_output=True, timeout=8)
                subject = observation(child)
                case = scenario + (':json' if flags else ':human')
                literal = literals[case]
                if scenario in ('checkpointed-wal', 'live-wal') and flags:
                    schema = json.loads(subject['stdout'])['schema']
                    assert schema['readable'] and schema['storeVersion'] == migrations[-1] and schema['pending'] == frozen_oracle.FORWARD_IDS, 'Rust must read live-WAL migration records'
                expected = literal['expected']
                good, diff = compare(normalized(expected), normalized(roots(subject, env['HRC_RUNTIME_DIR'], env['HRC_STATE_DIR'])))
                results.append(dict(case=case, expected=expected, subject=subject, diff=diff, **{'pass': good}))
            if scenario == 'healthy':
                continue  # A live daemon may write; effects are proved on isolated stores above.
            after = snapshot(db_path)
            wal_after, shm_after = snapshot(wal_path), snapshot(shm_path)
            control_after = {str(p): (p.stat().st_mtime_ns if p.exists() else None) for p in controls}
            assert before == after, f'{scenario}: status mutated main store bytes/mtime'
            assert control_before == control_after, f'{scenario}: status changed control files'
            if wal_before is None:
                assert wal_after is None or wal_after['bytes'] == 0, f'{scenario}: status wrote WAL frames'
            else:
                assert wal_after and all(wal_before[k] == wal_after[k] for k in ('bytes', 'sha256')), f'{scenario}: status changed existing WAL'
            results.append(dict(case=scenario + ':store-effects', before=dict(main=before, wal=wal_before, shm=shm_before), after=dict(main=after, wal=wal_after, shm=shm_after), controlsBefore=control_before, controlsAfter=control_after, shmCoordinationEffectsAllowed=True, **{'pass': True}))
            if wal_writer:
                wal_writer.close()
            if server:
                server.shutdown()
                server.server_close()
                thread.join()
    report = dict(normalization=NORMALIZATION, cases=results, **{'pass': sum(r.get('pass', False) for r in results), 'fail': sum(r.get('pass') is False for r in results)})
    (args.artifacts / 'results.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({k: report[k] for k in ('pass', 'fail')}))
    for result in results:
        if result.get('pass') is False:
            print('FAIL', result['case'], result.get('diff', ''))
    return int(bool(report['fail']))


if __name__ == '__main__':
    raise SystemExit(main())
