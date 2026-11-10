"""Shared native CLI lifecycle subject; private authority and real hrcpty lease.

The broker is the existing deterministic substrate broker, not a model. Every
owner/store/process belongs to a fresh short /tmp root. Model qualification is
explicitly separate; this fixture never reaches a live aspd or wrkq.
"""
import argparse
import functools
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import uuid

ROOT = Path(__file__).resolve().parents[3]
NATIVE = ROOT / 'crates/hrc-native/e2e'
sys.path.insert(0, str(NATIVE))
from n3_scratch import Scratch
from kernel_fold import DeclaringAspd
from hrcpty_substrate import ops, alive, CHILD
from metrics_isolation import isolated_suite


class SeatAspd(DeclaringAspd):
    def handle(self, method, params):
        if method == 'aspc.resolveRuntimeDeclaration' and params['context']['agentId'] != 'tabularasa':
            return {'schemaVersion': 'aspc-resolve-runtime-declaration-response/v1', 'ok': False,
                    'source': {'agentProfile': {'state': 'missing'}},
                    'diagnostics': [{'severity': 'error', 'code': 'agent_not_found', 'message': 'unknown fixture agent'}]}
        return super().handle(method, params)

    def compile(self, req):
        return self.codex(req, ':task:codex-fixture')


class Fixture:
    def __init__(self, args):
        self.args = args
        args.artifacts.mkdir(parents=True, exist_ok=True)
        self.root = Path(tempfile.mkdtemp(prefix='cs-', dir='/tmp'))
        self.root.rmdir()  # Scratch requires a fresh path.
        try:
            self.s = Scratch(self.root, None, getattr(args, 'aspd_socket', None) or self.root / 'aspd.sock', args.binary, self.root / 'evidence',
                             project_id='n5-t11819')
        except BaseException:
            shutil.rmtree(self.root, ignore_errors=True)
            raise
        self.env, self.project = self.s.env, self.s.project
        self.prefix = 'agent:tabularasa:project:n5-t11819:task:'
        self.asp = None

    def __enter__(self):
        try:
            s = self.s
            s.init_substrate()
            (s.root / 'federation.json').unlink()  # truly single-node, private project registry
            release_root = s.root / 'release'
            (release_root / 'bin').mkdir(parents=True)
            stub = release_root / 'bin/stub-broker'
            shutil.copy(NATIVE / 'hrcpty_stub_broker.py', stub.with_name('base_broker.py'))
            shutil.copy(Path(__file__).with_name('seat_broker.py'), stub)
            stub.chmod(0o755)
            release = {'releaseId': 'cli-seat-fixture', 'sourceCommit': '1' * 40,
                       'builtAt': '2026-11-10T00:00:00.000Z', 'releaseRoot': str(release_root),
                       'worker': {'protocol': 'harness-broker/0.2', 'executable': str(stub),
                                  'argvPrefix': ['--ops-only', '1'],
                                  'hostedDrivers': ['codex-app-server']}}
            (release_root / 'release.json').write_text(json.dumps({**{k: release[k] for k in ('releaseId', 'sourceCommit', 'builtAt')},
                'protocol': 'harness-broker/0.2', 'hostedDrivers': release['worker']['hostedDrivers']}))
            agent = s.root / 'agents/tabularasa'
            agent.mkdir(parents=True)
            (agent / 'agent-profile.toml').write_text('version = 4\n[identity]\ndisplay = "CLI fixture"\n[provisioning]\nharness = "codex-hrcpty"\n[spaces]\nbase = []\n')
            if getattr(self.args, 'harness_config', None):
                shutil.copy(self.args.harness_config, s.project / 'asp-targets.toml')
            else:
                self.asp = SeatAspd(s.aspd_socket, release, s.artifacts / 'aspd.ndjson', s.project)
            s.env.update(NO_COLOR='1', FORCE_COLOR='0', ASP_AGENTS_ROOT=str(s.root / 'agents'))
            s.up('native', 'cli')
            status = self.call('/v1/status')
            assert Path(status['runtimeRoot']).resolve() == (s.root / 'run').resolve(), status
            self.intent = {'placement': {'agentRoot': str(agent), 'projectRoot': str(s.project),
                'cwd': str(s.project), 'runMode': 'task', 'bundle': {'kind': 'compose', 'compose': []}, 'dryRun': False},
                'harness': {'provider': 'openai', 'interactive': False}}
            return self
        except BaseException:
            self.__exit__(*sys.exc_info())
            raise

    def call(self, path, body=None):
        status, value = self.s.http('POST' if body is not None else 'GET', path, body)
        assert 200 <= status < 300, (status, value)
        return value

    def run(self, argv, stdin='', extra=None, timeout=60):
        out = subprocess.run([str(self.args.binary.resolve()), *argv], env=dict(self.env, **(extra or {})),
            cwd=self.project, input=stdin, capture_output=True, text=True, timeout=timeout)
        value = dict(exit=out.returncode, stdout=out.stdout, stderr=out.stderr)
        self.s.steps.append(dict(argv=argv, **value))
        return value

    def birth(self, task=None, prompt='fixture turn CONT'):
        task = task or 'cli-' + uuid.uuid4().hex
        ref = self.prefix + task + '/lane:main'
        session = self.call('/v1/sessions/resolve', dict(sessionRef=ref, create=True, summonIntent='explicit_local', runtimeIntent=self.intent))
        turn = self.call('/v1/turns', dict(hostSessionId=session['hostSessionId'], prompt=prompt, runtimeIntent=self.intent))
        self.s.wait_completed(turn['runId'], 30)
        self.broker(turn['runtimeId'])
        self.s.wait(lambda: (self.root / 'run/lifecycle' / (turn['runtimeId'] + '.credential')).is_file(), 15, 'daemon-minted credential')
        return dict(sessionRef=ref, target='tabularasa@n5-t11819:' + task, intent=self.intent,
                    **turn, session=self.call('/v1/sessions/resolve', dict(sessionRef=ref))['session'])

    def broker(self, rid):
        row = self.s.rows('SELECT * FROM runtimes WHERE runtime_id=?', (rid,))[0]
        state = json.loads(row['runtime_state_json'])
        sub = state['broker']['substrate']
        sock = Path(sub['socketPath'])
        assert row['transport'] == 'hrcpty' and sub['kind'] == 'leased-hrcpty' and sock.is_socket(), row
        assert sock.resolve().is_relative_to(self.root.resolve()), sub
        status = ops(sock, sock.parent / 'attach.token', 'status')
        if not (status['status'].get('child') or {}).get('pid'):
            spawned = ops(sock, sock.parent / 'attach.token', 'spawn',
                {'argv': [sys.executable, '-u', '-c', CHILD, str(self.root)],
                 'env': {'PATH': '/usr/bin:/bin', 'SHELL': '/bin/sh', 'HOME': str(Path.home())}, 'cwd': str(self.project), 'cols': 100, 'rows': 30})
            assert 'code' not in spawned['spawn'], spawned
            status = ops(sock, sock.parent / 'attach.token', 'status')
        assert alive(sub['pid']) and status['status']['broker']['state'] == 'running', status
        (self.args.artifacts / ('broker-' + rid + '.json')).write_text(json.dumps(dict(row=row, status=status), indent=2))
        return status

    def __exit__(self, *exc):
        try:
            if self.s.db_path.exists():
                self.s.dump('rows', {'steps': self.s.steps})
        finally:
            try:
                prefixes = (self.prefix, 'agent:summarizer:project:n5-t11819:task:stacked:') if getattr(self.args, 'harness_config', None) else self.prefix
                self.s.cleanup(prefixes)
            finally:
                if self.asp:
                    self.asp.close()
                if self.s.artifacts.exists():
                    shutil.copytree(self.s.artifacts, self.args.artifacts, dirs_exist_ok=True)
                shutil.rmtree(self.root)
                assert not self.root.exists(), self.root
                (self.args.artifacts / 'cleanup.json').write_text(json.dumps({'root': str(self.root), 'rootAbsent': True}))


def arguments():
    p = argparse.ArgumentParser()
    p.add_argument('--binary', type=Path, required=True)
    p.add_argument('--artifacts', type=Path, required=True)
    p.add_argument('--lifecycle', action='store_true', default=True)
    return p


def suite(fn):
    @isolated_suite
    @functools.wraps(fn)
    def main():
        args = arguments().parse_args()
        args.artifacts.mkdir(parents=True, exist_ok=True)
        with Fixture(args) as f:
            return fn(f, args)
    return main


def refusal(out, argv):
    """An independent refusal contract, never comparison with another executable."""
    assert out['exit'] in (1, 2), (argv, out)
    assert out['stdout'].strip() or out['stderr'].strip(), (argv, out)
    stream = out['stdout'] if out['stdout'].lstrip().startswith('{') else out['stderr']
    if stream.lstrip().startswith('{'):
        value = json.loads(stream)
        assert value.get('ok') is False or value.get('error') or value.get('status') == 'error', (argv, value)
    else:
        assert out['stderr'].startswith('hrc: ') or out['stdout'].startswith('Usage: hrc '), (argv, out)
    return True


def report(args, results, **extra):
    value = dict(cases=results, **extra, **{'pass': sum(r['pass'] for r in results), 'fail': sum(not r['pass'] for r in results)})
    (args.artifacts / 'results.json').write_text(json.dumps(value, indent=2) + '\n')
    print(json.dumps({k: value[k] for k in ('pass', 'fail')}))
    assert value['fail'] == 0, value
    return 0
