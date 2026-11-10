#!/usr/bin/env python3
"""Real lifecycle publication regression, with every RPC captured locally.

An unmanaged daemon, or an atomic binary on scratch roots, must keep its local
facts without posting them. The production-shaped control must post a release.
No live service, ledger, installed tree or caller identity is used.
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import tempfile
import time

from foundation import UnixHTTP, daemon_env

REPO = Path(__file__).resolve().parents[3]
CAPTURE = '''#!/usr/bin/env python3
import json, sys
from pathlib import Path
for line in sys.stdin:
    frame = json.loads(line)
    with Path(__file__).with_name('capture.jsonl').open('a') as out:
        out.write(json.dumps(frame) + '\\n')
    reply = {'jsonrpc': '2.0', 'id': frame['id']}
    if frame['method'] in ('rpc.initialize', 'wrkq.projectEvent.post'):
        reply['result'] = {}
    else:
        reply['error'] = {'code': -32601, 'message': 'local capture: unsupported method'}
    print(json.dumps(reply), flush=True)
'''


def drive(binary, out, atomic=False, owner_roots=False):
    out.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='lp-', dir='/tmp') as tmp:
        root = Path(tmp)
        home = root / 'home'
        home.mkdir()
        runtime, state = root / 'run', root / 'state'
        if owner_roots:
            runtime = home / 'praesidium/var/run/hrc'
            state = home / 'praesidium/var/state/hrc'
        state.mkdir(parents=True)
        subprocess.run([str(binary), 'store', 'migrate', str(state / 'state.sqlite')],
                       cwd=REPO, check=True, capture_output=True)
        if atomic:
            release = root / 'atomic/hrc-runtime-releases/release-t12677'
            (release / 'bin').mkdir(parents=True)
            commit = json.loads(subprocess.check_output([binary, '--build-info']))['sourceCommit']
            manifest = dict(schema=1, releaseId=release.name,
                            hrcBuild=dict(schema=1, repository='hrc-runtime', canonicalRemote='local-fixture',
                                          sourceCommit=commit, setName='hrc', setVersion='fixture',
                                          builtAt='2026-11-06T00:00:00Z'),
                            aspContracts=[dict(name='fixture', version='1')], installedAt='2026-11-06T00:00:00Z')
            (release / 'praesidium-release.json').write_text(json.dumps(manifest))
            shutil.copy2(binary, release / 'bin/rusthrc')
            binary = release / 'bin/rusthrc'
        fixture_bin = root / 'bin'
        fixture_bin.mkdir()
        stub = fixture_bin / 'wrkq'
        stub.write_text(CAPTURE)
        stub.chmod(0o755)
        capture = fixture_bin / 'capture.jsonl'
        env = {k: v for k, v in os.environ.items()
               if not k.startswith(('HRC_', 'ASP_', 'HARNESS', 'WRKQ', 'AGENT', 'CODEX', 'CLAUDE', 'TMUX', 'XPC_'))}
        env.update(HOME=str(home), HRC_RUNTIME_DIR=str(runtime), HRC_STATE_DIR=str(state),
                   HRC_WRKQ_DB='rpc://127.0.0.1:1', HRC_LAUNCHD_LABEL='fixture.t12677')
        env = daemon_env(env, [fixture_bin])
        pids = []
        for boot in range(2):
            with (out / 'serve.log').open('a') as log:
                proc = subprocess.Popen([str(binary), 'server', 'serve'], cwd=root, env=env,
                                        stdin=subprocess.DEVNULL, stdout=log, stderr=log)
                pids.append(proc.pid)
                try:
                    for _ in range(200):
                        assert proc.poll() is None, 'daemon exited; see serve.log'
                        try:
                            h = UnixHTTP(runtime / 'hrc.sock')
                            h.request('GET', '/v1/status')
                            response = h.getresponse()
                            status = json.loads(response.read())
                            h.close()
                            if response.status == 200:
                                break
                        except (OSError, json.JSONDecodeError):
                            pass
                        time.sleep(.05)
                    else:
                        raise AssertionError('daemon did not answer status')
                    # A drained durable cursor proves the negative; no silence timer.
                    for _ in range(200):
                        with sqlite3.connect(state / 'state.sqlite') as db:
                            head = db.execute("SELECT max(hrc_seq) FROM hrc_events WHERE event_kind='server.started'").fetchone()[0]
                            cursor = db.execute("SELECT high_water FROM wrkq_ledger_cursors WHERE stream='server-project-events'").fetchone()
                        if head and cursor and cursor[0] >= head:
                            break
                        time.sleep(.05)
                    else:
                        raise AssertionError('publication never drained')
                finally:
                    proc.terminate()
                    proc.wait(timeout=20)
        frames = [json.loads(line) for line in capture.read_text().splitlines()] if capture.exists() else []
        posts = [frame['params'] for frame in frames if frame['method'] == 'wrkq.projectEvent.post']
        with sqlite3.connect(state / 'state.sqlite') as db:
            rows = [dict(kind=kind, payload=json.loads(payload)) for kind, payload in db.execute(
                "SELECT event_kind,payload_json FROM hrc_events WHERE scope_ref='server:hrc' ORDER BY hrc_seq")]
        result = dict(pids=pids, release=status['release'], posts=posts, localLifecycle=rows,
                      head=head, cursor=cursor[0], exit=proc.returncode)
        (out / 'result.json').write_text(json.dumps(result, indent=2) + '\n')
        (out / 'rpc.jsonl').write_text(''.join(json.dumps(frame) + '\n' for frame in frames))
        assert status['release']['mode'] == ('atomic' if atomic else 'unmanaged'), status
        assert proc.returncode == 0, result
        assert [row['kind'] for row in rows] == ['server.started', 'server.shutting_down', 'server.stopped'] * 2, rows
        if atomic and owner_roots:
            assert [post['type'] for post in posts] == ['server.started', 'server.stopped', 'server.started'], posts
            assert posts[0]['attributes']['release'] == 'release-t12677', posts
        else:
            assert not posts, posts
        return dict(pids=pids, posts=len(posts), localFacts=len(rows), **{'pass': True})


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--binary', type=Path, required=True)
    parser.add_argument('--artifacts', type=Path, required=True)
    args = parser.parse_args()
    results = {}
    for name, atomic, owner in [('unmanaged-private', False, False), ('unmanaged-owner', False, True),
                                ('atomic-private', True, False), ('atomic-owner', True, True)]:
        results[name] = drive(args.binary.resolve(), args.artifacts / name, atomic, owner)
    (args.artifacts / 'result.json').write_text(json.dumps(results, indent=2) + '\n')
    print(json.dumps({'pass': True, 'cases': results, 'artifacts': str(args.artifacts)}))


if __name__ == '__main__':
    main()
