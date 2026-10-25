#!/usr/bin/env python3
"""Black-box kernel check over its wire and the pinned HTTP contract.

Uses the shapes sampled from real HRC reads before building this fixture.
Real installed/live gates are separate; this drives deterministic failure cases.
"""
import argparse
import copy
import datetime
import http.server
import json
import os
import pathlib
import socket
import socketserver
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse


class Wire:
    def __init__(self, path):
        self.sock = socket.socket(socket.AF_UNIX)
        self.sock.settimeout(10)
        self.sock.connect(str(path))
        self.file = self.sock.makefile('rwb', buffering=0)

    def call(self, op, args=None):
        self.file.write((json.dumps(dict(id=op, op=op, args=args or {})) + '\n').encode())
        result = json.loads(self.file.readline())
        assert result.get('ok'), result
        return result['result']

    def close(self):
        self.file.close()
        self.sock.close()


class Server(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True


# An empty, caught-up HRC ledger. The kernel announces ready only once its first
# load lands, so an owner-op fixture serves this rather than refusing reads.
EMPTY_READS = {
    '/v1/events/page': dict(ledgerIncarnationId='ledger-1', head=0, rows=[], scannedThrough=0),
    '/v1/events/latest-by-session': [],
    '/v1/sessions': [],
    '/v1/presentation/runtimes': dict(ok=True, runtimes=[]),
}


def serve_empty_ledger(handler):
    value = EMPTY_READS.get(handler.path.split('?')[0])
    data = json.dumps(value if value is not None else dict(error=dict(code='unavailable'))).encode()
    handler.send_response(503 if value is None else 200)
    handler.send_header('Content-Length', str(len(data)))
    handler.end_headers()
    handler.wfile.write(data)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--binary', required=True)
    parser.add_argument('--artifacts', required=True)
    options = parser.parse_args()
    evidence = pathlib.Path(options.artifacts)
    evidence.mkdir(parents=True, exist_ok=True)
    binary = str(pathlib.Path(options.binary).resolve())
    now = datetime.datetime.now(datetime.timezone.utc).isoformat()
    record = dict(scopeRef='agent:test:project:test:task:primary', laneRef='main',
                  hostSessionId='hs-1', generation=1, status='active', updatedAt=now,
                  identity=dict(agentId='test', projectId='test', taskId='primary'))
    runtime = dict(**{k: record[k] for k in ['scopeRef', 'laneRef', 'hostSessionId', 'generation', 'identity']},
                   runtimeId='rt-1', status='busy', metadata={}, operatorSurfaces=[],
                   contextReading=dict(turnId='turn-1', usedTokens=10, observedAt=now),
                   tmux=dict(socketPath='/tmp/absent-hrc-tmux.sock', attachTarget='seat:tui'))
    state = dict(incarnation='ledger-1', head=0, events=[], sessions=[record], runtimes=[runtime], down=False,
                 wake_revision=0, stream_opens=0, stopping=False, slow_first_load=True)
    # Bootstrap with a tool result hidden behind category-turn bookkeeping.
    preview_call = dict(record, hrcSeq=1, category='turn', eventKind='turn.tool_call', ts=now,
                        payload=dict(toolUseId='call-1', toolName='Bash', input=dict(command='git status -sb')))
    preview_result = dict(record, hrcSeq=2, category='turn', eventKind='turn.tool_result', ts=now,
                          payload=dict(toolUseId='call-1', toolName='Bash'))
    bookkeeping = dict(record, hrcSeq=3, category='runtime', eventKind='runtime.context.updated', ts=now, payload=dict(usedTokens=10))
    # category=turn contains bookkeeping too. Force recovery beyond one page.
    category_bookkeeping = [dict(bookkeeping, hrcSeq=seq, category='turn', eventKind='broker.turn.origin') for seq in range(3, 15)]
    state['events'] = [preview_call, preview_result] + category_bookkeeping
    state['head'] = 14
    paths = []
    tail_queries = []
    lock = threading.Lock()
    wake = threading.Condition(lock)
    outage_read = threading.Event()

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            u = urllib.parse.urlparse(self.path)
            q = urllib.parse.parse_qs(u.query)
            with lock:
                paths.append(u.path)
                if u.path == '/v1/events/bounded-stream':
                    state['stream_opens'] += 1
                s = copy.deepcopy(state)
            if u.path == '/v1/events/bounded-stream':
                # Keep the stream open, as HRC does. Mutations send deliberately
                # lying wakes immediately; only the subsequent page may certify
                # state. EOF/reconnect backoff must not be the fixture's clock.
                self.send_response(200)
                self.end_headers()
                while not s['stopping']:
                    try:
                        self.wfile.write((json.dumps(dict(type='gap', ledgerIncarnationId=s['incarnation'],
                                                         afterHrcSeq=0, beforeHrcSeq=999999))+'\n').encode())
                        self.wfile.flush()
                    except (BrokenPipeError, ConnectionResetError):
                        return
                    # Exercise EOF during the outage: reconnect and failed-read
                    # backoff can overlap, just as they can against real HRC.
                    # Subsequent state changes use the live stream.
                    if s['down'] and s['stream_opens'] == 1:
                        return
                    with wake:
                        wake.wait_for(lambda: state['wake_revision'] != s['wake_revision'] or state['stopping'])
                        s = copy.deepcopy(state)
                return
            if u.path == '/v1/sessions' and s['slow_first_load']:
                # Real HRC takes visible time on a first load; a kernel that
                # announces before it lands is caught here (R-00477).
                with lock:
                    state['slow_first_load'] = False
                time.sleep(1.5)
            status = 200
            if s['down']:
                status, value = 503, dict(error=dict(code='unavailable'))
            elif u.path == '/v1/events/page':
                if q.get('ledgerIncarnationId', [s['incarnation']])[0] != s['incarnation']:
                    status, value = 409, dict(error=dict(code='cursor_invalid'))
                else:
                    after, limit = int(q['afterSeq'][0]), int(q['limit'][0])
                    rows = [e for e in s['events'] if e['hrcSeq'] > after][:limit]
                    value = dict(ledgerIncarnationId=s['incarnation'], head=s['head'], rows=rows,
                                 scannedThrough=rows[-1]['hrcSeq'] if len(rows) == limit else s['head'])
            elif u.path == '/v1/events/tail':
                assert q.get('limit') == ['10'], q
                assert q.get('hostSessionId') and q.get('generation'), q
                tail_queries.append(q)
                if q.get('ledgerIncarnationId', [s['incarnation']])[0] != s['incarnation']:
                    status, value = 409, dict(error=dict(code='cursor_invalid'))
                else:
                    events = [e for e in s['events'] if e['hostSessionId'] == q['hostSessionId'][0]
                              and e['generation'] == int(q['generation'][0])
                              and (not q.get('category') or e.get('category') == q['category'][0])
                              and (not q.get('beforeHrcSeq') or e['hrcSeq'] < int(q['beforeHrcSeq'][0]))]
                    truncated = len(events) > 10
                    events = events[-10:]
                    if not q.get('category'):
                        # A concurrent later call must not become selected.
                        future = dict(preview_call, hrcSeq=999999, payload=dict(toolUseId='future', input=dict(command='wrong future command')))
                        events.append(future)
                    value = dict(events=events, ledgerIncarnationId=s['incarnation'], headHrcSeq=s['head'], truncated=truncated)
            elif u.path == '/v1/sessions':
                value = s['sessions']
            elif u.path == '/v1/presentation/runtimes':
                value = dict(ok=True, runtimes=s['runtimes'])
            elif u.path == '/v1/events/latest-by-session':
                assert not q.get('category'), 'category cannot select the newest turn.* event'
                value = s['events'][-1:]
            else:
                status, value = 500, dict(error=dict(code='forbidden_read'))
            body = json.dumps(value).encode() + b'\n'
            self.send_response(status)
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            if s['down']:
                outage_read.set()

        def do_POST(self):
            assert self.path == '/v1/presentation/seats/read', self.path
            keys = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            with lock:
                paths.append(self.path)
                s = copy.deepcopy(state)
            wanted = set(keys['sessionRefs'])
            for r in s['runtimes']:
                if r['runtimeId'] in keys['runtimeIds']:
                    wanted.add(r['scopeRef'] + '/lane:' + r['laneRef'])
            sessions = [r for r in s['sessions'] if r['scopeRef'] + '/lane:' + r['laneRef'] in wanted]
            runtimes = [r for r in s['runtimes'] if r['scopeRef'] + '/lane:' + r['laneRef'] in wanted]
            events = [e for e in s['events'][-1:] if any(e['hostSessionId'] == r['hostSessionId'] for r in sessions)]
            value = dict(sessions=sessions, runtimes=runtimes, events=events)
            body = json.dumps(value).encode()
            self.send_response(503 if s['down'] else 200)
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_):
            pass

    def wait_for(test, description):
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            result = test()
            if result:
                return result
            time.sleep(.1)
        raise AssertionError((description, wire.call('ingest.status', dict(document_id='hrc'))))

    with tempfile.TemporaryDirectory(prefix='hk-e2e-', dir='/tmp') as root:
        root = pathlib.Path(root)
        tmux_socket = str(root / 'tmux.sock')
        subprocess.run(['tmux', '-S', tmux_socket, 'new-session', '-d', '-s', 'seat', '-n', 'tui', 'sleep 600'], check=True)
        subprocess.run(['tmux', '-S', tmux_socket, 'new-window', '-d', '-t', 'seat', '-n', 'keepalive', 'sleep 600'], check=True)
        state['runtimes'][0]['tmux']['socketPath'] = tmux_socket
        api = root / 'hrc.sock'
        server = Server(str(api), Handler)
        thread = threading.Thread(target=lambda: server.serve_forever(poll_interval=.01), daemon=True)
        thread.start()
        log = open(evidence / 'kernel.stderr.log', 'w')
        process = subprocess.Popen([binary, '--runtime-root', str(root)], stdin=subprocess.DEVNULL,
                                   stdout=subprocess.PIPE, stderr=log, text=True)
        try:
            ready = json.loads(process.stdout.readline())
            assert ready['status'] == 'serving' and ready['document'] == 'hrc' and ready['pid'] == process.pid, ready
            wire = Wire(ready['socket'])
            discovery = wire.call('registry.discover')
            assert {n['name'] for n in discovery['node_types']} >= {'hrc.seat', 'hrc.runtime', 'hrc.project'}
            query = lambda: wire.call('document.query', dict(document_id='hrc', type='hrc.seat'))
            # Ready means caught up: the first read after "serving" is the real
            # seat set, never revision 0's empty one (R-00477).
            first = query()
            assert first['rows'] and not first['bootstrapping'], ('served before first load', first)
            resynced = wire.call('resync')
            assert resynced['documents']['hrc']['revision'] > 0, resynced['documents']['hrc']
            row = first['rows'][0]
            assert row['payload']['contextReading']['usedTokens'] == 10, row
            assert row['payload']['latestEvent']['preview'] == 'ran: Bash', row
            assert row['payload']['lastHrcSeq'] == 14, row
            assert any(q.get('category') == ['turn'] and q.get('beforeHrcSeq') for q in tail_queries), tail_queries
            attachment = wire.call('resource.attach', dict(document_id='hrc', id=row['id']))
            assert attachment['descriptor']['socket'] == tmux_socket
            assert '-r' in attachment['descriptor']['argv']
            subprocess.run([sys.executable, str(pathlib.Path(__file__).with_name('live_probe.py')),
                            '--socket', ready['socket'], '--artifacts', str(evidence/'probe')], check=True, timeout=20)
            # A stale presentation row remains projected, but a dead window must
            # refuse descriptor issuance without reconciling or mutating HRC.
            subprocess.run(['tmux', '-S', tmux_socket, 'kill-window', '-t', 'seat:tui'], check=True)
            wire.file.write((json.dumps(dict(id='ended', op='resource.attach', args=dict(document_id='hrc', id=row['id'])))+'\n').encode())
            ended = json.loads(wire.file.readline())
            assert not ended['ok'] and ended['error']['code'] == 'resource_unavailable', ended
            assert ended['error']['details']['reason'] == 'ended', ended
            assert query()['rows'][0]['id'] == row['id'], 'attach probe changed the projection'
            subprocess.run(['tmux', '-S', tmux_socket, 'new-window', '-d', '-t', 'seat', '-n', 'tui', 'sleep 600'], check=True)
            duplicate = subprocess.run([binary, '--runtime-root', str(root)], capture_output=True, timeout=3)
            assert duplicate.returncode != 0, 'second kernel took over socket'
            with wake:
                state['down'] = True
                state['wake_revision'] += 1
                wake.notify_all()
            assert outage_read.wait(20), 'kernel never observed the API outage'
            assert process.poll() is None and query()['rows'][0]['id'] == row['id']
            with wake:
                state['down'] = False
                state['sessions'][0].update(hostSessionId='hs-2', generation=2)
                state['runtimes'][0].update(hostSessionId='hs-2', generation=2, runtimeId='rt-2')
                state['runtimes'][0]['contextReading']['usedTokens'] = 20
                state['runtimes'][0]['tmux']['attachTarget'] = 'seat'  # Legacy bare-session target.
                # Interior holes and a spill stub: never require dense seqs or
                # hydration to learn which current keys to re-read.
                state['events'].append(dict(preview_call, hostSessionId='hs-2', generation=2, hrcSeq=20))
                for seq in [22, 24]:
                    state['events'].append(dict(record, hostSessionId='hs-2', generation=2, hrcSeq=seq,
                                                category='turn', eventKind='turn.tool_result', ts=now, runtimeId='rt-2',
                                                payload=dict(toolUseId='call-1', toolName='Bash', result=dict(details=dict(spill=dict(blobId='blob'))))))
                state['events'].append(dict(bookkeeping, hostSessionId='hs-2', generation=2, hrcSeq=25))
                state['head'] = 26
                state['wake_revision'] += 1
                wake.notify_all()
            after = wait_for(lambda: (r if (r := query())['rows'][0]['payload'].get('generation') == 2 else None), 'replay sparse ledger')
            assert after['rows'][0]['id'] == row['id'], 'seat row changed across generation'
            assert after['rows'][0]['payload']['contextReading']['usedTokens'] == 20
            assert after['rows'][0]['payload']['latestEvent']['preview'] == 'ran: git status -sb', after
            assert any(q['generation'] == ['2'] for q in tail_queries), tail_queries
            assert after['rows'][0]['payload']['lastHrcSeq'] == 25, after
            assert any(q.get('category') == ['turn'] and q['generation'] == ['2'] for q in tail_queries), tail_queries
            legacy = wire.call('resource.attach', dict(document_id='hrc', id=row['id'], mode='normal'))
            assert legacy['descriptor']['target'] == 'seat' and '-r' not in legacy['descriptor']['argv']
            status = wire.call('ingest.status', dict(document_id='hrc'))['bindings'][0]
            assert status['resync']['every_ms'] == 600000, status
            cursor = status['cursor']
            with wake:
                state['sessions'][0].update(hostSessionId='hs-3', generation=3)
                state['runtimes'][0].update(hostSessionId='hs-3', generation=3, runtimeId='rt-3')
                state['events'].append(dict(bookkeeping, hostSessionId='hs-3', generation=3, hrcSeq=30, runtimeId='rt-3'))
                state['head'] = 30
                state['wake_revision'] += 1
                wake.notify_all()
            new_generation = wait_for(lambda: (r if (r := query())['rows'][0]['payload'].get('generation') == 3 else None), 'new generation clears turn preview')
            assert 'latestEvent' not in new_generation['rows'][0]['payload'], new_generation
            assert new_generation['rows'][0]['payload']['lastHrcSeq'] == 30, new_generation
            with wake:
                state['incarnation'] = 'ledger-2'
                state['events'] = []
                state['head'] = 0
                state['wake_revision'] += 1
                wake.notify_all()
            replaced = wait_for(lambda: (s if (s := wire.call('ingest.status', dict(document_id='hrc'))['bindings'][0])['cursor'] and s['cursor'].get('incarnation') == 'ledger-2' and s['caught_up'] else None), 'replacement reset/rebuild')
            assert replaced['last_reset_reason'] == 'incarnation_changed', replaced
            current = query()
            assert len(current['rows']) == 1
            assert 'latestEvent' not in current['rows'][0]['payload'], current
            resync = wire.call('resync')
            # Replay and subscribe are served even though client edits are disallowed.
            sub = Wire(ready['socket'])
            subscribed = sub.call('events.subscribe', dict(after=resync['cursor'], incarnation=resync['host_incarnation']))
            assert 'cursor' in subscribed
            sub.close()
            allowed = {'/v1/events/tail', '/v1/presentation/seats/read', '/v1/events/page', '/v1/events/bounded-stream', '/v1/events/latest-by-session', '/v1/presentation/runtimes', '/v1/sessions'}
            assert '/v1/presentation/seats/read' in paths, paths
            assert set(paths) <= allowed, set(paths)
            assert state['stream_opens'] >= 2, 'wake stream never reconnected after EOF'
            report = dict(ready=ready, types=[n['name'] for n in discovery['node_types']],
                          initial=first, replay=after, cursor_before_replace=cursor,
                          replacement=replaced, new_generation=new_generation, resync=resync, ended=ended, legacy_attach=legacy, tail_queries=tail_queries, paths=sorted(set(paths)), pass_=True)
            (evidence / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
            print('PASS bootstrap, API outage recovery, sparse/spill replay, stable generation row, attach, incarnation reset, subscribe/replay, pinned reads')
            wire.close()
        finally:
            process.terminate()
            process.wait(timeout=3)
            log.close()
            with wake:
                state['stopping'] = True
                wake.notify_all()
            server.shutdown()
            server.server_close()
            subprocess.run(['tmux', '-S', tmux_socket, 'kill-server'], check=False, capture_output=True)


if __name__ == '__main__':
    main()
