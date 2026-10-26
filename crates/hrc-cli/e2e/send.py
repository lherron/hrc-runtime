#!/usr/bin/env python3
"""Literal send against owned disposable brokers, with no model dispatch.
Failure modes: input source/UTF-8 drift, wrong caller task, lost option order,
incorrect enter/length, accidental model turn, foreign target, hidden Bun exec.
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
    for name in ('binary', 'oracle', 'runtime-root', 'state-root', 'seat', 'artifacts'):
        p.add_argument('--' + name, type=Path, required=True)
    p.add_argument('--lifecycle', action='store_true')
    a = p.parse_args()
    a.artifacts.mkdir(parents=True, exist_ok=True)
    assert all(root.resolve().is_relative_to(Path('/tmp').resolve()) for root in (a.runtime_root, a.state_root))
    seat = json.loads(a.seat.read_text())
    env = {k: v for k, v in os.environ.items() if not k.startswith(('ASP_', 'HRC_', 'WRKQ'))}
    env.update(HRC_RUNTIME_DIR=str(a.runtime_root), HRC_STATE_DIR=str(a.state_root), NO_COLOR='1', FORCE_COLOR='0')
    commands = [('oracle', [shutil.which('bun'), str(a.oracle.resolve())]), ('subject', [str(a.binary.resolve())])]
    native = next(row for row in json.loads((ROOT / 'crates/hrc-cli/command-scope.json').read_text())['commands'] if row['command'] == 'send')['implementation'] == 'native'
    results = []

    def run(label, cmd, argv, stdin=''):
        c = subprocess.run(cmd + argv, cwd=a.runtime_root.parent / 'project', env=env if label == 'oracle' else dict(env, PATH=str(a.artifacts / 'no-bun')), input=stdin, capture_output=True, text=True, timeout=60)
        return dict(exit=c.returncode, stdout=c.stdout, stderr=c.stderr)

    def call(path, body=None):
        h = UnixHTTP(a.runtime_root / 'hrc.sock')
        h.request('POST' if body is not None else 'GET', path, json.dumps(body) if body is not None else None, {'Content-Type': 'application/json'})
        response = h.getresponse()
        value = json.loads(response.read())
        h.close()
        assert response.status == 200, value
        return value

    assert isinstance(call('/v1/runtimes'), list)
    target = 'tabularasa@n5-t11819:missing-' + uuid.uuid4().hex
    file = a.artifacts / 'body.txt'
    file.write_bytes(b'\xff body\n')
    empty = a.artifacts / 'empty.txt'
    empty.write_text('')
    cases = [(['send'], ''), (['send', '', 'body'], ''), (['send', target], ''), (['send', target, ''], ''), (['send', target, '-'], ''), (['send', target, '-'], 'stdin text\n'), (['send', target, 'body'], ''), (['send', 'bad:scope', 'body'], ''), (['send', target, '--file', str(file)], ''), (['send', target, 'positional ignored', '--file', str(empty)], ''), (['send', target, '--file', str(a.artifacts / 'absent.txt')], '')]
    cases += [(argv + ['--output', 'json'], stdin) for argv, stdin in cases[1:]]
    for argv, stdin in cases:
        records = [run(label, cmd, argv, stdin) for label, cmd in commands]
        results.append(dict(argv=argv, stdin=stdin, oracle=records[0], subject=records[1], **{'pass': records[0] == records[1]}))
    if a.lifecycle:
        # A whitespace-only Enter is a broker no-op; no-enter is buffered.
        for flags, enter in (([], True), (['--no-enter'], False), (['--enter', '--no-enter'], False), (['--no-enter', '--enter'], True)):
            records, raw, effects = [], [], []
            for label, cmd in commands:
                task = 'n5-send-' + uuid.uuid4().hex
                target = 'tabularasa@n5-t11819:' + task
                ref = 'agent:tabularasa:project:n5-t11819:task:' + task + '/lane:main'
                intent = dict(seat['intent'])
                intent.pop('initialPrompt', None)
                host = call('/v1/sessions/resolve', dict(sessionRef=ref, create=True, summonIntent='explicit_local', runtimeIntent=intent))['hostSessionId']
                rid = call('/v1/runtimes/start', {'hostSessionId': host, 'intent': intent})['runtimeId']
                try:
                    out = run(label, cmd, ['send', target, ' ', '--json'] + flags)
                    raw.append(dict(out))
                    events = call('/v1/events/tail?limit=100&runtimeId=' + rid)['events']
                    effects.append(dict(runtimeId=rid, hostSessionId=host, events=events))
                    (a.artifacts / (label + '-' + rid + '.json')).write_text(json.dumps(dict(output=out, effects=effects[-1]), indent=2))
                    if label == 'oracle' or native:
                        assert out['exit'] == 0, out
                        value = json.loads(out['stdout'])
                        assert value['delivered'] is True and value['sessionRef'] == ref and value['runtimeId'] == rid and value['hostSessionId'] == host, value
                        literal = [e for e in events if e['eventKind'] == 'target.literal-input']
                        assert len(literal) == 1 and literal[0]['payload']['enter'] is enter and literal[0]['payload']['payloadLength'] == (0 if enter else 1), literal
                        assert not any(e['eventKind'] == 'turn.started' for e in events), events
                    for key in ('stdout', 'stderr'):
                        for old, new in ((ref, '<owned-session>'), (rid, '<owned-runtime>'), (host, '<owned-host>')):
                            out[key] = out[key].replace(old, new)
                    records.append(out)
                finally:
                    call('/v1/terminate', {'runtimeId': rid, 'reason': 'owned N5 send test cleanup'})
                    assert call('/v1/runtimes/inspect', {'runtimeId': rid})['status'] == 'terminated'
            results.append(dict(argv=['send', '<fresh-owned-live>', ' ', '--json'] + flags, oracle=records[0], subject=records[1], oracleRaw=raw[0], subjectRaw=raw[1], effects=effects, **{'pass': records[0] == records[1]}))
    report = dict(cases=results, **{'pass': sum(r['pass'] for r in results), 'fail': sum(not r['pass'] for r in results)})
    (a.artifacts / 'results.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({k: report[k] for k in ('pass', 'fail')}))
    return int(bool(report['fail']))


if __name__ == '__main__':
    raise SystemExit(main())
