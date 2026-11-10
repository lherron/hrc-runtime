#!/usr/bin/env python3
"""Transport error parity: existing dead socket, empty/non-JSON HTTP failures,
UTF-16 excerpt boundary and valid JSON without a domain error. These are HTTP
fault vectors, not a replacement daemon. Every CLI root belongs to the suite.
"""
import argparse
import json
import os
from pathlib import Path
import socketserver
import subprocess
import tempfile
import threading

from metrics_isolation import isolated_suite
from status import FaultServer
from frozen_cases import load, compare, observation, roots


class BodyHandler(socketserver.StreamRequestHandler):
    def handle(self):
        if not self.rfile.readline():
            return
        length = 0
        while True:
            line = self.rfile.readline()
            if line in (b'\r\n', b'\n', b''):
                break
            if line.lower().startswith(b'content-length:'):
                length = int(line.split(b':', 1)[1])
        if length:
            self.rfile.read(length)
        body = self.server.body
        self.wfile.write(b'HTTP/1.1 ' + self.server.status + b'\r\nContent-Length: ' + str(len(body)).encode() + b'\r\nConnection: close\r\n\r\n' + body)


@isolated_suite
def main():
    p = argparse.ArgumentParser()
    for key in ('binary', 'artifacts'):
        p.add_argument('--' + key, type=Path, required=True)
    p.add_argument('--fixtures', type=Path, default=Path(__file__).with_name('fixtures') / 'client_errors.json')
    args = p.parse_args()
    args.artifacts.mkdir(parents=True, exist_ok=True)
    vectors = [('stale-socket', None), ('empty', b''), ('short', b'gateway unavailable'), ('long', b'x' * 250), ('unicode-boundary', ('x' * 199 + '😀' + 'z').encode()), ('json-no-error', b'{"message":"down"}'), ('missing-route', b'not found')]
    commands = (['runtime', 'list'], ['runtime', 'list', '--output', 'json'], ['runtime', 'capture', 'rt-missing'], ['start', 'tabularasa@hrc-runtime:never-born', '--json'])
    frozen, literals = load(args.fixtures, [(name + ':' + str(i), argv) for name, _ in vectors for i, argv in enumerate(commands)])
    results = []
    with tempfile.TemporaryDirectory(prefix='n5-client-', dir='/tmp') as temp:
        root = Path(temp)
        for name, body in vectors:
            run = root / name / 'run'
            run.mkdir(parents=True)
            env = {k: v for k, v in os.environ.items() if not k.startswith(('HRC_', 'ASP_', 'WRKQ'))}
            env.update(HRC_RUNTIME_DIR=str(run), HRC_STATE_DIR=str(root / name / 'state'), NO_COLOR='1', FORCE_COLOR='0')
            server = None
            if body is None:
                (run / 'hrc.sock').touch()
            else:
                server = FaultServer(str(run / 'hrc.sock'), BodyHandler)
                server.body = body
                server.status = b'404 Not Found' if name == 'missing-route' else b'502 Bad Gateway'
                threading.Thread(target=server.serve_forever, daemon=True).start()
            try:
                for i, argv in enumerate(commands):
                    child = subprocess.run([str(args.binary.resolve()), *argv], env=env,
                                           capture_output=True, text=True, timeout=10)
                    subject = observation(child)
                    case = name + ':' + str(i)
                    expected = literals[case]['expected']
                    good, diff = compare(expected, roots(subject, run, env['HRC_STATE_DIR']))
                    results.append(dict(case=name, argv=argv, expected=expected,
                                        subject=subject, diff=diff, **{'pass': good}))
            finally:
                if server:
                    server.shutdown()
                    server.server_close()
    report = dict(cases=results, **{'pass': sum(r['pass'] for r in results), 'fail': sum(not r['pass'] for r in results)})
    (args.artifacts / 'results.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({k: report[k] for k in ('pass', 'fail')}))
    for row in results:
        if not row['pass']:
            print('FAIL', row['case'], row['argv'], row['diff'])
    return int(bool(report['fail']))


if __name__ == '__main__':
    raise SystemExit(main())
