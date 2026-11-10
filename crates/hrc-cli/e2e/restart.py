#!/usr/bin/env python3
"""Native restart contracts on disposable scratch scopes, never an existing agent seat.
Failure modes: wrong scope, missing generation fence, refusal rotates anyway,
lost launch failure, wrong JSON/exit, old broker retained, silent Bun exec.
Each case gets a fresh host; generation and termination are independently checked.
"""
import json
import subprocess
import uuid
from native_seat import suite, report, refusal



assert_matrix = refusal


@suite
def main(f, a):
    results = []
    seat = f.birth()
    rid = seat["runtimeId"]
    env = f.env
    commands = [("subject", [str(a.binary.resolve())])]

    def run(label, cmd, argv, stdin="", extra=None):
        if isinstance(stdin, dict):
            extra, stdin = stdin, ""
        return f.run(argv, stdin, extra)

    def call(*values):
        if len(values) > 1 and values[0] in ("GET", "POST"):
            return f.call(values[1], values[2] if len(values) > 2 else None)
        return f.call(*values)

    # Observe the real wire shape before constructing any lifecycle fixture.
    missing = call('/v1/sessions/resolve', {'sessionRef': 'agent:tabularasa:project:n5-t11819:task:absent-' + uuid.uuid4().hex + '/lane:main'})
    assert missing['found'] is False, missing
    for argv in (['restart'], ['restart', 'bad:scope'], ['restart', 'tabularasa@n5-t11819:missing-' + uuid.uuid4().hex], ['restart', 'tabularasa@n5-t11819:missing-' + uuid.uuid4().hex, '--json'], ['restart', 'bad:scope', '--output', 'json']):
        records = [run(label, cmd, argv) for label, cmd in commands]
        assert_matrix(records[0], argv)
        results.append(dict(argv=argv, subject=records[0], **{'pass': True}))

    for live in ([False, True] if a.lifecycle else [False]):
        for flags in ([], ['--json'], ['--force', '--json']):
            records, effects, raw = [], [], []
            for label, cmd in commands:
                task = 'n5-restart-' + uuid.uuid4().hex
                target = 'tabularasa@n5-t11819:' + task
                ref = 'agent:tabularasa:project:n5-t11819:task:' + task + '/lane:main'
                intent = dict(seat['intent'])
                intent.pop('initialPrompt', None)
                before = call('/v1/sessions/resolve', dict(sessionRef=ref, create=True, summonIntent='explicit_local', **({'runtimeIntent': intent} if live else {})))
                old_runtime = None
                if live:
                    old_runtime = call('/v1/runtimes/start', {'hostSessionId': before['hostSessionId'], 'intent': intent})['runtimeId']
                    f.broker(old_runtime)
                    turn = call('/v1/turns', dict(hostSessionId=before['hostSessionId'], prompt='fixture completed turn', runtimeIntent=intent))
                    assert turn['runtimeId'] == old_runtime, turn
                    f.s.wait_completed(turn['runId'], 30)
                after = None
                try:
                    out = run(label, cmd, ['restart', target] + flags)
                    raw.append(dict(out))
                    after = call('/v1/sessions/resolve', {'sessionRef': ref})
                    evidence = dict(before=before, after=after, oldRuntimeId=old_runtime)
                    assert after['generation'] == before['generation'] + int(live), (out, evidence)
                    assert (after['hostSessionId'] != before['hostSessionId']) is live, evidence
                    assert out['exit'] == (0 if live else 1), out
                    if '--json' in flags:
                        value = json.loads(out['stdout'])
                        if live:
                            assert value['hostSessionId'] == after['hostSessionId'] and value['generation'] == after['generation'], value
                            assert value['ok'] is True and value['launch']['status'] == 'started', value
                        else:
                            assert value['ok'] is False and value['code'] == 'missing_runtime_intent', value
                    if old_runtime:
                        evidence['oldRuntime'] = call('/v1/runtimes/inspect', {'runtimeId': old_runtime})
                        assert evidence['oldRuntime']['status'] == 'terminated', evidence
                    effects.append(evidence)
                    for key in ('stdout', 'stderr'):
                        out[key] = out[key].replace(target, '<owned-target>')
                        for host in (before['hostSessionId'], after['hostSessionId']):
                            out[key] = out[key].replace(host, '<owned-host>')
                        if '--json' in flags and out['stdout'].strip():
                            value = json.loads(out['stdout'])
                            rid = value.get('launch', {}).get('runtimeId')
                            if rid:
                                out[key] = out[key].replace(rid, '<owned-runtime>')
                        elif live and key == 'stdout' and '  launched ' in out[key]:
                            out[key] = out[key].split('  launched ')[0] + '  launched <owned-runtime>\n'
                    records.append(out)
                finally:
                    hosts = {before['hostSessionId']}
                    if after:
                        hosts.add(after['hostSessionId'])
                    for host in hosts:
                        rows = call('/v1/runtimes?hostSessionId=' + host)
                        assert isinstance(rows, list), rows
                        for row in rows:
                            assert row['hostSessionId'] == host, row
                            if row['status'] != 'terminated':
                                call('/v1/terminate', {'runtimeId': row['runtimeId'], 'reason': 'owned N5 restart test cleanup'})
                            assert call('/v1/runtimes/inspect', {'runtimeId': row['runtimeId']})['status'] == 'terminated'
            results.append(dict(argv=['restart', '<fresh-owned-live>' if live else '<fresh-owned-no-intent>'] + flags, subject=records[0], subjectRaw=raw[0], effects=effects, **{'pass': True}))
    return report(a, results)


if __name__ == '__main__':
    raise SystemExit(main())
