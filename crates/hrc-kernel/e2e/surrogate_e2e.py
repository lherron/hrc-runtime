#!/usr/bin/env python3
"""Replay preserved bytes through the real kernel, then observe a later seat.

Never logs response bodies: the real artifact may contain private tool output.
"""
import argparse
import datetime
import hashlib
import json
import pathlib
import subprocess
import tempfile
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler
from kernel_e2e import Wire, Server


def main():
    args = argparse.ArgumentParser()
    args.add_argument('--binary', required=True)
    args.add_argument('--artifacts', required=True)
    args.add_argument('--captured-page')
    opts = args.parse_args()
    evidence = pathlib.Path(opts.artifacts)
    evidence.mkdir(parents=True, exist_ok=True)
    if opts.captured_page:
        raw = pathlib.Path(opts.captured_page).read_bytes()
    else:
        # Same production path and UTF16 failure, with no private content.
        raw = json.dumps(dict(ledgerIncarnationId='surrogate-ledger', head=101,
                              scannedThrough=101, rows=[dict(hrcSeq=101, eventKind='turn.tool_result',
                              payload=dict(result=dict(content=[dict(type='text', text='prefix\ud800')])))]),
                         ensure_ascii=True).encode()
    captured = json.loads(raw)
    poison_seq = captured['rows'][0]['hrcSeq']
    incarnation = captured['ledgerIncarnationId']
    next_seq = captured['head'] + 1
    now = datetime.datetime.now(datetime.timezone.utc).isoformat()
    session = dict(scopeRef='agent:surrogate:project:test:task:primary', laneRef='main',
                   hostSessionId='surrogate-session', generation=1, status='active', updatedAt=now,
                   identity=dict(agentId='surrogate', projectId='test', taskId='primary'))
    later = dict(session, hrcSeq=next_seq, eventKind='turn.message', category='turn', ts=now,
                 payload=dict(text='fresh seat after preserved page'))
    state = dict(phase=0, served=0, reads=[], stopped=False)

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def reply(self, value=None, body=None):
            body = body if body is not None else json.dumps(value).encode()
            self.send_response(200)
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            u = urllib.parse.urlparse(self.path)
            q = urllib.parse.parse_qs(u.query)
            phase = state['phase']
            if u.path == '/v1/events/page':
                after = int(q['afterSeq'][0])
                state['reads'].append(after)
                if phase and after == poison_seq - 1:
                    state['served'] += 1
                    self.reply(body=raw)  # exact retained bytes, never reserialized
                    return
                head = next_seq if phase == 2 else captured['head'] if phase else poison_seq - 1
                rows = [later] if phase == 2 and after >= poison_seq and after < next_seq else []
                self.reply(dict(ledgerIncarnationId=incarnation, head=head, rows=rows, scannedThrough=head))
            elif u.path == '/v1/presentation/runtimes':
                self.reply(dict(runtimes=[]))
            elif u.path == '/v1/sessions':
                self.reply([session] if phase == 2 else [])
            elif u.path == '/v1/events/latest-by-session':
                self.reply([later] if phase == 2 else [])
            elif u.path == '/v1/events/bounded-stream':
                self.send_response(200)
                self.end_headers()
                try:
                    while not state['stopped']:
                        self.wfile.write(b'{}\n')
                        self.wfile.flush()
                        time.sleep(.1)
                except (BrokenPipeError, ConnectionResetError):
                    pass
            else:
                raise AssertionError('unexpected read route')

        def do_POST(self):
            assert self.path == '/v1/presentation/seats/read'
            self.rfile.read(int(self.headers['Content-Length']))
            self.reply(dict(sessions=[session] if state['phase'] == 2 else [], runtimes=[],
                            events=[later] if state['phase'] == 2 else []))

    with tempfile.TemporaryDirectory(prefix='surrogate-', dir='/tmp') as root:
        root = pathlib.Path(root)
        server = Server(str(root / 'hrc.sock'), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        with (evidence / 'kernel.stderr.log').open('w') as log:
            process = subprocess.Popen([str(pathlib.Path(opts.binary).resolve()), '--runtime-root', str(root)],
                                       stdout=subprocess.PIPE, stderr=log, text=True)
            try:
                ready = json.loads(process.stdout.readline())
                wire = Wire(ready['socket'])

                def status():
                    return wire.call('ingest.status', dict(document_id='hrc'))['bindings'][0]

                def until(predicate):
                    deadline = time.monotonic() + 12
                    while time.monotonic() < deadline:
                        if predicate():
                            return
                        time.sleep(.05)
                    raise AssertionError('kernel recovery deadline exceeded; see status artifact')

                until(lambda: status()['cursor'] is not None)
                before = status()
                assert before['cursor']['seq'] == poison_seq - 1
                state['phase'] = 1
                until(lambda: status()['cursor']['seq'] >= captured['head'])
                recovered = status()
                assert state['served'] > 0
                assert recovered['last_error'] is None
                state['phase'] = 2
                start = time.monotonic()
                until(lambda: status()['cursor']['seq'] == next_seq)
                query = wire.call('document.query', dict(document_id='hrc', type='hrc.seat'))
                assert len(query['rows']) == 1
                payload = query['rows'][0]['payload']
                assert payload['lastHrcSeq'] == next_seq
                assert payload['latestEvent']['preview'] == 'fresh seat after preserved page'
                final = status()
                assert final['resync']['last_resync_at_ms'] is None
                result = dict(rawBytes=len(raw), rawSha256=hashlib.sha256(raw).hexdigest(),
                              exactPageServed=state['served'], before=before, recovered=recovered,
                              final=final, freshSeatSeq=payload['lastHrcSeq'], freshSeatSeconds=time.monotonic()-start,
                              pageAfterSeq=state['reads'])
                (evidence / 'result.json').write_text(json.dumps(result, indent=2) + '\n')
                print(json.dumps(dict(result='PASS', poisonSeq=poison_seq, cursor=next_seq,
                                      rawSha256=result['rawSha256'], freshSeatSeconds=result['freshSeatSeconds'])))
                wire.close()
            finally:
                state['stopped'] = True
                process.terminate()
                process.wait(timeout=5)
                server.shutdown()


if __name__ == '__main__':
    main()
