#!/usr/bin/env python3
"""Real owner credential lifecycle: boot backfill, rotation, mint and revocation.

Failure modes: front writes credentials; stale-incarnation values survive;
credential files expose secrets; dead/moved bindings remain deliverable; the
watch subscribes after boot and misses a runtime commit. Only owned disposable
Bun/native daemons and real public runtime APIs are used.
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import uuid

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'crates/hrc-cli/e2e'))
from copied_release import copied_bun_cli, preflight_unmanaged
from metrics_isolation import isolated_suite
from foundation import UnixHTTP


@isolated_suite
def main():
    p = argparse.ArgumentParser()
    for flag in ('binary', 'oracle', 'environment', 'seat', 'artifacts'):
        p.add_argument('--' + flag, type=Path, required=True)
    p.add_argument('--native-lane', default='main')
    a = p.parse_args()
    a.artifacts.mkdir(parents=True, exist_ok=True)
    source = json.loads(a.environment.read_text())
    assert source['HRC_WRKQ_DB'].startswith('rpc://127.0.0.1:')
    assert str(a.environment.resolve()).startswith('/private/tmp/n5-server-owned-11819/')
    env = {k: v for k, v in os.environ.items() if not k.startswith(('ASP_', 'HRC_', 'WRKQ', 'HARNESS_BROKER_'))}
    env.update(source)
    owned = []
    proc = None
    report = {'cases': [], 'deliveries': []}
    with tempfile.TemporaryDirectory(prefix='c-', dir='/tmp/n5-server-owned-11819') as tmp:
        root = Path(tmp)
        env.update(HRC_RUNTIME_DIR=str(root / 'run'), HRC_STATE_DIR=str(root / 'state'))
        oracle = copied_bun_cli(a.oracle, root / 'release')
        bun = shutil.which('bun')
        def call(method, path, body=None):
            h = UnixHTTP(root / 'run/hrc.sock')
            h.request(method, path, json.dumps(body) if body is not None else None,
                      {'Content-Type': 'application/json'})
            r = h.getresponse()
            raw = r.read()
            h.close()
            value = json.loads(raw)
            assert 200 <= r.status < 300, (r.status, value)
            return value
        def up(owner):
            nonlocal proc
            log = (a.artifacts / (owner + '.log')).open('a')
            if owner == 'bun':
                preflight_unmanaged(oracle, env, a.artifacts / 'bun-release-preflight.json')
            command = [bun, str(oracle)] if owner == 'bun' else [str(a.binary.resolve())]
            proc = subprocess.Popen(command + ['server', 'serve'], env=env, cwd=root,
                                    stdin=subprocess.DEVNULL, stdout=log, stderr=log)
            log.close()
            for _ in range(200):
                assert proc.poll() is None, (owner, 'daemon exited; see log')
                try:
                    if call('GET', '/v1/health')['ok']:
                        if owner == 'bun':
                            assert call('GET', '/v1/status')['release']['mode'] != 'atomic'
                        return
                except (OSError, json.JSONDecodeError):
                    pass
                time.sleep(.05)
            raise AssertionError('owned daemon not ready')
        def down():
            if proc is not None and proc.poll() is None:
                proc.terminate()
                proc.wait(timeout=15)
        def credential(rid, different=None):
            path = root / 'run/lifecycle' / (rid + '.credential')
            for _ in range(100):
                if path.exists():
                    value = path.read_bytes().strip()
                    if value != different:
                        assert len(value) == 64 and all(c in b'0123456789abcdef' for c in value)
                        assert stat.S_IMODE(path.stat().st_mode) == 0o600
                        assert stat.S_IMODE(path.parent.stat().st_mode) == 0o700
                        report['deliveries'].append(dict(runtimeId=rid, fileMode=stat.S_IMODE(path.stat().st_mode),
                                                         directoryMode=stat.S_IMODE(path.parent.stat().st_mode), bytes=len(value)))
                        return value
                time.sleep(.03)
            raise AssertionError('credential not freshly delivered for owned runtime ' + rid)
        def start(agent, owner='bun'):
            path = root / 'agents' / agent
            path.mkdir(parents=True, exist_ok=True)
            (path / 'agent-profile.toml').write_text('version = 4\n[identity]\ndisplay = "N5 credential fixture"\n[provisioning]\nharness = "claude"\nyolo = true\n[spaces]\nbase = []\n')
            intent = json.loads(json.dumps(json.loads(a.seat.read_text())['intent']))
            intent.pop('initialPrompt', None)
            intent['placement']['agentRoot'] = str(path)
            intent['placement']['bundle']['agentName'] = agent
            intent['harness']['interactive'] = False
            lane = ('credential-' + uuid.uuid4().hex[:8]) if owner == 'bun' else a.native_lane
            ref = f'agent:{agent}:project:n5-t11819:task:primary/lane:' + lane
            host = call('POST', '/v1/sessions/resolve', dict(sessionRef=ref, create=True,
                         summonIntent='explicit_local', runtimeIntent=intent))['hostSessionId']
            runtime = (call('POST', '/v1/runtimes/start', dict(hostSessionId=host, intent=intent))
                       if owner == 'bun' else call('POST', '/v1/turns', dict(
                           hostSessionId=host, runtimeIntent=intent, prompt='Reply with OK. No tools.', waitFor='accepted')))
            owned.append(runtime['runtimeId'])
            return runtime['runtimeId']
        def passed(name, **data):
            report['cases'].append(dict(case=name, **data, **{'pass': True}))
        try:
            up('bun')
            rid = start('mable')
            original = credential(rid)
            passed('real Bun runtime mints protected credential', runtimeId=rid)
            down()
            up('native')
            first = credential(rid, original)
            passed('native boot backfills and rotates predecessor credential', runtimeId=rid)
            down()
            up('native')
            second = credential(rid, first)
            passed('second native incarnation rotates credential', runtimeId=rid)
            rid2 = start('tabularasa', 'native')
            credential(rid2)
            passed('runtime commit wake mints new binding', runtimeId=rid2)
            for runtime in (rid2, rid):
                call('POST', '/v1/terminate', dict(runtimeId=runtime, reason='owned credential qualification'))
                path = root / 'run/lifecycle' / (runtime + '.credential')
                for _ in range(100):
                    if not path.exists():
                        break
                    time.sleep(.03)
                assert not path.exists(), 'revoked runtime credential still delivered'
                passed('termination commit revokes delivered credential', runtimeId=runtime)
            down()
            directory = root / 'run/lifecycle'
            directory.mkdir(exist_ok=True)
            for name in ('rt-orphan.credential', '.orphan.tmp'):
                (directory / name).write_text('fixture orphan; never an authority')
            assert len(list(directory.iterdir())) == 2
            up('native')
            assert not list(directory.iterdir())
            passed('boot removes orphan credential files')
            report['pass'] = True
        finally:
            if proc is not None and proc.poll() is None:
                for runtime in owned:
                    row = call('POST', '/v1/runtimes/inspect', dict(runtimeId=runtime))
                    if row['status'] != 'terminated':
                        call('POST', '/v1/terminate', dict(runtimeId=runtime, reason='owned credential cleanup'))
            down()
            report['cleanup'] = {'runtimeIds': owned, 'daemonExited': proc is None or proc.poll() is not None,
                                 'socketAbsent': not (root / 'run/hrc.sock').exists(),
                                 'lockAbsent': not (root / 'run/server.lock').exists()}
            (a.artifacts / 'results.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(dict(pass_=report.get('pass', False), cases=len(report['cases']))))
    return int(not report.get('pass', False))


if __name__ == '__main__':
    raise SystemExit(main())
