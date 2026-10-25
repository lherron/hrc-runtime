#!/usr/bin/env python3
"""Real CLI differential status probes. All writable roots belong to this run.

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
import shutil
import sqlite3
import subprocess
import tempfile
import socketserver
import threading

ROOT = Path(__file__).resolve().parents[3]
# Only clock observations can vary between the two sequential diagnostic calls.
NORMALIZATION = {
    'timestamps': r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z',
    'uptime_json': r'("uptime": )\d+',
    'uptime_human': r'(uptime:       )\d+',
    'event_loop_max_json': r'("maxLagMs": )[\d.]+',
    'event_loop_max_human': r'(max lag )[\d.]+',
}


def normalized(item):
    item = dict(item)
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


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--binary', type=Path, required=True)
    p.add_argument('--oracle', type=Path, required=True)
    p.add_argument('--artifacts', type=Path, required=True)
    p.add_argument('--runtime-root', type=Path)
    p.add_argument('--state-root', type=Path)
    args = p.parse_args()
    args.artifacts.mkdir(parents=True, exist_ok=True)
    bun = shutil.which('bun')
    results = []
    with tempfile.TemporaryDirectory(prefix='n5-status-') as temp:
        scratch = Path(temp)
        migrations = sorted(set(re.findall(r"\bid:\s*['\"]([0-9]{4}_[^'\"]+)['\"]", '\n'.join(p.read_text() for p in (ROOT / 'packages/hrc-store-sqlite/src').rglob('*.ts') if '__tests__' not in p.parts))))
        for scenario in ('api-health-failed', 'api-status-failed', 'api-html-failed', 'absent', 'stale-pid', 'partial-pid', 'runtime-file', 'state-file', 'no-ledger', 'empty-ledger', 'partial-schema', 'unknown-schema', 'tmux-missing', 'tmux-stalled', 'tmux-large', 'healthy'):
            if scenario == 'healthy' and not args.runtime_root:
                continue
            base = scratch / scenario
            runtime, state = base / 'run', base / 'state'
            runtime.mkdir(parents=True)
            state.mkdir()
            env = dict(os.environ, HRC_RUNTIME_DIR=str(runtime), HRC_STATE_DIR=str(state), NO_COLOR='1', FORCE_COLOR='0')
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
            before = hashlib.sha256(db_path.read_bytes()).hexdigest() if db_path.is_file() else None
            for flags in ([], ['--json']):
                observed = []
                for command in ([bun, str(args.oracle.resolve())], [str(args.binary.resolve())]):
                    child = subprocess.run(command + ['server', 'status'] + flags, cwd=ROOT, env=env, text=True, capture_output=True, timeout=8)
                    observed.append(dict(exit=child.returncode, stdout=child.stdout, stderr=child.stderr))
                if scenario == 'tmux-large' and flags:
                    complete = json.loads(observed[1]['stdout'])
                    assert len(complete['tmux']['sessions']) == 12000, 'Rust must drain the complete probe'
                    results.append(dict(case='tmux-large:json', status='UNSUPPORTED', reason='Bun truncates server status --json above 64 KiB; Rust emits complete JSON', oracle=observed[0], subject=observed[1]))
                    continue
                results.append(dict(case=scenario + (':json' if flags else ':human'), oracle=observed[0], subject=observed[1], **{'pass': normalized(observed[0]) == normalized(observed[1])}))
            if server:
                server.shutdown()
                server.server_close()
                thread.join()
            after = hashlib.sha256(db_path.read_bytes()).hexdigest() if db_path.is_file() else None
            assert before == after, f'{scenario}: status mutated store'
    report = dict(normalization=NORMALIZATION, cases=results, **{'pass': sum(r.get('pass', False) for r in results), 'fail': sum(r.get('pass') is False for r in results)})
    (args.artifacts / 'results.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({k: report[k] for k in ('pass', 'fail')}))
    for result in results:
        if result.get('pass') is False:
            print('FAIL', result['case'])
    return int(bool(report['fail']))


if __name__ == '__main__':
    raise SystemExit(main())
