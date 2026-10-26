#!/usr/bin/env python3
"""Start with real owned daemon processes and a controlled launchctl boundary.
Failure modes: startup actuates a production job; ignores either governing
plist/lock; starts a second owner; leaks harness recursion guards; forks a Bun
CLI; loses startup failure; front starts before Bun; public health never holds;
foreground start double-records metrics; cleanup leaves an owned daemon.
"""
import argparse, fcntl, json, os, plistlib, shutil, signal, socket, sqlite3, subprocess, sys, tempfile, time
from pathlib import Path
from metrics_isolation import MetricsIsolation
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'hrc-native/e2e'))
from foundation import UnixHTTP

BUN_JOB = 'com.praesidium.hrc-server'
FRONT_JOB = 'com.praesidium.rusthrc-server'


def main():
    p = argparse.ArgumentParser()
    for name in ('binary', 'oracle', 'seed-state', 'artifacts'):
        p.add_argument('--' + name, type=Path, required=True)
    p.add_argument('--front-oracle', type=Path)
    p.add_argument('--wrkq-db', required=True)
    p.add_argument('--token-file', type=Path, required=True)
    a = p.parse_args()
    assert a.seed_state.resolve().is_relative_to(Path('/tmp').resolve())
    assert a.token_file.resolve().is_relative_to(Path('/tmp').resolve()) and a.wrkq_db.startswith('rpc://127.0.0.1:')
    a.artifacts.mkdir(parents=True, exist_ok=True)
    binary = a.binary.resolve()
    bun = shutil.which('bun')
    seed = sqlite3.connect(f'file:{a.seed_state / "state.sqlite"}?mode=ro', uri=True)
    assert seed.execute('SELECT COUNT(*) FROM runtimes').fetchone()[0] == 0
    assert seed.execute('SELECT COUNT(*) FROM sessions').fetchone()[0] == 0
    results = []

    def fixture(name, mode='none', declared=(), loaded=(), error=0, unrelated=False):
        root = Path(tempfile.mkdtemp(prefix='n5s-', dir='/tmp'))
        state = root / 's'; state.mkdir()
        db = sqlite3.connect(state / 'state.sqlite'); seed.backup(db); db.close()
        runtime = root / 'r'; runtime.mkdir()
        home = root / 'home'; home.mkdir()
        tools = root / 'tools'; tools.mkdir()
        oracle_tools = root / 'oracle-tools'; oracle_tools.mkdir()
        (oracle_tools / 'bun').symlink_to(bun)
        (tools / 'wrkq').symlink_to(shutil.which('wrkq'))
        (oracle_tools / 'wrkq').symlink_to(shutil.which('wrkq'))
        env = {k:v for k,v in os.environ.items() if not k.startswith(('ASP_', 'HRC_', 'WRKQ', 'HARNESS_BROKER_')) and k not in ('CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CODEX_SANDBOX')}
        env.update(HOME=str(home), HRC_RUNTIME_DIR=str(runtime), HRC_STATE_DIR=str(state), HRC_PEER_CONFIG_FILE=str(root / 'no-federation.json'), HRC_ACP_WEBHOOK_URL='', PATH=f'{tools}:/usr/bin:/bin', NO_COLOR='1', FORCE_COLOR='0')
        env.update(WRKQ_DB=a.wrkq_db, HRC_WRKQ_DB=a.wrkq_db, WRKQD_TOKEN_FILE=str(a.token_file), HRC_WRKQD_TOKEN_FILE=str(a.token_file))
        plist_dir = home / 'Library/LaunchAgents'; plist_dir.mkdir(parents=True)
        for label in declared:
            args = [str(binary), 'server', '--front', '--bun-socket', str(runtime / 'hrc-bun.sock')] if label == FRONT_JOB else [bun, str((a.front_oracle if mode == 'front' else a.oracle).resolve()), 'server', 'serve'] + (['--listen-socket', str(runtime / 'hrc-bun.sock')] if mode == 'front' else [])
            with (plist_dir / (label + '.plist')).open('wb') as f:
                plistlib.dump(dict(Label=label, ProgramArguments=args, EnvironmentVariables=dict(HRC_RUNTIME_DIR='/not-this-runtime' if unrelated else str(runtime), HRC_STATE_DIR=str(state))), f)
        config = dict(root=str(root), loaded=list(loaded), mode=mode, error=error, bun=bun, oracle=str((a.front_oracle if mode == 'front' else a.oracle).resolve()), binary=str(binary), environment={k:v for k,v in env.items() if k.startswith(('ASP_', 'HRC_', 'WRKQ')) or k in ('HOME','PATH','LANG','TERM')})
        (root / 'config.json').write_text(json.dumps(config)); (root / 'config.json').chmod(0o600)
        launcher = tools / 'launchctl'
        launcher.write_text('#!' + sys.executable + '\n' + '''import json,os,socket,subprocess,sys
from pathlib import Path
root=Path(__file__).resolve().parent.parent
c=json.loads((root/'config.json').read_text());args=sys.argv[1:];label=args[-1].split('/')[-1]
with (root/'launchctl.ndjson').open('a') as f:f.write(json.dumps(args)+'\\n')
assert args[0] in ('print','kickstart'),args
if args[0]=='print':sys.exit(0 if not args[-1].startswith('system/') and label in c['loaded'] else 3)
assert label in c['loaded'],args
if c['error']:sys.exit(c['error'])
r=root/'r';front=label=='com.praesidium.rusthrc-server';private=c['mode']=='front' and not front
path=r/('hrc-bun.sock' if private else 'hrc.sock')
s=socket.socket(socket.AF_UNIX)
try:s.connect(str(path));sys.exit(0)
except OSError:pass
finally:s.close()
cmd=[c['binary'],'server','--front','--bun-socket',str(r/'hrc-bun.sock')] if front else [c['bun'],c['oracle'],'server','serve']+(['--listen-socket',str(path)] if private else [])
with (root/(label+'.log')).open('a') as log:
 p=subprocess.Popen(cmd,env=c['environment'],stdin=subprocess.DEVNULL,stdout=log,stderr=log,start_new_session=True)
with (root/'children.ndjson').open('a') as f:f.write(json.dumps(dict(pid=p.pid,label=label,argv=cmd))+'\\n')
''')
        launcher.chmod(0o700)
        (oracle_tools / 'launchctl').symlink_to(launcher)
        (tools / 'plutil').symlink_to('/usr/bin/plutil')
        (oracle_tools / 'plutil').symlink_to('/usr/bin/plutil')
        return dict(name=name, root=root, runtime=runtime, state=state, env=env, oracle_tools=oracle_tools)

    def call(f, path):
        h = UnixHTTP(f['runtime'] / 'hrc.sock'); h.request('GET', path); r = h.getresponse(); data = json.loads(r.read()); h.close(); assert r.status == 200, data; return data

    def ready(f):
        try:return call(f, '/v1/health')['ok'] is True
        except (OSError, json.JSONDecodeError):return False

    def wait_ready(f):
        for _ in range(150):
            if ready(f):return
            time.sleep(.1)
        raise AssertionError(f['root'])

    def cleanup(f, metrics, processes=()):
        pids = set()
        children = f['root'] / 'children.ndjson'
        if children.exists():pids.update(json.loads(line)['pid'] for line in children.read_text().splitlines())
        for path in ('server.pid', 'rusthrc-front.pid'):
            file = f['runtime'] / path
            if file.exists():pids.add(int(file.read_text()))
        pids.update(p.pid for p in processes)
        metrics.pids.update(pids)
        # Every PID originates from this fixture's launcher, native pid file or
        # directly owned Popen. No global process matching or launchctl calls.
        for pid in pids:
            try:os.kill(pid, signal.SIGTERM)
            except ProcessLookupError:pass
        for child in processes:
            try:child.wait(timeout=10)
            except subprocess.TimeoutExpired:raise AssertionError(('owned child stuck', child.pid))
        for _ in range(100):
            if not ready(f) and not (f['runtime'] / 'server.lock').exists():break
            time.sleep(.1)
        assert not ready(f)
        (a.artifacts / (f['name'] + '-cleanup.json')).write_text(json.dumps(dict(root=str(f['root']), pids=sorted(pids), healthy=False), indent=2))

    def invoke(f, argv=(), oracle=False, extra=None):
        env = dict(f['env'], **(extra or {}))
        if oracle:env['PATH'] = f'{f["oracle_tools"]}:/usr/bin:/bin'
        cmd = [bun, str(a.oracle.resolve())] if oracle else [str(binary)]
        child = subprocess.run(cmd + ['server', 'start'] + list(argv), env=env, capture_output=True, text=True, timeout=20)
        return dict(exit=child.returncode, stdout=child.stdout, stderr=child.stderr)

    with MetricsIsolation() as metrics:
        # Real foreground engine: this PID owns the socket and start metrics.
        f = fixture('foreground')
        child = subprocess.Popen([str(binary), 'server', 'start'], env=f['env'], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            wait_ready(f)
            assert int((f['runtime'] / 'server.pid').read_text()) == child.pid
            status = call(f, '/v1/status'); assert status['runtimeRoot'] == str(f['runtime'])
            child.send_signal(signal.SIGTERM); stdout, stderr = child.communicate(timeout=10); assert child.returncode == 0, (stdout, stderr)
            records = [json.loads(line) for file in (f['state'] / 'metrics').glob('cli-*.ndjson') for line in file.read_text().splitlines()]
            owned = [row for row in records if row.get('pid') == child.pid]
            assert len(owned) == 1 and owned[0]['cmd'] == 'server start', owned
            results.append(dict(case=f['name'], **{'pass':True}, status=status, metrics=owned))
        finally:cleanup(f, metrics, [child])
        for mode in ('daemon', 'legacy', 'ealready', 'kick-error', 'stranded', 'unrelated', 'owner-lock', 'front-lock', 'stale-front-lock'):
            labels = (BUN_JOB,) if mode in ('legacy', 'ealready', 'kick-error') else ()
            declared = (BUN_JOB,) if mode in ('stranded', 'unrelated') else ()
            f = fixture(mode, declared=declared, loaded=labels, error=37 if mode == 'ealready' else 1 if mode == 'kick-error' else 0, unrelated=mode=='unrelated')
            lock = None
            if mode == 'owner-lock':(f['runtime'] / 'server.lock').write_text('fixture owner\n')
            if mode in ('front-lock', 'stale-front-lock'):
                lock = (f['runtime'] / 'rusthrc-front.lock').open('w')
                if mode == 'front-lock':fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            try:
                out = invoke(f, ['--daemon', '--timeout-ms', '5000'])
                expected = 2 if mode in ('kick-error', 'stranded', 'owner-lock', 'front-lock') else 0
                assert out['exit'] == expected, (mode, out, f['root'])
                if mode in ('daemon', 'legacy', 'unrelated', 'stale-front-lock'):wait_ready(f)
                if mode == 'ealready':assert 'EALREADY' in out['stderr'] and not ready(f), out
                if mode == 'stranded':assert 'refusing to start an unsupervised daemon' in out['stderr'], out
                if mode == 'front-lock':assert 'front-door lock is held' in out['stderr'], out
                if mode == 'owner-lock':assert (f['runtime'] / 'server.lock').read_text() == 'fixture owner\n'
                results.append(dict(case=mode, output=out, root=str(f['root']), **{'pass':True}))
            finally:
                if lock:lock.close()
                if mode == 'owner-lock':(f['runtime'] / 'server.lock').unlink()
                cleanup(f, metrics)
        if a.front_oracle:
            for mode in ('front', 'stranded-front'):
                f = fixture(mode, mode='front', declared=(BUN_JOB, FRONT_JOB), loaded=(BUN_JOB, FRONT_JOB) if mode=='front' else (BUN_JOB,))
                try:
                    out = invoke(f, ['--timeout-ms', '8000'])
                    assert out['exit'] == (0 if mode=='front' else 2), (out,f['root'])
                    if mode == 'front':
                        wait_ready(f)
                        calls = [json.loads(line) for line in (f['root'] / 'launchctl.ndjson').read_text().splitlines()]
                        assert [row[-1].split('/')[-1] for row in calls if row[0]=='kickstart'] == [BUN_JOB, FRONT_JOB], calls
                        status = call(f,'/v1/status');assert status['listenSocketPath'] != status['socketPath'],status
                    else:assert FRONT_JOB in out['stderr'] and 'not loaded' in out['stderr'],out
                    results.append(dict(case=mode, output=out, root=str(f['root']), **{'pass':True}))
                finally:cleanup(f, metrics)
    seed.close()
    (a.artifacts / 'results.json').write_text(json.dumps(dict(cases=results, **{'pass':all(x['pass'] for x in results)}), indent=2))
    print(json.dumps(dict(pass_=True, cases=len(results))))


if __name__ == '__main__':main()
