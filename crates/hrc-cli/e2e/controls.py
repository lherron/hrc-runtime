#!/usr/bin/env python3
"""Real owned-seat control commands. No production roots or foreign mutations.
Failure modes: selector/error drift, capture text changed, flags dropped before
RPC, binding fence stale, rotation clears wrong continuity, native execs Bun.
Fresh host/runtime IDs are replaced only after ownership and effects are
asserted. Raw outputs and durable effects accompany those cases.
"""
import json
import subprocess
import uuid
from native_seat import suite, report, refusal


def assert_matrix(out, argv):
    if argv[0:2] in (['runtime', 'capture'], ['capture', 'status']) and len(argv) > 2 and (argv[2].startswith('rt-') and argv[2] != 'rt-missing' or argv[2].startswith('runtime:rt-')):
        assert out['exit'] == 0, (argv, out)
        assert out['stdout'].strip(), out
    else:
        refusal(out, argv)


@suite
def main(f, a):
    results = []
    seat = f.birth()
    rid = seat["runtimeId"]
    env = f.env
    commands = [("subject", [str(a.binary.resolve())])]

    control_verbs = [['runtime', 'capture'], ['runtime', 'interrupt'], ['runtime', 'terminate'], ['capture', 'status'], ['session', 'drop-continuation'], ['session', 'rotate'], ['admin', 'surface', 'bind']]
    cases = []
    for cmd in control_verbs:
        cases.append(cmd)
        for target in ('rt-missing', 'host:hsid-missing', 'wat:foo', 'msg:missing', 'session:bad', 'scope:agent:tabularasa:project:n5-t11819:task:n5-no-runtime'):
            cases.append(cmd + [target])
    cases += [[*cmd, 'wat:foo', '--output', 'json'] for cmd in control_verbs]
    cases += [['runtime', 'capture', rid], ['runtime', 'capture', 'runtime:' + rid], ['capture', 'status', rid], ['capture', 'status', rid, '--json'], ['capture', 'status', 'runtime:' + rid, '--json']]
    cases += [['admin', 'surface', 'bind', rid, '--kind', 'ghostty'], ['admin', 'surface', 'bind', rid, '--id', 'n5-test'], ['admin', 'surface', 'bind', 'rt-missing', '--kind', 'ghostty', '--id', 'n5-test']]
    cases += [['runtime', 'terminate', 'rt-missing', '--drop-continuation', '--no-drop-continuation'], ['runtime', 'terminate', 'rt-missing', '--no-drop-continuation', '--reason', 'proof', '--source', 'n5-test']]
    for argv in cases:
        records = []
        for label, cmd in commands:
            c = subprocess.run(cmd + argv, env=env, capture_output=True, text=True, timeout=30)
            records.append(dict(exit=c.returncode, stdout=c.stdout, stderr=c.stderr))
        assert_matrix(records[0], argv)
        results.append(dict(argv=argv, subject=records[0], **{'pass': True}))

    def call(*values):
        if len(values) > 1 and values[0] in ("GET", "POST"):
            return f.call(values[1], values[2] if len(values) > 2 else None)
        return f.call(*values)
    for verb, flags in [('drop-continuation', []), ('drop-continuation', ['--reason', 'native control proof']), ('rotate', []), ('rotate', ['--relaunch'])]:
        records = []
        raw_records = []
        effects = []
        for label, cmd in commands:
            ref = 'agent:tabularasa:project:n5-t11819:task:n5-control-' + uuid.uuid4().hex + '/lane:main'
            before = call('POST', '/v1/sessions/resolve', {'sessionRef': ref, 'create': True, 'summonIntent': 'explicit_local'})
            hsid = before['hostSessionId']
            argv = ['session', verb, hsid] + flags
            c = subprocess.run(cmd + argv, env=env, capture_output=True, text=True, timeout=30)
            out = dict(exit=c.returncode, stdout=c.stdout, stderr=c.stderr)
            raw_records.append(dict(out))
            after = call('POST', '/v1/sessions/resolve', {'sessionRef': ref})
            effects.append(dict(before=before, after=after))
            if '--relaunch' in flags:
                assert c.returncode == 1 and after['generation'] == 2 and after['hostSessionId'] != hsid
            assert c.returncode == (1 if '--relaunch' in flags else 0), out
            if c.returncode == 0:
                value = json.loads(c.stdout)
                if verb == 'rotate':
                    assert value['generation'] == 2 and value['priorHostSessionId'] == hsid and (after['hostSessionId'] == value['hostSessionId'])
                    out['stdout'] = json.dumps(dict(value, hostSessionId='<successor>', priorHostSessionId='<original>'), sort_keys=True)
                else:
                    assert value == dict(ok=True, hostSessionId=hsid, dropped=False, previousContinuationKey=None) and after['hostSessionId'] == hsid
                    out['stdout'] = json.dumps(dict(value, hostSessionId='<original>'), sort_keys=True)
            records.append(out)
        results.append(dict(argv=['session', verb, '<fresh-owned-host>'] + flags, subject=records[0], subjectRaw=raw_records[0], effects=effects, **{'pass': True}))
    if a.lifecycle:
        surface = 'cli-fixture-' + uuid.uuid4().hex
        try:
            argv = ['admin', 'surface', 'bind', rid, '--kind', 'ghostty', '--id', surface]
            records = []
            for label, cmd in commands:
                c = subprocess.run(cmd + argv, env=env, capture_output=True, text=True, timeout=30)
                records.append(dict(exit=c.returncode, stdout=c.stdout, stderr=c.stderr))
            assert records[0]["exit"] == 0, records[0]
            results.append(dict(argv=argv, subject=records[0], **{'pass': True}))
            (a.artifacts / 'surface-binding.json').write_text(json.dumps(results[-1], indent=2))
        finally:
            bindings = f.s.rows('SELECT * FROM surface_bindings WHERE surface_id=?', (surface,))
            assert len(bindings) == 1 and bindings[0]['runtime_id'] == rid and bindings[0]['unbound_at'] is None, bindings
        for flags in ([], ['--no-drop-continuation'], ['--drop-continuation', '--reason', 'native control proof', '--source', 'n5-test']):
            records = []
            raw_records = []
            effects = []
            interrupts = []
            interrupts_raw = []
            for label, cmd in commands:
                intent = dict(seat['intent'])
                intent.pop('initialPrompt', None)
                ref = 'agent:tabularasa:project:n5-t11819:task:n5-terminate-' + uuid.uuid4().hex + '/lane:main'
                session = call('POST', '/v1/sessions/resolve', {'sessionRef': ref, 'create': True, 'summonIntent': 'explicit_local', 'runtimeIntent': intent})
                runtime = call('POST', '/v1/runtimes/start', {'hostSessionId': session['hostSessionId'], 'intent': intent})
                own = runtime['runtimeId']
                hsid = runtime['hostSessionId']
                argv = ['runtime', 'terminate', own] + flags
                try:
                    interrupt = subprocess.run(cmd + ['runtime', 'interrupt', own], env=env, capture_output=True, text=True, timeout=30)
                    (a.artifacts / ('interrupt-' + label + '-' + own + '.json')).write_text(json.dumps(dict(exit=interrupt.returncode, stdout=interrupt.stdout, stderr=interrupt.stderr), indent=2))
                    assert interrupt.returncode == 0, interrupt.stderr
                    interrupts_raw.append(dict(exit=interrupt.returncode, stdout=interrupt.stdout, stderr=interrupt.stderr))
                    assert json.loads(interrupt.stdout) == dict(ok=True, hostSessionId=hsid, runtimeId=own, warning='no active run to interrupt')
                    interrupts.append(dict(exit=interrupt.returncode, stdout=json.dumps(dict(json.loads(interrupt.stdout), runtimeId='<owned-runtime>', hostSessionId='<owned-host>'), sort_keys=True), stderr=interrupt.stderr))
                    c = subprocess.run(cmd + argv, env=env, capture_output=True, text=True, timeout=60)
                    out = dict(exit=c.returncode, stdout=c.stdout, stderr=c.stderr)
                    raw_records.append(dict(out))
                    inspect = call('POST', '/v1/runtimes/inspect', {'runtimeId': own})
                    events = call('GET', '/v1/events/tail?limit=100&runtimeId=' + own)
                    effects.append(dict(start=runtime, after=inspect, events=events))
                    if '--reason' in flags:
                        assert any(e['eventKind'] == 'runtime.terminated' and e['payload'].get('reason') == 'native control proof' and e['payload'].get('source') == 'n5-test' for e in events['events'])
                    assert c.returncode == 0, out
                    if c.returncode == 0:
                        value = json.loads(c.stdout)
                        assert value['ok'] is True and value['runtimeId'] == own and (value['hostSessionId'] == hsid) and (inspect['status'] == 'terminated')
                        assert value['droppedContinuation'] == ('--drop-continuation' in flags)
                        out['stdout'] = json.dumps(dict(value, runtimeId='<owned-runtime>', hostSessionId='<owned-host>'), sort_keys=True)
                    records.append(out)
                finally:
                    current = call('POST', '/v1/runtimes/inspect', {'runtimeId': own})
                    if current['status'] != 'terminated':
                        call('POST', '/v1/terminate', {'runtimeId': own, 'reason': 'owned N5 control test cleanup'})
                    final = call('POST', '/v1/runtimes/inspect', {'runtimeId': own})
                    assert final['status'] == 'terminated'
            if not flags:
                results.append(dict(argv=['runtime', 'interrupt', '<fresh-owned-runtime>'], subject=interrupts[0], effects=effects, **{'pass': True}))
            results.append(dict(argv=['runtime', 'terminate', '<fresh-owned-runtime>'] + flags, subject=records[0], subjectRaw=raw_records[0], effects=effects, **{'pass': True}))
    return report(a, results)


if __name__ == '__main__':
    raise SystemExit(main())
