#!/usr/bin/env python3
"""Continuation resume plans/refusals on an owned scratch project.
Failure modes: starting fresh without continuation, wrong predecessor choice,
dry run mutates, wrong prompt length, flags ignored, scope error envelope drift.
"""
import argparse, json, os, shutil, subprocess, sys, uuid
from pathlib import Path
from metrics_isolation import isolated_suite
from runtime import ROOT
sys.path.insert(0, str(ROOT / 'crates/hrc-native/e2e'))
from foundation import UnixHTTP


@isolated_suite
def main():
    p = argparse.ArgumentParser()
    for name in ('binary', 'oracle', 'runtime-root', 'state-root', 'artifacts'):
        p.add_argument('--' + name, type=Path, required=True)
    p.add_argument('--continuation-seat', type=Path)
    a = p.parse_args()
    a.artifacts.mkdir(parents=True, exist_ok=True)
    assert all(root.resolve().is_relative_to(Path('/tmp').resolve()) for root in (a.runtime_root, a.state_root))
    env = {k: v for k, v in os.environ.items() if not k.startswith(('ASP_', 'HRC_', 'WRKQ'))}
    env.update(HRC_RUNTIME_DIR=str(a.runtime_root), HRC_STATE_DIR=str(a.state_root), NO_COLOR='1', FORCE_COLOR='0')
    commands = [('oracle', [shutil.which('bun'), str(a.oracle.resolve())]), ('subject', [str(a.binary.resolve())])]

    def call(path, body=None):
        h = UnixHTTP(a.runtime_root / 'hrc.sock')
        h.request('POST' if body is not None else 'GET', path, json.dumps(body) if body is not None else None, {'Content-Type': 'application/json'})
        response = h.getresponse()
        value = json.loads(response.read())
        h.close()
        assert response.status == 200, value
        return value

    # Observe the real resolve shape, then create only the owned empty session.
    task = 'n5-resume-empty-' + uuid.uuid4().hex
    target = 'tabularasa@n5-t11819:' + task + '+remote=false'
    ref = 'agent:tabularasa:project:n5-t11819:task:' + task + '/lane:main'
    assert call('/v1/sessions/resolve', {'sessionRef': ref})['found'] is False
    created = call('/v1/sessions/resolve', {'sessionRef': ref, 'create': True, 'summonIntent': 'explicit_local'})
    assert created['generation'] == 1 and created['created'] is True
    missing = 'tabularasa@n5-t11819:n5-resume-absent-' + uuid.uuid4().hex + '+remote=false'
    prompt = a.artifacts / 'prompt.txt'
    prompt.write_text('hello 🐈\n')
    cases = [['resume'], ['resume', '--json'], ['resume', ''], ['resume', target, '--prior', '--host-session', created['hostSessionId']], ['resume', target, '--attach-only'], ['resume', target, '--force-restart']]
    for flags in ([], ['--json'], ['--prior'], ['--no-attach'], ['--prior', '--json'], ['--host-session', created['hostSessionId'], '--json']):
        cases.append(['resume', target] + flags)
    cases += [['resume', missing, '--prior'], ['resume', missing, '--prior', '--json'], ['resume', 'bad scope', '--json']]
    for flags in ([], ['--json'], ['--no-attach'], ['--prior'], ['--host-session', created['hostSessionId']], ['--debug'], ['--cwd', str(a.runtime_root.parent / 'project')], ['-p', 'hello 🐈'], ['--prompt-file', str(prompt)], ['--project-id', 'n5-t11819', '--project-root', str(a.runtime_root.parent / 'project')]):
        cases.append(['resume', target, '--dry-run'] + flags)
    cases += [['resume', target, '--dry-run', '-p', 'a', '--prompt-file', str(prompt)], ['resume', target, '--dry-run', '--cwd', 'relative']]
    before = call('/v1/runtimes')
    results = []
    for argv in cases:
        records = []
        for label, cmd in commands:
            c = subprocess.run(cmd + argv, env=env if label == 'oracle' else dict(env, PATH=str(a.artifacts / 'no-bun')), cwd=a.runtime_root.parent / 'project', capture_output=True, text=True, timeout=60)
            records.append(dict(exit=c.returncode, stdout=c.stdout, stderr=c.stderr))
        results.append(dict(argv=argv, oracle=records[0], subject=records[1], **{'pass': records[0] == records[1]}))
    after = call('/v1/sessions/resolve', {'sessionRef': ref})
    assert after['hostSessionId'] == created['hostSessionId'] and after['generation'] == 1, after
    assert [(r['runtimeId'], r['hostSessionId'], r['generation']) for r in before] == [(r['runtimeId'], r['hostSessionId'], r['generation']) for r in call('/v1/runtimes')]
    if a.continuation_seat:
        seed = json.loads(a.continuation_seat.read_text())
        assert ':project:n5-t11819:task:n5-continuation-' in seed['sessionRef']
        continuation = seed['session']['continuation']
        for flags in (['--host-session', seed['hostSessionId']], ['--prior'], []):
            records, raw, effects = [], [], []
            for label, cmd in commands:
                current = call('/v1/sessions/resolve', {'sessionRef': seed['sessionRef']})
                host = current['hostSessionId']
                # Only the selected checkpoint's owned scope can be started.
                assert current['session']['continuation'] == continuation, current
                assert all(row['status'] == 'terminated' for row in call('/v1/runtimes?hostSessionId=' + host))
                argv = ['resume', seed['target'], '--no-attach'] + flags
                c = subprocess.run(cmd + argv, env=env if label == 'oracle' else dict(env, PATH=str(a.artifacts / 'no-bun')), cwd=a.runtime_root.parent / 'project', capture_output=True, text=True, timeout=60)
                out = dict(exit=c.returncode, stdout=c.stdout, stderr=c.stderr)
                raw.append(dict(out))
                successor = call('/v1/sessions/resolve', {'sessionRef': seed['sessionRef']})
                rows = call('/v1/runtimes?hostSessionId=' + successor['hostSessionId'])
                try:
                    (a.artifacts / ('resume-' + label + '-' + str(len(results)) + '.json')).write_text(json.dumps(dict(output=out, before=current, after=successor, runtimes=rows), indent=2))
                    assert out['exit'] == 0, out
                    value = json.loads(out['stdout'])
                    assert value['sessionRef'] == seed['sessionRef'] and value['hostSessionId'] == successor['hostSessionId'] and value['continuation'] == continuation, value
                    assert successor['session']['continuation'] == continuation
                    assert successor['generation'] == current['generation'] + int(successor['hostSessionId'] != host), successor
                    selected = call('/v1/sessions/by-host/' + value['priorHostSessionId'])
                    assert selected['scopeRef'] + '/lane:' + selected['laneRef'] == seed['sessionRef'] and selected['continuation'] == continuation, selected
                    runtime = call('/v1/runtimes/inspect', {'runtimeId': value['runtime']['runtimeId']})
                    assert runtime['hostSessionId'] == successor['hostSessionId'] and runtime['generation'] == successor['generation'] and runtime['status'] not in ('terminated', 'ended', 'dead'), runtime
                    effects.append(dict(before=current, after=successor, selected=selected, runtime=runtime))
                    for stream in ('stdout', 'stderr'):
                        # Replace field values only after their own-scope and
                        # continuation/generation relationships are proven.
                        out[stream] = out[stream].replace(value['hostSessionId'], '<successor-host>').replace(value['priorHostSessionId'], '<continuation-source>').replace(runtime['runtimeId'], '<successor-runtime>')
                    records.append(out)
                finally:
                    for row in rows:
                        assert row['hostSessionId'] == successor['hostSessionId']
                        if row['status'] != 'terminated':
                            call('/v1/terminate', {'runtimeId': row['runtimeId'], 'reason': 'owned N5 resume test cleanup'})
                        assert call('/v1/runtimes/inspect', {'runtimeId': row['runtimeId']})['status'] == 'terminated'
            results.append(dict(argv=['resume', '<owned-checkpoint>', '--no-attach'] + flags, oracle=records[0], subject=records[1], oracleRaw=raw[0], subjectRaw=raw[1], effects=effects, **{'pass': records[0] == records[1]}))
    report = dict(cases=results, created=created, after=after, **{'pass': sum(r['pass'] for r in results), 'fail': sum(not r['pass'] for r in results)})
    (a.artifacts / 'results.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({k: report[k] for k in ('pass', 'fail')}))
    return int(bool(report['fail']))


if __name__ == '__main__':
    raise SystemExit(main())
