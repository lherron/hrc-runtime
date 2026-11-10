#!/usr/bin/env python3
"""Keep-manual transcript-search differential/golden (T-13053).

Failure cases were recorded before implementation in T-13053/failure-cases.md.
Runs against one isolated native daemon via a recording forwarding socket;
compares bytes/status plus request omission/order and duration call clocks.
The existing golden is read only.
Pass --root for an isolated native scratch. No installed writes.
"""
import argparse
from datetime import datetime, timezone
import http.client
import json
import os
import re
from pathlib import Path
import socket
import socketserver
import sqlite3
import subprocess
import tempfile
import threading
import time

ROOT = Path(__file__).resolve().parents[3]
GOLDEN = Path(__file__).parent / 'fixtures/transcript-search-golden.json'
SCOPE = 'agent:cody:project:hrc-runtime:task:T-13053'


def fixture(root):
    with sqlite3.connect(root / 'state/state.sqlite') as db:
        if db.execute('SELECT count(*) FROM transcript_turns').fetchone()[0]:
            assert db.execute('SELECT count(*) FROM transcript_turns').fetchone()[0] == 1004
            return
        for i in range(4):
            runtime = ['rt-a', 'rt-a', 'rt-b', 'rt-c'][i]
            gen = [1, 1, 2, 1][i]
            agent = 'cody' if i < 3 else 'outsider'
            scope = f'agent:{agent}:project:hrc-runtime:task:T-13053'
            stamp = '2026-11-01T00:00:00.000Z'
            db.execute('INSERT OR IGNORE INTO sessions(host_session_id,scope_ref,lane_ref,generation,status,created_at,updated_at) VALUES (?,?,?,1,?,?,?)', ('hsid-' + runtime, scope, 'main', 'idle', stamp, stamp))
            db.execute("INSERT OR IGNORE INTO runtimes(runtime_id,host_session_id,scope_ref,lane_ref,generation,transport,status,supports_inflight_input,created_at,updated_at) VALUES (?,?,?,?,?,'hrc-pty','terminated',0,?,?)", (runtime, 'hsid-' + runtime, scope, 'main', gen, stamp, stamp))
            db.execute('INSERT INTO transcript_turns VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', (i + 1, 'inv-' + runtime, runtime, agent, 'hrc-runtime', 'T-13053', scope, gen, i * 10 + 1, i * 10 + 9, stamp, f'2026-11-01T01:0{i}:00.000Z', ['completed', 'failed', 'interrupted', 'completed'][i], 2, 0, 'kestrel question', 'kestrel \t answer\n ' + str(i), 'mid'))
        for i in range(1000):
            db.execute("INSERT INTO transcript_turns(invocation_id,runtime_id,seq_from,seq_to,started_at,completed_at,terminal_status,message_count,user_text,final_text,mid_text) VALUES (?, 'rt-old',1,2,'2020-01-01','2020-01-01','completed',1,'filler','filler','')", ('inv-filler-' + str(i),))


def cases():
    cases = [[], ['--json'], ['--agent', 'cody'], ['--project', 'hrc-runtime'], ['--task', 'T-13053'],
             ['--limit', '1'], ['--candidate-limit', '2'], ['--since', '2026-11-01'],
             ['--until', '2026-11-01T01:01:00Z'], ['--since', '2026-11-01T02:00:00+01:00', '--json'],
             ['--agent', '', '--project', '', '--task', ''], ['--target', ''],
             ['--agent', '--json'], ['--limit', '01'], ['--limit', '0' * 100 + '1'], ['--limit=2', '--json']]
    for target in ['invocation:inv-rt-a', 'inv-rt-a', 'runtime:rt-a', 'rt-a', 'scope:' + SCOPE, SCOPE,
                   'session:' + SCOPE + '/lane:main', 'cody@hrc-runtime:T-13053', 'host:hsid-a',
                   'msg:message', 'seq:1', 'unknown:thing', 'scope:bad', 'scope:', 'host:', 'session:', 'seq:no', 'runtime:', 'invocation:',
                   'noSuchAgentT13053@hrc-runtime:T-13053']:
        cases += [['--target', target], ['--target', target, '--json']]
    for flag in ['--limit', '--candidate-limit']:
        for value in ['0', '-1', '1.5', 'x', '', ' 2 ', '9007199254740991', '9007199254740992', '9' * 400]:
            cases.append([flag, value])
    for flag in ['--since', '--until']:
        for value in ['nonsense', '', '1h', '2026-02-30', '2026-11-01T00:00:00.123Z', '+010000-01-01', '-000001-01-01', '2026-13-01']:
            cases.append([flag, value])
    rows = [['kestrel', *flags] for flags in cases]
    rows += [[], ['--json'], ['--', '--query'], [''], ['answer'], ['answer', '--target', 'rt-a'], ['filler'], ['zzznomatch'], ['zzznomatch', '--target', 'rt-a'],
             ['"kestrel'], ['"" kestrel'], ['kestrel', '--bogus'], ['kestrel', '--limit'],
             ['kestrel', '--target', 'rt-a', '--agent', 'absent'], ['kestrel', '--output', 'json']]
    for value in ['1m', '1h', '1.5h', '0d', '1d', '2w', '0.000001m', '0.5m', '1.25d', '0.5w']:
        rows.append(['kestrel', '--since', value])
    rows.append(['filler', '--json'])
    return rows


class UnixHTTP(http.client.HTTPConnection):
    def __init__(self, path):
        super().__init__('localhost', timeout=30)
        self.path = path

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX)
        self.sock.connect(str(self.path))


class Proxy(socketserver.ThreadingUnixStreamServer):
    daemon_threads = True


class Handler(__import__('http.server', fromlist=['BaseHTTPRequestHandler']).BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        self.forward()

    def do_GET(self):
        self.forward()

    def forward(self):
        body = self.rfile.read(int(self.headers.get('Content-Length', 0)))
        if self.path == '/v1/transcript-search':
            self.server.requests.append(json.loads(body))
        conn = UnixHTTP(self.server.upstream)
        conn.request(self.command, self.path, body, {k: v for k, v in self.headers.items() if k.lower() not in ['host', 'connection']})
        response = conn.getresponse()
        payload = response.read()
        self.send_response(response.status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)
        conn.close()


def run(cmd, argv, env, proxy, proxy_root):
    proxy.requests.clear()
    start = time.time() * 1000
    p = subprocess.run([*cmd, 'monitor', 'search', *argv], env=env, capture_output=True, text=True, timeout=30)
    end = time.time() * 1000
    requests = json.loads(json.dumps(proxy.requests))
    for request in requests:
        if '--since' in argv:
            raw = argv[argv.index('--since') + 1]
            import re
            if re.fullmatch(r'\d+(?:\.\d+)?[mhdw]', raw):
                duration = float(raw[:-1]) * dict(m=60000, h=3600000, d=86400000, w=604800000)[raw[-1]]
                millis = datetime.fromisoformat(request['since'].replace('Z', '+00:00')).timestamp() * 1000
                assert start - duration - 2 <= millis <= end - duration + 2, (request, start, end)
                request['since'] = '<duration:' + raw + '>'
    return dict(code=p.returncode, stdout=p.stdout.replace(str(proxy_root), '<proxy>'), stderr=p.stderr.replace(str(proxy_root), '<proxy>'), requests=requests)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--binary', type=Path, required=True)
    p.add_argument('--root', type=Path, required=True, help='owned native scratch with run/hrc.sock and state/state.sqlite')
    p.add_argument('--artifacts', type=Path, required=True)
    p.add_argument('--golden', type=Path, default=GOLDEN)
    a = p.parse_args()
    a.artifacts.mkdir(parents=True, exist_ok=True)
    root = a.root.resolve()
    assert root.is_relative_to(Path('/tmp').resolve()), 'scratch must be under /tmp'
    assert (root / 'run/hrc.sock').exists()
    fixture(root)
    expected = json.loads(a.golden.read_text())
    rows = []
    with tempfile.TemporaryDirectory(prefix='t13053-proxy-', dir='/tmp') as temp:
        proxy_root = Path(temp)
        env = {k: v for k, v in os.environ.items() if not k.startswith(('HRC_', 'ASP_', 'AGENT', 'HARNESS', 'CODEX', 'CLAUDE', 'WRKQ', 'TMUX'))}
        env.update(HRC_RUNTIME_DIR=temp, HRC_STATE_DIR=str(root / 'state'), HRC_ASPD_SOCKET=str(root / 'aspd.sock'), HRC_METRICS_DIR=str(proxy_root / 'metrics'))
        with Proxy(str(proxy_root / 'hrc.sock'), Handler) as proxy:
            proxy.upstream = root / 'run/hrc.sock'
            proxy.requests = []
            threading.Thread(target=proxy.serve_forever, daemon=True).start()
            for i, argv in enumerate(cases()):
                actual = run([str(a.binary.resolve())], argv, env, proxy, proxy_root)
                raw_since = argv[argv.index('--since') + 1] if '--since' in argv else ''
                divergence = bool(re.fullmatch(r'\d+(?:\.\d+)?[mhdw]', raw_since) and ('.' in raw_since or raw_since[-1] in 'dw'))
                if divergence:
                    assert actual['code'] == 0 and len(actual['requests']) == 1, actual
                row = dict(argv=argv, result=actual)
                if divergence:
                    row['intentionalDivergence'] = 'T-13053 C-36148: handler duration grammar'
                    row['bunResult'] = expected[i]['bunResult']
                rows.append(row)
                if expected is not None:
                    assert row == expected[i], (i, row, expected[i])
            for mode in ['absent', 'closed']:
                offline = proxy_root / mode
                offline.mkdir()
                if mode == 'closed':
                    sock = socket.socket(socket.AF_UNIX)
                    sock.bind(str(offline / 'hrc.sock'))
                    sock.close()
                dead_env = dict(env, HRC_RUNTIME_DIR=str(offline))
                for argv in [['kestrel'], ['kestrel', '--target', 'unknown:thing'], ['kestrel', '--target', 'host:hsid-a'],
                             ['kestrel', '--target', 'scope:' + SCOPE, '--since', 'invalid'],
                             ['kestrel', '--target', 'scope:' + SCOPE, '--limit', '0']]:
                    actual = run([str(a.binary.resolve())], argv, dead_env, proxy, proxy_root)
                    row = dict(transport=mode, argv=argv, result=actual)
                    if expected is not None:
                        assert row == expected[len(rows)], row
                    rows.append(row)
            proxy.shutdown()
    assert len(rows) == len(expected), 'golden case manifest drift'
    (a.artifacts / 'result.json').write_text(json.dumps(dict(passed=len(rows), mode='golden', cases=rows), indent=2, ensure_ascii=False) + '\n')
    print(f'PASS {len(rows)} transcript search cases')


if __name__ == '__main__':
    main()
