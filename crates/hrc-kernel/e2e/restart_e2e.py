#!/usr/bin/env python3
"""Restart wire failure modes: malformed input, busy/stale refusal, committed
launch failure, replay suppression, accidental retries, and blocking reads.
The success payload was captured from installed HRC on restart-probe.
"""
from native_fixture import NativeFixture, clean_env
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
from summon_e2e import raw


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--binary', required=True)
    p.add_argument('--artifacts', required=True)
    o = p.parse_args()
    binary = str(pathlib.Path(o.binary).resolve())
    evidence = pathlib.Path(o.artifacts)
    evidence.mkdir(parents=True, exist_ok=True)
    calls, replies = [], []
    response = dict(priorHostSessionId='hsid-a3ce33e5-f076-49cb-b420-3c1397445d3e',
                    hostSessionId='hsid-f777b3b2-b6f9-401c-8edd-81fa3aca1534', generation=2,
                    launch=dict(status='started', runtimeId='rt-77d20681-db48-4e87-b25d-bacca630ef1a'))
    state = dict(code=None, delay=0, response=response)

    class Server(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
        daemon_threads = True

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            calls.append(dict(route=self.path, body=body))
            assert self.path == '/v1/sessions/restart', self.path
            assert body == dict(hostSessionId='hs-probe', expectedGeneration=1), body
            time.sleep(state['delay'])
            data = json.dumps(dict(error=dict(code=state['code'], message='original refusal'))
                              if state['code'] else state['response']).encode()
            self.send_response(409 if state['code'] else 200)
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            serve_empty_ledger(self)

        def log_message(self, *_):
            pass

    with tempfile.TemporaryDirectory(prefix='hk-restart-', dir='/tmp') as root:
        root = pathlib.Path(root)
        ledger = NativeFixture(root)
        server = Server(str(root/'hrc.sock'), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        with open(evidence/'stderr.log', 'w') as log:
            process = subprocess.Popen(ledger.argv(binary,root), env=clean_env(), stdout=subprocess.PIPE, stderr=log, text=True)
            try:
                ready = json.loads(process.stdout.readline())
                w = Wire(ready['socket'])
                ops = {x['name']: x for x in w.call('registry.discover')['operations']}
                assert ops['seat.restart']['fences_on'] == 'none'
                assert ops['seat.restart']['idempotency'] is None
                args = dict(host_session_id='hs-probe', expected_generation=1)
                for bad in [dict(args, force=True), dict(args, document_id='hrc'),
                            dict(args, expected_generation=-1), dict(args, host_session_id=' ')]:
                    before = len(calls)
                    r = raw(w, 'seat.restart', bad)
                    assert not r['ok'] and len(calls) == before, r
                    replies.append(r)
                for code in ['runtime_busy', 'stale_context', 'seat_unobservable']:
                    state['code'] = code
                    before = len(calls)
                    r = raw(w, 'seat.restart', args)
                    assert not r['ok'] and r['error']['code'] == code, r
                    assert r['error']['details'] == dict(hrc_code=code, message='original refusal'), r
                    assert len(calls) == before+1
                    replies.append(r)
                state['code'] = None
                result = w.call('seat.restart', args)
                assert result == dict(prior_host_session_id=response['priorHostSessionId'],
                                      host_session_id=response['hostSessionId'], generation=2, launch=response['launch']), result
                # Same input must reach HRC again; never cache a successful rotation.
                state['code'] = 'stale_context'
                r = raw(w, 'seat.restart', args)
                assert not r['ok'] and r['error']['code'] == 'stale_context', r
                replies.append(r)
                state['code'] = None
                state['response'] = dict(response, launch=dict(status='failed', message='launch failed'))
                assert w.call('seat.restart', args)['launch']['status'] == 'failed'
                state['delay'] = 1
                def slow():
                    c = Wire(ready['socket'])
                    try:
                        return c.call('seat.restart', args)
                    finally:
                        c.close()
                with concurrent.futures.ThreadPoolExecutor() as pool:
                    future = pool.submit(slow)
                    time.sleep(.2)
                    start = time.monotonic()
                    w.call('registry.discover')
                    assert time.monotonic()-start < .5, 'restart blocked owner'
                    future.result()
                w.close()
                report = dict(pass_=True, calls=calls, refusals=replies, result=result)
                (evidence/'report.json').write_text(json.dumps(report, indent=2)+'\n')
                print(json.dumps(dict(pass_=True, artifact=str(evidence/'report.json'))))
            finally:
                process.terminate()
                process.wait(timeout=10)
                server.shutdown()
                server.server_close()


if __name__ == '__main__':
    main()
