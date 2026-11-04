#!/usr/bin/env python3
"""Real peer HTTP regression for T-12257 and T-12432, using a private native ledger.

Failure modes: missing route, missing bearer enforcement, an unbounded peer
page, changed exclusive cursor/fence semantics, or forwarding a node page.
Seed more than the cap through the real repository so a missing clamp fails.
T-12432: an unscoped peer bounded-stream must follow the receiving node's own
ledger (ready, then the rows after afterSeq, exclusive) with the local route's
incarnation fence, still require the bearer, and leave tail/runs scope-only.
"""
import argparse
import json
from pathlib import Path
import secrets
import socket
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from n4_federation import Node, free_port, local_tailnet_address


def follow(endpoint, path, token, want):
    """Read `want` NDJSON records from a held-open follow, then hang up."""
    host, port = endpoint.removeprefix('http://').rsplit(':', 1)
    with socket.create_connection((host, int(port)), timeout=10) as conn:
        conn.sendall(f'GET {path} HTTP/1.1\r\nHost: {host}\r\nAuthorization: Bearer {token}\r\n\r\n'.encode())
        reader = conn.makefile('rb')
        status = reader.readline().split()[1]
        assert status == b'200', status
        chunked = False
        while (line := reader.readline().strip()):
            chunked |= line.lower() == b'transfer-encoding: chunked'
        records, buffer = [], b''
        while len(records) < want:
            if chunked:
                size = int(reader.readline().strip(), 16)
                buffer += reader.read(size)
                reader.readline()
            else:
                buffer += reader.read1(65536)
            while b'\n' in buffer:
                line, buffer = buffer.split(b'\n', 1)
                if line.strip():
                    record = json.loads(line)
                    if record.get('type') != 'keepalive':
                        records.append(record)
        return records


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
        incarnation, head = page['ledgerIncarnationId'], page['head']
        stream = f'/v1/events/bounded-stream?ledgerIncarnationId={incarnation}&afterSeq={head - 2}&follow=true'
        status, body = peer('stream-unauth', stream, None)
        assert status == 401 and body['error']['code'] == 'unauthorized', (status, body)
        records = follow(endpoint, stream, token, want=3)
        results['stream'] = records
        assert records[0]['type'] == 'ready' and records[0]['ledgerIncarnationId'] == incarnation, records
        seqs = [r['event']['hrcSeq'] for r in records[1:] if r['type'] == 'event']
        assert seqs == [head - 1, head], records
        status, body = peer('stream-fence', f'/v1/events/bounded-stream?ledgerIncarnationId=wrong&afterSeq=0&follow=true')
        assert status == 409, (status, body)
        for route in ('/v1/events/tail?limit=2', '/v1/runs'):
            status, body = peer('scope-only:' + route, route)
            assert status == 400 and body['error']['code'] == 'invalid_request', (route, status, body)
        print(json.dumps({'pass': True, 'cases': len(results)}))
    finally:
        (args.artifacts / 'peer-events-page.json').write_text(json.dumps(results, indent=2) + '\n')
        node.cleanup()


if __name__ == '__main__':
    main()
