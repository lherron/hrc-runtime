#!/usr/bin/env python3
"""The kernel inside rusthrc (T-12067 §8.1 items 4 and 5), black-box on one
isolated scratch daemon. Never the live daemon or the live kernel socket.

The substrate is hrcpty_substrate.py's: a Bun-created schema, a fake aspd and
the stub broker release, so a seat births without a real harness. The fake
aspd here also answers aspc.resolveRuntimeDeclaration, which seat.summon's
first owner route (/v1/declarations/resolve) needs.

Failure modes, each a check below:
  1 startup order: the kernel serves before the HTTP listener announces, on
    <runtimeRoot>/hrc-kernel.sock, from the daemon's own pid
  2 kq.py status answers from that socket
  3 wake: a seat written over HTTP projects well inside the 10 s backstop
  4 seat.summon through the wire births an hrcpty seat; its row projects and
    resource.attach answers (the owner's in-process GET /v1/attach); every
    owner call is metered as client hrc-kernel/<version>
  5 shutdown order: SIGTERM stops the kernel after the listener and before
    the federation step; the daemon exits 0 and the socket is gone
  6 a kernel that cannot start (its lock held) logs kernel.start_failed and
    HRC still serves
  7 a front-mode rusthrc starts no kernel
"""
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
import time
import uuid

from hrcpty_substrate import FakeAspd, Run, AGENT, PROJECT, LEAK, HERE, REPO
from n4_federation import TAILNET, free_port

KQ = REPO / 'crates/hrc-kernel/e2e/kq.py'
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

    def raw(self, op, args=None):
        self.file.write((json.dumps(dict(id=op, op=op, args=args or {})) + '\n').encode())
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


def rows(path, kind):
    reply = wire(path, 'document.query', dict(document_id='hrc', type=kind, limit=1000))
    assert reply['ok'], reply
    return [r for r in reply['result']['rows']]


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
               'worker': {'protocol': 'harness-broker/0.2', 'executable': str(stub), 'argvPrefix': [],
                          'hostedDrivers': ['claude-code-hrcpty', 'claude-code-tmux']}}
    (release_root / 'release.json').write_text(json.dumps({**{k: release[k] for k in ('releaseId', 'sourceCommit', 'builtAt')},
                                                           'protocol': 'harness-broker/0.2',
                                                           'hostedDrivers': release['worker']['hostedDrivers']}))
    for d in ('run', 'state', PROJECT, 'agents/' + AGENT):
        (root / d).mkdir(parents=True)
    subprocess.run(['git', 'init', '-q'], cwd=root / PROJECT, check=True)
    clean = {k: v for k, v in os.environ.items() if not k.startswith(LEAK)}
    subprocess.run(['bun', '-e', 'import {openHrcDatabase} from "./packages/hrc-store-sqlite/src/database.ts";'
                    'openHrcDatabase(process.argv[1]).close()', str(r.db_path)],
                   cwd=REPO, check=True, capture_output=True, env=clean)
    config = root / 'federation.json'
    # seat.summon is an implicit exact-scope start: it needs an enforced gate.
    # A peerless node hosting its own registry on a private port is home for
    # every scope it births (runtimes_start.py's shape).
    config.write_text(json.dumps({'nodeId': 'hkf', 'peers': {},
                                  'registry': {'bind': f'http://{TAILNET}:{free_port()}'},
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
    for argv in (['wrkqadm', 'migrate'], ['wrkq', 'mkdir', '/' + PROJECT, '--kind', 'project', '--json'],
                 ['wrkq', 'set', '/' + PROJECT, '--root', str(root / PROJECT), '--json']):
        subprocess.run(argv, env=dict(env, WRKQ_PRINCIPAL_REF='agent:clod'), cwd=root / PROJECT,
                       check=True, capture_output=True, timeout=60)
    catalog = root / 'hook-catalog.json'
    catalog.write_text(json.dumps({'schemaVersion': 'wrkf.hook-catalog.v0', 'hooks': {}, 'effectHandlers': {}}))
    token = uuid.uuid4().hex + uuid.uuid4().hex
    token_file = root / 'wrkqd-token'
    token_file.write_text(token + '\n')
    token_file.chmod(0o600)
    port = free_port()
    wrkqd_log = (artifacts / 'wrkqd.log').open('w')
    r.logs.append(wrkqd_log)
    r.owners.append(subprocess.Popen(['wrkqd', '-addr', f'127.0.0.1:{port}', '-db', str(root / 'wrkq.db')],
                                     env=dict(env, WRKF_HOOK_CATALOG=str(catalog), WRKQD_TOKEN=token),
                                     cwd=root / PROJECT, stdout=wrkqd_log, stderr=wrkqd_log))
    r.wait(lambda: socket.socket().connect_ex(('127.0.0.1', port)) == 0, 10, 'private wrkqd')
    env.update(HRC_WRKQ_DB=f'rpc://127.0.0.1:{port}', WRKQ_DB=f'rpc://127.0.0.1:{port}',
               HRC_WRKQD_TOKEN_FILE=str(token_file), WRKQD_TOKEN_FILE=str(token_file), WRKQD_TOKEN='')
    # wrkqd admits RPC only after a client's rpc.initialize, which rusthrc's
    # stdio client never sends; the wrkq CLI does (n3_scratch.py does the same).
    subprocess.run(['wrkq', 'projects', '--json'], env=env, cwd=root / PROJECT, check=True, capture_output=True, timeout=60)
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


def serve(r, aspd, root, kernel):
    """--serve: one scratch daemon for another suite (cardo's HrcProfile). The
    first stdout line is the ready line, cardo-host's shape plus HRC's own
    socket; SIGTERM or SIGINT tears every process and the root down."""
    stop = []
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda *_: stop.append(True))
    daemon = r.up('serve')
    print(json.dumps({'status': 'serving', 'socket': str(kernel), 'pid': daemon.pid, 'hrcSocket': str(r.socket),
                      'root': str(root), 'agent': AGENT, 'project': PROJECT, 'runtimeIntent': placement_hint(root)}), flush=True)
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
        subprocess.run(['pkill', '-f', str(root)], check=False)
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

        # == 2. kq.py status ===================================================
        kq = subprocess.run([sys.executable, str(KQ), 'status'], env=dict(clean, HRC_KERNEL_SOCKET=str(kernel)),
                            capture_output=True, text=True, timeout=30)
        (args.artifacts / 'kq-status.txt').write_text(kq.stdout + kq.stderr)
        status = json.loads(kq.stdout) if kq.returncode == 0 else None
        r.check('2.kq-status-answers', status and status[0].get('cursor') is not None, rc=kq.returncode, out=kq.stdout, err=kq.stderr)
        r.wait(lambda: wire(kernel, 'ingest.status', dict(document_id='hrc'))['result']['bindings'][0].get('caught_up'),
               30, 'bootstrap')

        # == 3. ledger wake ====================================================
        woken = f'agent:{AGENT}:project:{PROJECT}:task:wake-{uuid.uuid4().hex[:6]}/lane:main'
        t0 = time.time()
        code, out = r.http('POST', '/v1/sessions/resolve', {'sessionRef': woken, 'create': True, 'summonIntent': 'explicit_local',
                                                             'runtimeIntent': placement_hint(root)})
        assert code == 200, out
        r.wait(lambda: any(x['payload'].get('sessionRef') == woken for x in rows(kernel, 'hrc.seat')), 9, 'woken seat')
        r.check('3.wake-before-backstop', time.time() - t0 < 3, seconds=round(time.time() - t0, 3))

        # == 4. seat.summon through the wire → attachable ======================
        ref = f'agent:{AGENT}:project:{PROJECT}:task:pty-{uuid.uuid4().hex[:8]}/lane:main'
        summoned = wire(kernel, 'seat.summon', dict(session_ref=ref, request_id='kf-' + uuid.uuid4().hex[:6]))
        (args.artifacts / 'summon-reply.json').write_text(json.dumps(summoned, indent=2) + '\n')
        r.check('4.summon-ok', summoned.get('ok') and summoned['result']['session_ref'] == ref, reply=summoned)
        runtime = summoned['result']['runtime_id'] if summoned.get('ok') else None
        seat = r.wait(lambda: next((x for x in rows(kernel, 'hrc.seat') if x['payload'].get('sessionRef') == ref
                                    and x['payload'].get('runtimeId') == runtime and x['payload'].get('hrcpty')), None),
                      30, 'summoned seat projected with its hrcpty surface')
        attached = wire(kernel, 'resource.attach', dict(document_id='hrc', id=seat['id']))
        (args.artifacts / 'attach-reply.json').write_text(json.dumps(attached, indent=2) + '\n')
        descriptor = (attached.get('result') or {}).get('descriptor') or {}
        r.check('4.seat-attachable', attached.get('ok') and descriptor.get('transport') == 'hrcpty' and descriptor.get('argv'),
                reply=attached)
        metered = [e['data'] for e in events(r, '1') if e.get('event') == 'http.request'
                   and e['data'].get('path') in ('/v1/declarations/resolve', '/v1/runtimes/start', '/v1/attach')]
        r.check('4.owner-calls-metered-as-kernel', {m['path'] for m in metered} == {'/v1/declarations/resolve', '/v1/runtimes/start', '/v1/attach'}
                and all(m['client'].startswith('hrc-kernel/') for m in metered), metered=metered)
        code, term = r.http('POST', '/v1/terminate', {'runtimeId': runtime})
        r.check('4.terminate', code == 200, status=code, body=term)

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

        # == 7. a front starts no kernel ======================================
        bun = root / 'run/fake-bun.sock'
        listener = socket.socket(socket.AF_UNIX)
        listener.bind(str(bun))
        listener.listen(4)
        log_path = args.artifacts / 'daemon-front.log'
        with log_path.open('w') as out:
            front = subprocess.Popen([str(binary), 'server', '--front', '--bun-socket', str(bun)], env=r.env,
                                     cwd=root / PROJECT, stdout=out, stderr=out, start_new_session=True)
            r.wait(lambda: '"server.listening"' in log_path.read_text() or front.poll() is not None, 20, 'front listening')
            text = log_path.read_text()
            r.check('7.front-has-no-kernel', front.poll() is None and '"role":"front"' in text and 'kernel.' not in text
                    and not kernel.exists(), log=text[-2000:])
            front.send_signal(signal.SIGTERM)
            front.wait(timeout=30)
        listener.close()
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
        subprocess.run(['pkill', '-f', str(root)], check=False)
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
