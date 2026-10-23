"""Sequential foreground monitor leg using reviewed P0 isolation admission."""
import importlib.util
import json
import os
from pathlib import Path
import shlex
import signal
import socket
import time
from assertions import require
from harness import InfraError, save, backup, rows, REPO


def run_profile(c, profile):
    root = Path(profile['scratchRoot']).absolute()
    require(root.resolve().is_relative_to(c.root.resolve()), 'monitor infrastructure must be inside admitted fresh scratch')
    db = Path(profile['dbPath'])
    require(db == root / 'state/state.sqlite' and not db.exists(), 'monitor DB must be new; no copied production state')
    require(not Path(profile['publicSocket']).exists(), 'scratch socket must have no existing owner')
    require(profile['cliArgv'] == c.cli, 'same qualified installed CLI required')
    # Infrastructure is provisioned by the caller before invocation. Seed only NEW HRC state.
    (root / 'state').mkdir(exist_ok=True)
    (root / 'run').mkdir(exist_ok=True)
    c.command('monitor-canonical-seed', [c.bun, Path(__file__).resolve().parent.parent / 'oracle.ts', c.release, root / 'state', 'seed'], root)
    ids = c.native_call('native-monitor-history', 'consumer-history-contract', root)
    native_done = time.time()  # command used subprocess.run: waited for exit and closed all handles.
    before = rows(db, "SELECT * FROM hrc_events ORDER BY hrc_seq")
    save(c.caseout / 'before-startup.json', {'nativeExitedAt': native_done, 'lifecycle': before,
         'runs': rows(db, 'SELECT * FROM runs'), 'runtimes': rows(db, 'SELECT * FROM runtimes')})
    # P0 owns isolation law. Reuse it unchanged, with declared owner checked again after start.
    spec = importlib.util.spec_from_file_location('p0_consumer_isolation', REPO / 'conformance/hrc-parity/run.py')
    p0 = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(p0)
    checks = []
    profile = dict(profile, claim='bun-compatibility', implementation='bun', ownerPid=1, rustOwnerPids=[])
    p0.isolation(profile, c.out, checks)
    save(c.caseout / 'isolation-preflight.json', checks)
    require(checks and all(x['pass'] for x in checks if x['id'] != 'isolation:ASP'), 'reviewed P0 isolation admission failed')
    # Capture no credentials. Both foreground and consumers receive the exact isolated destinations.
    env = c.env(root)
    env.update(profile['env'])
    env['HRC_DB_PATH'] = str(db)
    env['HRC_SOCKET_PATH'] = profile['publicSocket']
    env['HRC_EVENT_INGEST_SOCKET'] = str(root / 'run/ingest.sock')
    for marker in ('CLAUDECODE', 'CODEX_SANDBOX', 'CODEX_THREAD_ID', 'HRC_SESSION_REF', 'HRC_RUNTIME_ID', 'HRC_RUN_ID', 'HRC_HOST_SESSION_ID'):
        env.pop(marker, None)
    for key in ('HRC_EVENT_FORWARD_URL', 'HRC_EVENT_INGEST_TCP_PORT', 'HRC_EVENT_FORWARD_SOURCE_REF'):
        require(not env.get(key), 'unexpected publication destination')
    # Use a real clean Ghostty terminal. The launch file contains only env PATHS, never token bytes.
    launch = root / 'consumer-foreground.sh'
    pidfile = root / 'consumer-owner.pid'
    logfile = root / 'consumer-serve.log'
    safe_env = {k: v for k, v in env.items() if k.startswith(('HRC_', 'ASP_', 'WRKQ'))}
    for k, v in safe_env.items():
        require('TOKEN' not in k or k.endswith('_FILE') or v == '', 'inline credentials prohibited')
    lines = ['#!/bin/sh', 'unset CLAUDECODE CODEX_SANDBOX CODEX_THREAD_ID HRC_SESSION_REF HRC_RUNTIME_ID HRC_RUN_ID HRC_HOST_SESSION_ID',
             'unset WRKQD_NODE_TOKENS WRKQD_NODE_TOKENS_FILE WRKQD_UNIX WRKQ_DB_PATH WRKQ_DB_PATH_FILE WRKQD_TOKEN WRKQD_TOKEN_FILE HRC_WRKQD_TOKEN_FILE',
             'unset HRC_EVENT_FORWARD_URL HRC_EVENT_INGEST_TCP_PORT HRC_EVENT_FORWARD_SOURCE_REF']
    lines.extend(['echo $$ > ' + shlex.quote(str(pidfile)),
                  'exec env -i ' + shlex.join(['PATH=' + os.environ['PATH'], 'HOME=' + os.environ['HOME'], 'TMPDIR=/tmp', *[k + '=' + v for k, v in safe_env.items()], *c.cli, 'server', 'serve']) + ' > ' + shlex.quote(str(logfile)) + ' 2>&1'])
    launch.write_text('\n'.join(lines) + '\n'); launch.chmod(0o700)
    launched = c.command('ghostmux-foreground', ['ghostmux', 'new', '--json', '--cwd', root, '--title', 'P1 consumer monitor', '--command', shlex.join(['/bin/sh', str(launch)])], root)
    surface = launched['id']
    pid = None
    client = None
    try:
        deadline = time.monotonic() + 35
        while time.monotonic() < deadline:
            if pidfile.exists():
                pid = int(pidfile.read_text())
            if Path(profile['publicSocket']).exists():
                break
            time.sleep(.1)
        require(pid is not None and Path(profile['publicSocket']).exists(), 'foreground owner/socket startup')
        argv = c.command('foreground-pid-argv', ['ps', '-p', str(pid), '-o', 'args='], root, parse=False)
        require(str(c.release) in argv['stdout'] and 'server serve' in argv['stdout'], 'actual owned foreground PID argv')
        profile['ownerPid'] = pid
        status = c.command('real-cli-status', [*c.cli, 'server', 'status', '--json'], root, env=env)
        api = status['api']
        require(api['dbPath'] == str(db), 'CLI status exact scratch DB')
        # Resolve the real ASP declaration after startup, with no sessions/runtimes born.
        declaration = p0.request(profile, 'POST', '/v1/declarations/resolve', {
            'agentId': 'tabularasa', 'agentRoot': profile['agentRoot'], 'projectId': 'hrc-runtime',
            'projectRoot': profile['projectRoot'], 'cwd': profile['projectRoot'],
            'agentSources': {'agentsRoot': profile['agentsRoot']}, 'runMode': 'task',
            'interactive': True, 'preferredMode': 'headless'})
        save(profile['aspAdmissionEvidence'], declaration)
        require(declaration['status'] == 200, 'actual ASP declaration resolution')
        complete_checks = []
        p0.isolation(profile, c.out, complete_checks)
        save(c.caseout / 'isolation-admitted.json', complete_checks)
        require(all(x['pass'] for x in complete_checks), 'complete observed P0 isolation admission')
        # P0 transport handles chunked framing rather than accepting a hand-authored body.
        observed = p0.request(profile, 'GET', '/v1/status')
        save(c.caseout / 'real-socket-status.json', observed)
        require(observed['status'] == 200 and observed['body']['dbPath'] == str(db), 'real status exact DB')
        c.command('foreground-pane', ['ghostmux', 'capture-pane', '-t', surface], root, parse=False)
        body = c.command('real-monitor-show', [*c.cli, 'monitor', 'show', 'host:' + ids['hostSessionId'], '--json'], root, env=env)
        require(body['kind'] == 'monitor.snapshot', 'monitor kind')
        require(body['session']['hostSessionId'] == ids['hostSessionId'], 'nonempty native session identity')
        require(body['session']['scopeRef'] == ids['scopeRef'] and body['session']['generation'] == 1 and body['session']['laneRef'] == 'main', 'session scope/lane/generation')
        require(body['runtime']['runtimeId'] == ids['runtimeId'], 'native runtime identity')
        head = rows(db, "SELECT seq FROM sqlite_sequence WHERE name='hrc_events'")
        require(len(head) == 1 and body['eventLog']['highWaterSeq'] == head[0]['seq'] > 0, 'actual highwater after startup')
        save(c.caseout / 'after-startup.json', {'lifecycle': rows(db, 'SELECT * FROM hrc_events ORDER BY hrc_seq'),
             'runtimes': rows(db, 'SELECT * FROM runtimes'), 'startupIsPassive': False})
    finally:
        if client:
            client.close()
        if pid:
            import subprocess
            actual = subprocess.run(['ps', '-p', str(pid), '-o', 'args='], capture_output=True, text=True)
            if actual.returncode == 0:
                require(str(c.release) in actual.stdout and 'server serve' in actual.stdout, 'owned PID identity changed; do not signal')
                os.kill(pid, signal.SIGTERM)
                deadline = time.monotonic() + 15
                while time.monotonic() < deadline:
                    try:
                        os.kill(pid, 0)
                    except ProcessLookupError:
                        break
                    time.sleep(.1)
                else:
                    c.cleanup_failed = True
                    raise InfraError('owned foreground failed bounded shutdown; retained PID/root for operator')
        c.command('ghostmux-close-owned', ['ghostmux', 'kill-surface', '-t', surface], root, parse=False, exits=(0, 1))
        surfaces = c.command('foreground-surface-cleanup', ['ghostmux', 'list-surfaces', '--json'], root)
        require(all(x['id'].lower() != surface.lower() for x in surfaces['terminals']), 'owned foreground surface residue')
        if logfile.exists():
            (c.caseout / 'foreground.log').write_bytes(logfile.read_bytes())
        save(c.caseout / 'foreground-cleanup.json', {'pid': pid, 'socketAbsent': not Path(profile['publicSocket']).exists(), 'nativeExitedBeforeLaunch': native_done})
    require(not Path(profile['publicSocket']).exists(), 'foreground socket cleanup required before native reopen')
    loaded = c.native_call('native-after-Bun-exit', 'consumer-history-read', root)
    require(loaded['run']['runId'] == ids['runId'] and bool(loaded['lifecycle']), 'typed reopen same history')
    backup(db, c.caseout / 'monitor-state.sqlite')


def provision(c):
    """Fresh disposable wrkqd; no shared service changes or agent dispatch."""
    import secrets
    import shutil
    root = c.root / 'C04' / 'monitor'
    for part in ('agents/tabularasa', 'project', 'run', 'state'):
        (root / part).mkdir(parents=True, exist_ok=True)
    (root / 'agents/tabularasa/agent-profile.toml').write_text('version = 4\n[provisioning]\nharness = "claude"\n[spaces]\nbase = []\n')
    with socket.socket() as allocator:
        allocator.bind(('127.0.0.1', 0))
        port = allocator.getsockname()[1]
    require(port >= 30000, 'allocated private authority port must satisfy P0 range')
    tokenfile = root / 'wrkqd-token'
    tokenfile.write_text(secrets.token_hex(32)); tokenfile.chmod(0o600)
    save(root / 'hook-catalog.json', {'schemaVersion': 'wrkf.hook-catalog.v0', 'hooks': {}, 'effectHandlers': {}})
    save(root / 'federation.json', {'nodeId': 'p0-consumers-' + str(time.time_ns()), 'peers': {}})
    env = c.env(root)
    c.command('authority-migrate', ['wrkqadm', '--db', root / 'wrkq.db', 'migrate'], root, parse=False,
              env={**env, 'WRKQ_DB': str(root / 'wrkq.db')})
    pidfile = root / 'authority.pid'
    script = root / 'authority-launch.sh'
    script.write_text('#!/bin/sh\ncd ' + shlex.quote(str(root / 'project')) + '\n'
        'unset WRKQD_NODE_TOKENS WRKQD_NODE_TOKENS_FILE WRKQD_UNIX WRKQ_DB_PATH WRKQ_DB_PATH_FILE WRKQD_TOKEN_FILE HRC_WRKQD_TOKEN_FILE\n'
                'echo $$ > ' + shlex.quote(str(pidfile)) + '\nexec env -i ' + shlex.join(['PATH=' + os.environ['PATH'], 'HOME=' + os.environ['HOME'], 'TMPDIR=/tmp', 'WRKF_HOOK_CATALOG=' + str(root / 'hook-catalog.json')]) + ' WRKQD_TOKEN="$(cat ' + shlex.quote(str(tokenfile)) + ')" ' + shlex.join([shutil.which('wrkqd'), '-addr', '127.0.0.1:' + str(port), '-db', str(root / 'wrkq.db')]) +
        ' > ' + shlex.quote(str(root / 'authority.log')) + ' 2>&1\n')
    script.chmod(0o700)
    started = c.command('ghostmux-authority', ['ghostmux', 'new', '--json', '--cwd', root / 'project', '--title', 'P1 consumer authority', '--command', shlex.join(['/bin/sh', str(script)])], root)
    c.authority = {'surface': started['id'], 'pidfile': pidfile, 'root': root}
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        try:
            with socket.create_connection(('127.0.0.1', port), timeout=.2):
                break
        except OSError:
            time.sleep(.1)
    else:
        raise InfraError('fresh wrkqd failed to listen; see authority log')
    env.update(HRC_WRKQ_DB='rpc://127.0.0.1:' + str(port), WRKQ_DB='rpc://127.0.0.1:' + str(port),
               HRC_WRKQD_TOKEN_FILE=str(tokenfile), WRKQD_TOKEN_FILE=str(tokenfile), WRKQD_TOKEN='',
               HRC_ASPD_SOCKET=c.args.asp_socket, HRC_EVENT_INGEST_SOCKET=str(root / 'run/ingest.sock'),
               HRC_BROKER_DURABLE_IPC_ENABLED='1', HRC_HEADLESS_CODEX_BROKER_ENABLED='1', HRC_CLAUDE_CODE_TMUX_BROKER_ENABLED='1',
               HRC_PEER_CONFIG_FILE=str(root / 'federation.json'), HRC_SOCKET_PATH=str(root / 'run/hrc.sock'))
    c.command('authority-initialize', ['wrkq', 'projects', '--json'], root, env=env)
    c.command('authority-project', ['wrkq', 'mkdir', '/hrc-runtime', '--kind', 'project', '--as', 'agent:cody', '--json'], root, env=env)
    c.command('authority-project-root', ['wrkq', 'set', '/hrc-runtime', '--root', root / 'project', '--as', 'agent:cody', '--json'], root, env=env)
    profile = {'scratchRoot': str(root), 'runtimeRoot': str(root / 'run'), 'stateRoot': str(root / 'state'),
               'dbPath': str(root / 'state/state.sqlite'), 'publicSocket': str(root / 'run/hrc.sock'),
               'agentsRoot': str(root / 'agents'), 'agentRoot': str(root / 'agents/tabularasa'),
               'projectRoot': str(root / 'project'), 'peerConfig': str(root / 'federation.json'),
               'wrkqDbPath': str(root / 'wrkq.db'), 'wrkqLocator': env['WRKQ_DB'], 'wrkqPort': port,
               'scopePrefix': 'agent:tabularasa:project:hrc-runtime:task:p0-consumers-' + str(time.time_ns()),
               'runId': 'p1-consumer-monitor-' + str(time.time_ns()),
               'aspAdmissionEvidence': str(c.caseout / 'asp-resolution.json'),
               'cliArgv': c.cli, 'sdkArgv': [str(c.bun), str(REPO / 'conformance/hrc-parity/probe.ts')],
               'env': {k: v for k, v in env.items() if k.startswith(('HRC_', 'ASP_', 'WRKQ'))}}
    save(c.caseout / 'monitor-profile.json', profile)
    return profile



def run_monitor(c):
    """Infrastructure failure remains nonpassing; clean every owned subject in finally."""
    c.authority = None
    try:
        profile = json.loads(Path(c.args.monitor_profile).read_text()) if c.args.monitor_profile else provision(c)
        return run_profile(c, profile)
    finally:
        if c.authority:
            a = c.authority
            pid = int(a['pidfile'].read_text()) if a['pidfile'].exists() else None
            if pid:
                import subprocess
                argv = subprocess.run(['ps', '-p', str(pid), '-o', 'args='], capture_output=True, text=True)
                if 'wrkqd' in argv.stdout and str(a['root'] / 'wrkq.db') in argv.stdout:
                    try:
                        os.kill(pid, signal.SIGTERM)
                    except ProcessLookupError:
                        pass
                    deadline = time.monotonic() + 8
                    while time.monotonic() < deadline:
                        try:
                            os.kill(pid, 0)
                        except ProcessLookupError:
                            break
                        time.sleep(.1)
                    else:
                        c.cleanup_failed = True
                        raise InfraError('owned wrkqd did not stop; root retained')
            c.command('close-owned-authority', ['ghostmux', 'kill-surface', '-t', a['surface']], a['root'], parse=False, exits=(0, 1))
            surfaces = c.command('authority-surface-cleanup', ['ghostmux', 'list-surfaces', '--json'], a['root'])
            require(all(x['id'].lower() != a['surface'].lower() for x in surfaces['terminals']), 'owned authority surface residue')
            if (a['root'] / 'authority.log').exists():
                (c.caseout / 'authority.log').write_bytes((a['root'] / 'authority.log').read_bytes())
            save(c.caseout / 'authority-cleanup.json', {'pid': pid, 'stopped': True})
