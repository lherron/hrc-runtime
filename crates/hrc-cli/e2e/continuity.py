#!/usr/bin/env python3
"""Bun creates real continuity and metadata via public APIs. Both CLI binaries
then read the same state against each daemon owner. All state/owners are scratch;
no runtime is created. Missing/ambiguous targets must fail identically too.
"""
import argparse
import http.client
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time

from metrics_isolation import isolated_suite
from copied_release import copied_bun_cli, preflight_unmanaged
from runtime import normalize

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'crates/hrc-native/e2e'))
from foundation import UnixHTTP


@isolated_suite
def main():
    p = argparse.ArgumentParser()
    for flag in ('binary', 'oracle', 'authority', 'artifacts'):
        p.add_argument('--' + flag, type=Path, required=True)
    p.add_argument('--extended', action='store_true', help='also compare native-supported index, placement and maintenance CLI paths')
    args = p.parse_args()
    args.artifacts.mkdir(parents=True, exist_ok=True)
    authority = json.loads(args.authority.read_text())
    assert authority['locator'].startswith('rpc://127.0.0.1:'), 'owned isolated authority required'
    assert not str(args.authority.resolve()).startswith(str(Path.home() / 'praesidium/var'))
    bun = shutil.which('bun')
    results = []
    with tempfile.TemporaryDirectory(prefix='n5-continuity-', dir='/tmp') as temp:
        root = Path(temp)
        env = {k: v for k, v in os.environ.items() if not k.startswith(('ASP_', 'HRC_', 'WRKQ'))}
        env.update(HRC_PEER_CONFIG_FILE=str(root / 'absent-federation.json'), HRC_ACP_WEBHOOK_URL='', WRKQ_DB=authority['locator'], HRC_WRKQ_DB=authority['locator'], HRC_WRKQD_TOKEN_FILE=authority['tokenFile'], WRKQD_TOKEN_FILE=authority['tokenFile'])
        scope = 'agent:tabularasa:project:n5-t11819:task:n5-continuity'
        daemon_oracle = copied_bun_cli(args.oracle, root / 'release')
        proc = None
        def call(method, path, body=None):
            http = UnixHTTP(root / 'run/hrc.sock')
            http.request(method, path, json.dumps(body) if body is not None else None, {'Content-Type': 'application/json'})
            r = http.getresponse()
            value = json.loads(r.read())
            http.close()
            assert r.status == 200, value
            return value
        def up(owner):
            nonlocal proc
            child_env = dict(env, HRC_STATE_DIR=str(root / 'state'), HRC_RUNTIME_DIR=str(root / 'run'))
            log = (args.artifacts / (owner + '.log')).open('w')
            if owner == 'bun':preflight_unmanaged(daemon_oracle, child_env, args.artifacts / 'bun-release-preflight.json')
            command = [bun, str(daemon_oracle), 'server', 'serve'] if owner == 'bun' else [str(args.binary.resolve()), 'server', 'serve']
            proc = subprocess.Popen(command, env=child_env, cwd=root, stdout=log, stderr=log)
            log.close()
            for _ in range(200):
                assert proc.poll() is None, (owner, 'daemon exited; see log')
                try:
                    if call('GET', '/v1/health') == {'ok': True}:
                        if owner == 'bun':assert call('GET','/v1/status')['release']['mode'] != 'atomic'
                        return child_env
                except (OSError, http.client.HTTPException): pass
                time.sleep(.05)
            raise AssertionError('daemon not ready')
        def down():
            if proc is not None and proc.poll() is None:
                proc.terminate()
                proc.wait(timeout=10)
        try:
            child_env = up('bun')
            host = None
            for lane in ('main', 'alternate'):
                row = call('POST', '/v1/sessions/resolve', {'sessionRef': scope + '/lane:' + lane, 'create': True, 'summonIntent': 'explicit_local'})
                if lane == 'main': host = row['hostSessionId']
            metadata = call('PATCH', '/v1/sessions/metadata', {'scopeRef': scope, 'set': {'title': 'Native CLI continuity proof', 'custom.proof': True}})
            assert metadata['metadata']['title'] == 'Native CLI continuity proof', metadata
            down()
            with sqlite3.connect(root / 'state/state.sqlite') as a, sqlite3.connect(root / 'snapshot.sqlite') as b: a.backup(b)
            for owner in ('bun', 'native'):
                if owner == 'native':
                    with sqlite3.connect(root / 'snapshot.sqlite') as a, sqlite3.connect(root / 'state/state.sqlite') as b: a.backup(b)
                child_env = up(owner)
                selectors = [host, 'host:' + host, scope, 'scope:' + scope, 'session:' + scope + '/lane:main', scope + '/lane:main', 'session:' + scope + '/lane:alternate', 'session:' + scope + '/lane:missing', 'hsid-missing', 'runtime:rt-missing', 'msg:missing', 'wat:foo', 'scope:', 'session:bad', 'seq:no']
                cases = [command + [selector] for command in (['session', 'get'], ['session', 'meta', 'get']) for selector in selectors]
                cases += [['session', 'get', selector, '--live'] for selector in (host, 'scope:' + scope, 'session:' + scope + '/lane:alternate')]
                if args.extended:
                    commands = [
                        ['runtime', 'list'], ['runtime', 'list', '--all'],
                        ['runtime', 'list', '--status', 'ready'],
                        ['ls', 'runtimes'], ['list', 'runtimes'], ['ls', 'sessions'],
                        ['session', 'list', '--all'], ['session', 'list', '--porcelain'],
                        ['session', 'list', '--scope', scope],
                        ['session', 'resolve', '--scope', scope],
                        ['session', 'resolve', '--scope', scope, '--lane', 'alternate'],
                        ['target', 'bindings'], ['target', 'locate', 'tabularasa@n5-t11819:n5-continuity'],
                        ['runtime', 'sweep', '--dry-run'], ['runtime', 'prune', '--dry-run'],
                    ]
                    cases += [command + flags for command in commands for flags in ([], ['--json'])]
                    # A nonempty two-lane continuity discriminates an inert fixture.
                    sessions = call('GET', '/v1/sessions?all=true')
                    assert len([row for row in sessions if row['scopeRef'] == scope]) == 2, sessions
                for argv in cases:
                    observed = []
                    for label, command in (('oracle', [bun, str(args.oracle.resolve())]), ('subject', [str(args.binary.resolve())])):
                        command_env = dict(child_env, HRC_STATE_DIR=str(root / 'cli-metrics' / owner / label))
                        if label == 'subject': command_env['PATH'] = str(root / 'no-bun')
                        c = subprocess.run(command + argv, env=command_env, cwd=ROOT, text=True, capture_output=True, timeout=20)
                        observed.append(dict(exit=c.returncode, stdout=c.stdout, stderr=c.stderr))
                    results.append(dict(owner=owner, argv=argv, oracle=observed[0], subject=observed[1], **{'pass': normalize(observed[0]) == normalize(observed[1])}))
                down()
        finally: down()
    report = dict(extended=args.extended, cases=results, **{'pass': sum(r['pass'] for r in results), 'fail': sum(not r['pass'] for r in results)})
    (args.artifacts / 'results.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({k: report[k] for k in ('pass', 'fail')}))
    for r in results:
        if not r['pass']: print('FAIL', r['owner'], r['argv'])
    return int(bool(report['fail']))


if __name__ == '__main__':
    raise SystemExit(main())
