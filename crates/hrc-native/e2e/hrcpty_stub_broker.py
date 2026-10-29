#!/usr/bin/env python3
"""Stub harness-broker for hrcpty_substrate.py (T-12049).

The real `claude-code-hrcpty` driver (T-12050) has not landed, so this stands
in for it. It speaks just enough harness-broker/0.2 NDJSON JSON-RPC on
--socket for rusthrc's birth, reattach and dispose paths, and does what the
real driver will do with its lease:

  hrcpty lease  connect to terminalSurface.socketPath, `hello` with the token
                in --attach-token-file, `spawn` spec.process (argv/env/cwd)
  tmux lease    `tmux respawn-pane` spec.process into the leased tui pane

On invocation.start with an initialInput it emits a turn for that input. With
an hrcpty lease the turn opens an AskUserQuestion tool call and stays open
until the child prints `GOT#n[<answer>]` (polled through the lease's
`capture`), so the daemon's question-answer door has a live ask to answer.
With a tmux lease the turn completes at once.

Every request and emitted event is appended to <ipcDir>/stub.ndjson.
Release identity comes from release.json two directories above this file.
"""
import base64
import json
import os
from pathlib import Path
import shlex
import signal
import socket
import subprocess
import sys
import threading
import time

ARGS = {}
argv = sys.argv[1:]
for i in range(0, len(argv) - 1, 2):
    ARGS[argv[i].lstrip('-')] = argv[i + 1]
SOCKET = ARGS['socket']
IPC = Path(SOCKET).parent
LOG = IPC / 'stub.ndjson'
RELEASE = json.loads((Path(__file__).resolve().parents[1] / 'release.json').read_text())
DRIVERS = RELEASE['hostedDrivers']

lock = threading.RLock()
state = {'invocation': None, 'events': [], 'acked': 0, 'controller': None, 'lease': None,
         'child': None, 'state': 'ready', 'start': None, 'snapshotSeen': threading.Event()}


def now():
    return time.strftime('%Y-%m-%dT%H:%M:%S', time.gmtime()) + '.%03dZ' % (int(time.time() * 1000) % 1000)


def log(kind, **fields):
    with lock, open(LOG, 'a') as f:
        f.write(json.dumps({'at': now(), 'kind': kind, **fields}) + '\n')


def send(conn, frame):
    data = (json.dumps(frame) + '\n').encode()
    with lock:
        try:
            conn.sendall(data)
        except OSError:
            pass


def emit(kind, payload, input_id=None):
    with lock:
        seq = len(state['events']) + 1
        envelope = {'invocationId': state['invocation'], 'seq': seq, 'type': kind, 'time': now(), 'payload': payload}
        if input_id:
            envelope['inputId'] = input_id
        state['events'].append(envelope)
        with open(ARGS['event-ledger'], 'a') as f:
            f.write(json.dumps(envelope) + '\n')
        log('emit', envelope=envelope)
        conn = state['controller']
    if conn is not None:
        send(conn, {'jsonrpc': '2.0', 'method': 'invocation.event', 'params': envelope})


# -- the lease ---------------------------------------------------------------
class Ops:
    """One authenticated hrc-pty ops connection."""
    def __init__(self, path):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(10)
        self.sock.connect(path)
        self.reader = self.sock.makefile('r')
        self.next = 0
        token = Path(ARGS['attach-token-file']).read_text().strip()
        self.hello = self.call('hello', {'token': token})

    def call(self, method, params):
        self.next += 1
        self.sock.sendall((json.dumps({'jsonrpc': '2.0', 'id': self.next, 'method': method, 'params': params}) + '\n').encode())
        reply = json.loads(self.reader.readline())
        if 'error' in reply:
            raise RuntimeError(f'{method}: {reply["error"]}')
        return reply['result']

    def close(self):
        self.sock.close()


def child_spec(start):
    proc = start['spec']['process']
    argv = [proc['command'], *proc.get('args', [])]
    env = {k: v for k, v in os.environ.items() if not k.startswith(('HRC_', 'ASP_', 'AGENT_', 'WRKQ'))}
    env.update(proc.get('env', {}))
    env['SHELL'] = '/bin/sh'  # hrc-pty execs the argv through `$SHELL -lc`
    return argv, env, proc.get('cwd') or os.getcwd()


def take_lease(lease, start):
    argv, env, cwd = child_spec(start)
    if lease['kind'] == 'hrcpty':
        ops = Ops(lease['socketPath'])
        log('lease.hello', hello=ops.hello)
        spawned = ops.call('spawn', {'argv': argv, 'env': env, 'cwd': cwd, 'cols': 100, 'rows': 30})
        ops.close()
        log('lease.spawned', spawned=spawned)
        return spawned['pid']
    if lease['kind'] == 'tmux-pane':
        command = ' '.join(shlex.quote(a) for a in argv)
        out = subprocess.run(['tmux', '-S', lease['socketPath'], 'respawn-pane', '-k', '-t', lease['paneId'], '-c', cwd,
                              command], capture_output=True, text=True, timeout=10)
        log('lease.respawn', exit=out.returncode, stderr=out.stderr)
        pid = subprocess.run(['tmux', '-S', lease['socketPath'], 'display-message', '-p', '-t', lease['paneId'],
                              '#{pane_pid}'], capture_output=True, text=True, timeout=10).stdout.strip()
        return int(pid) if pid.isdigit() else None
    raise RuntimeError('unsupported lease ' + lease['kind'])


def run_turn(input_id, prompt):
    state['snapshotSeen'].wait(30)
    time.sleep(.3)
    emit('input.accepted', {'inputId': input_id}, input_id)
    emit('turn.started', {}, input_id)
    with lock:
        state['state'] = 'running'
    lease = state['lease']
    if not lease or lease['kind'] != 'hrcpty':
        emit('assistant.message.completed', {'content': [{'type': 'text', 'text': 'stub ok'}], 'final': True}, input_id)
        emit('turn.completed', {}, input_id)
        with lock:
            state['state'] = 'ready'
        return
    tool = 'toolu_stub_ask_1'
    emit('tool.call.started', {'toolCallId': tool, 'name': 'AskUserQuestion',
                               'input': {'questions': [{'question': 'stub question for ' + prompt}]}}, input_id)
    # The answer arrives as a typed line; the child echoes it as GOT#n[...].
    deadline = time.time() + 600
    while time.time() < deadline:
        try:
            ops = Ops(lease['socketPath'])
            text = ops.call('capture', {})['text']
            ops.close()
        except (OSError, RuntimeError, ValueError):
            time.sleep(.3)
            continue
        answered = [l for l in text.splitlines() if l.startswith('GOT#') and ']' in l and l[l.index('[') + 1:].strip(']').strip()]
        if answered:
            emit('tool.call.completed', {'toolCallId': tool, 'name': 'AskUserQuestion',
                                         'result': {'output': answered[0]}}, input_id)
            emit('assistant.message.completed', {'content': [{'type': 'text', 'text': 'answered'}], 'final': True}, input_id)
            emit('turn.completed', {}, input_id)
            with lock:
                state['state'] = 'ready'
            return
        time.sleep(.3)


# -- JSON-RPC ----------------------------------------------------------------
def snapshot():
    with lock:
        return {'invocationId': state['invocation'], 'state': state['state'], 'currentSeq': len(state['events']),
                'retentionFloorSeq': 0, 'capture': None}


def handle(conn, method, params):
    if method == 'broker.hello':
        return {'protocolVersion': RELEASE['protocol'], 'release': {k: RELEASE[k] for k in ('releaseId', 'sourceCommit', 'builtAt')},
                'capabilities': {'multiInvocation': False, 'inspection': {'snapshot': True}},
                'drivers': [{'kind': d} for d in DRIVERS]}
    if method == 'broker.health':
        return {'status': 'ok', 'drivers': [{'kind': d, 'status': 'ok'} for d in DRIVERS]}
    if method == 'invocation.start':
        start = params['startRequest']
        lease = (params.get('runtime') or {}).get('terminalSurface')
        with lock:
            state['invocation'] = start['spec']['invocationId']
            state['controller'] = conn
            state['lease'] = lease
            state['start'] = params
        child = take_lease(lease, start) if lease else None
        with lock:
            state['child'] = child
        initial = start.get('initialInput')
        if initial:
            text = ''.join(p.get('text', '') for p in initial.get('content', []) if isinstance(p, dict))
            threading.Thread(target=run_turn, args=(initial['inputId'], text), daemon=True).start()
        return {'invocationId': state['invocation'], 'state': 'ready', 'childPid': child,
                'capabilities': {'interrupt': True, 'stop': True}}
    if method == 'invocation.snapshot':
        state['snapshotSeen'].set()
        return snapshot()
    if method == 'invocation.status':
        return snapshot()
    if method == 'broker.attach':
        with lock:
            state['controller'] = conn
        return {'attached': True, 'currentSeq': len(state['events']), 'retentionFloorSeq': 0}
    if method == 'invocation.eventsSince':
        after = params.get('afterSeq', 0)
        with lock:
            return {'events': [e for e in state['events'] if e['seq'] > after], 'currentSeq': len(state['events']),
                    'retentionFloorSeq': 0}
    if method == 'invocation.ackEvents':
        with lock:
            state['acked'] = max(state['acked'], params.get('throughSeq', 0))
            return {'ackedThroughSeq': state['acked']}
    if method == 'invocation.interrupt':
        return {'ok': True}
    if method == 'invocation.stop':
        with lock:
            state['state'] = 'stopped'
        return {'ok': True}
    if method == 'invocation.dispose':
        threading.Timer(1.0, lambda: os._exit(0)).start()
        return {'ok': True, 'disposed': True}
    raise KeyError(method)


def serve_connection(conn):
    reader = conn.makefile('r')
    for line in reader:
        try:
            frame = json.loads(line)
        except ValueError:
            continue
        if 'method' not in frame:
            continue  # a reply to one of our own requests (none are sent)
        log('request', method=frame['method'], params=frame.get('params'))
        try:
            result = handle(conn, frame['method'], frame.get('params') or {})
            reply = {'jsonrpc': '2.0', 'id': frame.get('id'), 'result': result}
        except KeyError as error:
            reply = {'jsonrpc': '2.0', 'id': frame.get('id'), 'error': {'code': -32601, 'message': f'method not found: {error}'}}
        except Exception as error:  # noqa: BLE001 - every failure is an RPC error
            reply = {'jsonrpc': '2.0', 'id': frame.get('id'), 'error': {'code': -32603, 'message': f'{type(error).__name__}: {error}'}}
        log('reply', method=frame['method'], reply=reply)
        if frame.get('id') is not None:
            send(conn, reply)
    with lock:
        if state['controller'] is conn:
            state['controller'] = None


def main():
    signal.signal(signal.SIGTERM, lambda *_: (log('sigterm'), os._exit(0)))
    log('boot', argv=sys.argv, pid=os.getpid())
    if os.path.exists(SOCKET):
        os.unlink(SOCKET)
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(SOCKET)
    os.chmod(SOCKET, 0o600)
    server.listen(16)
    while True:
        conn, _ = server.accept()
        threading.Thread(target=serve_connection, args=(conn,), daemon=True).start()


if __name__ == '__main__':
    main()
