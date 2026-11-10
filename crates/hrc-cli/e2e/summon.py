#!/usr/bin/env python3
"""Strict target materialization, on unique scratch project/scopes only.
Failure modes: advisory drift on a birth, wrong intent mode/caller task,
lost directives, duplicate sessions, human/JSON drift, silent Bun fallback.
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

    # Inspect the real daemon before declaring any materialization fixture.
    assert isinstance(call('/v1/runtimes'), list)
    for argv in (['summon'], ['summon', ''], ['summon', 'bad:scope'], ['summon', 'n5-missing-agent@n5-t11819:missing'], ['summon', 'tabularasa@n5-t11819:missing+yolo=true'], ['summon', 'tabularasa@n5-t11819:missing+nope=value']):
        for flags in ([], ['--output', 'json']):
            records = [run(label, cmd, argv + flags) for label, cmd in commands]
            assert_matrix(records[0], argv + flags)
            results.append(dict(argv=argv + flags, subject=records[0], **{'pass': True}))
    for flags, bare in (([], False), (['--json'], False), (['--json'], True)):
        records, raw, effects = [], [], []
        for label, cmd in commands:
            task = 'n5-summon-' + uuid.uuid4().hex
            ref = 'agent:tabularasa:project:n5-t11819:task:' + task + '/lane:main'
            target = 'tabularasa' if bare else 'tabularasa@n5-t11819:' + task + '+remote=false'
            extra = dict(ASP_PROJECT='n5-t11819', HRC_SESSION_REF='agent:cody:project:n5-t11819:task:' + task + '/lane:main') if bare else {}
            out = run(label, cmd, ['summon', target] + flags, extra)
            raw.append(dict(out))
            resolved = call('/v1/sessions/resolve', {'sessionRef': ref})
            rows = []
            try:
                assert out['exit'] == 0 and resolved['found'] is True, (out, resolved)
                assert resolved['identity']['taskId'] == task, resolved
                host = resolved['hostSessionId']
                rows = call('/v1/runtimes?hostSessionId=' + host)
                assert rows == [], rows  # summon materializes; it does not launch a turn
                started = call('/v1/turns', dict(hostSessionId=host, prompt='summon fixture turn', runtimeIntent=f.intent))
                f.s.wait_completed(started['runId'], 30)
                f.broker(started['runtimeId'])
                rows = call('/v1/runtimes?hostSessionId=' + host)
                assert len(rows) == 1 and rows[0]['hostSessionId'] == host, rows
                if '--json' not in flags:
                    assert out['stdout'].startswith('Summoned: ' + ref), out
                if '--json' in flags:
                    value = json.loads(out['stdout'])
                    assert value['sessionRef'] == ref and value['activeHostSessionId'] == host and value['generation'] == 1, value
                for key in ('stdout', 'stderr'):
                    out[key] = out[key].replace(ref, '<owned-session>').replace(host, '<owned-host>')
                    for row in rows:
                        out[key] = out[key].replace(row['runtimeId'], '<owned-runtime>')
                    out[key] = out[key].replace(task, '<owned-task>')
                effects.append(dict(resolved=resolved, runtimes=rows))
                records.append(out)
            finally:
                for row in rows:
                    if row['status'] != 'terminated':
                        call('/v1/terminate', {'runtimeId': row['runtimeId'], 'reason': 'owned N5 summon test cleanup'})
                    assert call('/v1/runtimes/inspect', {'runtimeId': row['runtimeId']})['status'] == 'terminated'
        results.append(dict(argv=['summon', '<caller-task>' if bare else '<fresh-owned-scope>'] + flags, subject=records[0], subjectRaw=raw[0], effects=effects, **{'pass': True}))
    return report(a, results)


if __name__ == '__main__':
    raise SystemExit(main())
