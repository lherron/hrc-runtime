#!/usr/bin/env python3
"""Native federation listeners drain on owner shutdown (N5's stop seam).

A scratch native node serves a registry and a peer listener. Case `idle`:
SIGTERM with no peer connection must exit promptly and report the listeners
quiescent. Case `held`: a peer bounded-stream follow is open at SIGTERM; the
owner's stream fence ends it, and shutdown must wait for that handler (not
cut it) and then report quiescent within the 3s budget. The not-quiescent
path (a handler outliving the budget) has no real peer route to provoke it.
Failure modes: a listener that keeps accepting after stop, a shutdown that
returns while a handler still runs, or one that hangs past the budget.
"""
import argparse
import json
from pathlib import Path
import secrets
import signal
import socket
import time

from n4_federation import Node, TAILNET, free_port, scope


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--binary', type=Path, required=True)
    p.add_argument('--installed-release', type=Path, required=True)
    p.add_argument('--aspd-socket', type=Path, required=True)
    p.add_argument('--scratch-root', type=Path, required=True)
    p.add_argument('--artifacts', type=Path, required=True)
    args = p.parse_args()
    args.artifacts.mkdir(parents=True, exist_ok=True)
    node = Node(args.scratch_root / 'n', args.installed_release, args.aspd_socket, args.artifacts, 'stop')
    token = secrets.token_hex(24)
    results = {}
    try:
        for case in ('idle', 'held'):
            ports = {'registry': free_port(), 'peer': free_port()}
            node.write_config({'nodeId': 'n4s', 'peers': {'n4o': {'endpoint': f'http://{TAILNET}:1', 'token': token}},
                               'registry': {'bind': f'http://{TAILNET}:{ports["registry"]}'},
                               'peerListener': {'bind': f'http://{TAILNET}:{ports["peer"]}'},
                               'gate': {'mode': 'off', 'registryHost': 'n4s'}})
            proc = node.up('native', args.binary, case)
            _, tail, _ = node.http('GET', '/v1/events/tail?limit=1')
            held = None
            if case == 'held':
                held = socket.create_connection((TAILNET, ports['peer']), timeout=10)
                path = ('/v1/events/bounded-stream?scopeRef=' + scope('held').replace(':', '%3A')
                        + f'&ledgerIncarnationId={tail["ledgerIncarnationId"]}&afterSeq=0&follow=true')
                held.sendall((f'GET {path} HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer {token}\r\n\r\n').encode())
                first = held.recv(4096).decode(errors='replace')
                assert ' 200 ' in first.split('\r\n')[0], first[:200]
            started = time.monotonic()
            proc.send_signal(signal.SIGTERM)
            proc.wait(timeout=30)
            elapsed = round(time.monotonic() - started, 2)
            stream_closed = None
            if held is not None:
                held.settimeout(5)
                try:
                    data = b''
                    while True:
                        chunk = held.recv(65536)
                        if not chunk:
                            break
                        data += chunk
                    stream_closed = True
                except (socket.timeout, OSError):
                    stream_closed = False
                held.close()
            refused = []
            for name, port in ports.items():
                try:
                    socket.create_connection((TAILNET, port), timeout=1).close()
                    refused.append({name: False})
                except OSError:
                    refused.append({name: True})
            log = (args.artifacts / f'stop-native-{case}.log').read_text()
            results[case] = {'exit': proc.returncode, 'stopSeconds': elapsed,
                             'notQuiescentLogged': 'server.stop.federation_listeners_not_quiescent' in log,
                             'stopTimeoutLogged': 'federation.listener.stop_timeout' in log,
                             'streamClosed': stream_closed, 'listenersClosed': refused}
        idle, held = results['idle'], results['held']
        # A held peer stream ends when the owner's stream fence closes it on
        # shutdown; the listener must wait for that handler, not cut it.
        checks = {
            'idle-quiescent': not idle['notQuiescentLogged'] and idle['stopSeconds'] < 3,
            'held-waited-for-handler': held['stopSeconds'] >= idle['stopSeconds'] + 1,
            'held-drained-in-budget': not held['notQuiescentLogged'] and held['stopSeconds'] < 3 + idle['stopSeconds'],
            'held-stream-closed': held['streamClosed'] is True,
            'listeners-closed': all(v for r in results.values() for e in r['listenersClosed'] for v in e.values()),
        }
        results['checks'] = checks
        (args.artifacts / 'listener-stop.json').write_text(json.dumps(results, indent=1) + '\n')
        print(json.dumps(results))
        assert all(checks.values()), checks
    finally:
        node.cleanup()


if __name__ == '__main__':
    main()
