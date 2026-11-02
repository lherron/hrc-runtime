#!/usr/bin/env python3
"""R6/work continuity E2E on an isolated native daemon and private authorities.
Failure inventory: birth policy ignored, task precedence lost, suffix misclassified,
stale work overwrite, failed write ledger pollution, profile refresh lost, work
lost on restart, or projection missing fields. No production files are written.
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import time
import tomllib
from urllib.parse import urlencode

from kernel_fold import substrate, placement_hint
from hrcpty_substrate import AGENT, PROJECT, REPO


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--binary', type=Path, default=REPO / 'crates/target/debug/rusthrc')
    p.add_argument('--artifacts', type=Path, required=True)
    args = p.parse_args()
    root = Path(f'/tmp/hsw-{os.getpid()}')
    assert not root.exists()
    root.mkdir()
    args.artifacts.mkdir(parents=True, exist_ok=True)
    r, aspd, _ = substrate(root, args.artifacts, args.binary.resolve())
    profile = root / 'agents' / AGENT / 'agent-profile.toml'
    profile.write_text('[placement.homes]\nprimary = "hkf"\n')
    original = aspd.handle

    def declaration(method, params):
        out = original(method, params)
        if method == 'aspc.resolveRuntimeDeclaration':
            out['policy'] = {'claimsTask': False, 'placement': tomllib.loads(profile.read_text()).get('placement', {})}
        return out
    aspd.handle = declaration
    scope = f'agent:{AGENT}:project:{PROJECT}:task:primary'
    failure = None

    def state(target=scope):
        status, out = r.http('GET', '/v1/sessions/work?' + urlencode({'scopeRef': target}))
        assert status == 200, out
        return out

    def cli(argv):
        c = subprocess.run([str(args.binary.resolve()), 'seat', 'work'] + argv,
                           env=r.env, cwd=root / PROJECT, capture_output=True, text=True, timeout=20)
        (args.artifacts / 'cli.ndjson').open('a').write(json.dumps({'argv': argv, 'exit': c.returncode, 'stdout': c.stdout, 'stderr': c.stderr}) + '\n')
        return c

    try:
        daemon = r.up('1')
        for task, expected in [('primary', 'standing'), ('primary-nova', 'standing'), ('T-12247', 'task'), ('free', 'adhoc')]:
            target = f'agent:{AGENT}:project:{PROJECT}:task:{task}'
            status, out = r.http('POST', '/v1/sessions/resolve', {'sessionRef': target + '/lane:main', 'create': True,
                                'summonIntent': 'explicit_local', 'runtimeIntent': placement_hint(root)})
            assert status == 200, out
            s = state(target)
            r.check('birth-' + task, s['kind'] == expected and s['work'] == (
                {'kind': 'task', 'taskId': task} if expected == 'task' else {'kind': 'none'}), state=s)
        get = cli(['get', scope])
        assert get.returncode == 0, get.stderr
        r.check('cli-get', json.loads(get.stdout)['workEtag'] == 1)
        put = cli(['set', scope, '--workstream', 'stream-1', '--if-match', '1'])
        assert put.returncode == 0, put.stderr
        r.check('cli-set', json.loads(put.stdout)['workEtag'] == 2)
        stale = cli(['set', scope, '--none', '--if-match', '1'])
        r.check('stale-fence', stale.returncode != 0 and state()['work'] == {'kind': 'workstream', 'workstreamId': 'stream-1'}, stderr=stale.stderr)
        events = r.rows("SELECT * FROM hrc_events WHERE scope_ref=? AND event_kind='session.work.changed'", (scope,))
        r.check('failed-write-no-event', len(events) == 1)
        # T-12360: projection coverage moved to praesidium-kernel; owner
        # state, stale-fence and ledger assertions remain above.
        # Watcher must resolve changed declarations without a new summon.
        time.sleep(.1)
        profile.write_text('[placement.homes]\n')
        r.wait(lambda: state()['kind'] == 'adhoc', 20, 'profile change')
        r.check('profile-refresh-preserves-work', state()['workEtag'] == 2 and state()['work']['kind'] == 'workstream')
        r.down(daemon)
        daemon = r.up('2')
        r.check('restart-preserves-continuity', state() == {'kind': 'adhoc', 'work': {'kind': 'workstream', 'workstreamId': 'stream-1'}, 'workEtag': 2}, state=state())
    except BaseException as e:
        failure = repr(e)
        r.check('harness', False, error=failure)
    finally:
        for proc in r.owners:
            if proc.poll() is None:
                proc.send_signal(signal.SIGTERM)
                try:
                    proc.wait(timeout=30)
                except subprocess.TimeoutExpired:
                    proc.kill()
        aspd.close()
        for log in r.logs:
            log.close()
        passed = bool(r.checks) and all(c['pass'] for c in r.checks)
        (args.artifacts / 'summary.json').write_text(json.dumps({'pass': passed, 'failure': failure, 'checks': r.checks}, indent=2) + '\n')
        shutil.rmtree(root, ignore_errors=True)
    return 0 if passed else 1


if __name__ == '__main__':
    raise SystemExit(main())
