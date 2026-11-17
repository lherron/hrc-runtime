#!/usr/bin/env python3
"""A participant broker's hello.release is its runtime's executionRelease (T-13703).

The steer-door gate reads every broker's release from GET /v1/runtimes
runtimeStateJson.executionRelease.sourceCommit. HRC-launched brokers carry the
release aspd prepared; a participant carries what its own broker.hello reports.

Fixture cases (real ASP broker CLI from --broker-module with its idle
noop-driver, release identity handed in the way a release entrypoint does):
  release  hello carries release A: executionRelease is A, source broker.hello.
  respawn  the same seat re-registers onto its runtime (expectedPredecessor)
           behind a broker on release B: the same runtime now reads B.
  none     hello carries no release: executionRelease is absent, never invented.
--real-release adds one case: a participant served by the release-built
harness-broker that the live aspd compile names (n2_participant.attach, one
short claude turn), whose executionRelease.sourceCommit must equal that
release's release.json sourceCommit.

Failure modes: the release is dropped (absent for a release-built broker); an
invented or aspd-shaped record for a broker that reported none; a respawned
broker's newer release not overwriting the old one; a release landing on
another runtime.
"""
import argparse
import json
import subprocess
import uuid
from pathlib import Path
from n2_scratch import Scratch
from n2_participant import register, rows
import n2_participant
import participant_descriptor

A = {'releaseId': 'asp-0123456789ab-20261117T120000Z-aaaaaa',
     'sourceCommit': '0123456789abcdef0123456789abcdef01234567',
     'builtAt': '2026-11-17T12:00:00.000Z'}
B = {'releaseId': 'asp-fedcba987654-20261117T130000Z-bbbbbb',
     'sourceCommit': 'fedcba9876543210fedcba9876543210fedcba98',
     'builtAt': '2026-11-17T13:00:00.000Z'}


def runtime_state(s, rid):
    status, listed = s.http('GET', '/v1/runtimes')
    assert status == 200, listed
    items = listed if isinstance(listed, list) else listed.get('runtimes', listed.get('items', []))
    found = [r for r in items if r.get('runtimeId') == rid]
    assert len(found) == 1, (rid, [r.get('runtimeId') for r in items])
    return found[0]['runtimeStateJson']


def fixture_broker(s, args, name, identity, log, held):
    endpoint = s.root/(name+'.sock')
    if endpoint.exists():
        endpoint.unlink()
    env = dict(s.env)
    env.pop('PARTICIPANT_RELEASE_IDENTITY', None)
    if identity is not None:
        env['PARTICIPANT_RELEASE_IDENTITY'] = json.dumps(identity)
    broker = subprocess.Popen(['bun', str(Path(__file__).with_name('participant_release_broker.mjs')),
        'run', str(args.broker_module), '--transport', 'unix', '--socket', str(endpoint),
        '--event-ledger', str(s.root/(name+'-'+uuid.uuid4().hex[:6]+'.ndjson')), '--join', 'participant-served'],
        env=env, cwd=s.project, stdout=log, stderr=log)
    held.append(broker)
    s.wait(lambda: endpoint.exists() or broker.poll() is not None, 30, name+' broker socket')
    assert broker.poll() is None, name+' broker exited'
    return broker, endpoint


def attach_fixture(s, args, case, joined, name, identity, log, held):
    ident = joined['identity']
    d = participant_descriptor.scratch(joined, s.root)
    spec = d['harnessInvocation']['startRequest']['spec']
    spec['driver']['kind'] = spec['harness']['driver'] = d['brokerDriver'] = 'noop-driver'
    d = participant_descriptor.seal(d)
    broker, endpoint = fixture_broker(s, args, name, identity, log, held)
    body = {k: ident[k] for k in ('registrationId', 'attemptId', 'attachEpoch')}
    body.update(descriptor=d, socketPath=str(endpoint))
    case['attach'] = s.http('POST', '/v1/participants/attach', body)
    assert case['attach'][0] == 200, case['attach']
    s.wait(lambda: s.rows("SELECT 1 FROM participant_registration_attempts WHERE attempt_id=? AND state='ACTIVE' AND establishment_work_state='completed'",
                          (ident['attemptId'],)), 60, name+' participant ACTIVE')
    return broker


def main():
    p = argparse.ArgumentParser(description=__doc__)
    for key in ('binary', 'installed-release', 'aspd-socket', 'scratch-root', 'artifacts', 'broker-module'):
        p.add_argument('--'+key, type=Path, required=True)
    p.add_argument('--real-release', action='store_true')
    args = p.parse_args()
    args.owner = 'native'
    s = Scratch(args.scratch_root, args.installed_release, args.aspd_socket,
                args.binary, args.artifacts, project_id='n2-t13703')
    prefix = 'agent:tabularasa:project:n2-t13703:task:'
    report, held = {'cases': {}}, []
    log = (s.artifacts/'broker.log').open('w')
    owner = None
    try:
        s.init_substrate()
        (s.root/'run/btmux').mkdir()
        owner = s.up('native', 'release')
        cases = report['cases']

        c = cases['release'] = {}
        joined = register(s, prefix+'release', c, single=False)
        rid = joined['identity']['runtimeId']
        first = attach_fixture(s, args, c, joined, 'release', A, log, held)
        c['state'] = runtime_state(s, rid)
        assert c['state'].get('executionRelease') == {'source': 'broker.hello', **A}, c['state'].get('executionRelease')

        c = cases['respawn'] = {}
        s.down(owner)
        first.terminate()
        first.wait(timeout=20)
        owner = s.up('native', 'respawn')
        c['register'] = s.http('POST', '/v1/participants/register', {
            'registrationMode': 'direct', 'requestedSessionRef': prefix+'release',
            'hostIncarnationId': cases['release']['hostIncarnationId'], 'workspaceCwd': str(s.project),
            'expectedPredecessor': {'hostIncarnationId': cases['release']['hostIncarnationId'],
                                    'runtimeId': rid, 'generation': joined['generation']}})
        assert c['register'][0] == 200, c['register']
        again = c['register'][1]
        assert again['identity']['runtimeId'] == rid and again['identity']['attachEpoch'] == 2, again
        attach_fixture(s, args, c, again, 'release', B, log, held)
        c['state'] = runtime_state(s, rid)
        assert c['state'].get('executionRelease') == {'source': 'broker.hello', **B}, c['state'].get('executionRelease')

        c = cases['none'] = {}
        joined = register(s, prefix+'none', c, single=False)
        attach_fixture(s, args, c, joined, 'none', None, log, held)
        c['state'] = runtime_state(s, joined['identity']['runtimeId'])
        assert 'executionRelease' not in c['state'], c['state']['executionRelease']
        assert runtime_state(s, rid)['executionRelease']['sourceCommit'] == B['sourceCommit'], 'no cross-runtime write'

        if args.real_release:
            c = cases['real-release'] = {}
            joined = register(s, prefix+'real', c, single=False)
            box = {}
            n2_participant.attach(s, args, prefix+'real', joined, c, log, box, 'real.sock', single=False)
            held.extend(box.get('brokers', []))
            attempt = s.rows('SELECT state,establishment_work_state FROM participant_registration_attempts WHERE attempt_id=?',
                             (joined['identity']['attemptId'],))[0]
            assert attempt == {'state': 'ACTIVE', 'establishment_work_state': 'completed'}, attempt
            worker = c['compiled']['executionRelease']
            manifest = json.loads((Path(worker['releaseRoot'])/'release.json').read_text())
            c['releaseJson'] = {k: manifest[k] for k in ('releaseId', 'sourceCommit', 'builtAt')}
            c['brokerExecutable'] = worker['worker']['executable']
            c['state'] = runtime_state(s, joined['identity']['runtimeId'])
            got = c['state'].get('executionRelease')
            assert got == {'source': 'broker.hello', **c['releaseJson']}, (got, c['releaseJson'])
            c.pop('compileRequest', None)
            c.pop('durable', None)
        report['pass'] = True
    finally:
        report['final'] = {t: v for t, v in rows(s).items() if t in ('runtimes', 'participant_registration_attempts')}
        (s.artifacts/'result.json').write_text(json.dumps(report, indent=2, default=str)+'\n')
        (s.artifacts/'steps.json').write_text(json.dumps(s.steps, indent=2)+'\n')
        s.cleanup(prefix)
        for attempt in report['final']['participant_registration_attempts']:
            tui = json.loads(attempt.get('realized_hosting_json') or '{}').get('presentation', {}).get('tuiWindow')
            if tui and Path(tui['socketPath']).is_relative_to(s.root/'run'):
                subprocess.run(['tmux', '-S', tui['socketPath'], 'kill-server'], capture_output=True, timeout=5)
        for broker in held:
            if broker.poll() is None:
                broker.terminate()
                broker.wait(timeout=20)
        log.close()
    print(json.dumps({'pass': True, 'artifacts': str(s.artifacts)}))


if __name__ == '__main__':
    main()
