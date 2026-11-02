#!/usr/bin/env python3
"""Real peer HTTP regression for T-12257, using a private native ledger.

Failure modes: missing route, missing bearer enforcement, an unbounded peer
page, changed exclusive cursor/fence semantics, or forwarding a node page.
Seed more than the cap through the real repository so a missing clamp fails.
"""
import argparse
import json
from pathlib import Path
import secrets
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from n4_federation import Node, free_port, local_tailnet_address


def main():
    parser = argparse.ArgumentParser()
    for key in ('binary', 'installed-release', 'aspd-socket', 'scratch-root', 'artifacts'):
        parser.add_argument('--' + key, type=Path, required=True)
    args = parser.parse_args()
    args.artifacts.mkdir(parents=True, exist_ok=True)
    node = Node(args.scratch_root, args.installed_release, args.aspd_socket, args.artifacts, 'events')
    token = secrets.token_hex(24)
    address = local_tailnet_address()
    endpoint = f'http://{address}:{free_port(address)}'
    results = {}

    def peer(name, path, auth=token):
        req = Request(endpoint + path, headers={} if auth is None else {'Authorization': f'Bearer {auth}'})
        try:
            response = urlopen(req, timeout=10)
        except HTTPError as error:
            response = error
        with response:
            value = {'status': response.code, 'body': json.loads(response.read())}
        results[name] = value
        return value['status'], value['body']

    try:
        node.write_config({'nodeId': 'events-test',
                           'peers': {'other': {'endpoint': f'http://{address}:1', 'token': token}},
                           'peerListener': {'bind': endpoint},
                           'gate': {'mode': 'off', 'registryHost': 'events-test'}})
        node.bun_store('events', '''const db=openHrcDatabase(a[0]);
for(let i=0;i<250;i++) db.hrcEvents.append({ts:new Date(1700000000000+i).toISOString(),hostSessionId:'hrc-server',scopeRef:'server:hrc',laneRef:'main',generation:0,category:'server',eventKind:'server.test.peer',payload:{i}});
db.close();''', node.db)
        node.up('native', args.binary.resolve(), 'page')
        path = '/v1/events/page?afterSeq=0&limit=2'
        for route in (path, '/v1/sessions/page?limit=2'):
            status, body = peer('unauth:' + route, route, None)
            assert status == 401 and body['error']['code'] == 'unauthorized', (status, body)
        status, page = peer('page', path)
        assert status == 200, (status, page)
        assert set(page) == {'ledgerIncarnationId', 'head', 'rows', 'scannedThrough'}, page
        assert len(page['rows']) == 2 and page['scannedThrough'] == page['rows'][-1]['hrcSeq'], page
        cursor = page['scannedThrough']
        status, following = peer('next', f'/v1/events/page?afterSeq={cursor}&limit=2&ledgerIncarnationId={page["ledgerIncarnationId"]}')
        assert status == 200 and len(following['rows']) == 2, following
        assert following['rows'][0]['hrcSeq'] > cursor, following
        for limit in (200, 201, 1001):
            status, capped = peer(f'cap:{limit}', f'/v1/events/page?afterSeq=0&limit={limit}&nodes=other')
            assert status == 200 and len(capped['rows']) == 200, (status, capped)
            assert capped['rows'][-1]['hrcSeq'] == capped['scannedThrough'] < capped['head'], capped
        status, local = node.http('GET', '/v1/events/page?afterSeq=0&limit=201')[:2]
        assert status == 200 and len(local['rows']) == 201, local
        status, body = peer('fence', '/v1/events/page?afterSeq=0&limit=2&ledgerIncarnationId=wrong')
        assert status == 409 and body['error']['code'] == 'cursor_invalid', (status, body)
        for query in ('limit=0', 'limit=1.5', 'limit=-1', 'limit=bad', 'limit=2', 'afterSeq=0'):
            status, body = peer('invalid:' + query, '/v1/events/page?' + query + ('&afterSeq=0' if query.startswith('limit=') and query != 'limit=2' else ''))
            assert status == 400, (query, status, body)
        print(json.dumps({'pass': True, 'cases': len(results)}))
    finally:
        (args.artifacts / 'peer-events-page.json').write_text(json.dumps(results, indent=2) + '\n')
        node.cleanup()


if __name__ == '__main__':
    main()
