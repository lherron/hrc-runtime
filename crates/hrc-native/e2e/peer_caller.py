#!/usr/bin/env python3
"""Two private native nodes: preserve caller attribution across peer hops.

No observation windows: finish finite HTTP responses, stop owners, then inspect
all request logs. Distinct concurrent callers detect cross-request leakage.
"""
import argparse
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import secrets
from urllib.parse import quote

from n2_scratch import UnixHTTP
from n4_federation import Node, free_port, local_tailnet_address


def main():
    p = argparse.ArgumentParser()
    for key in ('binary', 'installed-release', 'aspd-socket', 'scratch-root', 'artifacts'):
        p.add_argument('--' + key, type=Path, required=True)
    p.add_argument('--baseline', action='store_true')
    args = p.parse_args()
    args.artifacts.mkdir(parents=True, exist_ok=True)
    host = local_tailnet_address()
    ports = [free_port(host) for _ in range(3)]
    token = secrets.token_hex(24)
    a, b = [Node(args.scratch_root / name, args.installed_release,
                 args.aspd_socket, args.artifacts, name) for name in ('a', 'b')]
    binary = args.binary.resolve()
    if binary.is_relative_to(args.installed_release.resolve()):
        binary = a.release / binary.relative_to(args.installed_release.resolve())
    scope = 'agent:tabularasa:project:n4-t11872:task:peer-caller'
    a.write_config({'nodeId': 'caller-a', 'peers': {'caller-b': {
        'endpoint': f'http://{host}:{ports[1]}', 'registryEndpoint': f'http://{host}:{ports[2]}', 'token': token}},
        'peerListener': {'bind': f'http://{host}:{ports[0]}'}, 'gate': {'mode': 'off'}})
    b.write_config({'nodeId': 'caller-b', 'peers': {'caller-a': {
        'endpoint': f'http://{host}:{ports[0]}', 'token': token}},
        'peerListener': {'bind': f'http://{host}:{ports[1]}'},
        'registry': {'bind': f'http://{host}:{ports[2]}'},
        'gate': {'mode': 'off', 'registryHost': 'caller-b'}})
    for node in (a, b):
        node.bun_store('binding', 'const db=openHrcDatabase(a[0]);'
                       'createPlacementLedgerRepository(db.sqlite).installActive({scopeRef:a[1],homeNodeId:"caller-b",updatedAt:"2026-11-05T00:00:00Z"});db.close()', node.db, scope)
    observations = []
    expected = []

    def call(path, caller, method='GET', body=None):
        headers = {'Content-Type': 'application/json', 'User-Agent': 'caller-fixture/1'}
        if caller is not None:
            headers['x-praesidium-caller'] = caller
        conn = UnixHTTP(a.socket, 20)
        conn.request(method, path, None if body is None else json.dumps(body), headers)
        res = conn.getresponse()
        raw = (res.readline() if '/bounded-stream?' in path else res.read()).decode()
        conn.close()
        assert res.status == 200, (path, res.status, raw)
        return {'path': path, 'caller': caller, 'status': res.status, 'body': raw}

    result = {}
    try:
        b.up('native', binary, 'caller')
        a.up('native', binary, 'caller')
        status, value, _ = b.http('POST', '/v1/sessions/resolve', {'sessionRef': scope + '/lane:main', 'create': True})
        assert status == 200, (status, value)
        locate = '/v1/federation/locate?scopeRef=' + quote(scope)
        routes = [(locate, '/v1/federation/locate', 'GET', None),
                  ('/v1/runs?scopeRef=' + quote(scope), '/v1/runs', 'GET', None),
                  ('/v1/sessions/resolve', '/v1/sessions/resolve', 'POST', {'sessionRef': scope + '/lane:main', 'create': False})]
        _, tail, _ = b.http('GET', '/v1/events/tail?limit=1')
        stream = '/v1/events/bounded-stream?scopeRef=' + quote(scope) + '&afterSeq=0&follow=true&ledgerIncarnationId=' + tail['ledgerIncarnationId']
        routes.append((stream, '/v1/events/bounded-stream', 'GET', None))
        for i, (path, peer_path, method, body) in enumerate(routes):
            caller = f'caller-route-{i}'
            observations.append(call(path, caller, method, body))
            expected.append((peer_path, caller))
        for caller in (None, 'invalid caller', 'caller-after-absent'):
            observations.append(call(locate, caller))
            expected.append(('/v1/federation/locate', 'unknown' if caller is None else 'invalid' if caller == 'invalid caller' else caller))
        callers = [f'caller-concurrent-{i}' for i in range(8)]
        with ThreadPoolExecutor(max_workers=8) as pool:
            observations.extend(pool.map(lambda caller: call(locate, caller), callers))
        expected.extend(('/v1/federation/locate', caller) for caller in callers)
    finally:
        a.cleanup()
        b.cleanup()
        (args.artifacts / 'responses.json').write_text(json.dumps(observations, indent=2) + '\n')
    lines = [json.loads(line) for line in (args.artifacts / 'b-native-caller.log').read_text().splitlines() if line.startswith('{')]
    peer = [line for line in lines if line.get('event') in ('http.request', 'http.stream.open') and line['data'].get('listener') == 'peer']
    result['peerRequests'] = peer
    (args.artifacts / 'result.json').write_text(json.dumps(result, indent=2) + '\n')
    wanted = Counter((path, 'unknown' if args.baseline else caller) for path, caller in expected)
    actual = Counter((v['data']['path'], v['data']['caller']) for v in peer)
    assert actual == wanted, (actual, wanted)
    assert all(v['data']['peer'] == 'caller-a' and v['data']['client'] == 'hrc-server/0.1.0' for v in peer), peer
    registry = [v['data'] for v in lines if v.get('event') == 'http.request' and v['data'].get('listener') == 'registry']
    for path, caller in expected:
        if path != '/v1/federation/locate':
            continue
        want = 'unknown' if args.baseline else caller
        assert any(v['caller'] == want and v['peer'] == 'caller-a' and v['client'] == 'hrc-server/0.1.0' for v in registry), (want, registry)
    print(json.dumps({'pass': True, 'baseline': args.baseline, 'peerRequests': len(peer)}))


if __name__ == '__main__':
    main()
