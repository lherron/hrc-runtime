#!/usr/bin/env python3
"""seat.send wire failure modes: malformed input never reaches HRC, HRC's
refusals (stale fence, no live runtime) pass through untouched, the request
carries the selector, fence and enter flag, and a success is never cached.
The success payload is the shape HRC's literal-input route returns.
"""
from native_fixture import NativeFixture, clean_env
import argparse
import http.server
import json
import pathlib
import socketserver
import subprocess
import tempfile
import threading
from kernel_e2e import Wire, serve_empty_ledger
from summon_e2e import raw

SESSION_REF = 'agent:probe:project:probe:task:primary/lane:main'


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--binary', required=True)
    p.add_argument('--artifacts', required=True)
    o = p.parse_args()
    binary = str(pathlib.Path(o.binary).resolve())
    evidence = pathlib.Path(o.artifacts)
    evidence.mkdir(parents=True, exist_ok=True)
    calls, replies = [], []
    response = dict(delivered=True, sessionRef=SESSION_REF, hostSessionId='hs-probe', generation=1,
                    runtimeId='rt-probe', runId='run-probe', status='started')
    state = dict(code=None, status=409, response=response)

    class Server(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
        daemon_threads = True

    def reply(handler, status, value):
        data = json.dumps(value).encode()
        handler.send_response(status)
        handler.send_header('Content-Length', str(len(data)))
        handler.end_headers()
        handler.wfile.write(data)

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            if self.path == '/v1/presentation/seats/read':
                return reply(self, 200, dict(sessions=[], runtimes=[]))
            calls.append(dict(route=self.path, body=body))
            assert self.path == '/v1/literal-input/by-selector', self.path
            if state['code']:
                return reply(self, state['status'], dict(error=dict(code=state['code'], message='original refusal')))
            reply(self, 200, state['response'])

        def do_GET(self):
            serve_empty_ledger(self)

        def log_message(self, *_):
            pass

    with tempfile.TemporaryDirectory(prefix='hk-send-', dir='/tmp') as root:
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
                assert ops['seat.send']['fences_on'] == 'none'
                assert ops['seat.send']['idempotency'] is None
                args = dict(session_ref=SESSION_REF, host_session_id='hs-probe', expected_generation=1,
                            text='please create a wrkq handoff and then run `hrc restartme`')
                for bad in [dict(args, force=True), dict(args, document_id='hrc'), dict(args, expected_generation=-1),
                            dict(args, host_session_id=' '), dict(args, session_ref=''), dict(args, text=''),
                            dict(args, enter='yes'), {k: v for k, v in args.items() if k != 'expected_generation'}]:
                    before = len(calls)
                    r = raw(w, 'seat.send', bad)
                    assert not r['ok'] and len(calls) == before, (bad, r)
                    replies.append(r)
                for code, status in [('stale_context', 409), ('runtime_unavailable', 409), ('unknown_session', 404)]:
                    state.update(code=code, status=status)
                    before = len(calls)
                    r = raw(w, 'seat.send', args)
                    assert not r['ok'] and r['error']['code'] == code, r
                    assert r['error']['details'] == dict(hrc_code=code, message='original refusal'), r
                    assert len(calls) == before+1
                    replies.append(r)
                state['code'] = None
                result = w.call('seat.send', args)
                assert calls[-1]['body'] == dict(selector=dict(sessionRef=SESSION_REF), text=args['text'], enter=True,
                                                 fences=dict(expectedHostSessionId='hs-probe', expectedGeneration=1)), calls[-1]
                assert result == dict(session_ref=SESSION_REF, host_session_id='hs-probe', generation=1,
                                      runtime_id='rt-probe', run_id='run-probe'), result
                # Same input must reach HRC again; a delivered send is never replayed from cache.
                before = len(calls)
                w.call('seat.send', dict(args, enter=False))
                assert len(calls) == before+1 and calls[-1]['body']['enter'] is False, calls[-1]
                # A held (unsubmitted) send has no run.
                state['response'] = {k: v for k, v in response.items() if k not in ('runId', 'status')}
                held = w.call('seat.send', args)
                assert 'run_id' not in held, held
                state['response'] = dict(response, delivered=False)
                r = raw(w, 'seat.send', args)
                assert not r['ok'] and r['error']['code'] == 'hrc_response_invalid', r
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
