#!/usr/bin/env python3
"""Judge listener boundaries and untrusted registry replies on private native nodes.

Run with --binary, --scratch-root and --artifacts (all scratch paths under /tmp).
No harness is launched; a private HTTP registry supplies controlled replies to
an enforce-mode caller. --judge rechecks captured observations without daemons;
--plant-wrong-answer corrupts one observation and must exit nonzero.
"""
import argparse
from copy import deepcopy
from http.client import HTTPConnection
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import secrets
import sqlite3
import threading
from urllib.parse import parse_qs, urlsplit

import n4_federation as federation


def call(host, port, method, path, token=None, body=None):
    conn = HTTPConnection(host, port, timeout=15)
    headers = {'content-type': 'application/json'}
    if token is not None:
        headers['authorization'] = 'Bearer ' + token
    try:
        conn.request(method, path, None if body is None else json.dumps(body), headers)
        res = conn.getresponse()
        raw = res.read().decode()
        return {'status': res.status, 'body': json.loads(raw) if raw else None}
    finally:
        conn.close()


def rows(node):
    # Read only the caller's private, owner-created store. Missing tables fail.
    with sqlite3.connect(f'file:{node.db}?mode=ro', uri=True) as db:
        return {table: db.execute(f'SELECT COUNT(*) FROM {table}').fetchone()[0]
                for table in ('placement_ledger', 'runtimes', 'sessions')}


def judge(observations):
    results = []
    for name, expected in {
        'registry:no-auth': 401, 'registry:bad-token': 401,
        'peer:accept': 404, 'registry:accept': 404,
        'registry:locate': 404, 'registry:health': 404,
        'peer:consult': 404, 'peer:establish': 404,
        'control:peer-health': 200, 'control:registry-consult': 404,
    }.items():
        got = observations[name]
        passed = got['status'] == expected
        if name == 'control:registry-consult':
            passed = passed and got['body'].get('ok') is False and got['body'].get('error') == 'unbound'
        results.append({'case': name, 'pass': passed, 'expectedStatus': expected, 'observed': got})
    for name, reason in [('non-unbound-404', 'registry-unreachable'),
                         ('malformed-200', 'registry-unreachable'),
                         ('unauthorized-401', 'registry-refused'),
                         ('control:bound', 'bound-elsewhere')]:
        got = observations[name]
        error = got['body'].get('error', {})
        passed = (got['status'] == 409 and error.get('code') == 'stale_context'
                  and error.get('detail', {}).get('reason') == reason
                  and got['before'] == got['after'] == {'placement_ledger': 0, 'runtimes': 0, 'sessions': 0}
                  and got['consultObserved'])
        results.append({'case': name, 'pass': passed, 'expectedReason': reason, 'observed': got})
    return results


def drive(args, observations):
    host = federation.local_tailnet_address()
    port = lambda: federation.free_port(host)
    token = secrets.token_hex(24)
    node = federation.Node(args.scratch_root, None, args.scratch_root / 'absent-aspd.sock',
                           args.artifacts, 'judgments', args.binary)
    registry_port, peer_port = port(), port()
    fake = None
    thread = None
    try:
        node.write_config({'nodeId': 'n4a', 'peers': {'n4b': {
            'endpoint': f'http://{host}:{port()}', 'token': token}},
            'registry': {'bind': f'http://{host}:{registry_port}'},
            'peerListener': {'bind': f'http://{host}:{peer_port}'},
            'gate': {'mode': 'enforce', 'registryHost': 'n4a'}})
        proc = node.up('native', node.binary, 'listeners')
        scope = federation.scope('judgments')
        consult = '/v1/federation/registry/consult?scopeRef=' + federation.quote(scope, safe='')
        cases = [
            ('registry:no-auth', registry_port, 'GET', consult, None, None),
            ('registry:bad-token', registry_port, 'GET', consult, 'bad-token', None),
            ('peer:accept', peer_port, 'POST', '/v1/federation/accept', token, {}),
            ('registry:accept', registry_port, 'POST', '/v1/federation/accept', token, {}),
            ('registry:locate', registry_port, 'POST', '/v1/federation/locate', token, {'scopeRef': scope}),
            ('registry:health', registry_port, 'GET', '/v1/federation/health', token, None),
            ('peer:consult', peer_port, 'GET', consult, token, None),
            ('peer:establish', peer_port, 'POST', '/v1/federation/registry/establish', token,
             {'scopeRef': scope, 'homeNodeId': 'n4b'}),
            ('control:peer-health', peer_port, 'GET', '/v1/federation/health', token, None),
            ('control:registry-consult', registry_port, 'GET', consult, token, None),
        ]
        for name, target, method, path, auth, body in cases:
            observations[name] = call(host, target, method, path, auth, body)
        node.down(proc)

        class Registry(BaseHTTPRequestHandler):
            answer = (404, {'ok': False, 'error': 'not_found'})
            requests = []

            def do_GET(self):
                self.requests.append((self.path, self.headers.get('authorization')))
                status, value = self.answer
                if status == 200 and value == 'bound':
                    ref = parse_qs(urlsplit(self.path).query)['scopeRef'][0]
                    value = {'ok': True, 'binding': {'scopeRef': ref, 'homeNodeId': 'n4b',
                             'createdAt': '2026-11-10T00:00:00Z', 'updatedAt': '2026-11-10T00:00:00Z'}}
                raw = json.dumps(value).encode()
                self.send_response(status)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            def log_message(self, *args):
                pass

        fake = ThreadingHTTPServer((host, 0), Registry)
        thread = threading.Thread(target=fake.serve_forever, daemon=True)
        thread.start()
        node.write_config({'nodeId': 'n4a', 'peers': {'n4b': {
            'endpoint': f'http://{host}:{peer_port}',
            'registryEndpoint': f'http://{host}:{fake.server_port}', 'token': token}},
            'gate': {'mode': 'enforce', 'registryHost': 'n4b'}})
        proc = node.up('native', node.binary, 'caller')
        for name, answer in [
            ('non-unbound-404', (404, {'ok': False, 'error': 'not_found'})),
            ('malformed-200', (200, {'ok': True, 'binding': {'homeNodeId': 'n4a'}})),
            ('unauthorized-401', (401, {'ok': False, 'error': 'unauthorized'})),
            ('control:bound', (200, 'bound')),
        ]:
            Registry.answer, Registry.requests = answer, []
            ref = federation.scope(name.replace(':', '-'))
            before = rows(node)
            status, body, _ = node.http('POST', '/v1/targets/ensure',
                                      {'sessionRef': ref + '/lane:main', 'runtimeIntent': {}})
            observed = any(urlsplit(path).path == '/v1/federation/registry/consult'
                           and parse_qs(urlsplit(path).query).get('scopeRef') == [ref]
                           and auth == 'Bearer ' + token for path, auth in Registry.requests)
            observations[name] = {'status': status, 'body': body, 'before': before,
                                  'after': rows(node), 'consultObserved': observed, 'registryAnswer': answer}
        node.down(proc)
    finally:
        if fake:
            fake.shutdown()
            fake.server_close()
            thread.join()
        (args.artifacts / 'steps.json').write_text(json.dumps(node.steps, indent=2) + '\n')
        node.cleanup()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary', type=Path)
    parser.add_argument('--scratch-root', type=Path)
    parser.add_argument('--artifacts', type=Path, required=True)
    parser.add_argument('--judge', type=Path, help='judge captured observations without starting nodes')
    parser.add_argument('--plant-wrong-answer', choices=['listener', 'caller'])
    args = parser.parse_args()
    args.artifacts.mkdir(parents=True, exist_ok=True)
    observations = {}
    try:
        if args.judge:
            observations = json.loads(args.judge.read_text())
        else:
            if not args.binary or not args.scratch_root:
                parser.error('--binary and --scratch-root required without --judge')
            if args.scratch_root.exists():
                parser.error('--scratch-root must be fresh')
            drive(args, observations)
    finally:
        (args.artifacts / 'observations.json').write_text(json.dumps(observations, indent=2) + '\n')
    judged = deepcopy(observations)
    if args.plant_wrong_answer == 'listener':
        judged['peer:accept']['status'] = 200
    elif args.plant_wrong_answer == 'caller':
        judged['malformed-200']['after']['runtimes'] = 1
    results = judge(judged)
    (args.artifacts / 'results.json').write_text(json.dumps(results, indent=2) + '\n')
    failures = [row['case'] for row in results if not row['pass']]
    print(json.dumps({'cases': len(results), 'failures': failures, 'planted': args.plant_wrong_answer}))
    raise SystemExit(1 if failures else 0)


if __name__ == '__main__':
    main()
