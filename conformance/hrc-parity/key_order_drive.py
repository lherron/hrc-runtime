#!/usr/bin/env python3
"""Run an existing native E2E driver with scratch provenance and wire capture.

This adds evidence around drivers that project away full response bodies. It
never edits route behavior. Invoke from a clean terminal, passing the existing
driver and its normal arguments. Captures are supplemental evidence;
value comparison still runs through each suite's original comparator.
"""
import argparse
import http.client
import inspect
import json
import os
from pathlib import Path
import re
import runpy
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[2]
NATIVE = ROOT / 'crates/hrc-native/e2e'


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--suite', required=True)
    p.add_argument('--capture', type=Path, required=True)
    p.add_argument('driver')
    p.add_argument('arguments', nargs=argparse.REMAINDER)
    args = p.parse_args()
    assert not any(os.environ.get(k) for k in ('CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CODEX_SANDBOX'))
    sys.path.insert(0, str(NATIVE))
    from n2_scratch import preflight_unmanaged
    original_popen = subprocess.Popen
    owners, provenance, captures = {}, [], {'bun': [], 'native': []}

    def popen(command, *pos, **kw):
        argv = [str(a) for a in command] if not isinstance(command, str) else []
        env = kw.get('env', os.environ)
        if 'compare' in argv and any(a.endswith('hrc-parity/run.py') for a in argv):
            save_captures()
        bun_owner = 'server' in argv and 'serve' in argv and any(a.endswith('/hrc-cli/src/cli.ts') for a in argv)
        native_owner = 'server' in argv and argv and Path(argv[0]).name == 'rusthrc'
        release = None
        if bun_owner or native_owner:
            env = dict(env)
            for key in ('XPC_SERVICE_NAME', 'HRC_LAUNCHD_LABEL'):
                env.pop(key, None)
            kw['env'] = env
            for key in ('HRC_RUNTIME_DIR', 'HRC_STATE_DIR'):
                assert Path(env[key]).resolve().is_relative_to(Path('/tmp').resolve()), (key, env[key])
            assert not env.get('XPC_SERVICE_NAME') and not env.get('HRC_LAUNCHD_LABEL')
            owners[str(Path(env['HRC_RUNTIME_DIR']) / 'hrc.sock')] = 'bun' if bun_owner else 'native'
        if bun_owner:
            cli = next(a for a in argv if a.endswith('/hrc-cli/src/cli.ts'))
            release = preflight_unmanaged(Path(cli).parents[3], env)
        proc = original_popen(command, *pos, **kw)
        if bun_owner:
            from n2_scratch import UnixHTTP
            for _ in range(300):
                if proc.poll() is not None:
                    raise RuntimeError('copied Bun exited before non-atomic readback')
                try:
                    h = UnixHTTP(Path(env['HRC_RUNTIME_DIR']) / 'hrc.sock', timeout=2)
                    h.request('GET', '/v1/status')
                    r = h.getresponse()
                    value = json.loads(r.read())
                    h.close()
                    if r.status == 200:
                        assert value['release']['mode'] == 'unmanaged', value['release']
                        provenance.append({'preflight': release, 'readback': value['release'], 'pid': proc.pid})
                        break
                except (OSError, http.client.HTTPException):
                    pass
                time.sleep(.1)
            else:
                proc.terminate()
                proc.wait(timeout=20)
                raise RuntimeError('copied Bun non-atomic status readback timed out')
        return proc
    def save_captures():
        args.capture.mkdir(parents=True, exist_ok=True)
        (args.capture / 'order-provenance.json').write_text(json.dumps(provenance, indent=2) + '\n')
        for owner, rows in captures.items():
            if rows:
                directory = args.capture / owner
                directory.mkdir(exist_ok=True)
                (directory / 'wire-observations.json').write_text(json.dumps(rows, indent=2) + '\n')

    subprocess.Popen = popen
    original_request, original_response = http.client.HTTPConnection.request, http.client.HTTPConnection.getresponse

    def request(self, method, url, body=None, headers=None, **kw):
        self._order_request = (method, url, headers or {})
        return original_request(self, method, url, body, headers or {}, **kw)

    def getresponse(self):
        response = original_response(self)
        method, route, headers = getattr(self, '_order_request', ('', '', {}))
        owner = owners.get(str(getattr(self, 'path', '')))
        # Accounting intentionally saves only byte counts; capture its actual
        # selected request population, excluding boot/setup probes.
        account = args.suite == 'n1-accounting' and str(headers.get('User-Agent', '')).startswith('n1-accounting/')
        front = args.suite == 'n1-front-accounting' and str(headers.get('User-Agent', '')).startswith('n1-front/')
        frame = next((f for f in inspect.stack() if Path(f.filename).name == args.driver + '.py'), None)
        direct = frame and not any(f.function in ('up', 'wait') for f in inspect.stack()
                                   if Path(f.filename).name == 'n2_scratch.py')
        supplemental = args.suite in ('n2-lanes', 'n2-continuation') and direct and route not in ('/v1/health', '/v1/status')
        passthrough = (args.suite == 'n1-passthrough' and frame and (frame.function == 'request' or route.startswith('/v1/events/bounded-stream?'))
                       # Bare targets are the two native-only legacy-env
                       # controls; the paired target read has a query string.
                       and route not in ('/v1/health', '/v1/sessions/resolve', '/v1/targets')
                       and not route.startswith(('/v1/events/page', '/v1/events/head')))
        if front:
            # The historical front report puts the SAME frontend requests in
            # both files. Obtain a real direct Bun oracle for these responses.
            bun_socket = next(path for path, kind in owners.items() if kind == 'bun')
            from n2_scratch import UnixHTTP
            h = UnixHTTP(bun_socket)
            h.request(method, route, headers={'User-Agent': 'key-order-oracle'})
            r = h.getresponse()
            raw = r.read().decode('utf-8')
            h.close()
            name = method + ' ' + route
            number = sum(row['route'] == name for row in captures['bun'])
            captures['bun'].append({'case': f'{name}#{number}', 'route': name, 'status': r.status, 'raw': raw})
        if owner and (account or supplemental or front or passthrough):
            normalized = re.sub(r'(?:rt|hsid|run)-[0-9a-f-]{36}', '<id>', route)
            normalized = re.sub(r'ledgerIncarnationId=[^&]+', 'ledgerIncarnationId=<owner-ledger>', normalized)
            name = method + ' ' + normalized
            # Preserve repetitions: arrays/requests remain positional.
            number = sum(r['route'] == name for r in captures[owner])
            row = {'case': f'{name}#{number}', 'route': name, 'status': response.status, 'raw': ''}
            captures[owner].append(row)
            depth = [0]
            for operation in ('read', 'readline'):
                original = getattr(response, operation)
                def read(*a, _original=original, _row=row, _depth=depth, **k):
                    _depth[0] += 1
                    try:
                        chunk = _original(*a, **k)
                    finally:
                        _depth[0] -= 1
                    if _depth[0] == 0:
                        _row['raw'] += chunk.decode('utf-8')
                    return chunk
                setattr(response, operation, read)
        return response
    http.client.HTTPConnection.request = request
    http.client.HTTPConnection.getresponse = getresponse
    sys.argv = [str(NATIVE / (args.driver + '.py'))] + args.arguments
    try:
        runpy.run_path(sys.argv[0], run_name='__main__')
    finally:
        save_captures()


if __name__ == '__main__':
    main()
