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

Driver `codex-app-server` (T-12167) stands in for the codex-hrcpty driver:
it spawns spec.process as the app-server, a child in the broker's own process
group (never a pty child), writes its pid to <ipcDir>/appserver.pid, and on
an hrcpty lease only says `hello` and reads `status`: no TUI at birth. Its
turns, initial and `submission.*`, complete at once as RPC evidence.

A codex turn whose prompt contains `HOLD` stays open until
`invocation.interrupt`, then ends `turn.interrupted` (T-12177). While it is
held, `seat.probe` answers turn-active (turnId `turn-held`) and
`turn.manifest` lists the held input as that turn's only submission.

`stub.localTurn` emits a turn no HRC input started (a prompt typed in a TUI).
`stub.usage` {turnId, usedTokens, windowTokens}, sent on its own connection,
emits one usage.updated for that turn (kernel_fold.py --serve's turnContext).

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
         'child': None, 'state': 'ready', 'start': None, 'snapshotSeen': threading.Event(), 'driver': None,
         'held': None}


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


def emit(kind, payload, input_id=None, turn_id=None):
    with lock:
        seq = len(state['events']) + 1
        envelope = {'invocationId': state['invocation'], 'seq': seq, 'type': kind, 'time': now(), 'payload': payload}
        if input_id:
            envelope['inputId'] = input_id
        if turn_id:
            envelope['turnId'] = turn_id
        state['events'].append(envelope)
        with open(ARGS['event-ledger'], 'a') as f:
            f.write(json.dumps(envelope) + '\n')
        log('emit', envelope=envelope)
        conn = state['controller']
    if conn is not None:
        send(conn, {'jsonrpc': '2.0', 'method': 'invocation.event', 'params': envelope})
    return seq


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


def start_app_server(lease, start):
    """codex-app-server: the broker spawns the app-server itself, in its own group."""
    if lease and lease['kind'] == 'hrcpty':
        ops = Ops(lease['socketPath'])
        log('lease.hello', hello=ops.hello, status=ops.call('status', {}), lease=lease)
        ops.close()
    argv, env, cwd = child_spec(start)
    env.update(start['spec']['process'].get('lockedEnv') or {})
    proc = subprocess.Popen(argv, env=env, cwd=cwd, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                            stderr=subprocess.DEVNULL)
    (IPC / 'appserver.pid').write_text(str(proc.pid))
    log('appserver.spawned', pid=proc.pid, pgid=os.getpgid(proc.pid), brokerPgid=os.getpgid(0))
    return proc.pid


def run_turn(input_id, prompt):
    state['snapshotSeen'].wait(30)
    time.sleep(.3)
    emit('input.accepted', {'inputId': input_id}, input_id)
    emit('turn.started', {}, input_id)
    with lock:
        state['state'] = 'running'
    lease = state['lease']
    if state['driver'] == 'codex-app-server' and 'HOLD' in prompt:
        # T-12177: a codex turn that runs until invocation.interrupt, as a long
        # tool call does; it ends turn.interrupted, never completed.
        held = threading.Event()
        with lock:
            state['held'] = held
            state['heldInput'] = input_id
        held.wait(120)
        with lock:
            state['held'] = None
            state['heldInput'] = None
            state['state'] = 'ready'
        emit('turn.interrupted', {'reason': 'interrupt'}, input_id)
        return
    if not lease or lease['kind'] != 'hrcpty' or state['driver'] == 'codex-app-server':
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
            state['driver'] = start['spec']['driver']['kind']
        if state['driver'] == 'codex-app-server':
            child = start_app_server(lease, start)
        else:
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
    if method in ('submission.invoke', 'submission.enqueue', 'submission.steer') and state['driver'] == 'codex-app-server':
        submission = 'sub-' + os.urandom(6).hex()
        body = params.get('body') or {}
        text = json.dumps(body)[:200]
        threading.Thread(target=run_turn, args=(submission, text), daemon=True).start()
        return {'submissionId': submission, 'admission': 'admitted', 'inputId': submission}
    if method == 'seat.probe' and state.get('heldInput'):
        # T-12177: only a held turn answers; otherwise the probe stays the
        # unknown method it always was, so the rest of the run is unchanged.
        return {'seat': {'state': 'turn-active', 'turnId': 'turn-held'}}
    if method == 'turn.manifest' and state.get('heldInput'):
        held = params.get('turnId') == 'turn-held'
        return {'turnId': params.get('turnId'), 'submissionIds': [state['heldInput']] if held else []}
    if method == 'invocation.interrupt':
        with lock:
            held = state['held']
        if held is not None:
            held.set()
            return {'accepted': True, 'effect': 'turn_interrupted'}
        return {'ok': True}
    if method == 'invocation.stop':
        with lock:
            state['state'] = 'stopped'
        return {'ok': True}
    if method == 'stub.closeController':
        # Transport-only fault: the broker and supervisor remain running.
        with lock:
            controller = state['controller']
        if controller is not None:
            controller.shutdown(socket.SHUT_RDWR)
        return {'ok': True}
    if method == 'stub.usage':
        # A test control, not harness-broker/0.2: one usage.updated carrying a
        # context reading for an explicit turn (kernel_fold.py --serve, T-12140).
        if not state['invocation']:
            raise RuntimeError('no invocation has started')
        context = {'usedTokens': params['usedTokens'], 'windowTokens': params['windowTokens']}
        return {'seq': emit('usage.updated', {'context': context}, turn_id=params['turnId'])}
    if method == 'stub.localTurn':
        # A test control: a turn no HRC input started, as a prompt typed in a
        # TUI arrives (observe.rs origin local-interactive, T-12167).
        turn = 'turn-local-' + os.urandom(4).hex()
        emit('turn.started', {'turnId': turn}, turn_id=turn)
        emit('turn.completed', {'turnId': turn}, turn_id=turn)
        return {'turnId': turn}
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
