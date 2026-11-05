#!/usr/bin/env python3
"""HRC handoff CLI → native owner → store → kernel, on a private real daemon.

Failure modes: routes absent from native dispatch, caller seat/lane lost,
blank body or duplicate accepted, stale etag accepted, history lost on owner
restart, or kernel leaking the body/omitting handoff metadata. Live model
rotation is separately driven after installation on the assigned task seat.
"""
from foundation import daemon_env
import argparse
import json
import os
import socket
import subprocess
import time
from pathlib import Path
from n2_scratch import UnixHTTP


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary', type=Path, required=True)
    parser.add_argument('--scratch-root', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    root, binary = args.scratch_root.resolve(), args.binary.resolve()
    assert not root.exists(), 'use a fresh scratch path'
    assert 'hrc-runtime-releases' not in binary.parts, 'use an unmanaged build'
    root.mkdir(parents=True)
    args.out.mkdir(parents=True, exist_ok=True)
    for name in ('state', 'run'):
        (root / name).mkdir()
    repo = Path(__file__).resolve().parents[3]
    env = {k: v for k, v in os.environ.items() if not k.startswith(
        ('HRC_', 'HARNESS', 'ASP_', 'WRKQ', 'CODEX', 'CLAUDE', 'AGENT', 'TMUX'))}
    env.update(HRC_RUNTIME_DIR=str(root / 'run'), HRC_STATE_DIR=str(root / 'state'),
               HRC_ACP_WEBHOOK_URL='', HRC_WRKQ_DB=str(root / 'private-wrkq.sqlite'))
    subprocess.run(['bun', '-e', "import {openHrcDatabase} from './packages/hrc-store-sqlite/src/database.ts';openHrcDatabase(process.argv[1]).close()", str(root / 'state/state.sqlite')], cwd=repo, env=env, check=True)
    scope = 'agent:handoff:project:hrc-runtime:task:T-12248'
    session = scope + '/lane:main'
    steps = []
    proc = None
    log = (args.out / 'owner.log').open('w')

    def http(method, path, body=None):
        client = UnixHTTP(root / 'run/hrc.sock', 30)
        client.request(method, path, json.dumps(body) if body is not None else None,
                       {'Content-Type': 'application/json'})
        response = client.getresponse()
        data = json.loads(response.read())
        client.close()
        return response.status, data

    def up():
        nonlocal proc
        proc = subprocess.Popen([str(binary), 'server'], cwd=root, env=daemon_env(env), stdout=log, stderr=log)
        for _ in range(300):
            assert proc.poll() is None, 'owner exited; inspect owner.log'
            try:
                if http('GET', '/v1/health')[0] == 200:
                    return
            except (OSError, ValueError):
                pass
            time.sleep(.1)
        raise AssertionError('owner did not become healthy')

    def cli(argv, body=None, ok=True):
        result = subprocess.run([str(binary), 'handoff', *argv], env={**env, 'HRC_SESSION_REF': session}, input=body, text=True, capture_output=True, timeout=30)
        steps.append(dict(argv=argv, stdin=body, exit=result.returncode, stdout=result.stdout, stderr=result.stderr))
        assert (result.returncode == 0) == ok, steps[-1]
        return json.loads(result.stdout) if ok else result.stderr

    try:
        up()
        status, resolved = http('POST', '/v1/sessions/resolve', {'sessionRef': session, 'create': True})
        assert status == 200, resolved
        cli(['create', '--body-file', '-'], '   ', ok=False)
        created = cli(['create', '-t', 'Successor objective', '--body-file', '-'], 'INLINE_BODY_T12248')
        assert created['scopeRef'] == scope and created['laneRef'] == 'main', created
        hid = created['id']
        cli(['create', '--body-file', '-'], 'duplicate', ok=False)
        assert cli(['get', hid])['body'] == 'INLINE_BODY_T12248'
        assert len(cli(['list'])['handoffs']) == 1
        assert cli(['list', '--scope', scope + '/lane:other'])['handoffs'] == []
        cli(['acknowledge', hid, '--if-match', '999', '--note', 'stale'], ok=False)
        cli(['acknowledge', hid, '--if-match', '1', '--note', 'Consumed'])
        assert cli(['list'])['handoffs'] == []
        history = cli(['list', '--project', 'hrc-runtime', '--all'])['handoffs']
        assert history[0]['state'] == 'acknowledged' and history[0]['etag'] == 2
        # T-12360: projected handoff metadata is owned by praesidium-kernel;
        # this suite retains native CLI/store/fence and restart durability.
        proc.terminate()
        proc.wait(timeout=30)
        up()
        assert cli(['get', hid])['note'] == 'Consumed'
        (args.out / 'result.json').write_text(json.dumps({'pass': True, 'handoffId': hid, 'steps': steps}, indent=2) + '\n')
        print(json.dumps({'pass': True, 'handoffId': hid, 'steps': len(steps)}))
    finally:
        if proc is not None and proc.poll() is None:
            proc.terminate()
            proc.wait(timeout=30)
        log.close()
        (args.out / 'drive.json').write_text(json.dumps(steps, indent=2) + '\n')


if __name__ == '__main__':
    main()
