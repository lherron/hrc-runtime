#!/usr/bin/env python3
"""Real HTTP request drain: a partial body must not hold the owner indefinitely.

Failure modes: no request reached the handler; stop waits indefinitely; timed-out
teardown claims server.stopped; the clean control also loses its terminal row;
cleanup clears another owner's files. Uses copied Bun only to create the schema.
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'crates/hrc-cli/e2e'))
from copied_release import copied_bun_cli, preflight_unmanaged
from foundation import UnixHTTP
from metrics_isolation import isolated_suite


@isolated_suite
def main():
    parser = argparse.ArgumentParser()
    for name in ('binary', 'oracle', 'environment', 'artifacts'):
        parser.add_argument('--' + name, type=Path, required=True)
    parser.add_argument('--held-only', action='store_true')
    args = parser.parse_args()
    args.artifacts.mkdir(parents=True, exist_ok=True)
    env = {k: v for k, v in os.environ.items()
           if not k.startswith(('ASP_', 'HRC_', 'WRKQ', 'HARNESS_BROKER_'))}
    env.update(json.loads(args.environment.read_text()))
    env.pop('XPC_SERVICE_NAME', None)
    env.pop('HRC_LAUNCHD_LABEL', None)
    assert env['HRC_WRKQ_DB'].startswith('rpc://127.0.0.1:')
    cases = []
    with tempfile.TemporaryDirectory(prefix='s-', dir='/tmp/n5-server-owned-11819') as tmp:
        root = Path(tmp)
        env.update(HRC_RUNTIME_DIR=str(root/'run'), HRC_STATE_DIR=str(root/'state'))
        oracle = copied_bun_cli(args.oracle, root/'release')
        proc = None
        held = None

        def call(path):
            http = UnixHTTP(root/'run/hrc.sock')
            http.request('GET', path)
            response = http.getresponse()
            value = json.loads(response.read())
            http.close()
            assert response.status == 200, value
            return value

        def boot(command, name):
            nonlocal proc
            log = (args.artifacts/(name+'.log')).open('w')
            proc = subprocess.Popen(command+['server', 'serve'], env=env, cwd=root,
                                    stdin=subprocess.DEVNULL, stdout=log, stderr=log)
            log.close()
            for _ in range(300):
                assert proc.poll() is None, name+' exited at boot'
                try:
                    status = call('/v1/status')
                    assert status['runtimeRoot'] == str(root/'run')
                    assert status['stateRoot'] == str(root/'state')
                    assert status['release']['mode'] != 'atomic'
                    return
                except (OSError, ValueError):
                    time.sleep(.05)
            raise AssertionError('no private listener')

        def facts():
            with sqlite3.connect('file:'+str(root/'state/state.sqlite')+'?mode=ro', uri=True) as db:
                return list(db.execute("SELECT hrc_seq,event_kind,payload_json FROM hrc_events WHERE scope_ref='server:hrc' ORDER BY hrc_seq"))

        try:
            preflight_unmanaged(oracle, env, args.artifacts/'release-preflight.json')
            boot([shutil.which('bun'), str(oracle)], 'schema-bootstrap')
            proc.terminate()
            proc.wait(timeout=15)
            for partial in ([True] if args.held_only else [False, True]):
                name = 'held-request' if partial else 'clean'
                boot([str(args.binary.resolve())], name)
                before = facts()[-1][0]
                if partial:
                    held = socket.socket(socket.AF_UNIX)
                    held.connect(str(root/'run/hrc.sock'))
                    # Expect/100-continue proves the server parsed headers before
                    # the deliberately incomplete body parks dispatch_inner.
                    held.sendall(b'POST /v1/sessions/resolve HTTP/1.1\r\nHost: localhost\r\nContent-Length: 100000\r\nExpect: 100-continue\r\nContent-Type: application/json\r\n\r\n')
                    held.settimeout(3)
                    assert b'100 Continue' in held.recv(4096)
                    held.sendall(b'{')
                    time.sleep(.1)
                started = time.monotonic()
                proc.terminate()
                timed_out = False
                try:
                    code = proc.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    timed_out = True
                    code = None
                elapsed = time.monotonic()-started
                delta = [r for r in facts() if r[0] > before]
                record = dict(case=name, elapsedSeconds=elapsed, exitCode=code,
                              timedOut=timed_out, rows=delta)
                (args.artifacts/(name+'.json')).write_text(json.dumps(record, indent=2)+'\n')
                assert not timed_out, 'request drain exceeded its shutdown budget'
                kinds = [r[1] for r in delta]
                assert kinds == (['server.shutting_down'] if partial else ['server.shutting_down', 'server.stopped']), kinds
                if partial:
                    assert 2.5 <= elapsed < 10, elapsed
                    assert 'request_drain_timeout' in (args.artifacts/(name+'.log')).read_text()
                    held.close()
                    held = None
                assert not (root/'run/hrc.sock').exists() and not (root/'run/server.lock').exists()
                cases.append(dict(record, **{'pass': True}))
        finally:
            if held is not None:
                held.close()
            if proc is not None and proc.poll() is None:
                proc.kill()
                proc.wait(timeout=5)
            # SIGKILL has no destructor. Clear only this verified dead child's
            # exact files in this TemporaryDirectory before it is removed.
            if (root/'run/server.lock').exists():
                lock = json.loads((root/'run/server.lock').read_text())
                assert lock['pid'] == proc.pid and proc.poll() is not None
                for name in ('server.lock', 'server.pid', 'hrc.sock'):
                    (root/'run'/name).unlink(missing_ok=True)
            result = dict(cases=cases, **{'pass': len(cases) == (1 if args.held_only else 2)})
            (args.artifacts/'results.json').write_text(json.dumps(result, indent=2)+'\n')
    print(json.dumps(result))
    return int(not result['pass'])


if __name__ == '__main__':
    raise SystemExit(main())
