#!/usr/bin/env python3
"""Caller standard against a real isolated native owner and its Rust CLI.

Failure modes: missing/invalid headers disappear; boundary values are truncated;
callers share a sampling bucket; one CLI transport omits identity; spawning
children loses attribution. No shared daemon, store, or release is modified.
"""
import argparse
from datetime import datetime, timezone
import json
import os
import pty
import http.server
import socketserver
import threading
import sqlite3
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / 'crates/hrc-native/e2e'))
from hrcpty_substrate import Run, FakeAspd, PROJECT, LEAK  # noqa: E402
from n2_scratch import UnixHTTP  # noqa: E402
from metrics_isolation import isolated_suite  # noqa: E402


def supervisor_checks(r, binary, root):
    sys.path.insert(0, str(REPO / 'crates/hrc-pty/e2e'))
    from hrcpty import Ops, wait_until
    ipc = root / 'pty'
    ipc.mkdir()
    (ipc / 'attach.token').write_text('1234567890abcdef1234567890abcdef')
    broker_env = ipc / 'broker-caller.txt'
    seat_env = ipc / 'seat-caller.json'
    broker = ('import os,pathlib,time; pathlib.Path(' + repr(str(broker_env)) +
              ').write_text(os.environ.get("PRAESIDIUM_CALLER", "absent")); time.sleep(3600)')
    log = (r.artifacts / 'pty.log').open('w')
    proc = subprocess.Popen([str(binary), 'serve', '--foreground', '--socket', str(ipc / 'hrcpty.sock'),
                             '--broker-argv', sys.executable, '-c', broker],
                            env=dict(r.env, PRAESIDIUM_CALLER='inherited-parent'), stdout=log, stderr=log)
    ops = None
    try:
        assert wait_until(lambda: (ipc / 'hrcpty.sock').exists() or proc.poll() is not None)
        assert proc.poll() is None, (r.artifacts / 'pty.log').read_text()
        ops = Ops(str(ipc / 'hrcpty.sock'), (ipc / 'attach.token').read_text())
        assert wait_until(broker_env.exists)
        r.check('supervisor-child-replaces-parent', broker_env.read_text() == 'hrc-pty', caller=broker_env.read_text())
        child = ('import os,pathlib,json; pathlib.Path(' + repr(str(seat_env)) +
                 ').write_text(json.dumps({k:os.environ.get(k) for k in ["PRAESIDIUM_CALLER","ASP_HANDLE"]}))')
        env = {k: r.env[k] for k in ('HOME', 'PATH', 'TERMINFO', 'TERMINFO_DIRS') if k in r.env}
        env.update(PRAESIDIUM_CALLER='wrong-parent', ASP_HANDLE='seat@fixture:primary', SHELL='/bin/sh')
        ops.call('spawn', {'argv': [sys.executable, '-c', child], 'env': env})
        assert wait_until(seat_env.exists)
        value = json.loads(seat_env.read_text())
        r.check('agent-seat-clears-parent', value == {'PRAESIDIUM_CALLER': None, 'ASP_HANDLE': 'seat@fixture:primary'}, env=value)
    finally:
        if ops:
            try:
                ops.call('shutdown')
            finally:
                ops.close()
        if proc.poll() is None:
            proc.terminate()
        proc.wait(timeout=15)
        log.close()


@isolated_suite
def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--binary', type=Path, required=True)
    p.add_argument('--artifacts', type=Path, required=True)
    p.add_argument('--pty-binary', type=Path)
    a = p.parse_args()
    a.artifacts.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='hcaller-', dir='/tmp') as temp:
        root = Path(temp).resolve()
        for d in ('run', 'state', PROJECT, 'bin'):
            (root / d).mkdir()
        # Even the baseline installed executable is copied out of its owner tree.
        binary = root / 'bin/rusthrc'
        shutil.copy2(a.binary.resolve(), binary)
        r = Run(root, a.artifacts, binary)
        r.env = {k: v for k, v in os.environ.items() if not k.startswith(LEAK + ('PRAESIDIUM_',))}
        r.env.update(HRC_RUNTIME_DIR=str(root / 'run'), HRC_STATE_DIR=str(root / 'state'),
                     HRC_WRKQ_DB=str(root / 'wrkq.db'), WRKQ_DB=str(root / 'wrkq.db'),
                     HRC_WRKQD_TOKEN_FILE='', WRKQD_TOKEN_FILE='', WRKQD_TOKEN='',
                     HRC_PEER_CONFIG_FILE=str(root / 'absent.json'), HRC_ACP_WEBHOOK_URL='', ASP_PROJECT_ROOT_OVERRIDE=str(root / PROJECT),
                     HRC_EVENT_INGEST_SOCKET=str(root / 'run/ingest.sock'), HRC_METRICS='1')
        subprocess.run([str(binary), 'store', 'migrate', str(r.db_path)],
                       cwd=REPO, env=r.env, check=True, capture_output=True)
        # Grounded in aspc.resolveRuntimeDeclaration's real absent-agent reply
        # (T-12542/aspc-2.json). HRC treats that advisory placement refusal as
        # nonfatal when attaching to an already durable session.
        class PlacementAspd(FakeAspd):
            def handle(self, method, params):
                if method == 'aspc.resolveRuntimeDeclaration':
                    return {'schemaVersion': 'aspc-resolve-runtime-declaration-response/v1',
                            'ok': False, 'searchedAgentRoots': [],
                            'resolution': {'state': 'absent', 'code': 'agent_not_found',
                                           'message': 'fixture agent is absent', 'diagnostics': []}}
                value = super().handle(method, params)
                if method == 'aspc.hello':
                    value['capabilities']['resolveRuntimeDeclaration'] = True
                return value

        aspd = PlacementAspd(root / 'aspd.sock', {}, a.artifacts / 'aspd.ndjson')
        r.env['HRC_ASPD_SOCKET'] = str(root / 'aspd.sock')
        expected = {}

        def request(tag, caller=None, path='/v1/health', sampling=False):
            headers = {'User-Agent': 'caller-e2e/1'}
            if caller is not None:
                headers['X-Praesidium-Caller'] = caller
            if not sampling:
                headers['X-Hrc-Request-Id'] = tag
            c = UnixHTTP(r.socket)
            c.request('GET', path, headers=headers)
            response = c.getresponse()
            response.read()
            c.close()
            return response.status

        try:
            proc = r.up('caller')
            supervisor_checks(r, (a.pty_binary or a.binary.resolve().with_name('hrc-pty')).resolve(), root)
            cases = [('present', 'cody@hrc-runtime:T-12542', 'cody@hrc-runtime:T-12542'),
                     ('absent', None, 'unknown'), ('empty', '', 'invalid'),
                     ('space', 'two words', 'invalid'), ('long', 'x' * 129, 'invalid'),
                     ('boundary', 'x' * 128, 'x' * 128), ('punctuation', 'Aaz09._:@/+-', 'Aaz09._:@/+-'),
                     ('nonascii', '\xe9', 'invalid')]
            for tag, value, want in cases:
                assert request(tag, value) == 200
                expected[tag] = want
            assert request('error', 'error-component', '/not-a-route') == 404
            expected['error'] = 'error-component'
            # No request IDs: each caller must get its own ten unsampled heads.
            # A whole minute boundary cannot mask the isolation failure.
            if time.time() % 60 > 55:
                time.sleep(60 - time.time() % 60 + .1)
            for caller in ('sample-a', 'sample-b'):
                for _ in range(10):
                    assert request('', caller, sampling=True) == 200
            # Real native blocking CLI: ambient component beats the agent seat.
            for tag, env, want in [
                ('cli-env', {'PRAESIDIUM_CALLER': '  test-component  ', 'ASP_HANDLE': 'ignored@seat'}, 'test-component'),
                ('cli-seat', {'PRAESIDIUM_CALLER': ' ', 'ASP_HANDLE': ' cody@fixture:primary '}, 'cody@fixture:primary'),
                ('cli-unknown', {}, 'unknown'),
            ]:
                child = subprocess.run([str(binary), 'server', 'status', '--json'], env=dict(r.env, **env),
                                       capture_output=True, text=True, timeout=20)
                r.check(tag + '-exit', child.returncode == 0, stderr=child.stderr)
                # Each invocation sends at least one status request; keep order.
                expected[tag] = want
            master, slave = pty.openpty()
            try:
                child = subprocess.run([str(binary), 'server', 'status', '--json'], env=r.env,
                                       stdin=slave, capture_output=True, text=True, timeout=20)
                r.check('cli-tty-exit', child.returncode == 0, stderr=child.stderr)
            finally:
                os.close(master)
                os.close(slave)
            # A private wrkq child records its environment, never the live ledger.
            child_env = root / 'child-caller.txt'
            wrkq = root / 'bin/wrkq'
            wrkq.write_text('#!/bin/sh\nprintf "%s" "$PRAESIDIUM_CALLER" > "' + str(child_env) +
                            "\"\ncat >/dev/null\necho '{\"result\":{\"presentedTo\":[]}}'\n")
            wrkq.chmod(0o755)
            child = subprocess.run([str(binary), 'monitor', 'watch', 'EN-12345', '--json'],
                                   env=dict(r.env, PATH=str(root / 'bin') + os.pathsep + r.env['PATH'],
                                            PRAESIDIUM_CALLER='inherited-parent'),
                                   capture_output=True, text=True, timeout=20)
            r.check('cli-child-replaces-parent', child_env.exists() and child_env.read_text() == 'hrc-cli',
                    stderr=child.stderr)
            # Attach to a private durable runtime: no broker or model birth is
            # needed to reach the real asynchronous replay request.
            scope = 'agent:caller:project:fixture:task:async'
            status, session = r.http('POST', '/v1/sessions/resolve',
                                    {'sessionRef': scope + '/lane:main', 'create': True,
                                     'summonIntent': 'explicit_local'})
            assert status == 200, session
            now = datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
            with sqlite3.connect(r.db_path) as db:
                db.execute('INSERT INTO runtimes(runtime_id,host_session_id,scope_ref,lane_ref,generation,'
                           'transport,status,supports_inflight_input,active_run_id,created_at,updated_at) '
                           "VALUES('caller-runtime',?,?,'main',1,'sdk','running',0,'caller-run',?,?)",
                           (session['hostSessionId'], scope, now, now))
                db.execute('INSERT INTO runs(run_id,host_session_id,runtime_id,scope_ref,lane_ref,generation,'
                           "transport,status,updated_at) VALUES('caller-run',?,'caller-runtime',?,'main',1,'sdk','running',?)",
                           (session['hostSessionId'], scope, now))
            child = subprocess.run([str(binary), 'turn', scope, '--attach', '--json'],
                                   env=dict(r.env, PRAESIDIUM_CALLER='async-component'),
                                   capture_output=True, text=True, timeout=20)
            r.check('async-replay-reached', child.returncode == 6,
                    exit=child.returncode, stdout=child.stdout, stderr=child.stderr)
            # A dead ledger copy ensures the ingest transport also identifies
            # its own named component, overriding an inherited parent hint.
            dead = root / 'dead/state.sqlite'
            dead.parent.mkdir()
            with sqlite3.connect(r.db_path) as source, sqlite3.connect(dead) as target:
                source.backup(target)
            class IngestServer(socketserver.UnixStreamServer):
                pass

            ingest_calls = []

            class IngestHandler(http.server.BaseHTTPRequestHandler):
                def log_message(self, *_):
                    pass

                def do_POST(self):
                    body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                    ingest_calls.append(dict(caller=self.headers.get('X-Praesidium-Caller'), path=self.path))
                    # forwardSequencedBatch consumes only ok and ackedThrough.
                    ack = json.dumps({'ok': True, 'ackedThrough': body['events'][-1]['originSeq']}).encode()
                    self.send_response(200)
                    self.send_header('Content-Length', str(len(ack)))
                    self.end_headers()
                    self.wfile.write(ack)

            ingest_socket = root / 'run/ingest/events.sock'
            ingest_socket.parent.mkdir()
            with IngestServer(str(ingest_socket), IngestHandler) as ingest_server:
                thread = threading.Thread(target=ingest_server.serve_forever, daemon=True)
                thread.start()
                try:
                    child = subprocess.run([str(binary), 'admin', 'events', 'drain', str(dead),
                                            '--source-ref', 'caller-fixture', '--json'],
                                           env=dict(r.env, PRAESIDIUM_CALLER='ignored-parent'),
                                           capture_output=True, text=True, timeout=20)
                    r.check('ingest-exit', child.returncode == 0, stdout=child.stdout, stderr=child.stderr)
                finally:
                    ingest_server.shutdown()
                    thread.join()
            r.check('ingest-component-caller', bool(ingest_calls) and
                    all(v['caller'] == 'hrc-events-drain' for v in ingest_calls), rows=ingest_calls)
        finally:
            for owner in r.owners:
                if owner.poll() is None:
                    r.down(owner)
            for log in r.logs:
                log.close()
            aspd.close()
        logs = [json.loads(line) for line in (a.artifacts / 'daemon-caller.log').read_text().splitlines()
                if line.startswith('{')]
        requests = [v['data'] for v in logs if v.get('event') == 'http.request']
        metrics = [json.loads(line) for f in (root / 'state/metrics').glob('rusthrc-server-*.ndjson')
                   for line in f.read_text().splitlines()]
        for tag, want in expected.items():
            if tag.startswith('cli-'):
                continue
            for label, records, key in [('log', requests, 'requestId'), ('metric', metrics, 'reqId')]:
                rows = [v for v in records if v.get(key) == tag]
                r.check(tag + '-' + label, len(rows) == 1 and rows[0].get('caller') == want, rows=rows, want=want)
        cli = [v for v in requests if v.get('client', '').startswith('rusthrc/') and v.get('route') == '/v1/status']
        r.check('blocking-cli-resolution', [v.get('caller') for v in cli] ==
                ['test-component', 'cody@fixture:primary', 'unknown', 'tty'], rows=cli)
        streams = [v['data'] for v in logs if v.get('event') in ('http.stream.open', 'http.request')
                   and v.get('data', {}).get('route') in ('/v1/events', '/v1/events/bounded-stream')
                   and v.get('data', {}).get('client', '').startswith('rusthrc/')]
        r.check('async-caller', bool(streams) and all(v.get('caller') == 'async-component' for v in streams), rows=streams)
        for caller in ('sample-a', 'sample-b'):
            rows = [v for v in metrics if v.get('caller') == caller]
            r.check(caller + '-sampling', len(rows) == 10 and all('sampleWeight' not in v for v in rows), rows=rows)
        report = {'checks': r.checks, 'metrics': metrics, 'requests': requests,
                  'pass': all(c['pass'] for c in r.checks)}
        (a.artifacts / 'results.json').write_text(json.dumps(report, indent=2) + '\n')
        return 0 if report['pass'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
