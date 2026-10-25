#!/usr/bin/env python3
"""Black-box summon failures and wire mapping; live gates run separately.

Resolve/start shapes were sampled on installed HRC before creating this fixture.
"""
import argparse
import concurrent.futures
import http.server
import json
import pathlib
import socketserver
import subprocess
import tempfile
import threading
import time
from kernel_e2e import Wire, serve_empty_ledger


def raw(wire, op, args):
    wire.file.write((json.dumps(dict(id=op, op=op, args=args))+'\n').encode())
    return json.loads(wire.file.readline())


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--binary', required=True)
    parser.add_argument('--artifacts', required=True)
    options = parser.parse_args()
    binary = str(pathlib.Path(options.binary).resolve())
    evidence = pathlib.Path(options.artifacts)
    evidence.mkdir(parents=True, exist_ok=True)
    calls, replies = [], []
    scope = 'agent:test:project:test:task:primary'
    ref = scope+'/lane:main'
    intent = dict(placement=dict(agentRoot='/agent', projectRoot='/project', cwd='/cwd',
                                runMode='task', bundle=dict(kind='agent-project', agentName='test', projectRoot='/project'), dryRun=False),
                  harness=dict(interactive=True), execution=dict(preferredMode='headless'),
                  provision=dict(harness='claude', model='opus[1m]', node='max3', remote=True))
    state = dict(refusal=None, delay=0, receipts={})

    class Server(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
        daemon_threads = True

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            calls.append(dict(route=self.path, body=body))
            status = 200
            if state['refusal'] and state['refusal']['route'] == self.path:
                status, value = 409, dict(error=state['refusal']['error'])
            elif self.path == '/v1/declarations/resolve':
                assert body == dict(scopeRef=scope, runMode='task', interactive=True, preferredMode='headless'), body
                value = dict(intent=intent, declaration={})
            elif self.path == '/v1/runtimes/start':
                time.sleep(state['delay'])
                key = body['idempotencyKey']
                fresh = body['conflictPolicy'] == 'suffix'
                expected = dict(runtimeIntent={**intent, 'placement': {**intent['placement'], 'correlation': dict(sessionRef=ref)}},
                                conflictPolicy='suffix' if fresh else 'reject', summonIntent='implicit',
                                idempotencyKey=key, restartStyle='reuse_pty')
                expected['baseSessionRef' if fresh else 'sessionRef'] = ref
                assert body == expected, body
                replayed = key in state['receipts']
                state['receipts'][key] = True
                claimed = ref.replace('primary', 'primary-nova') if fresh else ref
                value = dict(runtimeId='rt-1', hostSessionId='hs-1', transport='tmux', status='idle',
                             claim=dict(sessionRef=claimed, hostSessionId='hs-1', scopeRef=claimed.split('/')[0],
                                        slot='primary-nova' if fresh else 'primary', idempotencyKey=key, replayed=replayed))
            else:
                status, value = 500, dict(error=dict(code='unexpected_route', message=self.path))
            data = json.dumps(value).encode()
            self.send_response(status)
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            serve_empty_ledger(self)

        def log_message(self, *_):
            pass

    with tempfile.TemporaryDirectory(prefix='hk-summon-', dir='/tmp') as root:
        root = pathlib.Path(root)
        server = Server(str(root/'hrc.sock'), Handler)
        threading.Thread(target=lambda: server.serve_forever(poll_interval=.01), daemon=True).start()
        with open(evidence/'stderr.log', 'w') as log:
            process = subprocess.Popen([binary, '--runtime-root', str(root)], stdout=subprocess.PIPE, stderr=log, text=True)
            try:
                ready = json.loads(process.stdout.readline())
                w = Wire(ready['socket'])
                ops = {x['name']: x for x in w.call('registry.discover')['operations']}
                assert ops['seat.summon']['fences_on'] == 'none'
                assert ops['seat.summon']['idempotency'] is None, 'HRC owns durable replay'
                args = dict(session_ref=ref, fresh=False, request_id='same')
                for bad in [dict(args, document_id='hrc'), dict(args, request_id=' '),
                            dict(args, session_ref=scope), dict(args, session_ref=ref.replace('main','other')),
                            dict(args, fresh='true'), dict(args, surprise=1)]:
                    before = len(calls)
                    r = raw(w, 'seat.summon', bad)
                    assert not r['ok'] and len(calls) == before, r
                    replies.append(r)
                for route in ['/v1/declarations/resolve', '/v1/runtimes/start']:
                    for code in ['session_scope_occupied', 'idempotency_key_conflict', 'roster_claim_superseded']:
                        state['refusal'] = dict(route=route, error=dict(code=code, message='original refusal'))
                        before = len(calls)
                        r = raw(w, 'seat.summon', args)
                        assert not r['ok'] and r['error']['details'] == dict(hrc_code=code, message='original refusal'), r
                        assert len(calls)-before == (1 if route.endswith('resolve') else 2), calls[before:]
                        replies.append(r)
                state['refusal'] = None
                a = w.call('seat.summon', args)
                b = w.call('seat.summon', args)
                assert a == dict(session_ref=ref, host_session_id='hs-1', runtime_id='rt-1', status='idle', replayed=False), a
                assert b == dict(a, replayed=True), b
                fresh = w.call('seat.summon', dict(args, fresh=True, request_id='fresh'))
                assert fresh['session_ref'] == ref.replace('primary','primary-nova'), fresh
                state['delay'] = 1
                def slow():
                    client = Wire(ready['socket'])
                    try:
                        return client.call('seat.summon', dict(args, request_id='slow'))
                    finally:
                        client.close()
                with concurrent.futures.ThreadPoolExecutor() as pool:
                    future = pool.submit(slow)
                    time.sleep(.2)
                    start = time.monotonic()
                    w.call('registry.discover')
                    assert time.monotonic()-start < .5, 'summon blocked the owner'
                    future.result()
                w.close()
                report = dict(pass_=True, calls=calls, refusals=replies, exact=a, replay=b, fresh=fresh)
                (evidence/'report.json').write_text(json.dumps(report, indent=2)+'\n')
                print(json.dumps(dict(pass_=True, artifact=str(evidence/'report.json'))))
            finally:
                process.terminate()
                process.wait(timeout=10)
                server.shutdown()
                server.server_close()


if __name__ == '__main__':
    main()
