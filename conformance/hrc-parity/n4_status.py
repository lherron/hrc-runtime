#!/usr/bin/env python3
"""Installed-layout owner provenance and status parity, including object key order.

Failures: a proxy reports Bun paths; a native binary accepts another commit's
manifest; capture changes when a manifest changes; current-link state is stale;
status silently drops or reorders fields. No production release is executed.
"""
import argparse
import json
from pathlib import Path
import shutil
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'crates/hrc-native/e2e'))
from n3_scratch import Scratch

DYNAMIC = {'uptime', 'startedAt', 'processStartedAt', 'maxLagMs', 'maxLagAt', 'sourceCommit',
           'releaseId', 'setVersion', 'builtAt', 'installedAt', 'at', 'probedAt'}


def canonical(v):
    if isinstance(v, dict):
        return [(k, '<dynamic>' if k in DYNAMIC else canonical(x)) for k, x in v.items()]
    if isinstance(v, list):
        return [canonical(x) for x in v]
    return v


def compare(args, checks):
    a = json.loads((Path(args.baseline) / 'status.json').read_text())
    b = json.loads((Path(args.candidate) / 'status.json').read_text())
    checks.append({'id': 'owners', 'pass': a['owner'] == 'bun' and b['owner'] == 'native'
                   and a['ownerVerified'] and b['ownerVerified'], 'reason': 'both own their executable and manifest', 'failureCode': 1})
    checks.append({'id': 'complete', 'pass': a.get('pass') is True and b.get('pass') is True and len(a['cases']) == 6 and set(a['cases']) == set(b['cases']), 'reason': 'all six real-owner cases completed', 'failureCode': 1})
    cases = []
    for case in ('health', 'status', 'status-sessions', 'invalid-sessions', 'captured-release', 'link-moved'):
        passed = canonical(a['cases'][case]) == canonical(b['cases'][case])
        checks.append({'id': case, 'pass': passed, 'reason': 'Bun/native values and recursive key order', 'failureCode': 1})
        cases.append({'id': case, 'pass': passed})
    # Each owner run must exercise the discriminator; a forged candidate must
    # also fail the compare rather than being normalized to a green proxy.
    checks.append({'id': 'native-manifest-control', 'pass': b['manifestControl'],
                   'reason': 'wrong-commit executable cannot start as an atomic release', 'failureCode': 1})
    return {'suite': args.suite, 'cases': cases, 'behaviorQualified': all(c['pass'] for c in checks)}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--owner', choices=['bun', 'native'], required=True)
    p.add_argument('--binary', type=Path, required=True)
    p.add_argument('--installed-release', type=Path, required=True)
    p.add_argument('--aspd-socket', type=Path, required=True)
    p.add_argument('--scratch-root', type=Path, required=True)
    p.add_argument('--artifacts', type=Path, required=True)
    a = p.parse_args()
    a.binary = a.binary.resolve()
    s = Scratch(a.scratch_root, a.installed_release, a.aspd_socket, a.binary, a.artifacts, project_id='n4b-status')
    observations = {'owner': a.owner, 'ownerVerified': False, 'manifestControl': False, 'cases': {}}
    try:
        s.init_substrate()
        manifest = json.loads((s.release / 'praesidium-release.json').read_text())
        if a.owner == 'native':
            build = s.command('binary-identity', [a.binary, '--build-info'])
            if not isinstance(build, dict) or build.get('owner') != 'rusthrc':
                raise AssertionError(('missing native build identity', build))
            manifest['hrcBuild']['sourceCommit'] = build['sourceCommit']
        install = s.root / 'private-install'
        release = install / 'hrc-runtime-releases' / manifest['releaseId']
        release.parent.mkdir(parents=True)
        s.release.rename(release)
        s.release = release
        (release / 'praesidium-release.json').write_text(json.dumps(manifest))
        binary = release / 'bin/rusthrc'
        shutil.copy2(a.binary, binary)
        s.binary = binary.resolve()
        current = install / 'hrc-runtime-current'
        current.symlink_to(release)
        owner = s.up(a.owner, 'installed') if a.owner == 'native' else None
        if a.owner == 'bun':
            # Scratch.up intentionally refuses Bun atomic releases. This is a
            # private install root, pinned by cp -R, never the real install tree.
            log = (a.artifacts / 'bun-installed.log').open('w');s.logs.append(log)
            owner = subprocess.Popen(['bun', str(release / 'packages/hrc-cli/src/cli.ts'), 'server', 'serve'],
                                     cwd=s.project, env=s.env, stdout=log, stderr=log)
            s.owners.append(owner)
            s.wait(lambda: s.socket.exists() or owner.poll() is not None, 30, 'Bun socket')
            assert owner.poll() is None
            s.wait(lambda: s.http('GET', '/v1/health')[0] == 200, 30, 'Bun health')
        time.sleep(1)
        raw = s.http('GET', '/v1/status')[1]
        (a.artifacts / 'raw-status.json').write_text(json.dumps(raw, indent=2)+'\n')
        expected_binary = binary if a.owner == 'native' else release / 'packages/hrc-cli/src/cli.ts'
        expected_package = binary.parent if a.owner == 'native' else release / 'packages/hrc-server'
        assert Path(raw['binaryPath']).resolve() == expected_binary.resolve(), raw
        assert Path(raw['packagePath']).resolve() == expected_package.resolve(), raw
        assert raw['release']['mode'] == 'atomic' and raw['release']['hrcBuild'] == manifest['hrcBuild'], raw['release']
        assert raw['release']['runningEqualsInstalled'] is True, raw['release']
        observations['ownerVerified'] = True

        def normalized(v):
            if isinstance(v, dict):
                return {k: '<owner-binary>' if k == 'binaryPath' else '<owner-package>' if k == 'packagePath' else normalized(x) for k,x in v.items()}
            if isinstance(v, list):return [normalized(x) for x in v]
            if isinstance(v, str):return v.replace(str(release), '<release>').replace(str(s.root), '<scratch>')
            return v
        for name, route in [('health','/v1/health'), ('status','/v1/status'), ('status-sessions','/v1/status?includeSessions=true'),
                            ('invalid-sessions','/v1/status?includeSessions=wrong')]:
            status, body = s.http('GET', route)
            observations['cases'][name] = {'status': status, 'body': normalized(body)}
        manifest['hrcBuild']['sourceCommit'] = '0' * 40
        (release / 'praesidium-release.json').write_text(json.dumps(manifest))
        captured = s.http('GET', '/v1/status')[1]['release']
        assert captured['hrcBuild'] == raw['release']['hrcBuild'], captured
        observations['cases']['captured-release'] = normalized(captured)
        current.unlink()
        moved = s.http('GET', '/v1/status')[1]['release']
        assert moved['runningEqualsInstalled'] is False, moved
        observations['cases']['link-moved'] = normalized(moved)
        s.down(owner)
        if a.owner == 'native':
            refused = s.command('manifest-negative-control', [binary, 'server'], check=False)
            observations['manifestControl'] = 'sourceCommit differs' in s.steps[-1]['stderr'] and s.steps[-1]['exit'] != 0
            assert observations['manifestControl'], refused
        observations['pass'] = True
    finally:
        (a.artifacts / 'status.json').write_text(json.dumps(observations, indent=2)+'\n')
        (a.artifacts / 'drive.json').write_text(json.dumps(s.steps, indent=2)+'\n')
        s.cleanup('agent:tabularasa:project:n4b-status:')
    print(json.dumps({'pass': True, 'owner': a.owner, 'cases': len(observations['cases'])}))

if __name__ == '__main__':main()
