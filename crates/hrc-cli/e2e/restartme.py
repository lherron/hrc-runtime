#!/usr/bin/env python3
"""Self-restart parity on an owned runtime and isolated wrkq authority.
Failure modes: wrong caller/scope/handoff status; escaping credential root;
arming an idle turn; missing/rejected credentials; incorrect arm/cancel output;
rotation after cancellation; shelling to Bun. Never use a production seat.
"""
import argparse, json, os, shutil, subprocess, sys, time
from pathlib import Path
from metrics_isolation import isolated_suite
from runtime import ROOT
sys.path.insert(0, str(ROOT / 'crates/hrc-native/e2e'))
from foundation import UnixHTTP


@isolated_suite
def main():
    p = argparse.ArgumentParser()
    for name in ('binary', 'oracle', 'runtime-root', 'state-root', 'seat', 'artifacts', 'token-file'):
        p.add_argument('--' + name, type=Path, required=True)
    p.add_argument('--wrkq-db', required=True)
    p.add_argument('--active-turn', action='store_true')
    a = p.parse_args()
    assert all(path.resolve().is_relative_to(Path('/tmp').resolve()) for path in (a.runtime_root, a.state_root, a.token_file))
    assert a.wrkq_db.startswith('rpc://127.0.0.1:')
    seat = json.loads(a.seat.read_text())
    assert ':project:n5-t11819:task:n5-restartme-' in seat['sessionRef']
    a.artifacts.mkdir(parents=True, exist_ok=True)
    safe = a.artifacts / 'no-bun'
    safe.mkdir(exist_ok=True)
    if not (safe / 'wrkq').exists():
        (safe / 'wrkq').symlink_to(Path(seat['wrkq']).resolve())
    env = {k: v for k, v in os.environ.items() if not k.startswith(('ASP_', 'HRC_', 'WRKQ'))}
    env.update(HRC_RUNTIME_DIR=str(a.runtime_root), HRC_STATE_DIR=str(a.state_root), WRKQ_DB=a.wrkq_db, HRC_WRKQ_DB=a.wrkq_db, WRKQD_TOKEN_FILE=str(a.token_file), HRC_WRKQD_TOKEN_FILE=str(a.token_file), NO_COLOR='1', FORCE_COLOR='0')
    commands = [('oracle', [shutil.which('bun'), str(a.oracle.resolve())]), ('subject', [str(a.binary.resolve())])]
    scope = {'HRC_SESSION_REF': seat['sessionRef']}
    own = dict(scope, HRC_RUNTIME_ID=seat['runtimeId'])
    invalid = dict(scope, HRC_RUNTIME_ID='../outside')
    results = []

    def call(path, body=None):
        h = UnixHTTP(a.runtime_root / 'hrc.sock')
        h.request('POST' if body is not None else 'GET', path, json.dumps(body) if body is not None else None, {'Content-Type': 'application/json'})
        r = h.getresponse()
        value = json.loads(r.read())
        h.close()
        assert 200 <= r.status < 300, value
        return value

    def run(label, cmd, argv, context):
        child_env = dict(env, **context)
        if label == 'subject':
            child_env['PATH'] = str(safe)
        c = subprocess.run(cmd + ['restartme'] + argv, env=child_env, cwd=a.runtime_root.parent / 'project', capture_output=True, text=True, timeout=25)
        return dict(exit=c.returncode, stdout=c.stdout, stderr=c.stderr)

    # Observe real caller and seat before issuing commands or constructing a turn.
    status = call('/v1/status')
    assert Path(status['runtimeRoot']).resolve() == a.runtime_root.resolve()
    before = call('/v1/sessions/resolve', {'sessionRef': seat['sessionRef']})
    assert before['hostSessionId'] == seat['hostSessionId']
    probe = call('/v1/runtimes/' + seat['runtimeId'] + '/seat')
    (a.artifacts / 'seat-before.json').write_text(json.dumps(probe, indent=2))
    for _ in range(180):
        if probe['probe']['seat']['state'] == 'idle':
            break
        time.sleep(.5)
        probe = call('/v1/runtimes/' + seat['runtimeId'] + '/seat')
    else:
        raise AssertionError(probe)
    cases = [([], {}, 'handoff_required'), (['--handoff', '  '], {}, 'handoff_required'), (['--handoff', seat['pending']], {}, 'not_an_agent_runtime'), (['--cancel', '--handoff', seat['pending']], own, 'mutually exclusive'), ([], scope, 'tabularasa@n5-t11819'), (['--handoff', seat['pending']], own, 'no_active_turn'), (['--handoff', seat['acknowledged']], own, 'handoff_not_pending'), (['--handoff', seat['mismatch']], own, 'handoff_scope_mismatch'), (['--handoff', 'H-99999'], own, 'could not read handoff'), (['--cancel'], own, 'no restart was armed'), (['--cancel'], scope, 'credential'), (['--cancel'], invalid, 'credential')]
    cases += [(argv + ['--output', 'json'], context, "--output json is not supported by 'restartme'") for argv, context, expected in cases[:9]]
    for argv, context, expected in cases:
        observed = [run(label, cmd, argv, context) for label, cmd in commands]
        assert expected in observed[0]['stdout'] + observed[0]['stderr'], (argv, observed[0])
        results.append(dict(argv=['restartme'] + argv, context=context, oracle=observed[0], subject=observed[1], **{'pass': observed[0] == observed[1]}))

    if a.active_turn:
        # One real model turn, both subjects arm and immediately cancel before
        # its terminal event. No credential value is captured in artifacts.
        started = call('/v1/turns', dict(hostSessionId=seat['hostSessionId'], prompt='Use the Bash tool to run /bin/sleep 30, then reply with exactly OK. Do not use any other tools.', runtimeIntent=seat['intent']))
        (a.artifacts / 'turn-start.json').write_text(json.dumps(started, indent=2))
        for _ in range(100):
            probe = call('/v1/runtimes/' + seat['runtimeId'] + '/seat')
            if probe['probe']['seat']['state'] == 'turn-active':
                break
            time.sleep(.1)
        else:
            raise AssertionError(probe)
        (a.artifacts / 'seat-active.json').write_text(json.dumps(probe, indent=2))
        paired = [[], []]
        for label, cmd in commands:
            try:
                armed = run(label, cmd, ['--handoff', seat['pending']], own)
                assert armed['exit'] == 0 and 'restart armed' in armed['stdout'], armed
            finally:
                cancelled = run(label, cmd, ['--cancel'], own)
                assert cancelled['exit'] == 0 and 'restart cancelled' in cancelled['stdout'], cancelled
            paired[0].append(armed)
            paired[1].append(cancelled)
        for label, values in zip(('arm-active', 'cancel-active'), paired):
            results.append(dict(case=label, oracle=values[0], subject=values[1], **{'pass': values[0] == values[1]}))
        for _ in range(180):
            events = call('/v1/events/tail?limit=200&runId=' + started['runId'])
            if any(e['eventKind'] == 'turn.completed' for e in events['events']):
                break
            time.sleep(.5)
        assert any(e['eventKind'] == 'turn.completed' and e['payload']['success'] is True for e in events['events']), events
        ledger = call('/v1/events/tail?limit=200&hostSessionId=' + seat['hostSessionId'])
        (a.artifacts / 'events.json').write_text(json.dumps(ledger, indent=2))
        for kind in ('session.restart_armed', 'session.restart_cancelled'):
            assert sum(e['eventKind'] == kind for e in ledger['events']) == 2, ledger
        after = call('/v1/sessions/resolve', {'sessionRef': seat['sessionRef']})
        assert after['hostSessionId'] == before['hostSessionId'] and after['generation'] == before['generation']
        assert call('/v1/runtimes/inspect', {'runtimeId': seat['runtimeId']})['status'] != 'terminated'
        (a.artifacts / 'continuity.json').write_text(json.dumps(dict(before=before, after=after), indent=2))
    report = dict(cases=results, **{'pass': sum(x['pass'] for x in results), 'fail': sum(not x['pass'] for x in results)})
    (a.artifacts / 'results.json').write_text(json.dumps(report, indent=2))
    print(json.dumps({k: report[k] for k in ('pass', 'fail')}))
    assert report['fail'] == 0


if __name__ == '__main__':
    main()
