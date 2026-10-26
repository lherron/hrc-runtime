#!/usr/bin/env python3
"""Real owned-seat control commands. No production roots or foreign mutations.
Failure modes: selector/error drift, capture text changed, flags dropped before
RPC, binding fence stale, rotation clears wrong continuity, native execs Bun.
Fresh host/runtime IDs are replaced only after ownership and effects are
asserted. Raw outputs accompany those cases; read-only output normalizes only
the explicitly declared clock fields in runtime.py.
"""
import argparse, json, os, shutil, subprocess, sys, uuid
from pathlib import Path
from metrics_isolation import isolated_suite
from runtime import normalize, ROOT
sys.path.insert(0, str(ROOT / 'crates/hrc-native/e2e'))
from foundation import UnixHTTP

@isolated_suite
def main():
    p = argparse.ArgumentParser()
    for name in ('binary', 'oracle', 'runtime-root', 'state-root', 'seat', 'artifacts'):
        p.add_argument('--' + name, type=Path, required=True)
    p.add_argument('--lifecycle', action='store_true', help='also birth disposable runtimes and bind an owned Ghostty surface')
    a = p.parse_args()
    a.artifacts.mkdir(parents=True, exist_ok=True)
    assert a.runtime_root.resolve().is_relative_to(Path('/tmp').resolve())
    assert a.state_root.resolve().is_relative_to(Path('/tmp').resolve())
    seat = json.loads(a.seat.read_text())
    rid = seat['start']['runtimeId']
    env = {k: v for k, v in os.environ.items() if not k.startswith(('ASP_', 'HRC_', 'WRKQ'))}
    env.update(HRC_RUNTIME_DIR=str(a.runtime_root), HRC_STATE_DIR=str(a.state_root), NO_COLOR='1', FORCE_COLOR='0')
    bun = shutil.which('bun')
    results = []
    commands = [['runtime', 'capture'], ['runtime', 'interrupt'], ['runtime', 'terminate'], ['capture', 'status'], ['session', 'drop-continuation'], ['session', 'rotate'], ['admin', 'surface', 'bind']]
    cases = []
    for cmd in commands:
        cases.append(cmd)
        for target in ('rt-missing', 'host:hsid-missing', 'wat:foo', 'msg:missing', 'session:bad', 'scope:agent:tabularasa:project:hrc-runtime:task:n5-no-runtime'):
            cases.append(cmd + [target])
    cases += [[*cmd, 'wat:foo', '--output', 'json'] for cmd in commands]
    cases += [['runtime', 'capture', rid], ['runtime', 'capture', 'runtime:' + rid], ['capture', 'status', rid], ['capture', 'status', rid, '--json'], ['capture', 'status', 'runtime:' + rid, '--json']]
    cases += [['admin', 'surface', 'bind', rid, '--kind', 'ghostty'], ['admin', 'surface', 'bind', rid, '--id', 'n5-test'], ['admin', 'surface', 'bind', 'rt-missing', '--kind', 'ghostty', '--id', 'n5-test']]
    cases += [['runtime', 'terminate', 'rt-missing', '--drop-continuation', '--no-drop-continuation'], ['runtime', 'terminate', 'rt-missing', '--no-drop-continuation', '--reason', 'proof', '--source', 'n5-test']]
    for argv in cases:
        records = []
        for label, cmd in [('oracle', [bun, str(a.oracle.resolve())]), ('subject', [str(a.binary.resolve())])]:
            c = subprocess.run(cmd + argv, env=env if label == 'oracle' else dict(env, PATH=str(a.artifacts / 'no-bun')), capture_output=True, text=True, timeout=30)
            records.append(dict(exit=c.returncode, stdout=c.stdout, stderr=c.stderr))
        results.append(dict(argv=argv, oracle=records[0], subject=records[1], **{'pass': normalize(records[0]) == normalize(records[1])}))

    def call(method, path, body=None):
        h = UnixHTTP(a.runtime_root / 'hrc.sock')
        h.request(method, path, json.dumps(body) if body is not None else None, {'Content-Type': 'application/json'})
        r = h.getresponse()
        v = json.loads(r.read())
        h.close()
        assert r.status == 200, v
        return v
    for verb, flags in [('drop-continuation', []), ('drop-continuation', ['--reason', 'native parity proof']), ('rotate', []), ('rotate', ['--relaunch'])]:
        records = []
        raw_records = []
        effects = []
        for label, cmd in [('oracle', [bun, str(a.oracle.resolve())]), ('subject', [str(a.binary.resolve())])]:
            ref = 'agent:tabularasa:project:hrc-runtime:task:n5-control-' + uuid.uuid4().hex + '/lane:main'
            before = call('POST', '/v1/sessions/resolve', {'sessionRef': ref, 'create': True, 'summonIntent': 'explicit_local'})
            hsid = before['hostSessionId']
            argv = ['session', verb, hsid] + flags
            c = subprocess.run(cmd + argv, env=env if label == 'oracle' else dict(env, PATH=str(a.artifacts / 'no-bun')), capture_output=True, text=True, timeout=30)
            out = dict(exit=c.returncode, stdout=c.stdout, stderr=c.stderr)
            raw_records.append(dict(out))
            after = call('POST', '/v1/sessions/resolve', {'sessionRef': ref})
            effects.append(dict(before=before, after=after))
            if '--relaunch' in flags:
                assert c.returncode == 1 and after['generation'] == 2 and after['hostSessionId'] != hsid
            if c.returncode == 0:
                value = json.loads(c.stdout)
                if verb == 'rotate':
                    assert value['generation'] == 2 and value['priorHostSessionId'] == hsid and (after['hostSessionId'] == value['hostSessionId'])
                    out['stdout'] = json.dumps(dict(value, hostSessionId='<successor>', priorHostSessionId='<original>'), sort_keys=True)
                else:
                    assert value == dict(ok=True, hostSessionId=hsid, dropped=False, previousContinuationKey=None) and after['hostSessionId'] == hsid
                    out['stdout'] = json.dumps(dict(value, hostSessionId='<original>'), sort_keys=True)
            records.append(out)
        results.append(dict(argv=['session', verb, '<fresh-owned-host>'] + flags, oracle=records[0], subject=records[1], oracleRaw=raw_records[0], subjectRaw=raw_records[1], effects=effects, **{'pass': records[0] == records[1]}))
    if a.lifecycle:
        surface = json.loads(subprocess.check_output(['ghostmux', 'new', '--json', '--title', 'n5-control-bind', '--cwd', str(a.runtime_root.parent / 'project')], text=True))['id']
        try:
            argv = ['admin', 'surface', 'bind', rid, '--kind', 'ghostty', '--id', surface]
            records = []
            for label, cmd in [('oracle', [bun, str(a.oracle.resolve())]), ('subject', [str(a.binary.resolve())])]:
                c = subprocess.run(cmd + argv, env=env if label == 'oracle' else dict(env, PATH=str(a.artifacts / 'no-bun')), capture_output=True, text=True, timeout=30)
                records.append(dict(exit=c.returncode, stdout=c.stdout, stderr=c.stderr))
            results.append(dict(argv=argv, oracle=records[0], subject=records[1], **{'pass': normalize(records[0]) == normalize(records[1])}))
            (a.artifacts / 'surface-binding.json').write_text(json.dumps(results[-1], indent=2))
        finally:
            call('POST', '/v1/surfaces/unbind', {'surfaceKind': 'ghostty', 'surfaceId': surface, 'reason': 'owned N5 control test cleanup'})
            subprocess.run(['ghostmux', 'kill-surface', '-t', surface, '--force'], check=True, capture_output=True, text=True)
        for flags in ([], ['--no-drop-continuation'], ['--drop-continuation', '--reason', 'native control parity', '--source', 'n5-test']):
            records = []
            raw_records = []
            effects = []
            interrupts = []
            for label, cmd in [('oracle', [bun, str(a.oracle.resolve())]), ('subject', [str(a.binary.resolve())])]:
                intent = dict(seat['intent'])
                intent.pop('initialPrompt', None)
                ref = 'agent:tabularasa:project:hrc-runtime:task:n5-terminate-' + uuid.uuid4().hex + '/lane:main'
                session = call('POST', '/v1/sessions/resolve', {'sessionRef': ref, 'create': True, 'summonIntent': 'explicit_local', 'runtimeIntent': intent})
                runtime = call('POST', '/v1/runtimes/start', {'hostSessionId': session['hostSessionId'], 'intent': intent})
                own = runtime['runtimeId']
                hsid = runtime['hostSessionId']
                argv = ['runtime', 'terminate', own] + flags
                try:
                    interrupt = subprocess.run(cmd + ['runtime', 'interrupt', own], env=env if label == 'oracle' else dict(env, PATH=str(a.artifacts / 'no-bun')), capture_output=True, text=True, timeout=30)
                    (a.artifacts / ('interrupt-' + label + '-' + own + '.json')).write_text(json.dumps(dict(exit=interrupt.returncode, stdout=interrupt.stdout, stderr=interrupt.stderr), indent=2))
                    assert interrupt.returncode == 0, interrupt.stderr
                    assert json.loads(interrupt.stdout) == dict(ok=True, hostSessionId=hsid, runtimeId=own)
                    interrupts.append(dict(exit=interrupt.returncode, stdout=json.dumps(dict(json.loads(interrupt.stdout), runtimeId='<owned-runtime>', hostSessionId='<owned-host>'), sort_keys=True), stderr=interrupt.stderr))
                    c = subprocess.run(cmd + argv, env=env if label == 'oracle' else dict(env, PATH=str(a.artifacts / 'no-bun')), capture_output=True, text=True, timeout=60)
                    out = dict(exit=c.returncode, stdout=c.stdout, stderr=c.stderr)
                    raw_records.append(dict(out))
                    inspect = call('POST', '/v1/runtimes/inspect', {'runtimeId': own})
                    events = call('GET', '/v1/events/tail?limit=100&runtimeId=' + own)
                    effects.append(dict(start=runtime, after=inspect, events=events))
                    if '--reason' in flags:
                        assert any(e['eventKind'] == 'runtime.terminated' and e['payload'].get('reason') == 'native control parity' and e['payload'].get('source') == 'n5-test' for e in events['events'])
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
                results.append(dict(argv=['runtime', 'interrupt', '<fresh-owned-runtime>'], oracle=interrupts[0], subject=interrupts[1], **{'pass': interrupts[0] == interrupts[1]}))
            results.append(dict(argv=['runtime', 'terminate', '<fresh-owned-runtime>'] + flags, oracle=records[0], subject=records[1], oracleRaw=raw_records[0], subjectRaw=raw_records[1], effects=effects, **{'pass': records[0] == records[1]}))
    report = dict(cases=results, **{'pass': sum((r['pass'] for r in results)), 'fail': sum((not r['pass'] for r in results))})
    (a.artifacts / 'results.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({k: report[k] for k in ('pass', 'fail')}))
    return int(bool(report['fail']))
if __name__ == '__main__':
    raise SystemExit(main())
