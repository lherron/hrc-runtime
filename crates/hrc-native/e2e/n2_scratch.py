"""Isolated scratch subject for N2 broker-turn workflows.

One fresh /tmp root holds the copied Bun release, runtime/state dirs, wrkq
ledger, project and federation config. Failure modes this guards: a scratch Bun
daemon running from the atomic release tree (its startup prune deletes the
production release), env leaking this seat's HRC/ASP identity into the scratch
daemon or its brokers, production usage metrics, and a broker escaping the
scratch runtime root.
"""
from http.client import HTTPConnection, HTTPException
import json
import os
from pathlib import Path
import shutil
import signal
import socket
import sqlite3
import subprocess
import time

LEAK_PREFIXES = ('HRC_', 'ASP_', 'AGENT_', 'AGENTCHAT_', 'WRKQ', 'CLAUDE', 'CODEX', 'ACP_', 'HARNESS_', 'TMUX')


class UnixHTTP(HTTPConnection):
    def __init__(self, path, timeout=120):
        super().__init__('localhost', timeout=timeout)
        self.path = str(path)

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(self.path)


def copy_release(installed, destination):
    installed = Path(installed).resolve()
    destination = Path(destination)
    assert (installed / 'praesidium-release.json').is_file(), installed
    assert 'hrc-runtime-releases' not in destination.absolute().parts
    if not destination.exists():
        subprocess.run(['/bin/cp', '-R', str(installed), str(destination)], check=True,
                       env={k:v for k,v in os.environ.items() if not k.startswith(LEAK_PREFIXES)})
    assert (destination / 'praesidium-release.json').read_bytes() == (installed / 'praesidium-release.json').read_bytes()
    return destination.resolve()


def preflight_unmanaged(release, env):
    """The daemon's own provenance function must say unmanaged before any start."""
    package = release / 'packages/hrc-server'
    out = subprocess.run(['bun', '-e', 'const {captureServerRelease}=await import(process.argv[1]); '
                          'console.log(JSON.stringify(captureServerRelease(process.argv[2],new Date().toISOString())))',
                          str(package / 'src/release-provenance.ts'), str(package)],
                         env=env, cwd=release, capture_output=True, text=True, check=True)
    value = json.loads(out.stdout)
    assert value['mode'] == 'unmanaged' and 'hrc-runtime-releases' not in Path(value['packagePath']).parts, value
    return value


class Scratch:
    def __init__(self, root, installed_release, aspd_socket, binary, artifacts, project_id='n2-t11823'):
        self.root = Path(root).absolute()
        if self.root.exists():
            raise RuntimeError('scratch root must be fresh: ' + str(self.root))
        self.root.mkdir(parents=True)
        self.artifacts = Path(artifacts)
        self.artifacts.mkdir(parents=True, exist_ok=True)
        self.binary = Path(binary).resolve()
        self.project_id = project_id
        self.release = copy_release(installed_release, self.root / 'bun-release')
        self.cli = self.release / 'packages/hrc-cli/bin/hrc.js'
        bin_dir = self.root / 'bin'
        bin_dir.mkdir()
        (bin_dir / 'hrc').symlink_to(self.cli)
        self.project = self.root / project_id
        self.project.mkdir()
        for d in ('run', 'state'):
            (self.root / d).mkdir()
        config = self.root / 'federation.json'
        config.write_text(json.dumps({'nodeId': project_id, 'peers': {}}))
        config.chmod(0o600)
        env = {k: v for k, v in os.environ.items() if not k.startswith(LEAK_PREFIXES)}
        env['PATH'] = str(bin_dir) + os.pathsep + os.environ.get('PATH', '')
        env.update(HRC_RUNTIME_DIR=str(self.root / 'run'), HRC_STATE_DIR=str(self.root / 'state'),
                   ASP_PROJECT_ROOT_OVERRIDE=str(self.project), HRC_PROJECT_SEARCH_ROOTS=str(self.project),
                   HRC_WRKQ_DB=str(self.root / 'wrkq.db'), WRKQ_DB=str(self.root / 'wrkq.db'),
                   WRKQ_PRINCIPAL_REF='agent:clod', HRC_WRKQD_TOKEN_FILE='', WRKQD_TOKEN_FILE='', WRKQD_TOKEN='',
                   HRC_PEER_CONFIG_FILE=str(config), HRC_EVENT_INGEST_SOCKET=str(self.root / 'run/ingest.sock'),
                   HRC_ACP_WEBHOOK_URL='', HRC_ASPD_SOCKET=str(Path(aspd_socket).resolve()),
                   HRC_BROKER_DURABLE_IPC_ENABLED='1', HRC_HEADLESS_CODEX_BROKER_ENABLED='1',
                   HRC_CLAUDE_CODE_TMUX_BROKER_ENABLED='1')
        self.env = env
        assert Path(shutil.which('hrc', path=env['PATH'])).resolve() == self.cli.resolve()
        self.release_provenance = preflight_unmanaged(self.release, env)
        self.db_path = self.root / 'state/state.sqlite'
        self.socket = self.root / 'run/hrc.sock'
        self.steps, self.owners, self.logs = [], [], []

    # -- subprocesses -----------------------------------------------------
    def command(self, name, argv, timeout=300, check=True, stdin=None):
        run = subprocess.run([str(v) for v in argv], env=self.env, cwd=self.project, input=stdin,
                             capture_output=True, text=True, timeout=timeout)
        self.steps.append({'name': name, 'argv': [str(v) for v in argv], 'exit': run.returncode,
                           'stdout': run.stdout[-20000:], 'stderr': run.stderr[-20000:]})
        if check:
            assert run.returncode == 0, (name, run.returncode, run.stdout, run.stderr)
        out = run.stdout.strip()
        try:
            return json.loads(out) if out.startswith(('{', '[')) else run.stdout
        except json.JSONDecodeError:
            return run.stdout

    def init_substrate(self):
        self.command('project-init', ['git', 'init', '-q'])
        self.command('wrkq-migrate', ['wrkqadm', 'migrate'])
        self.command('wrkq-project', ['wrkq', 'mkdir', '/' + self.project_id, '--kind', 'project', '--json'])
        self.command('wrkq-root', ['wrkq', 'set', '/' + self.project_id, '--root', self.project, '--json'])
        self.command('schema-create', ['bun', '-e',
                     'import {openHrcDatabase} from ' + json.dumps(str(self.release / 'packages/hrc-store-sqlite/src/database.ts'))
                     + ';openHrcDatabase(process.argv[1]).close()', self.db_path])

    def up(self, kind, tag):
        log = (self.artifacts / f'{kind}-{tag}.log').open('w')
        self.logs.append(log)
        argv = [self.binary, 'server'] if kind == 'native' else [
            'bun', self.release / 'packages/hrc-cli/src/cli.ts', 'server', 'serve']
        proc = subprocess.Popen([str(a) for a in argv], env=self.env, cwd=self.project, stdout=log, stderr=log)
        self.owners.append(proc)
        for _ in range(300):
            assert proc.poll() is None, (kind, 'owner exited', proc.returncode)
            try:
                status, value = self.http('GET', '/v1/status')
                if status == 200:
                    if kind == 'native':
                        assert Path(value['binaryPath']).resolve() == self.binary
                    else:
                        assert Path(value['packagePath']).resolve().is_relative_to(self.release)
                        assert value['release']['mode'] == 'unmanaged', value['release']
                    self.steps.append({'name': f'{kind}-up', 'pid': proc.pid})
                    return proc
            except (OSError, HTTPException, ValueError):
                pass
            time.sleep(.1)
        raise AssertionError(kind + ' not ready')

    def down(self, proc, sig=signal.SIGTERM):
        proc.send_signal(sig)
        proc.wait(timeout=30)
        self.steps.append({'name': 'owner-down', 'pid': proc.pid, 'exit': proc.returncode})
        return proc.returncode

    # -- reads ------------------------------------------------------------
    def rows(self, sql, params=()):
        with sqlite3.connect(f'file:{self.db_path}?mode=ro', uri=True, timeout=30) as db:
            db.row_factory = sqlite3.Row
            return [dict(row) for row in db.execute(sql, params)]

    def http(self, method, path, body=None, timeout=120):
        c = UnixHTTP(self.socket, timeout)
        c.request(method, path, json.dumps(body) if body is not None else None,
                  {'Content-Type': 'application/json'})
        res = c.getresponse()
        raw = res.read().decode()
        c.close()
        try:
            return res.status, json.loads(raw)
        except ValueError:
            return res.status, raw

    def wait(self, predicate, timeout=300, what='condition'):
        deadline = time.time() + timeout
        while time.time() < deadline:
            value = predicate()
            if value:
                return value
            time.sleep(.2)
        raise AssertionError('timed out waiting for ' + what)

    def wait_completed(self, run_id, timeout=300):
        return self.wait(lambda: self.rows(
            "SELECT * FROM hrc_events WHERE run_id=? AND event_kind='turn.completed'", (run_id,)),
            timeout, 'turn.completed ' + run_id)

    def tmux_sockets(self):
        out = []
        for record in self.rows('SELECT runtime_state_json FROM runtimes'):
            state = json.loads(record['runtime_state_json'] or '{}')
            path = (state.get('tmux') or {}).get('socketPath')
            if path:
                assert Path(path).resolve().is_relative_to((self.root / 'run').resolve()), path
                out.append(path)
        return out

    def cleanup(self, scope_prefix):
        # Owners stop whatever the store checks find: a leaked native server
        # outlived a failed run for hours and ignored SIGTERM.
        try:
            if self.db_path.exists():
                for record in self.rows('SELECT scope_ref FROM runtimes'):
                    assert record['scope_ref'].startswith(scope_prefix), record['scope_ref']
                for path in self.tmux_sockets():
                    subprocess.run(['tmux', '-S', path, 'kill-server'], env=self.env, capture_output=True, timeout=5)
        finally:
            for owner in self.owners:
                if owner.poll() is None:
                    owner.terminate()
                    try:
                        owner.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        owner.kill()
                        owner.wait(timeout=10)
            for log in self.logs:
                log.close()

    def dump(self, name, extra=None):
        """Every durable row the workflow wrote, for per-case compares."""
        tables = ['sessions', 'continuities', 'runtimes', 'runs', 'broker_invocations',
                  'broker_invocation_events', 'broker_projection_dispositions', 'hrc_events',
                  'runtime_operations', 'inputs', 'active_input_deliveries', 'submission_admissions',
                  'runtime_buffers', 'runtime_first_turn_watch', 'tool_result_blobs',
                  'tool_result_blob_parts', 'runtime_artifacts', 'surface_bindings', 'event_stream_cursor']
        have = {r['name'] for r in self.rows("SELECT name FROM sqlite_master WHERE type='table'")}
        value = {t: self.rows(f'SELECT * FROM {t}') for t in tables if t in have}
        metrics = sorted((self.root / 'state/metrics').glob('*.ndjson')) if (self.root / 'state/metrics').exists() else []
        value['requests'] = [json.loads(l) for f in metrics for l in f.read_text().splitlines() if l.strip()]
        # The broker's own durable ledger is the raw-row authority both owners mirror.
        value['brokerLedger'] = [json.loads(l) for f in sorted((self.root / 'run/bipc').glob('*/events.ndjson'))
                                 for l in f.read_text().splitlines() if l.strip()]
        value['scratchRoot'] = str(self.root)
        if extra:
            value.update(extra)
        (self.artifacts / f'{name}.json').write_text(json.dumps(value, indent=1, default=str) + '\n')
        return value
