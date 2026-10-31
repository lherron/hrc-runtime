#!/usr/bin/env python3
"""hrcpty seat substrate, end to end on one isolated rusthrc (T-12049).

One fresh short root (unix socket paths stay < 104 bytes) holds a Bun-created
schema, runtime/state dirs, a FAKE aspd and a stub execution release. The real
`claude-code-hrcpty` broker driver (T-12050) has not landed, so a real birth
cannot complete: the fake aspd answers `aspc.compileHarnessInvocation` with a
plan built from the request (identities echoed, startRequestHash computed with
the daemon's own canonical projection) whose executionRelease points at
hrcpty_stub_broker.py copied into the stub release. Scope `...:task:pty-*`
compiles to terminalHost hrcpty (driver claude-code-hrcpty, supervisor-process);
`...:task:tmux-*` compiles to terminalHost tmux (claude-code-tmux,
broker-process) so both substrates run side by side on one daemon. The child
the stub spawns into the lease is a line echo: it prints `GOT#n[<line>]` per
line read and `INTERRUPTED` on SIGINT, so the capture shows what reached the pty.

Checks (spec T-12046 §4.2, §4.6, §5):
  1 birth: transport hrcpty, substrate leased-hrcpty, hrcpty.sock, hello pid,
    child running, no tmux for the seat
  2 daemon writes reach the pty: the question-answer door (POST
    /v1/active-run-contributions answering a live AskUserQuestion pastes the
    answer + \\r) and the literal door's empty Enter (POST
    /v1/literal-input/by-selector, text "" → b"\\r"); both captured through GET
    /v1/capture and POST /v1/capture/by-selector
  3 interrupt route on a broker seat never types ^C into the lease (T-12177):
    with no active run it answers ok + warning and the child sees nothing
  4 daemon restart: supervisor and child pids unchanged, broker-attached,
    capture still served
  5 GET /v1/attach → hrc-pty attach argv
  6 terminate: supervisor, child and socket gone, row terminal
  7 tmux sibling: transport tmux, btmux socket with broker+tui windows,
    survives the restart, its tmux server gone after terminate
  8 attached door (POST /v1/runs/prepare-attached) on both live seats: the
    hrcpty seat stays operatorAttachable with its hrcpty block, the tmux
    sibling's runtime.presentation keeps its tmux shape

Codex leg (T-12167, spec T-12162 §4.2, §4.3, §5): scope `...:task:codex-*`
compiles to the REAL codex-hrcpty aspc response captured from an isolated aspd
(T-12163 hrcpty-{true,false}-response.json: jsonrpc-stdio, terminalRequired,
terminalHost hrcpty, supervisor-process, attachable, websocket-unix surface),
and `...:task:codextmux-*` to the real codex-tui response (after-true:
terminalHost tmux, broker-process). Identities, paths and the start hash are
substituted; hosting, presentation and driver blocks are the producer's bytes.
  C1 both presentation variants admit; transport hrcpty, run transport
     headless, leased-hrcpty substrate, the hrcpty lease reaches the broker as
     runtime.terminalSurface (allowedOps.spawn), no child at birth, no tmux,
     broker argv carries what a claude-hrcpty broker does (no observer socket),
     operatorAttachable with the hrcpty attach surface from birth, a turn no
     HRC input started (typed in the TUI) has origin local-interactive
  C2 GET /v1/attach and the attached door serve the hrc-pty attach argv
  C3 daemon restart: supervisor, broker and app-server pids unchanged,
     broker-attached, a delivery after the restart completes
  C4 terminate: supervisor, broker and app-server gone, socket removed
  C5 broker SIGKILL with no lease end: runtime crash-marked, the app-server
     gone within 6 s (hrc-pty's group signal), the lease kept
  C6 codex (tmux) sibling: tui pane lease, tmux transport, observer socket
     argv, as before
  C7 POST /v1/interrupt on a busy codex-hrcpty seat (no pty child) reaches
     the broker as invocation.interrupt {scope turn, runId}, answers ok, and
     the held turn ends cancelled (T-12177; the pre-fix binary answers
     `no_child: no pty` and the turn runs on)
Run on the pre-change binary, C1 records the admit refusal (discriminator).

Never touches the live daemon (its socket is refused), the live aspd, or any
shared service. Every process and root it creates is removed on exit.
"""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import socket
import sqlite3
import subprocess
import sys
import threading
import time
import uuid

from n2_scratch import UnixHTTP

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
LIVE_HRC_SOCKET = Path.home() / 'praesidium/var/run/hrc/hrc.sock'
LEAK = ('GIT_', 'HRC_', 'ASP_', 'AGENT_', 'AGENTCHAT_', 'WRKQ', 'CLAUDE', 'CODEX', 'ACP_', 'HARNESS_', 'TMUX')
PROJECT = 't12049'
T12163 = Path.home() / 'praesidium/var/wrkq-artifacts/T-12163'
T12163_SCRATCH = '/Users/lherron/praesidium/var/scratch/agent-spaces/T-12163'
APP_SERVER = r'''
import os, signal, sys, time
signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
while True:
    time.sleep(1)
'''
AGENT = 'hrcptye2e'
CHILD = r'''
import os, signal, sys
n = 0
def on_int(*_):
    sys.stdout.write("\r\nINTERRUPTED\r\n"); sys.stdout.flush()
signal.signal(signal.SIGINT, on_int)
print("CHILD-READY pid=%d" % os.getpid(), flush=True)
while True:
    line = sys.stdin.readline()
    if not line:
        break
    n += 1
    line = line.rstrip("\r\n")
    pasted = "\x1b[200~" in line
    line = line.replace("\x1b[200~", "").replace("\x1b[201~", "")
    print("GOT#%d[%s]%s" % (n, line, " paste" if pasted else ""), flush=True)
'''


# -- the daemon's canonical start-request hash (compile.rs) ------------------
STAMP_SUFFIXES = ('_at', 'At', '_ts', 'Ts', 'timestamp', 'Timestamp')


def canonical(v):
    if isinstance(v, dict):
        keys = sorted((k for k in v if not k.endswith(STAMP_SUFFIXES)), key=lambda k: k.encode('utf-16-be'))
        return '{' + ','.join(json.dumps(k, ensure_ascii=False) + ':' + canonical(v[k]) for k in keys) + '}'
    if isinstance(v, list):
        return '[' + ','.join(canonical(x) for x in v) + ']'
    return json.dumps(v, ensure_ascii=False, separators=(',', ':'))


def start_hash(start):
    neutral = json.loads(json.dumps(start))
    for k in ('invocationId', 'correlation'):
        neutral['spec'].pop(k, None)
    if 'initialInput' in start:
        neutral['initialInput'] = {k: start['initialInput'][k] for k in ('inputId', 'responseFormat') if k in start['initialInput']}
    return hashlib.sha256(canonical(neutral).encode()).hexdigest()


# -- fake aspd ---------------------------------------------------------------
class FakeAspd:
    """aspc/0.1 over NDJSON: hello + compileHarnessInvocation, every frame logged."""
    def __init__(self, path, release, log):
        self.path, self.release, self.log = str(path), release, log
        self.lock = threading.Lock()
        self.server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.server.bind(self.path)
        self.server.listen(16)
        threading.Thread(target=self.accept, daemon=True).start()

    def accept(self):
        while True:
            try:
                conn, _ = self.server.accept()
            except OSError:
                return
            threading.Thread(target=self.serve, args=(conn,), daemon=True).start()

    def record(self, frame):
        with self.lock, open(self.log, 'a') as f:
            f.write(json.dumps(frame) + '\n')

    def serve(self, conn):
        for line in conn.makefile('r'):
            frame = json.loads(line)
            self.record({'request': frame})
            try:
                result = self.handle(frame['method'], frame.get('params') or {})
                reply = {'jsonrpc': '2.0', 'id': frame['id'], 'result': result}
            except Exception as error:  # noqa: BLE001
                reply = {'jsonrpc': '2.0', 'id': frame['id'], 'error': {'code': -32601, 'message': repr(error)}}
            self.record({'reply': reply})
            conn.sendall((json.dumps(reply) + '\n').encode())

    def handle(self, method, params):
        if method == 'aspc.hello':
            return {'protocolVersion': 'aspc/0.1', 'release': {'releaseId': 'fake-aspd-t12049', 'sourceCommit': '0' * 40,
                                                               'builtAt': '2026-10-29T00:00:00.000Z'},
                    'capabilities': {'compileHarnessInvocation': True, 'transports': ['unix-jsonrpc-ndjson']},
                    'facadeInfo': {'name': 'hrcpty_substrate.py fake aspd'}}
        if method == 'aspc.compileHarnessInvocation':
            return self.compile(params['compileRequest'])
        raise KeyError(method)

    def compile(self, req):
        ident = req['identity']
        scope = req['correlation']['scopeRef']
        if ':task:codex' in scope:
            return self.codex(req, scope)
        tmux = ':task:tmux-' in scope
        driver, host = ('claude-code-tmux', 'tmux') if tmux else ('claude-code-hrcpty', 'hrcpty')
        hosting = {'executionTransport': 'pty', 'terminalRequired': True, 'terminalHost': host,
                   'processExecution': 'broker-process' if tmux else 'supervisor-process'}
        correlation = {k: ident[k] for k in ('requestId', 'hostSessionId', 'operationId', 'runtimeId', 'runId',
                                             'invocationId', 'traceId') if k in ident}
        correlation.update(scopeRef=scope, laneRef='main')
        cwd = req['placement']['cwd']
        spec = {'specVersion': 'harness-broker.invocation/v1', 'invocationId': ident['invocationId'],
                'harness': {'frontend': 'stub', 'provider': 'anthropic', 'driver': driver},
                'process': {'command': sys.executable, 'args': ['-u', '-c', CHILD], 'cwd': cwd,
                            'env': {'HOME': str(Path.home()), 'PATH': '/usr/bin:/bin:/usr/sbin:/sbin', 'LANG': 'en_US.UTF-8'},
                            'lockedEnv': {}, 'harnessTransport': {'kind': 'pty'}},
                'interaction': {'mode': 'interactive', 'turnConcurrency': 'single', 'inputQueue': 'fifo'},
                'driver': {'kind': driver, 'terminalHost': host}, 'correlation': correlation}
        start = {'spec': spec}
        if 'initialInputId' in ident:
            text = req['materialization'].get('initialPrompt', '')
            start['initialInput'] = {'inputId': ident['initialInputId'], 'content': [{'type': 'text', 'text': text}]}
        digest = lambda s: hashlib.sha256(s.encode()).hexdigest()
        execution = {'recipeId': 'claude-code', 'driver': driver, 'protocol': 'harness-broker/0.2', 'hosting': hosting,
                     'presentationFulfillment': 'intrinsic',
                     'profile': {'profileId': 'profile_stub_' + host, 'profileHash': digest('profile' + host),
                                 'compatibilityHash': digest('compat' + host), 'startRequestHash': start_hash(start)},
                     'dispatchRequest': {'startRequest': start}}
        plan = {'schemaVersion': 'agent-runtime-plan/v2', 'compiler': {'name': 'fake-aspd', 'version': '0'},
                'compileId': 'compile_' + uuid.uuid4().hex, 'createdAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
                'agent': {'id': req['agent']['id']}, 'identity': ident, 'placement': req['placement'],
                'selection': {'harness': 'claude' if tmux else 'claude-hrcpty', 'modelProvider': 'anthropic', 'model': 'stub',
                              'presentation': True,
                              'provenance': {'harness': 'compile-request', 'modelProvider': 'compile-request',
                                             'model': 'compile-request', 'presentation': 'compile-request'}},
                'execution': execution, 'diagnostics': []}
        plan['planHash'] = digest(canonical(plan))
        return {'schemaVersion': 'aspc-compile-harness-invocation-response/v2', 'ok': True, 'plan': plan,
                'diagnostics': [], 'executionRelease': self.release}

    def codex(self, req, scope):
        """A real aspc codex response (T-12163) re-addressed to this request."""
        ident, cwd = req['identity'], req['placement']['cwd']
        if ':task:codextmux-' in scope:
            name = 'after-true-response.json'
        else:
            name = 'hrcpty-%s-response.json' % ('true' if req.get('requested', {}).get('presentation') is True else 'false')
        raw = (T12163 / name).read_text()
        raw = raw.replace(T12163_SCRATCH + '/project', cwd).replace(T12163_SCRATCH, str(Path(cwd).parent / 'codex-home'))
        plan = json.loads(raw)['plan']
        plan.update(identity=ident, agent={'id': req['agent']['id']}, placement=req['placement'],
                    compileId='compile_' + uuid.uuid4().hex, createdAt=time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()))
        start = plan['execution']['dispatchRequest']['startRequest']
        spec = start['spec']
        spec['invocationId'] = ident['invocationId']
        spec['correlation'] = {**{k: ident[k] for k in ('requestId', 'hostSessionId', 'operationId', 'runtimeId', 'runId',
                                                         'invocationId', 'traceId') if k in ident},
                               'scopeRef': scope, 'laneRef': 'main'}
        spec['process'].update(command=sys.executable, args=['-u', '-c', APP_SERVER, 'fake-app-server', cwd], cwd=cwd)
        if 'initialInputId' in ident:
            text = req['materialization'].get('initialPrompt', '')
            start['initialInput'] = {'inputId': ident['initialInputId'], 'kind': 'user', 'content': [{'type': 'text', 'text': text}]}
        else:
            start.pop('initialInput', None)
        plan['execution']['profile']['startRequestHash'] = start_hash(start)
        plan.pop('planHash', None)
        plan['planHash'] = hashlib.sha256(canonical(plan).encode()).hexdigest()
        return {'schemaVersion': 'aspc-compile-harness-invocation-response/v2', 'ok': True, 'plan': plan,
                'diagnostics': [], 'executionRelease': self.release}

    def close(self):
        self.server.close()


# -- harness -----------------------------------------------------------------
class Run:
    def __init__(self, root, artifacts, binary):
        self.root, self.artifacts, self.binary = root, artifacts, binary
        self.checks, self.owners, self.logs, self.notes = [], [], [], []
        self.socket = root / 'run/hrc.sock'
        self.db_path = root / 'state/state.sqlite'
        assert self.socket.resolve() != LIVE_HRC_SOCKET.resolve()

    def check(self, name, ok, **evidence):
        self.checks.append({'check': name, 'pass': bool(ok), 'evidence': evidence})
        print(('PASS ' if ok else 'FAIL ') + name + ('' if ok else '  ' + json.dumps(evidence, default=str)[:1500]), flush=True)
        return ok

    def up(self, tag):
        log = (self.artifacts / f'daemon-{tag}.log').open('w')
        self.logs.append(log)
        proc = subprocess.Popen([str(self.binary), 'server'], env=self.env, cwd=self.root / PROJECT,
                                stdout=log, stderr=log, start_new_session=True)
        self.owners.append(proc)
        for _ in range(300):
            assert proc.poll() is None, ('daemon exited', proc.returncode, (self.artifacts / f'daemon-{tag}.log').read_text()[-3000:])
            try:
                status, value = self.http('GET', '/v1/status')
                if status == 200:
                    assert Path(value['binaryPath']).resolve() == self.binary, value['binaryPath']
                    return proc
            except (OSError, ValueError, KeyError):
                pass
            time.sleep(.1)
        raise AssertionError('daemon not ready')

    def down(self, proc):
        proc.send_signal(signal.SIGTERM)
        proc.wait(timeout=60)
        return proc.returncode

    def http(self, method, path, body=None, timeout=120):
        c = UnixHTTP(self.socket, timeout)
        c.request(method, path, json.dumps(body) if body is not None else None, {'Content-Type': 'application/json'})
        res = c.getresponse()
        raw = res.read().decode()
        c.close()
        try:
            return res.status, json.loads(raw)
        except ValueError:
            return res.status, raw

    def rows(self, sql, params=()):
        with sqlite3.connect(f'file:{self.db_path}?mode=ro', uri=True, timeout=30) as db:
            db.row_factory = sqlite3.Row
            return [dict(r) for r in db.execute(sql, params)]

    def wait(self, predicate, timeout=60, what='condition'):
        deadline = time.time() + timeout
        while time.time() < deadline:
            value = predicate()
            if value:
                return value
            time.sleep(.2)
        raise AssertionError('timed out waiting for ' + what)

    def runtime(self, rid):
        r = self.rows('SELECT * FROM runtimes WHERE runtime_id=?', (rid,))[0]
        r['state'] = json.loads(r['runtime_state_json'] or '{}')
        return r

    def events(self, rid, kind=None):
        sql = 'SELECT hrc_seq,event_kind,run_id,transport,payload_json FROM hrc_events WHERE runtime_id=?'
        args = [rid]
        if kind:
            sql += ' AND event_kind=?'
            args.append(kind)
        out = self.rows(sql + ' ORDER BY hrc_seq', args)
        for e in out:
            e['payload'] = json.loads(e.pop('payload_json') or 'null')
        return out

    def daemon_log(self, tag):
        out = []
        for line in (self.artifacts / f'daemon-{tag}.log').read_text().splitlines():
            try:
                out.append(json.loads(line))
            except ValueError:
                pass
        return out


def ops(socket_path, token_path, method, params=None):
    """One authenticated hrc-pty ops call (spec §4.2)."""
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.settimeout(10)
    s.connect(str(socket_path))
    f = s.makefile('r')
    token = Path(token_path).read_text().strip()
    out = {}
    for i, (m, p) in enumerate([('hello', {'token': token})] + ([(method, params or {})] if method != 'hello' else []), 1):
        s.sendall((json.dumps({'jsonrpc': '2.0', 'id': i, 'method': m, 'params': p}) + '\n').encode())
        reply = json.loads(f.readline())
        out[m] = reply.get('result', reply.get('error'))
    s.close()
    return out


def alive(pid):
    if not pid:
        return False
    try:
        os.kill(int(pid), 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def descendants_of(pids):
    """Every live pid whose command line names this run's root (cleanup sweep)."""
    out = subprocess.run(['ps', '-axo', 'pid=,command='], capture_output=True, text=True).stdout
    return [(int(l.split(None, 1)[0]), l.split(None, 1)[1]) for l in out.splitlines() if l.strip() and any(p in l for p in pids)]


def broker_call(path, method, params=None):
    """One harness-broker NDJSON request on its own connection (stub test controls)."""
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.settimeout(10)
    s.connect(str(path))
    s.sendall((json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': method, 'params': params or {}}) + '\n').encode())
    reply = json.loads(s.makefile('r').readline())
    s.close()
    return reply.get('result', reply.get('error'))


def pgid(pid):
    try:
        return os.getpgid(int(pid))
    except (ProcessLookupError, TypeError, ValueError):
        return None


def command_of(pid):
    return subprocess.run(['ps', '-o', 'command=', '-p', str(pid)], capture_output=True, text=True).stdout.strip()


def flags(command):
    return sorted(t for t in command.split() if t.startswith('--'))


class CodexLeg:
    """codex-hrcpty seats on the same daemon (T-12167); see the module docstring."""
    def __init__(self, r, root, binary, try_birth):
        self.r, self.root, self.binary, self.try_birth = r, root, binary, try_birth
        self.seats = {}

    def stub_log(self, sock):
        f = Path(sock).parent / 'stub.ndjson'
        return [json.loads(l) for l in f.read_text().splitlines()] if f.exists() else []

    def seat_info(self, name, rid):
        r = self.r
        row = r.runtime(rid)
        sub = row['state'].get('broker', {}).get('substrate', {})
        sock = Path(sub.get('socketPath', '') or '/nonexistent')
        info = {'rt': rid, 'row': row, 'sub': sub, 'sock': sock, 'token': sock.parent / 'attach.token', 'pid': sub.get('pid')}
        app = sock.parent / 'appserver.pid'
        info['app'] = int(app.read_text()) if app.exists() else None
        return info

    def born(self, claude_broker_pid):
        r = self.r
        for name, extra in (('true', {'presentation': {'operator': 'tmux-tui'}}), ('false', {})):
            task = 'codex-' + uuid.uuid4().hex[:8]
            ref, host, status, out = self.try_birth(task, f'codex-hrcpty {name} first turn', extra)
            ok = r.check(f'C1.{name}.admitted', status in (200, 202) and out.get('status') == 'accepted', status=status, response=out)
            if not ok:
                continue
            rid, run = out['runtimeId'], out['runId']
            s = self.seat_info(name, rid)
            s.update(ref=ref, host=host, run=run, task=task, extra=extra)
            self.seats[name] = s
            row, sub, sock = s['row'], s['sub'], s['sock']
            r.check(f'C1.{name}.transport-hrcpty-leased-hrcpty', row['transport'] == 'hrcpty' and sub.get('kind') == 'leased-hrcpty'
                    and sock.is_socket() and sock.parent.parent == self.root / 'run/bipc' and sock.name == 'hrcpty.sock',
                    transport=row['transport'], substrate=sub)
            runs = r.rows('SELECT transport FROM runs WHERE run_id=?', (run,))
            r.check(f'C1.{name}.run-transport-headless', runs and runs[0]['transport'] == 'headless' and out.get('transport') == 'headless',
                    runs=runs, responseTransport=out.get('transport'))
            r.wait(lambda: r.rows("SELECT 1 FROM runs WHERE run_id=? AND status='completed'", (run,)), 60, f'codex {name} first turn')
            r.check(f'C1.{name}.first-turn-completed', True, runId=run)
            log = self.stub_log(sock)
            starts = [e for e in log if e['kind'] == 'request' and e['method'] == 'invocation.start']
            lease = ((starts[-1]['params'].get('runtime') or {}).get('terminalSurface') if starts else None) or {}
            r.check(f'C1.{name}.hrcpty-lease-to-broker', lease.get('kind') == 'hrcpty' and lease.get('socketPath') == str(sock)
                    and lease.get('ownership') == 'hrc' and (lease.get('allowedOps') or {}).get('spawn') is True
                    and 'terminalSurfaceRequired' not in starts[-1]['params'].get('runtime', {})
                    and 'HARNESS_BROKER_OBSERVER_SOCKET' not in starts[-1]['params'].get('dispatchEnv', {}),
                    runtime=starts[-1]['params'].get('runtime') if starts else None)
            st = ops(sock, s['token'], 'status')
            child = (st['status'] or {}).get('child')
            broker = (st['status'] or {}).get('broker') or {}
            s['broker'] = broker.get('pid')
            r.check(f'C1.{name}.no-child-at-birth', not (child or {}).get('pid') and broker.get('state') == 'running'
                    and broker.get('pid') == row['state']['broker'].get('brokerPid')
                    and not any(e['kind'] == 'lease.spawned' for e in log), status=st['status'])
            r.check(f'C1.{name}.app-server-in-broker-group', alive(s['app']) and pgid(s['app']) == pgid(s['broker']) == s['broker']
                    and pgid(s['broker']) != pgid(s['pid']), app=s['app'], appPgid=pgid(s['app']), broker=s['broker'],
                    brokerPgid=pgid(s['broker']), supervisorPgid=pgid(s['pid']))
            btmux = sorted(str(x) for x in (self.root / 'run/btmux').glob('*')) if (self.root / 'run/btmux').exists() else []
            r.check(f'C1.{name}.no-tmux', not row['tmux_json'] and not row['state'].get('tmux')
                    and not any(rid[:32].replace('-', '_') in x for x in btmux), tmuxJson=row['tmux_json'], btmux=btmux)
            cmd, ref_cmd = command_of(s['broker']), command_of(claude_broker_pid)
            r.check(f'C1.{name}.broker-argv-as-claude-hrcpty', '--experimental-observer-socket' not in cmd
                    and flags(cmd) == flags(ref_cmd), codex=cmd, claude=ref_cmd)
            pres = json.loads(row['presentation_json'] or 'null') or {}
            evs = r.events(rid, 'runtime.presentation')
            ev = evs[-1]['payload'] if evs else {}
            r.check(f'C1.{name}.operator-attachable-from-birth', pres.get('operatorAttachable') is True
                    and (ev.get('presentation') or {}).get('operatorAttachable') is True
                    and (ev.get('hrcpty') or {}).get('socketPath') == str(sock)
                    and (ev.get('hrcpty') or {}).get('attachCommand', '').endswith(f'attach --socket {sock}') and 'tmux' not in ev,
                    presentationJson=pres, events=[e['payload'] for e in evs])
            local = broker_call(sock.parent / 'b.sock', 'stub.localTurn')
            origin = r.wait(lambda: [e['payload'] for e in r.events(rid, 'broker.turn.origin')
                                     if e['payload'].get('turnId') == local.get('turnId')], 20, 'local turn origin')
            r.check(f'C1.{name}.typed-turn-origin-local-interactive', origin[-1].get('origin') == 'local-interactive',
                    origin=origin, local=local)
            status, att = r.http('GET', f'/v1/attach?runtimeId={rid}')
            argv = att.get('argv', []) if isinstance(att, dict) else []
            s['attach'] = att
            r.check(f'C2.{name}.attach-descriptor', status == 200 and att.get('transport') == 'hrcpty'
                    and argv == [str(self.binary.parent / 'hrc-pty'), 'attach', '--socket', str(sock)]
                    and att.get('bindingFence', {}).get('supervisorPid') == s['pid'], status=status, response=att)

    def interrupt(self):
        r, s = self.r, self.seats.get('false')
        if not r.check('C7.seat-available', s is not None):
            return
        _, _, status, out = self.try_birth(s['task'], 'codex-hrcpty HOLD until interrupted', s['extra'])
        if not r.check('C7.hold-turn-admitted', status in (200, 202) and out.get('runId'), status=status, response=out):
            return
        run = out['runId']
        r.wait(lambda: r.runtime(s['rt'])['active_run_id'] == run, 30, 'held codex turn active')
        before = len(self.stub_log(s['sock']))
        status, intr = r.http('POST', '/v1/interrupt', {'runtimeId': s['rt']})
        reqs = [e for e in self.stub_log(s['sock'])[before:] if e['kind'] == 'request' and e['method'] == 'invocation.interrupt']
        r.check('C7.interrupt-ok', status == 200 and intr.get('ok') is True and 'warning' not in intr,
                status=status, response=intr)
        r.check('C7.interrupt-reaches-broker', len(reqs) == 1 and reqs[0]['params'].get('scope') == 'turn'
                and reqs[0]['params'].get('runId') == run, requests=reqs)
        ended = r.wait(lambda: r.rows("SELECT status FROM runs WHERE run_id=? AND status NOT IN ('accepted','started','running')",
                                      (run,)), 30, 'held codex turn ended')
        ev = [e['payload'] for e in r.events(s['rt'], 'runtime.interrupted')]
        r.check('C7.turn-ended-cancelled', ended[0]['status'] == 'cancelled' and ev
                and ev[-1].get('runId') == run and ev[-1].get('controllerKind') == 'harness-broker',
                status=ended[0]['status'], events=ev)

    def tmux_sibling(self):
        r = self.r
        ref, host, status, out = self.try_birth('codextmux-' + uuid.uuid4().hex[:8], 'codex tmux sibling first turn',
                                                {'presentation': {'operator': 'tmux-tui'}})
        if not r.check('C6.codex-tmux-admitted', status in (200, 202), status=status, response=out):
            return
        rid = out['runtimeId']
        row = r.runtime(rid)
        b = row['state']['broker']
        sock = (row['state'].get('tmux') or {}).get('socketPath') or json.loads(row['tmux_json'] or '{}').get('socketPath')
        ipc = Path(b.get('endpoint', {}).get('socketPath', '') or '/nonexistent').parent
        log = self.stub_log(ipc / 'b.sock')
        starts = [e for e in log if e['kind'] == 'request' and e['method'] == 'invocation.start']
        params = starts[-1]['params'] if starts else {}
        lease = (params.get('runtime') or {}).get('terminalSurface') or {}
        cmd = command_of(b.get('brokerPid'))
        pres = json.loads(row['presentation_json'] or 'null') or {}
        self.seats['tmux'] = {'rt': rid, 'tmux': sock, 'host': host}
        r.check('C6.codex-tmux-shape', row['transport'] == 'tmux' and (b.get('tuiWindow') or {}).get('socketPath') == sock
                and lease.get('kind') == 'tmux-pane' and lease.get('windowName') == 'tui'
                and '--experimental-observer-socket' in cmd and pres.get('operatorAttachable') is True
                and (params.get('runtime') or {}).get('terminalSurfaceRequired') is True,
                transport=row['transport'], tuiWindow=b.get('tuiWindow'), lease=lease, argv=cmd, presentationJson=pres,
                runtime=params.get('runtime'))
        norm = lambda v: json.loads(json.dumps(v).replace(str(self.root), '<root>').replace(rid, '<rt>'))
        (self.r.artifacts / 'codex-tmux-shape.json').write_text(json.dumps(norm(
            {'transport': row['transport'], 'leaseKeys': sorted(lease), 'leaseKind': lease.get('kind'), 'argvFlags': flags(cmd),
             'runtimeKeys': sorted(params.get('runtime') or {}), 'presentationJson': pres,
             'hostingKeys': sorted(k for k in b if not k.endswith('At'))}), indent=1, sort_keys=True) + '\n')

    def door(self, intent):
        r, s = self.r, self.seats.get('true')
        if not s:
            return
        before = len(r.events(s['rt'], 'runtime.presentation'))
        status, out = r.http('POST', '/v1/runs/prepare-attached', {'hostSessionId': s['host'], 'intent': intent})
        evs = [e['payload'] for e in r.events(s['rt'], 'runtime.presentation')[before:]]
        ev = evs[-1] if evs else {}
        r.check('C2.true.attached-door', status == 200 and out.get('status') == 'started'
                and out.get('result', {}).get('runtimeId') == s['rt'] and out.get('attach', {}).get('transport') == 'hrcpty'
                and (ev.get('presentation') or {}).get('operatorAttachable') is True
                and (ev.get('hrcpty') or {}).get('socketPath') == str(s['sock']) and 'tmux' not in ev,
                status=status, response=out, events=evs)

    def after_restart(self, per_rt):
        r = self.r
        for name, s in self.seats.items():
            if name == 'tmux':
                r.check('C6.codex-tmux-survives-restart', per_rt.get(s['rt'], {}).get('state') == 'broker-attached',
                        warmup=per_rt.get(s['rt']))
                continue
            st = ops(s['sock'], s['token'], 'status')
            row = r.runtime(s['rt'])
            r.check(f'C3.{name}.pids-unchanged', st['hello'].get('pid') == s['pid'] and (st['status']['broker'] or {}).get('pid') == s['broker']
                    and alive(s['app']) and not (st['status'].get('child') or {}).get('pid'),
                    before={'supervisor': s['pid'], 'broker': s['broker'], 'app': s['app']},
                    after={'hello': st['hello'], 'status': st['status'], 'appAlive': alive(s['app'])})
            r.check(f'C3.{name}.rediscovered-broker-attached', per_rt.get(s['rt'], {}).get('state') == 'broker-attached'
                    and row['status'] not in ('stale', 'dead', 'terminated', 'crashed')
                    and json.loads(row['presentation_json'] or '{}').get('operatorAttachable') is True,
                    warmup=per_rt.get(s['rt']), status=row['status'])
            status, out = r.http('POST', '/v1/turns', {'hostSessionId': s['host'], 'prompt': f'codex {name} after restart'})
            run = out.get('runId') if isinstance(out, dict) else None
            done = run and r.wait(lambda: r.rows("SELECT status,transport,runtime_id FROM runs WHERE run_id=? AND status='completed'", (run,)),
                                  60, f'codex {name} post-restart turn')
            r.check(f'C3.{name}.delivery-after-restart', status in (200, 202) and done and done[0]['runtime_id'] == s['rt'],
                    status=status, response=out, run=done)
            status, att = r.http('GET', f'/v1/attach?runtimeId={s["rt"]}')
            r.check(f'C3.{name}.attach-descriptor-after-restart', status == 200 and att == s['attach'], response=att)

    def terminate(self):
        r = self.r
        s = self.seats.get('true')
        if s:
            status, term = r.http('POST', '/v1/terminate', {'runtimeId': s['rt']})
            gone = status == 200 and r.wait(lambda: not alive(s['pid']) and not alive(s['broker']) and not alive(s['app']), 20, 'codex lease end')
            row = r.runtime(s['rt'])
            r.check('C4.true.terminate-ends-lease', status == 200 and gone and not s['sock'].exists()
                    and not (s['sock'].parent / 'hrcpty.pid').exists() and row['status'] == 'terminated',
                    status=status, response=term, supervisor=s['pid'], broker=s['broker'], app=s['app'], rowStatus=row['status'],
                    socketExists=s['sock'].exists())
        t = self.seats.get('tmux')
        if t:
            status, _ = r.http('POST', '/v1/terminate', {'runtimeId': t['rt']})
            r.wait(lambda: subprocess.run(['tmux', '-S', str(t['tmux']), 'has-session'], capture_output=True).returncode != 0, 20, 'codex tmux gone')
            r.check('C6.codex-tmux-terminated', status == 200 and r.runtime(t['rt'])['status'] == 'terminated')

    def crash(self):
        r = self.r
        s = self.seats.get('false')
        if not s:
            return
        st = ops(s['sock'], s['token'], 'status')
        broker = (st['status']['broker'] or {}).get('pid')
        os.kill(broker, signal.SIGKILL)
        killed = time.time()
        app_gone = None
        while time.time() - killed < 6:
            if not alive(s['app']):
                app_gone = round(time.time() - killed, 2)
                break
            time.sleep(.1)
        row = r.wait(lambda: (lambda x: x if x['status'] == 'crashed' else None)(r.runtime(s['rt'])), 20, 'crash mark')
        after = ops(s['sock'], s['token'], 'status')
        r.check('C5.false.broker-kill-app-server-gone-within-6s', app_gone is not None, app=s['app'], goneAfterS=app_gone)
        r.check('C5.false.runtime-crash-marked', row['status'] == 'crashed', status=row['status'], state=row['state'].get('status'))
        r.check('C5.false.lease-kept', alive(s['pid']) and s['sock'].is_socket() and (after['status']['broker'] or {}).get('state') != 'running',
                supervisorAlive=alive(s['pid']), status=after['status'])
        status, term = r.http('POST', '/v1/terminate', {'runtimeId': s['rt']})
        r.notes.append({'crashedTerminate': {'status': status, 'response': term, 'supervisorAliveAfter': alive(s['pid'])}})

    def pids(self):
        return [p for s in self.seats.values() for p in (s.get('pid'), s.get('broker'), s.get('app')) if p]


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--binary', type=Path, default=REPO / 'crates/target/debug/rusthrc')
    p.add_argument('--root', type=Path, default=Path(f'/tmp/h12049-{os.getpid()}'))
    p.add_argument('--artifacts', type=Path, default=Path.home() / 'praesidium/var/wrkq-artifacts/T-12049/e2e')
    p.add_argument('--keep', action='store_true', help='leave the root (processes are still stopped)')
    args = p.parse_args()
    binary = args.binary.resolve()
    assert (binary.parent / 'hrc-pty').is_file(), 'build hrc-pty beside rusthrc: cargo build -p hrc-native -p hrc-pty'
    root = args.root.absolute()
    if root.exists():
        raise SystemExit('root must be fresh: ' + str(root))
    root.mkdir(parents=True)
    args.artifacts.mkdir(parents=True, exist_ok=True)
    for stale in [*args.artifacts.glob('bipc-*'), *args.artifacts.glob('daemon-*.log'),
                  *(args.artifacts / n for n in ('summary.json', 'fake-aspd.ndjson', 'rows.json', 'codex-tmux-shape.json', 'attached-door.json'))]:
        stale.unlink(missing_ok=True)
    r = Run(root, args.artifacts, binary)

    # -- substrate: stub release, schema, env, fake aspd ----------------------
    release_root = root / 'release'
    (release_root / 'bin').mkdir(parents=True)
    stub = release_root / 'bin/stub-broker'
    shutil.copy(HERE / 'hrcpty_stub_broker.py', stub)
    stub.chmod(0o755)
    release = {'releaseId': 'stub-broker-t12049', 'sourceCommit': '1' * 40, 'builtAt': '2026-10-29T00:00:00.000Z',
               'releaseRoot': str(release_root),
               'worker': {'protocol': 'harness-broker/0.2', 'executable': str(stub), 'argvPrefix': [],
                          'hostedDrivers': ['claude-code-hrcpty', 'claude-code-tmux', 'codex-app-server']}}
    (release_root / 'release.json').write_text(json.dumps({**{k: release[k] for k in ('releaseId', 'sourceCommit', 'builtAt')},
                                                           'protocol': 'harness-broker/0.2',
                                                           'hostedDrivers': release['worker']['hostedDrivers']}))
    for d in ('run', 'state', PROJECT):
        (root / d).mkdir()
    subprocess.run(['git', 'init', '-q'], cwd=root / PROJECT, check=True,
                   env={k: v for k, v in os.environ.items() if not k.startswith(LEAK)})
    subprocess.run(['bun', '-e', 'import {openHrcDatabase} from "./packages/hrc-store-sqlite/src/database.ts";'
                    'openHrcDatabase(process.argv[1]).close()', str(r.db_path)],
                   cwd=REPO, check=True, capture_output=True, env={k: v for k, v in os.environ.items() if not k.startswith(LEAK)})
    config = root / 'federation.json'
    config.write_text(json.dumps({'nodeId': 'h12049', 'peers': {}}))
    config.chmod(0o600)
    aspd_socket = root / 'aspd.sock'
    aspd = FakeAspd(aspd_socket, release, args.artifacts / 'fake-aspd.ndjson')
    env = {k: v for k, v in os.environ.items() if not k.startswith(LEAK)}
    env.update(HRC_RUNTIME_DIR=str(root / 'run'), HRC_STATE_DIR=str(root / 'state'), HRC_ASPD_SOCKET=str(aspd_socket),
               ASP_PROJECT_ROOT_OVERRIDE=str(root / PROJECT), HRC_PROJECT_SEARCH_ROOTS=str(root / PROJECT),
               HRC_WRKQ_DB=str(root / 'wrkq.db'), WRKQ_DB=str(root / 'wrkq.db'), HRC_WRKQD_TOKEN_FILE='',
               WRKQD_TOKEN_FILE='', WRKQD_TOKEN='', HRC_PEER_CONFIG_FILE=str(config),
               HRC_EVENT_INGEST_SOCKET=str(root / 'run/ingest.sock'), HRC_ACP_WEBHOOK_URL='',
               HRC_BROKER_DURABLE_IPC_ENABLED='1', HRC_CLAUDE_CODE_TMUX_BROKER_ENABLED='1', ASP_HOME=str(root / 'asp-home'))
    r.env = env
    print(f'root {root}\nbinary {binary}\nartifacts {args.artifacts}', flush=True)

    pty_rt = tmux_rt = None
    pty_sock = pty_pid = child_pid = None
    tmux_sock = None
    failure = None
    try:
        daemon = r.up('1')

        def session(task):
            ref = f'agent:{AGENT}:project:{PROJECT}:task:{task}/lane:main'
            status, out = r.http('POST', '/v1/sessions/resolve', {'sessionRef': ref, 'create': True, 'summonIntent': 'explicit_local'})
            assert status == 200, (status, out)
            return ref, out['hostSessionId']

        def try_birth(task, prompt, extra=None):
            ref, host = session(task)
            intent = {'placement': {'agentRoot': str(root / PROJECT), 'projectRoot': str(root / PROJECT), 'cwd': str(root / PROJECT),
                                    'runMode': 'task', 'bundle': {'kind': 'compose', 'compose': []}, 'dryRun': False},
                      'harness': {'provider': 'anthropic', 'interactive': True}, **(extra or {})}
            status, out = r.http('POST', '/v1/turns', {'hostSessionId': host, 'prompt': prompt, 'runtimeIntent': intent})
            return ref, host, status, out

        def birth(task, prompt):
            ref, host, status, out = try_birth(task, prompt)
            assert status in (200, 202), ('birth', task, status, out)
            return ref, host, out
        codex = CodexLeg(r, root, binary, try_birth)

        # == 1. hrcpty birth ===================================================
        pty_ref, pty_host, born = birth('pty-' + uuid.uuid4().hex[:8], 'hrcpty e2e first turn')
        pty_rt, pty_run = born['runtimeId'], born['runId']
        row = r.runtime(pty_rt)
        sub = row['state'].get('broker', {}).get('substrate', {})
        pty_sock, pty_pid = Path(sub.get('socketPath', '')), sub.get('pid')
        token = pty_sock.parent / 'attach.token'
        r.check('1.transport-hrcpty', row['transport'] == 'hrcpty', transport=row['transport'], runtimeId=pty_rt)
        r.check('1.substrate-leased-hrcpty', sub.get('kind') == 'leased-hrcpty' and isinstance(pty_pid, int), substrate=sub)
        r.check('1.socket-in-bipc', pty_sock.is_socket() and pty_sock.parent.parent == root / 'run/bipc'
                and pty_sock.name == 'hrcpty.sock', socket=str(pty_sock))
        hello = ops(pty_sock, token, 'status')
        child_pid = (hello['status'] or {}).get('child', {}).get('pid')
        r.check('1.hello-protocol-and-pid', hello['hello'].get('protocol') == 'hrc-pty/1' and hello['hello'].get('pid') == pty_pid
                and alive(pty_pid), hello=hello['hello'], recordedPid=pty_pid)
        r.check('1.child-running', hello['status']['child'].get('state') == 'running' and alive(child_pid)
                and hello['status']['broker'].get('state') == 'running', status=hello['status'])
        r.check('1.broker-under-supervisor', hello['status']['broker'].get('pid') == row['state']['broker'].get('brokerPid'),
                statusBroker=hello['status']['broker'], recordedBrokerPid=row['state']['broker'].get('brokerPid'))
        btmux = sorted(str(x) for x in (root / 'run/btmux').glob('*')) if (root / 'run/btmux').exists() else []
        tmux_procs = [l for _, l in descendants_of([pty_rt[3:15]]) if 'tmux' in l]
        r.check('1.no-tmux-for-seat', not row['tmux_json'] and not row['state'].get('tmux')
                and not any(pty_rt[:32].replace('-', '_') in x or pty_rt in x for x in btmux) and not tmux_procs
                and 'tmuxSocketPath' not in sub,
                tmuxJson=row['tmux_json'], stateTmux=row['state'].get('tmux'), btmux=btmux, tmuxProcs=tmux_procs)
        presentation = r.events(pty_rt, 'runtime.presentation')
        r.check('1.presentation-event-hrcpty', presentation and presentation[-1]['payload'].get('hrcpty', {}).get('socketPath') == str(pty_sock),
                events=presentation)

        # == 7a. tmux sibling birth on the same daemon ========================
        tmux_ref, tmux_host, tborn = birth('tmux-' + uuid.uuid4().hex[:8], 'tmux sibling first turn')
        tmux_rt = tborn['runtimeId']
        trow = r.runtime(tmux_rt)
        tmux_sock = (trow['state'].get('tmux') or {}).get('socketPath') or json.loads(trow['tmux_json'] or '{}').get('socketPath')
        windows = subprocess.run(['tmux', '-S', str(tmux_sock), 'list-windows', '-a', '-F', '#{window_name}'],
                                 capture_output=True, text=True).stdout.split() if tmux_sock else []
        tb = trow['state']['broker']
        r.check('7.tmux-transport', trow['transport'] == 'tmux' and (tb.get('brokerWindow') or {}).get('socketPath') == tmux_sock
                and (tb.get('tuiWindow') or {}).get('socketPath') == tmux_sock,
                transport=trow['transport'], brokerWindow=tb.get('brokerWindow'), tuiWindow=tb.get('tuiWindow'))
        r.check('7.tmux-socket-windows', tmux_sock and Path(tmux_sock).is_socket() and Path(tmux_sock).parent == root / 'run/btmux'
                and {'broker', 'tui'} <= set(windows), socket=tmux_sock, windows=windows)
        r.wait(lambda: r.rows("SELECT 1 FROM runs WHERE run_id=? AND status='completed'", (tborn['runId'],)), 60, 'tmux first turn')
        tmux_server_pid = subprocess.run(['tmux', '-S', str(tmux_sock), 'display-message', '-p', '#{pid}'],
                                         capture_output=True, text=True).stdout.strip()

        # == C1/C2/C6. codex-hrcpty seats and the codex (tmux) sibling ========
        codex.born(hello['status']['broker'].get('pid'))
        codex.tmux_sibling()

        # == 2. daemon writes reach the pty =====================================
        r.wait(lambda: r.rows("SELECT 1 FROM hrc_events WHERE run_id=? AND event_kind='turn.tool_call'", (pty_run,)), 60, 'ask tool call')
        r.wait(lambda: r.runtime(pty_rt)['active_run_id'] == pty_run, 30, 'active run')
        answer = 'E2E-ANSWER-' + uuid.uuid4().hex[:6]
        status, contrib = r.http('POST', '/v1/active-run-contributions', {
            'inputApplicationId': 'app-' + uuid.uuid4().hex, 'inputAttemptId': 'att-' + uuid.uuid4().hex,
            'prompt': answer, 'selector': {'runtimeId': pty_rt}})
        r.check('2.answer-accepted', status == 200 and contrib.get('status') == 'accepted', status=status, response=contrib)
        cap1 = r.wait(lambda: (lambda c: c if f'GOT#1[{answer}] paste' in c[1].get('text', '') else None)(
            r.http('GET', f'/v1/capture?runtimeId={pty_rt}')), 20, 'answer in capture')
        r.check('2.answer-in-GET-capture', cap1[0] == 200 and f'GOT#1[{answer}] paste' in cap1[1]['text'],
                text=cap1[1].get('text'), cursor=cap1[1].get('cursor'), screen=cap1[1].get('screen'))
        r.wait(lambda: r.rows("SELECT 1 FROM runs WHERE run_id=? AND status='completed'", (pty_run,)), 30, 'ask turn completed')
        status, lit = r.http('POST', '/v1/literal-input/by-selector', {'selector': {'sessionRef': pty_ref}, 'text': '', 'enter': True})
        r.check('2.literal-empty-enter-delivered', status == 200 and lit.get('delivered') is True and lit.get('runtimeId') == pty_rt,
                status=status, response=lit)
        cap2 = r.wait(lambda: (lambda c: c if 'GOT#2[]' in c[1].get('text', '') else None)(
            r.http('POST', '/v1/capture/by-selector', {'selector': {'sessionRef': pty_ref}})), 20, 'empty enter in capture')
        lit_ev = [e for e in r.events(pty_rt, 'target.literal-input') if e['payload'].get('delivery') == 'broker-empty-enter']
        r.check('2.literal-enter-in-selector-capture', 'GOT#2[]' in cap2[1]['text'] and lit_ev, text=cap2[1]['text'], literalEvents=lit_ev)
        status, buffered = r.http('POST', '/v1/literal-input/by-selector', {'selector': {'sessionRef': pty_ref}, 'text': 'NOT-TYPED', 'enter': False})
        time.sleep(1)
        cap3 = r.http('GET', f'/v1/capture?runtimeId={pty_rt}')[1]
        r.check('2.literal-text-buffers-not-typed', status == 200 and 'NOT-TYPED' not in cap3['text'],
                note='broker runtime with an active invocation buffers non-empty literal text for a turn flush (input.rs broker_literal)',
                response=buffered, text=cap3['text'])

        # == 3. interrupt ======================================================
        # A broker seat is interrupted through its driver (C7), never by ^C
        # into the lease (T-12177). The ask turn is over, so there is no run.
        r.wait(lambda: r.runtime(pty_rt)['active_run_id'] is None, 30, 'pty seat idle')
        status, intr = r.http('POST', '/v1/interrupt', {'runtimeId': pty_rt})
        time.sleep(1)
        cap4 = r.http('GET', f'/v1/capture?runtimeId={pty_rt}')[1]
        r.check('3.interrupt-idle-broker-seat-warns', status == 200 and intr.get('ok') is True
                and intr.get('warning') == 'no active run to interrupt', status=status, response=intr)
        r.check('3.interrupt-never-types-into-lease', 'INTERRUPTED' not in cap4.get('text', '') and alive(child_pid),
                text=cap4.get('text'))
        codex.interrupt()

        # == 5 (pre-restart). attach descriptor ================================
        status, att = r.http('GET', f'/v1/attach?runtimeId={pty_rt}')
        argv = att.get('argv', []) if isinstance(att, dict) else []
        r.check('5.attach-descriptor', status == 200 and att.get('transport') == 'hrcpty' and len(argv) == 4
                and argv[0].endswith('/hrc-pty') and Path(argv[0]) == binary.parent / 'hrc-pty'
                and argv[1:] == ['attach', '--socket', str(pty_sock)]
                and att.get('bindingFence', {}).get('supervisorPid') == pty_pid, status=status, response=att)

        # == 8. attached door on the live seats ================================
        # POST /v1/runs/prepare-attached selects a live seat as-is and republishes
        # its presentation (attachedRunSelected). An hrcpty seat stays
        # attachable with its hrcpty block; the tmux sibling's event keeps its
        # tmux shape (normalized copies land in attached-door.json for diffing).
        door_intent = {'placement': {'agentRoot': str(root / PROJECT), 'projectRoot': str(root / PROJECT), 'cwd': str(root / PROJECT),
                                     'runMode': 'task', 'bundle': {'kind': 'compose', 'compose': []}, 'dryRun': False},
                       'harness': {'provider': 'anthropic', 'interactive': True}}
        door = {}
        for name, host, rid in (('hrcpty', pty_host, pty_rt), ('tmux', tmux_host, tmux_rt)):
            before = len(r.events(rid, 'runtime.presentation'))
            status, out = r.http('POST', '/v1/runs/prepare-attached', {'hostSessionId': host, 'intent': door_intent})
            evs = r.events(rid, 'runtime.presentation')
            row = r.runtime(rid)
            door[name] = {'status': status, 'response': out, 'newEvents': [e['payload'] for e in evs[before:]],
                          'presentationJson': json.loads(row['presentation_json'] or 'null')}
        codex.door(door_intent)
        hd, td = door['hrcpty'], door['tmux']
        hev = hd['newEvents'][-1] if hd['newEvents'] else {}
        r.check('8.hrcpty-door-selects-live-seat', hd['status'] == 200 and hd['response'].get('status') == 'started'
                and hd['response'].get('result', {}).get('runtimeId') == pty_rt and hd['response'].get('attach', {}).get('transport') == 'hrcpty',
                status=hd['status'], response=hd['response'])
        r.check('8.hrcpty-door-event-attachable', len(hd['newEvents']) == 1 and hev.get('presentation', {}).get('operatorAttachable') is True
                and hev.get('invocation') == {'operatorAttachPending': True}
                and hev.get('hrcpty', {}).get('socketPath') == str(pty_sock)
                and hev.get('hrcpty', {}).get('attachCommand', '').endswith(f'attach --socket {pty_sock}')
                and 'tmux' not in hev, events=hd['newEvents'])
        r.check('8.hrcpty-door-row-attachable', (hd['presentationJson'] or {}).get('operatorAttachable') is True,
                presentationJson=hd['presentationJson'])
        status, seats = r.http('GET', '/v1/presentation/runtimes')
        listed = seats if isinstance(seats, list) else next((v for v in seats.values() if isinstance(v, list)), []) if isinstance(seats, dict) else []
        seat = next((x for x in listed if isinstance(x, dict) and x.get('runtimeId') == pty_rt), {})
        r.check('8.hrcpty-presentation-row-keeps-hrcpty', seat.get('presentation', {}).get('operatorAttachable') is True
                and seat.get('hrcpty', {}).get('socketPath') == str(pty_sock), status=status, seat=seat)
        tev = td['newEvents'][-1] if td['newEvents'] else {}
        r.check('8.tmux-door-event-shape', td['status'] == 200 and len(td['newEvents']) == 1
                and tev.get('presentation', {}).get('operatorAttachable') is True and 'hrcpty' not in tev
                and tev.get('tmux', {}).get('socketPath') == tmux_sock and tev.get('tmux', {}).get('attachTarget'),
                status=td['status'], events=td['newEvents'])
        norm = lambda v: json.loads(json.dumps(v).replace(str(root), '<root>').replace(tmux_rt, '<tmux_rt>').replace(pty_rt, '<pty_rt>'))
        (args.artifacts / 'attached-door.json').write_text(json.dumps(
            {'hrcpty': norm({'event': hev, 'presentationJson': hd['presentationJson'], 'attach': hd['response'].get('attach')}),
             'tmux': norm({'event': tev, 'presentationJson': td['presentationJson']}),
             'hrcptyAttachRaw': att, 'hrcptySeatRow': seat}, indent=2))

        # == 4. daemon restart =================================================
        old_daemon_pid = daemon.pid
        rc = r.down(daemon)
        survived = alive(pty_pid) and alive(child_pid) and pty_sock.is_socket()
        r.check('4.supervisor-outlives-daemon', rc == 0 and survived and not alive(old_daemon_pid),
                daemonExit=rc, supervisorAlive=alive(pty_pid), childAlive=alive(child_pid))
        daemon = r.up('2')
        warm = r.wait(lambda: [e for e in r.daemon_log('2') if e.get('event') == 'broker.warmup.complete'], 60, 'warmup complete')
        per_rt = {e['data']['runtimeId']: e['data'] for e in r.daemon_log('2') if e.get('event') == 'broker.warmup.runtime'}
        after = ops(pty_sock, token, 'status')
        row2 = r.runtime(pty_rt)
        r.check('4.pids-unchanged', after['hello'].get('pid') == pty_pid and after['status']['child'].get('pid') == child_pid
                and row2['state']['broker']['substrate'].get('pid') == pty_pid,
                before={'supervisor': pty_pid, 'child': child_pid}, after={'hello': after['hello'], 'child': after['status']['child']})
        r.check('4.rediscovered-broker-attached', per_rt.get(pty_rt, {}).get('state') == 'broker-attached'
                and row2['status'] not in ('stale', 'dead', 'terminated', 'crashed'),
                warmup=per_rt.get(pty_rt), complete=warm[-1]['data'], status=row2['status'])
        inv = r.rows('SELECT owner_server_instance_id FROM broker_invocations WHERE runtime_id=?', (pty_rt,))
        r.check('4.invocation-owned-by-new-daemon', inv and inv[0]['owner_server_instance_id'] == f'hrc-server:{daemon.pid}', rows=inv,
                newDaemonPid=daemon.pid)
        cap5 = r.http('GET', f'/v1/capture?runtimeId={pty_rt}')
        r.check('4.capture-after-restart', cap5[0] == 200 and f'GOT#1[{answer}] paste' in cap5[1].get('text', '')
                and 'GOT#2[]' in cap5[1].get('text', ''), status=cap5[0], text=cap5[1].get('text') if isinstance(cap5[1], dict) else cap5[1])
        status, lit2 = r.http('POST', '/v1/literal-input/by-selector', {'selector': {'sessionRef': pty_ref}, 'text': '', 'enter': True})
        cap6 = r.wait(lambda: (lambda c: c if 'GOT#3[NOT-TYPED]' in c.get('text', '') or 'GOT#3[]' in c.get('text', '') else None)(
            r.http('GET', f'/v1/capture?runtimeId={pty_rt}')[1]), 20, 'post-restart enter')
        r.check('4.literal-after-restart', status == 200 and ('GOT#3[]' in cap6['text']), response=lit2, text=cap6['text'],
                note='the pre-restart enter:false buffer is daemon memory and does not survive the restart')
        trow2 = r.runtime(tmux_rt)
        tserver2 = subprocess.run(['tmux', '-S', str(tmux_sock), 'display-message', '-p', '#{pid}'], capture_output=True, text=True).stdout.strip()
        r.check('7.tmux-survives-restart', per_rt.get(tmux_rt, {}).get('state') == 'broker-attached' and tserver2 == tmux_server_pid
                and trow2['status'] not in ('stale', 'dead', 'terminated', 'crashed'),
                warmup=per_rt.get(tmux_rt), serverPidBefore=tmux_server_pid, serverPidAfter=tserver2, status=trow2['status'])

        codex.after_restart(per_rt)

        # == 5 (post-restart). attach descriptor still served =================
        status, att2 = r.http('GET', f'/v1/attach?runtimeId={pty_rt}')
        r.check('5.attach-descriptor-after-restart', status == 200 and att2 == att, status=status, response=att2)

        # == 6. terminate ======================================================
        broker_pid = after['status']['broker'].get('pid')
        status, term = r.http('POST', '/v1/terminate', {'runtimeId': pty_rt})
        gone = r.wait(lambda: not alive(pty_pid) and not alive(child_pid) and not alive(broker_pid), 20, 'supervisor exit') if status == 200 else False
        row3 = r.runtime(pty_rt)
        term_ev = r.events(pty_rt, 'runtime.terminated')
        r.check('6.terminate-ok', status == 200 and term.get('ok') is True, status=status, response=term)
        r.check('6.supervisor-child-broker-gone', gone and not alive(pty_pid) and not alive(child_pid) and not alive(broker_pid),
                supervisor=pty_pid, child=child_pid, broker=broker_pid)
        r.check('6.socket-removed', not pty_sock.exists() and not (pty_sock.parent / 'hrcpty.pid').exists(),
                socketExists=pty_sock.exists(), pidFileExists=(pty_sock.parent / 'hrcpty.pid').exists())
        r.check('6.row-terminal', row3['status'] == 'terminated' and row3['active_invocation_id'] is None and term_ev,
                status=row3['status'], activeInvocation=row3['active_invocation_id'], terminatedEvents=term_ev)
        hrcpty_log = (pty_sock.parent / 'hrcpty.log').read_text() if (pty_sock.parent / 'hrcpty.log').exists() else ''
        r.notes.append({'hrcptyLogTail': hrcpty_log[-3000:]})

        # == 7b. tmux sibling terminate ========================================
        status, tterm = r.http('POST', '/v1/terminate', {'runtimeId': tmux_rt})
        r.wait(lambda: subprocess.run(['tmux', '-S', str(tmux_sock), 'has-session'], capture_output=True).returncode != 0, 20, 'tmux gone')
        trow3 = r.runtime(tmux_rt)
        r.check('7.tmux-terminated-server-gone', status == 200 and trow3['status'] == 'terminated'
                and not alive(int(tmux_server_pid)) and subprocess.run(['tmux', '-S', str(tmux_sock), 'list-sessions'],
                                                                        capture_output=True).returncode != 0,
                status=status, response=tterm, rowStatus=trow3['status'], serverPid=tmux_server_pid,
                serverAlive=alive(int(tmux_server_pid)))
        codex.terminate()
        codex.crash()
        r.check('0.pty-rt-tmux-rt-coexisted', pty_rt != tmux_rt and r.runtime(pty_rt)['transport'] == 'hrcpty'
                and trow['transport'] == 'tmux', hrcpty=pty_rt, tmux=tmux_rt)
        r.down(daemon)
    except Exception as error:  # noqa: BLE001 - recorded as a failed check
        import traceback
        failure = traceback.format_exc()
        print(failure, flush=True)
        r.check('harness-completed', False, error=repr(error)[:3000])
    finally:
        # Stop everything this run started, by recorded pid and by root path.
        for proc in r.owners:
            if proc.poll() is None:
                proc.terminate()
                try:
                    proc.wait(timeout=20)
                except subprocess.TimeoutExpired:
                    proc.kill()
        for pid in (pty_pid, child_pid, *(codex.pids() if 'codex' in locals() else [])):
            if pid and alive(pid):
                os.kill(pid, signal.SIGKILL)
        if tmux_sock:
            subprocess.run(['tmux', '-S', str(tmux_sock), 'kill-server'], capture_output=True)
        for sockfile in (root / 'run/btmux').glob('*') if (root / 'run/btmux').exists() else []:
            subprocess.run(['tmux', '-S', str(sockfile), 'kill-server'], capture_output=True)
        leftovers = descendants_of([str(root), root.name])
        for pid, _ in leftovers:
            if pid != os.getpid():
                try:
                    os.kill(pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
        aspd.close()
        for log in r.logs:
            log.close()
        # Keep the small per-seat evidence before the root goes.
        evidence = {}
        for name in ('stub.ndjson', 'hrcpty.log', 'broker.err', 'events.ndjson'):
            for f in sorted((root / 'run/bipc').glob('*/' + name)) if (root / 'run/bipc').exists() else []:
                evidence.setdefault(name, {})[f.parent.name] = f.read_text()[-200000:]
        for name, by_leaf in evidence.items():
            for leaf, text in by_leaf.items():
                (args.artifacts / f'bipc-{leaf}-{name}').write_text(text)
        if r.db_path.exists():
            dump = {t: r.rows(f'SELECT * FROM {t}') for t in ('runtimes', 'runs', 'broker_invocations')}
            dump['hrc_events'] = r.rows('SELECT hrc_seq,ts,event_kind,runtime_id,run_id,transport,payload_json FROM hrc_events ORDER BY hrc_seq')
            (args.artifacts / 'rows.json').write_text(json.dumps(dump, indent=1, default=str) + '\n')
        remaining = [l for _, l in descendants_of([str(root), root.name])]
        r.check('cleanup.no-leftover-processes', not remaining, remaining=remaining)
        if not args.keep:
            shutil.rmtree(root, ignore_errors=True)
        summary = {'pass': all(c['pass'] for c in r.checks), 'root': str(root), 'binary': str(binary),
                   'hrcptyRuntimeId': pty_rt, 'tmuxRuntimeId': tmux_rt,
                   'codexRuntimeIds': {k: v['rt'] for k, v in codex.seats.items()} if 'codex' in locals() else {}, 'checks': r.checks, 'notes': r.notes,
                   'failure': failure}
        (args.artifacts / 'summary.json').write_text(json.dumps(summary, indent=1, default=str) + '\n')
        print('\n'.join(f"{'PASS' if c['pass'] else 'FAIL'}  {c['check']}" for c in r.checks))
        print(json.dumps({'pass': summary['pass'], 'checks': len(r.checks), 'failed': [c['check'] for c in r.checks if not c['pass']]}))
    sys.exit(0 if summary['pass'] else 1)


if __name__ == '__main__':
    main()
