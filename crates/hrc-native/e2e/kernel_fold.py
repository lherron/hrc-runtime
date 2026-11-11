#!/usr/bin/env python3
"""Ops-only HRC wire E2E (2026-11-02, praesidium-kernel r1.9 / T-12360).
Private real daemon, stub broker, private wrkqd. Proves six owner operations,
stale fences, discovery without HRC types/documents, startup/stop ordering,
lock failure isolation and retired front-mode refusal. Projection/attach coverage
moved to praesidium-kernel and campaign T-12361; no live service is modified.
"""
from foundation import daemon_env
import argparse
import fcntl
import json
import os
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time
import uuid

from hrcpty_substrate import FakeAspd, Run, AGENT, PROJECT, LEAK, HERE, REPO
from n4_federation import local_tailnet_address, free_port

LIVE_KERNEL = Path.home() / 'praesidium/var/run/hrc/hrc-kernel.sock'


class DeclaringAspd(FakeAspd):
    """Adds the declaration seat.summon resolves before it starts a runtime."""
    def __init__(self, path, release, log, project_root):
        self.project_root = str(project_root)
        super().__init__(path, release, log)

    def handle(self, method, params):
        if method == 'aspc.hello':
            hello = super().handle(method, params)
            hello['capabilities']['resolveRuntimeDeclaration'] = True
            return hello
        if method == 'aspc.resolveRuntimeDeclaration':
            context = params['context']
            return {'schemaVersion': 'aspc-resolve-runtime-declaration-response/v1', 'ok': True,
                    'source': {'agentProfile': {'state': 'present'}},
                    'placement': {'agentRoot': context.get('agentRoot') or str(Path(self.project_root).parent / 'agents' / context['agentId']),
                                  'projectRoot': self.project_root,
                                  'cwd': self.project_root, 'runMode': context['runMode'],
                                  'bundle': {'kind': 'compose', 'compose': []}},
                    'agentSources': {}, 'provisioning': {'scalars': {}}, 'diagnostics': []}
        return super().handle(method, params)


class Wire:
    def __init__(self, path):
        self.sock = socket.socket(socket.AF_UNIX)
        self.sock.settimeout(120)
        self.sock.connect(str(path))
        self.file = self.sock.makefile('rwb', buffering=0)

    def raw(self, op, args=None, caller=None):
        request = dict(id=op, op=op, args=args or {})
        if caller is not None:
            request['caller'] = caller
        self.file.write((json.dumps(request) + '\n').encode())
        return json.loads(self.file.readline())

    def close(self):
        self.file.close()
        self.sock.close()


def wire(path, op, args=None):
    w = Wire(path)
    try:
        return w.raw(op, args)
    finally:
        w.close()


def events(r, tag):
    return [e for e in r.daemon_log(tag) if isinstance(e, dict) and e.get('server') == 'rusthrc']


def index_of(log, event, **data):
    for i, e in enumerate(log):
        if e.get('event') == event and all(e.get('data', {}).get(k) == v for k, v in data.items()):
            return i
    return -1


def substrate(root, artifacts, binary):
    """A fresh scratch rusthrc substrate under `root`; returns (run, aspd, clean env).
    Nothing here reaches the live daemon, its aspd, its wrkqd or its kernel."""
    r = Run(root, artifacts, binary)
    # -- substrate (hrcpty_substrate.main's, plus the declaring aspd) ---------
    release_root = root / 'release'
    (release_root / 'bin').mkdir(parents=True)
    stub = release_root / 'bin/stub-broker'
    shutil.copy(HERE / 'hrcpty_stub_broker.py', stub)
    stub.chmod(0o755)
    release = {'releaseId': 'stub-broker-t12140', 'sourceCommit': '1' * 40, 'builtAt': '2026-10-29T00:00:00.000Z',
               'releaseRoot': str(release_root),
               'worker': {'protocol': 'harness-broker/0.2', 'executable': str(stub), 'argvPrefix': ['--ops-only', '1'],
                          'hostedDrivers': ['claude-code-hrcpty', 'claude-code-tmux']}}
    (release_root / 'release.json').write_text(json.dumps({**{k: release[k] for k in ('releaseId', 'sourceCommit', 'builtAt')},
                                                           'protocol': 'harness-broker/0.2',
                                                           'hostedDrivers': release['worker']['hostedDrivers']}))
    for d in ('run', 'state', PROJECT, 'agents/' + AGENT):
        (root / d).mkdir(parents=True)
    clean = {k: v for k, v in os.environ.items() if not k.startswith(LEAK)}
    subprocess.run(['git', 'init', '-q'], cwd=root / PROJECT, check=True, env=clean)
    subprocess.run([str(binary), 'store', 'migrate', str(r.db_path)],
                   cwd=REPO, check=True, capture_output=True, env=clean)
    config = root / 'federation.json'
    # seat.summon is an implicit exact-scope start: it needs an enforced gate.
    # A peerless node hosting its own registry on a private port is home for
    # every scope it births (runtimes_start.py's shape).
    tailnet = local_tailnet_address()
    config.write_text(json.dumps({'nodeId': 'hkf', 'peers': {},
                                  'registry': {'bind': f'http://{tailnet}:{free_port(tailnet)}'},
                                  'gate': {'mode': 'enforce', 'registryHost': 'hkf'}}))
    config.chmod(0o600)
    aspd_socket = root / 'aspd.sock'
    aspd = DeclaringAspd(aspd_socket, release, artifacts / 'fake-aspd.ndjson', root / PROJECT)
    env = dict(clean)
    env.update(HRC_RUNTIME_DIR=str(root / 'run'), HRC_STATE_DIR=str(root / 'state'), HRC_ASPD_SOCKET=str(aspd_socket),
               ASP_AGENTS_ROOT=str(root / 'agents'),
               ASP_PROJECT_ROOT_OVERRIDE=str(root / PROJECT), HRC_PROJECT_SEARCH_ROOTS=str(root / PROJECT),
               HRC_WRKQ_DB=str(root / 'wrkq.db'), WRKQ_DB=str(root / 'wrkq.db'), HRC_WRKQD_TOKEN_FILE='',
               WRKQD_TOKEN_FILE='', WRKQD_TOKEN='', HRC_PEER_CONFIG_FILE=str(config),
               HRC_EVENT_INGEST_SOCKET=str(root / 'run/ingest.sock'), HRC_ACP_WEBHOOK_URL='',
               HRC_BROKER_DURABLE_IPC_ENABLED='1', HRC_CLAUDE_CODE_TMUX_BROKER_ENABLED='1', ASP_HOME=str(root / 'asp-home'))
    r.env = env
    # A private wrkq ledger behind a private wrkqd (n3_scratch.py's shape): an
    # implicit birth reads the scope's birth envelope over wrkq RPC.
    for argv in (['wrkqadm', 'migrate'], [str(Path.home() / ".local/bin/wrkq"), 'mkdir', '/' + PROJECT, '--kind', 'project', '--json'],
                 [str(Path.home() / ".local/bin/wrkq"), 'set', '/' + PROJECT, '--root', str(root / PROJECT), '--json']):
        subprocess.run(argv, env=dict(env, WRKQ_PRINCIPAL_REF='agent:clod'), cwd=root / PROJECT,
                       check=True, capture_output=True, timeout=60)
    catalog = root / 'hook-catalog.json'
    catalog.write_text(json.dumps({'schemaVersion': 'wrkf.hook-catalog.v0', 'hooks': {}, 'effectHandlers': {}}))
    token = uuid.uuid4().hex + uuid.uuid4().hex
    token_file = root / 'wrkqd-token'
    token_file.write_text(token + '\n')
    token_file.chmod(0o600)
    port = free_port('127.0.0.1')
    wrkqd_log = (artifacts / 'wrkqd.log').open('w')
    r.logs.append(wrkqd_log)
    r.owners.append(subprocess.Popen(['wrkqd', '-addr', f'127.0.0.1:{port}', '-db', str(root / 'wrkq.db')],
                                     env=dict(env, WRKF_HOOK_CATALOG=str(catalog), WRKQD_TOKEN=token),
                                     cwd=root / PROJECT, stdout=wrkqd_log, stderr=wrkqd_log))
    r.wait(lambda: socket.socket().connect_ex(('127.0.0.1', port)) == 0, 10, 'private wrkqd')
    env.update(HRC_WRKQ_DB=f'rpc://127.0.0.1:{port}', WRKQ_DB=f'rpc://127.0.0.1:{port}',
               HRC_WRKQD_TOKEN_FILE=str(token_file), WRKQD_TOKEN_FILE=str(token_file), WRKQD_TOKEN='')
    # No client pre-warms this fresh wrkqd: rusthrc's own wrkq client must send
    # rpc.initialize before its first call (T-12140).
    (artifacts / 'launch.json').write_text(json.dumps(
        {'argv': [str(binary), 'server'], 'cwd': str(root / PROJECT),
         'env': {k: v for k, v in env.items() if k.startswith(('HRC_', 'ASP_', 'WRKQ'))}}, indent=2) + '\n')
    return r, aspd, clean


def placement_hint(root):
    """The runtimeIntent an explicit session create carries past the enforced
    gate's capability check (no harness id: the fake aspd declares none)."""
    return {'placement': {'agentRoot': str(root / 'agents' / AGENT), 'projectRoot': str(root / PROJECT),
                          'cwd': str(root / PROJECT), 'runMode': 'task', 'bundle': {'kind': 'compose', 'compose': []},
                          'dryRun': False}, 'harness': {'interactive': True}}


def turn_context(r, request, window):
    """One context reading on a stub-broker runtime: the stub emits one
    usage.updated for the named turn, which rusthrc projects in one
    transaction as one runtime.context.updated. `window` must differ from the
    stored reading's windowTokens: HRC skips a reading whose usedTokens and
    windowTokens both equal the stored one, whatever its turnId. Returns the
    committed row's hrc_seq."""
    runtime, turn, used = request.get('runtimeId'), request.get('turnId'), request.get('usedTokens')
    if not (isinstance(runtime, str) and runtime and isinstance(turn, str) and turn.strip()
            and isinstance(used, int) and not isinstance(used, bool) and used >= 0):
        raise ValueError('turnContext needs runtimeId, a non-empty turnId and an integer usedTokens >= 0')
    found = r.rows('SELECT runtime_state_json FROM runtimes WHERE runtime_id=?', (runtime,))
    if not found:
        raise ValueError(f'unknown runtime {runtime}')
    endpoint = (json.loads(found[0]['runtime_state_json'] or '{}').get('broker') or {}).get('endpoint') or {}
    if not endpoint.get('socketPath'):
        raise ValueError(f'runtime {runtime} has no broker endpoint')
    kind = 'runtime.context.updated'
    before = r.rows('SELECT coalesce(max(hrc_seq),0) AS s FROM hrc_events')[0]['s']
    with socket.socket(socket.AF_UNIX) as s:
        s.settimeout(10)
        s.connect(endpoint['socketPath'])
        s.sendall((json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': 'stub.usage', 'params':
                               {'turnId': turn, 'usedTokens': used, 'windowTokens': window}}) + '\n').encode())
        reply = json.loads(s.makefile('r').readline())
    if 'error' in reply:
        raise ValueError(f"stub broker refused: {reply['error'].get('message')}")
    sql = ("SELECT hrc_seq FROM hrc_events WHERE hrc_seq>? AND runtime_id=? AND event_kind=? "
           "AND json_extract(payload_json,'$.turnId')=? AND json_extract(payload_json,'$.usedTokens')=?")
    deadline = time.time() + 10
    while time.time() < deadline:
        row = r.rows(sql, (before, runtime, kind, turn, used))
        if row:
            return row[0]['hrc_seq']
        time.sleep(0.02)
    raise ValueError(f'no {kind} committed within 10 s')


def serve(r, aspd, root, kernel):
    """--serve: one scratch daemon for another suite (cardo's HrcProfile). The
    first stdout line is the ready line, cardo-host's shape plus HRC's own
    socket. Each stdin line {"turnContext":{runtimeId,turnId,usedTokens}} is
    answered by one stdout line once HRC has committed it. SIGTERM, SIGINT or
    stdin EOF (the suite is gone) tears every process and the root down."""
    stop = []
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda *_: stop.append(True))
    daemon = r.up('serve')
    print(json.dumps({'status': 'serving', 'socket': str(kernel), 'pid': daemon.pid, 'hrcSocket': str(r.socket),
                      'root': str(root), 'agent': AGENT, 'project': PROJECT, 'runtimeIntent': placement_hint(root)}), flush=True)

    def control():
        window = 200_000
        for line in sys.stdin:
            if not line.strip():
                continue
            try:
                request = json.loads(line)['turnContext']
                window += 1
                seq = turn_context(r, request, window)
                answer = {'ok': True, 'runtimeId': request['runtimeId'], 'hrcSeq': seq}
            except Exception as error:  # noqa: BLE001 - every failure is answered
                answer = {'ok': False, 'error': f'{type(error).__name__}: {error}'}
            print(json.dumps({'turnContext': answer}), flush=True)
        stop.append(True)
    threading.Thread(target=control, daemon=True).start()
    try:
        while not stop and daemon.poll() is None:
            time.sleep(0.2)
    finally:
        for proc in r.owners:
            if proc.poll() is None:
                proc.send_signal(signal.SIGTERM)
                try:
                    proc.wait(timeout=30)
                except subprocess.TimeoutExpired:
                    proc.kill()
        # The root plus its separator: a bare prefix would also match a sibling
        # path such as <work>/red.sock when the root is <work>/r.
        subprocess.run(['pkill', '-f', str(root) + '/'], check=False)
        aspd.close()
        for log in r.logs:
            log.close()
        shutil.rmtree(root, ignore_errors=True)
    return 0 if stop else 1


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--binary', type=Path, default=REPO / 'crates/target/debug/rusthrc')
    p.add_argument('--root', type=Path, default=Path(f'/tmp/hkf-{os.getpid()}'))
    p.add_argument('--artifacts', type=Path, required=True)
    p.add_argument('--serve', action='store_true',
                   help='launch the scratch daemon, print a ready line, serve until SIGTERM or stdin EOF')
    args = p.parse_args()
    binary = args.binary.resolve()
    assert (binary.parent / 'hrc-pty').is_file(), 'build hrc-pty beside rusthrc: cargo build -p hrc-native -p hrc-pty'
    root = args.root.absolute()
    if root.exists():
        raise SystemExit('root must be fresh: ' + str(root))
    root.mkdir(parents=True)
    args.artifacts.mkdir(parents=True, exist_ok=True)
    r, aspd, clean = substrate(root, args.artifacts, binary)
    kernel = root / 'run/hrc-kernel.sock'
    assert kernel.resolve() != LIVE_KERNEL.resolve()
    if args.serve:
        sys.exit(serve(r, aspd, root, kernel))
    print(f'root {root}\nbinary {binary}\nartifacts {args.artifacts}', flush=True)

    runtime = None
    failure = None
    try:
        # == 1. startup order ==================================================
        daemon = r.up('1')
        log = events(r, '1')
        serving, listening = index_of(log, 'kernel.serving'), index_of(log, 'server.listening')
        r.check('1.kernel-before-listener', 0 <= serving < listening and kernel.is_socket()
                and log[serving]['data']['socket'] == str(kernel) and log[listening]['data']['pid'] == daemon.pid,
                serving=log[serving] if serving >= 0 else None, listening=log[listening] if listening >= 0 else None)
        r.check('1.no-start-failed', index_of(log, 'kernel.start_failed') < 0)

        discovery = wire(kernel, 'registry.discover')
        (args.artifacts / 'discovery.json').write_text(json.dumps(discovery, indent=2) + '\n')
        assert discovery['ok'], discovery
        # Caller is additive only after the Cardo caller-standard bump.
        # Old kernels refuse the top-level field; accepted requests must also
        # retain it in rpc.request attribution, independent of authentication.
        caller = 'kernel-fold/caller-proof'
        w = Wire(kernel)
        try:
            attributed = w.raw('registry.discover', caller=caller)
        finally:
            w.close()
        r.check('2.caller-accepted', attributed.get('ok') is True, reply=attributed)
        def caller_logs():
            return [e for e in r.daemon_log('1') if isinstance(e, dict)
                    and e.get('event') == 'rpc.request'
                    and e.get('data', {}).get('caller') == caller
                    and e['data'].get('op') == 'registry.discover'
                    and e['data'].get('outcome') == 'ok']
        deadline = time.monotonic() + 2
        while not caller_logs() and time.monotonic() < deadline:
            time.sleep(.01)
        r.check('2.caller-logged', bool(caller_logs()), records=caller_logs())
        d = discovery['result']
        expected = {'seat.summon', 'seat.send', 'seat.restart', 'seat.annotation.put',
                    'seat.annotation.act', 'seat.annotation.delete'}
        r.check('2.exact-six-ops', {o['name'] for o in d['operations'] if o['provider'] == 'hrc'} == expected)
        r.check('2.no-hrc-types', not [t for t in d['node_types'] if t['provider'] == 'hrc'])
        resync = wire(kernel, 'resync')
        r.check('2.no-documents', resync.get('ok') and resync['result']['documents'] == {}, reply=resync)
        unknown = wire(kernel, 'seat.unknown')
        r.check('2.unknown-refused', unknown.get('ok') is False and unknown['error']['code'] == 'unknown_declaration')
        status_cli = subprocess.run([str(binary), 'server', 'status', '--json'], env=r.env,
                                    capture_output=True, text=True, timeout=30)
        (args.artifacts / 'server-status.json').write_text(status_cli.stdout + status_cli.stderr)
        r.check('2.server-status-unchanged', status_cli.returncode == 0 and bool(json.loads(status_cli.stdout)), rc=status_cli.returncode)

        ref = f'agent:{AGENT}:project:{PROJECT}:task:pty-{uuid.uuid4().hex[:8]}/lane:main'
        summoned = wire(kernel, 'seat.summon', dict(session_ref=ref, request_id='kf-' + uuid.uuid4().hex[:6]))
        r.check('3.summon', summoned.get('ok') and summoned['result']['session_ref'] == ref, reply=summoned)
        assert summoned['ok'], summoned
        host, runtime = summoned['result']['host_session_id'], summoned['result']['runtime_id']
        # A resume never starts fresh: a scope with no recorded conversation is
        # refused with HRC's own code, which the caller branches on.
        cold = f'agent:{AGENT}:project:{PROJECT}:task:pty-{uuid.uuid4().hex[:8]}/lane:main'
        resumed = wire(kernel, 'seat.summon', dict(session_ref=cold, continuation='resume', request_id='kf-resume'))
        r.check('3.resume-refused-without-continuation', resumed.get('ok') is False
                and resumed['error']['code'] == 'no_resumable_continuation'
                and resumed['error']['details'].get('hrc_code') == 'no_resumable_continuation', reply=resumed)
        key = dict(session_ref=ref, subject='seat', ns='e2e', kind='ops', id='one')
        put = wire(kernel, 'seat.annotation.put', dict(**key, body={'v': 1}, expect={'updatedAt': None}))
        r.check('3.annotation-put', put.get('ok') and put['result']['created'] is True, reply=put)
        assert put['ok'], put
        stale = wire(kernel, 'seat.annotation.put', dict(**key, body={'v': 2}, expect={'updatedAt': None}))
        r.check('3.stale-annotation', stale.get('ok') is False and stale['error']['code'] == 'stale_annotation', reply=stale)
        act = wire(kernel, 'seat.annotation.act', dict(**key, action='sent', attributes={'ok': True}))
        r.check('3.annotation-act', act.get('ok'), reply=act)
        deleted = wire(kernel, 'seat.annotation.delete', dict(**key, expect={'updatedAt': put['result']['updated_at']}))
        r.check('3.annotation-delete', deleted.get('ok') and deleted['result'] == {'deleted': True}, reply=deleted)
        # Submit real literal input to the stub broker and grade the turn ledger.
        sent = wire(kernel, 'seat.send', dict(session_ref=ref, host_session_id=host, expected_generation=1,
                                             text='ops-only e2e'))
        r.check('3.send', sent.get('ok') and sent['result']['runtime_id'] == runtime, reply=sent)
        assert sent['ok'], sent
        run_id = sent['result']['run_id']
        r.wait(lambda: r.rows("SELECT 1 FROM hrc_events WHERE run_id=? AND event_kind='turn.awaiting_input'", (run_id,)),
               30, 'stub asks a question')
        code, answer = r.http('POST', '/v1/active-run-contributions', {
            'inputApplicationId': 'app-' + uuid.uuid4().hex, 'inputAttemptId': 'att-' + uuid.uuid4().hex,
            'prompt': 'E2E-ANSWER', 'selector': {'runtimeId': runtime}})
        r.check('3.answer', code == 200 and answer.get('status') == 'accepted', reply=answer)
        r.wait(lambda: r.rows("SELECT 1 FROM hrc_events WHERE run_id=? AND event_kind='turn.completed'", (run_id,)),
               30, 'turn completed')
        restarted = wire(kernel, 'seat.restart', dict(host_session_id=host, expected_generation=1))
        r.check('3.restart', restarted.get('ok') and restarted['result']['generation'] == 2
                and restarted['result']['launch']['status'] == 'started', reply=restarted)
        stale = wire(kernel, 'seat.send', dict(session_ref=ref, host_session_id=host, expected_generation=1, text='stale'))
        r.check('3.stale-context', stale.get('ok') is False and stale['error']['code'] == 'stale_context', reply=stale)
        records = r.rows("SELECT event_kind,payload_json FROM hrc_events WHERE scope_ref=? AND event_kind LIKE 'session.annotation.%'",
                         (ref.split('/lane:')[0],))
        r.check('3.annotation-ledger', len(records) == 3 and all(json.loads(e['payload_json'])['updatedBy'] == 'system:hrc-kernel' for e in records if e['event_kind'] == 'session.annotation.changed'), records=records)
        (args.artifacts / 'ops.json').write_text(json.dumps(dict(summon=summoned, put=put, act=act, delete=deleted, send=sent, restart=restarted), indent=2) + '\n')

        # == 9. clear-context owner lifecycle (T-12360 F3) ==================
        assert restarted['ok'], restarted
        clear_host = restarted['result']['host_session_id']
        clear_runtime = restarted['result']['launch']['runtimeId']
        head = r.rows('SELECT coalesce(max(hrc_seq),0) AS s FROM hrc_events')[0]['s']
        code, rotated = r.http('POST', '/v1/clear-context', {'hostSessionId': clear_host})
        r.check('9.clear-context-ok', code == 200 and rotated['hostSessionId'] != clear_host,
                status=code, body=rotated)
        ended = r.rows("SELECT runtime_id,host_session_id,event_kind,payload_json FROM hrc_events "
                       "WHERE hrc_seq>? AND runtime_id=? AND event_kind='runtime.terminated'", (head, clear_runtime))
        r.check('9.runtime-end-published', len(ended) == 1 and ended[0]['host_session_id'] == clear_host
                and json.loads(ended[0]['payload_json']).get('reason') == 'clear-context', rows=ended)
        stored = r.rows('SELECT status FROM runtimes WHERE runtime_id=?', (clear_runtime,))
        r.check('9.old-runtime-ended', stored == [{'status': 'terminated'}], rows=stored)
        code, terminated = r.http('POST', '/v1/terminate', {'runtimeId': clear_runtime})
        r.check('9.owner-confirms-terminated', code == 503
                and terminated.get('error', {}).get('code') == 'runtime_unavailable'
                and terminated['error'].get('detail', {}).get('status') == 'terminated',
                status=code, body=terminated)

        # == 5. shutdown order =================================================
        rc = r.down(daemon)
        log = events(r, '1')
        steps = [e['data']['step'] for e in log if e.get('event') == 'server.stop.step']
        r.check('5.kernel-stops-first-after-listener', rc == 0 and steps[:2] == ['kernel', 'federation_listeners']
                and index_of(log, 'kernel.stopped') > index_of(log, 'server.stop.step', step='kernel')
                and not kernel.exists(), rc=rc, steps=steps, socketLeft=kernel.exists())

        # == 6. start failure never fails the daemon ===========================
        with open(str(kernel) + '.lock', 'w') as held:
            fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
            daemon = r.up('2')
            log = events(r, '2')
            failed = index_of(log, 'kernel.start_failed')
            code, _ = r.http('GET', '/v1/status')
            r.check('6.start-failed-logged-hrc-serves', failed >= 0 and index_of(log, 'kernel.serving') < 0 and code == 200,
                    failed=log[failed] if failed >= 0 else None, status=code)
            r.check('6.clean-stop-without-kernel', r.down(daemon) == 0)

        # == 7. retired front options fail before opening either listener =====
        log_path = args.artifacts / 'daemon-front.log'
        with log_path.open('w') as out:
            refused = subprocess.run([str(binary), 'server', '--front', '--bun-socket', str(root / 'run/fake-bun.sock')],
                                     env=daemon_env(r.env), cwd=root / PROJECT, stdout=out, stderr=out, timeout=20)
        text = log_path.read_text()
        r.check('7.retired-front-refused-without-kernel', refused.returncode != 0 and '--front is retired' in text
                and '"server.listening"' not in text and 'kernel.' not in text
                and not kernel.exists() and not (root / 'run/hrc.sock').exists(), log=text[-2000:])
    except BaseException as error:  # noqa: BLE001
        failure = repr(error)
        r.check('harness', False, error=failure)
    finally:
        for proc in r.owners:
            if proc.poll() is None:
                proc.send_signal(signal.SIGTERM)
                try:
                    proc.wait(timeout=30)
                except subprocess.TimeoutExpired:
                    proc.kill()
        # The root plus its separator: a bare prefix would also match a sibling
        # path such as <work>/red.sock when the root is <work>/r.
        subprocess.run(['pkill', '-f', str(root) + '/'], check=False)
        aspd.close()
        for log in r.logs:
            log.close()
        passed = all(c['pass'] for c in r.checks)
        (args.artifacts / 'summary.json').write_text(json.dumps(
            {'pass': passed, 'failure': failure, 'binary': str(binary), 'root': str(root), 'checks': r.checks}, indent=2) + '\n')
        shutil.rmtree(root, ignore_errors=True)
    print('PASS' if passed else 'FAIL', f'{sum(c["pass"] for c in r.checks)}/{len(r.checks)}')
    sys.exit(0 if passed else 1)


if __name__ == '__main__':
    main()
