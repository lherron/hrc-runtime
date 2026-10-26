#!/usr/bin/env python3
"""N1 gates 1, 2 and 4 as one real workflow on fresh, isolated state.

Failure modes: wrong daemon, escaped paths, duplicate birth, lost/unACKed events,
broker disposal on owner shutdown, identity drift on reattach, Bun unreadable
rows, first-prompt replay failure, and second-turn failure. No production rows
are copied. Run from a clean ghostmux terminal; both owners are foreground
children of this driver. The named Bun copy must be outside the atomic tree.
"""
import argparse
from http.client import HTTPException
import json
import os
from pathlib import Path
import signal
import shutil
import socket
import sqlite3
import subprocess
import time

from foundation import UnixHTTP


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--binary', type=Path, required=True)
    p.add_argument('--bun-release', type=Path, required=True)
    p.add_argument('--aspd-socket', type=Path, required=True)
    p.add_argument('--scratch-root', type=Path, required=True)
    p.add_argument('--artifacts', type=Path, required=True)
    args = p.parse_args()
    if any(os.environ.get(k) for k in ('CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CODEX_SANDBOX')):
        raise RuntimeError('run this workflow from a clean ghostmux terminal')
    root = args.scratch_root.absolute()
    if root.exists():
        raise RuntimeError('scratch root must be fresh: ' + str(root))
    root.mkdir(parents=True)
    args.artifacts.mkdir(parents=True, exist_ok=True)
    release = args.bun_release.resolve()
    assert release.parent.name != 'hrc-runtime-releases'
    bin_dir = root / 'bin'
    bin_dir.mkdir()
    cli = release / 'packages/hrc-cli/bin/hrc.js'
    assert cli.is_file()
    (bin_dir / 'hrc').symlink_to(cli)
    project = root / 'n1-t11818'
    project.mkdir()
    (root / 'run').mkdir()
    (root / 'state').mkdir()
    config = root / 'federation.json'
    config.write_text(json.dumps({'nodeId': 'n1-t11818', 'peers': {}}))
    config.chmod(0o600)
    env = dict(os.environ, PATH=str(bin_dir)+os.pathsep+os.environ.get('PATH',''))
    assert Path(shutil.which('hrc',path=env['PATH'])).resolve()==cli.resolve()
    for k in ('HRC_SESSION_REF', 'HRC_RUNTIME_ID', 'HRC_RUN_ID', 'HRC_HOST_SESSION_ID',
              'HRC_EVENT_FORWARD_URL', 'HRC_EVENT_INGEST_TCP_PORT', 'HRC_EVENT_FORWARD_SOURCE_REF',
              'WRKQ_DB_PATH', 'WRKQ_DB_PATH_FILE', 'WRKQD_NODE_TOKENS', 'WRKQD_NODE_TOKENS_FILE', 'WRKQD_UNIX'):
        env.pop(k, None)
    env.update(HRC_RUNTIME_DIR=str(root / 'run'), HRC_STATE_DIR=str(root / 'state'),
               ASP_PROJECT_ROOT_OVERRIDE=str(project), HRC_PROJECT_SEARCH_ROOTS=str(project),
               HRC_WRKQ_DB=str(root / 'wrkq.db'), WRKQ_DB=str(root / 'wrkq.db'),
               WRKQ_PRINCIPAL_REF='agent:cody',
               HRC_WRKQD_TOKEN_FILE='', WRKQD_TOKEN_FILE='', WRKQD_TOKEN='',
               HRC_PEER_CONFIG_FILE=str(config), HRC_EVENT_INGEST_SOCKET=str(root / 'run/ingest.sock'),
               HRC_ACP_WEBHOOK_URL='', HRC_ASPD_SOCKET=str(args.aspd_socket.resolve()),
               HRC_BROKER_DURABLE_IPC_ENABLED='1', HRC_HEADLESS_CODEX_BROKER_ENABLED='1',
               HRC_CLAUDE_CODE_TMUX_BROKER_ENABLED='1')
    db_path = root / 'state/state.sqlite'
    scope = 'agent:tabularasa:project:n1-t11818:task:native-' + str(time.time_ns())
    steps, gates, owners, logs = [{'name':'named-bun-cli','resolvedPath':str(cli.resolve()),'releasePath':str(release)}], {}, [], []
    def command(name, argv, timeout=120):
        run = subprocess.run([str(v) for v in argv], env=env, cwd=project,
                             capture_output=True, text=True, timeout=timeout)
        steps.append({'name': name, 'argv': [str(v) for v in argv], 'exit': run.returncode,
                      'stdout': run.stdout, 'stderr': run.stderr})
        assert run.returncode == 0, (name, run.returncode, run.stdout, run.stderr)
        return json.loads(run.stdout) if run.stdout.strip().startswith(('{', '[')) else run.stdout
    def rows(sql, params=()):
        with sqlite3.connect(f'file:{db_path}?mode=ro', uri=True) as db:
            db.row_factory = sqlite3.Row
            return [dict(row) for row in db.execute(sql, params)]
    def http(method, path, body=None):
        c = UnixHTTP(root / 'run/hrc.sock')
        c.request(method, path, json.dumps(body) if body is not None else None,
                  {'Content-Type': 'application/json'})
        res = c.getresponse()
        raw = res.read().decode()
        c.close()
        return res.status, raw
    def up(kind, index):
        log = (args.artifacts / f'{kind}-{index}.log').open('w')
        logs.append(log)
        argv = [args.binary.resolve(), 'server'] if kind == 'native' else [
            'bun', release / 'packages/hrc-cli/src/cli.ts', 'server', 'serve']
        proc = subprocess.Popen([str(a) for a in argv], env=env, cwd=project, stdout=log, stderr=log)
        owners.append(proc)
        for _ in range(200):
            assert proc.poll() is None, (kind, 'owner exited', proc.returncode)
            try:
                status, raw = http('GET', '/v1/status')
                value = json.loads(raw)
                if status == 200:
                    if kind == 'native':
                        assert Path(value['binaryPath']).resolve() == args.binary.resolve()
                    else:
                        assert Path(value['packagePath']).resolve().is_relative_to(release)
                        assert value['release']['mode'] == 'unmanaged'
                    return proc
            except (OSError, HTTPException):
                pass
            time.sleep(.1)
        raise AssertionError(kind + ' not ready')
    def down(proc):
        proc.send_signal(signal.SIGTERM)
        proc.wait(timeout=20)
        steps.append({'name': 'owner-shutdown', 'pid': proc.pid, 'exit': proc.returncode})
        assert proc.returncode == 0
    def wait_completed(run_id):
        for _ in range(900):
            matches = rows("SELECT * FROM hrc_events WHERE run_id=? AND event_kind='turn.completed'", (run_id,))
            if matches:
                return matches
            time.sleep(.1)
        raise AssertionError('turn did not complete: ' + run_id)
    try:
        command('project-init', ['git', 'init', '-q'])
        command('wrkq-migrate', ['wrkqadm', 'migrate'])
        command('wrkq-project', ['wrkq', 'mkdir', '/n1-t11818', '--kind', 'project', '--json'])
        command('wrkq-root', ['wrkq', 'set', '/n1-t11818', '--root', project, '--json'])
        command('schema-create', ['bun', '-e',
            f'import {{openHrcDatabase}} from {json.dumps(str(release / "packages/hrc-store-sqlite/src/database.ts"))};openHrcDatabase(process.argv[1]).close()', db_path])
        native = up('native', 1)
        start = command('native-ordinary-start', ['hrc', 'start', scope, '--project-id', 'n1-t11818',
                        '--project-root', project, '--cwd', project, '-p',
                        'Reply with exactly the word OK and nothing else. No tools.', '--json'])
        runtime = start['runtime']['runtimeId']
        first_run = start['runtime']['runId']
        assert isinstance(start['runtime']['submissionId'], str) and start['runtime']['submissionId']
        record = rows('SELECT * FROM runtimes WHERE runtime_id=?', (runtime,))[0]
        state = json.loads(record['runtime_state_json'])
        endpoint = state['broker']['endpoint']
        for value in (endpoint['socketPath'], endpoint['attachTokenRef']['path'], state['tmux']['socketPath']):
            assert Path(value).resolve().is_relative_to((root / 'run').resolve()), value
        status = command('native-status', ['hrc', 'server', 'status', '--json'])
        listed = command('native-runtime-list', ['hrc', 'runtime', 'list', '--json'])
        assert status['ok'] is True and any(r['runtimeId'] == runtime for r in listed)
        refs_status, refs_raw = http('GET', '/v1/runtimes/live-refs')
        assert refs_status == 200 and any(r['runtimeId'] == runtime for r in json.loads(refs_raw)['refs'])
        invocation = rows('SELECT * FROM broker_invocations WHERE runtime_id=?', (runtime,))[0]
        assert (invocation.get('last_projected_seq') or 0) == 0
        assert not rows("SELECT * FROM hrc_events WHERE run_id=? AND event_kind='turn.completed'", (first_run,))
        gates['1'] = {'pass': True, 'runtimeId': runtime, 'hostSessionId': record['host_session_id'], 'runId': first_run}
        before_seq = rows('SELECT COALESCE(MAX(hrc_seq),0) AS seq FROM hrc_events')[0]['seq']
        broker_pid = state['broker']['brokerPid']
        down(native)
        os.kill(broker_pid, 0)
        native = up('native', 2)
        reattached = rows('SELECT owner_server_instance_id FROM broker_invocations WHERE runtime_id=?', (runtime,))[0]
        assert reattached['owner_server_instance_id'] == f'hrc-server:{native.pid}', reattached
        assert rows('SELECT runtime_id FROM runtimes WHERE runtime_id=?', (runtime,))[0]['runtime_id'] == runtime
        assert (rows('SELECT last_projected_seq FROM broker_invocations WHERE runtime_id=?', (runtime,))[0]['last_projected_seq'] or 0) == 0
        down(native)
        os.kill(broker_pid, 0)
        gates['4'] = {'pass': True, 'brokerPid': broker_pid, 'runtimeId': runtime}
        bun = up('bun', 1)
        first_events = wait_completed(first_run)
        replay = rows('SELECT * FROM hrc_events WHERE hrc_seq>? ORDER BY hrc_seq', (before_seq,))
        second = command('bun-second-turn', ['hrc', 'start', scope, '--project-id', 'n1-t11818',
                         '--project-root', project, '--cwd', project, '-p',
                         'Reply with exactly the word OK and nothing else. No tools.', '--json'])
        second_run = second['runtime']['runId']
        assert second_run != first_run
        wait_completed(second_run)
        completed = rows("SELECT DISTINCT run_id FROM hrc_events WHERE runtime_id=? AND event_kind='turn.completed'", (runtime,))
        assert len(completed) >= 2 and any(r['run_id'] != first_run for r in completed), completed
        gates['2'] = {'pass': True, 'firstCompleted': first_events, 'replayedEvents': replay,
                      'completedRuns': completed, 'secondTurn': second}
    finally:
        # Every candidate came from our own fresh database. Validate both scope
        # and destination before cleaning only this workflow's tmux servers.
        if db_path.exists():
            for record in rows('SELECT scope_ref,runtime_state_json FROM runtimes'):
                assert record['scope_ref'] == scope, record['scope_ref']
                state = json.loads(record['runtime_state_json'] or '{}')
                path = state.get('tmux', {}).get('socketPath')
                if path:
                    assert Path(path).resolve().is_relative_to((root / 'run').resolve())
                    subprocess.run(['tmux', '-S', path, 'kill-server'], capture_output=True, timeout=5)
        for owner in owners:
            if owner.poll() is None:
                owner.terminate()
                owner.wait(timeout=20)
        for log in logs:
            log.close()
        (args.artifacts / 'results.json').write_text(json.dumps({'gates': gates, 'steps': steps, 'scratchRoot': str(root)}, indent=2) + '\n')
    assert all(gates.get(k, {}).get('pass') for k in ('1', '2', '4'))
    print(json.dumps({'pass': ['1', '2', '4'], 'artifacts': str(args.artifacts)}))


if __name__ == '__main__':
    main()
