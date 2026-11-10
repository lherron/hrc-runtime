#!/usr/bin/env python3
"""Literal send against owned disposable brokers, with no model dispatch.
Failure modes: input source/UTF-8 drift, wrong caller task, lost option order,
incorrect enter/length, accidental model turn, foreign target, hidden Bun exec.
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
        refusal(records[0], argv)
        results.append(dict(argv=argv, stdin=stdin, subject=records[0], **{'pass': True}))
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
                f.broker(rid)
                turn = call('/v1/turns', dict(hostSessionId=host, prompt='fixture completed turn', runtimeIntent=intent))
                assert turn['runtimeId'] == rid, turn
                f.s.wait_completed(turn['runId'], 30)
                prior_seq = f.s.rows('SELECT MAX(hrc_seq) AS seq FROM hrc_events')[0]['seq']
                try:
                    out = run(label, cmd, ['send', target, ' ', '--json'] + flags)
                    raw.append(dict(out))
                    events = [e for e in call('/v1/events/tail?limit=100&runtimeId=' + rid)['events'] if e['hrcSeq'] > prior_seq]
                    effects.append(dict(runtimeId=rid, hostSessionId=host, events=events))
                    (a.artifacts / (label + '-' + rid + '.json')).write_text(json.dumps(dict(output=out, effects=effects[-1]), indent=2))
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
            results.append(dict(argv=['send', '<fresh-owned-live>', ' ', '--json'] + flags, subject=records[0], subjectRaw=raw[0], effects=effects, **{'pass': True}))
    return report(a, results)


if __name__ == '__main__':
    raise SystemExit(main())
