#!/usr/bin/env python3
"""Caller-bound self restart on private wrkqd, with refusal and arm/cancel facts.

A deterministic broker turn replaces the former model sleep. Cancellation
must leave generation/host/runtime unchanged after that turn's terminal fact.
"""
import json
import time
from native_seat import suite, report


@suite
def main(f, a):
    seat = f.birth('n5-restartme-owned')
    scope = {'HRC_SESSION_REF': seat['sessionRef']}
    own = dict(scope, HRC_RUNTIME_ID=seat['runtimeId'])
    invalid = dict(scope, HRC_RUNTIME_ID='../outside')
    results = []

    def handoff(name, ref):
        out = f.run(['handoff', 'create', '--scope', ref, '-t', name, '--body-file', '-'], 'fixture successor context')
        assert out['exit'] == 0, out
        value = json.loads(out['stdout'])
        return value.get('handoff', value)

    acknowledged = handoff('acknowledged', seat['sessionRef'])
    out = f.run(['handoff', 'acknowledge', acknowledged['id'], '--if-match', str(acknowledged['etag']), '--note', 'consumed by fixture'])
    assert out['exit'] == 0, out
    pending = handoff('pending', seat['sessionRef'])
    f.call('/v1/sessions/resolve', dict(sessionRef=f.prefix + 'other/lane:main', create=True, summonIntent='explicit_local'))
    mismatch = handoff('other seat', f.prefix + 'other/lane:main')
    before = f.call('/v1/sessions/resolve', {'sessionRef': seat['sessionRef']})
    probe = f.call('/v1/runtimes/' + seat['runtimeId'] + '/seat')
    assert probe['probe']['seat']['state'] == 'idle', probe
    (a.artifacts / 'seat-before.json').write_text(json.dumps(probe, indent=2))
    cases = [([], {}, 'handoff_required'), (['--handoff', '  '], {}, 'handoff_required'),
             (['--handoff', pending['id']], {}, 'not_an_agent_runtime'),
             (['--cancel', '--handoff', pending['id']], own, 'mutually exclusive'),
             ([], scope, 'handoff_required'),
             (['--handoff', pending['id']], own, 'no_active_turn'),
             (['--handoff', acknowledged['id']], own, 'handoff_not_pending'),
             (['--handoff', mismatch['id']], own, 'handoff_scope_mismatch'),
             (['--handoff', 'H-99999'], own, 'handoff_scope_mismatch'),
             (['--cancel'], own, 'no restart was armed'),
             (['--cancel'], scope, 'credential'), (['--cancel'], invalid, 'credential')]
    cases += [(argv + ['--output', 'json'], context, "--output json is not supported by 'restartme'") for argv, context, _ in cases[:9]]
    for argv, context, expected in cases:
        out = f.run(['restartme', *argv], extra=context)
        assert out['exit'] == (0 if expected == 'no restart was armed' else 2 if 'mutually exclusive' in expected or '--output json' in expected else 1), (argv, out)
        assert expected in out['stdout'] + out['stderr'], (argv, expected, out)
        results.append(dict(argv=['restartme', *argv], context=context, subject=out, expected=expected, **{'pass': True}))

    # The existing broker's HOLD control lasts until interrupt or 120 seconds.
    # Arm/cancel runs during that turn; an interrupt is its terminal fact.
    started = f.call('/v1/turns', dict(hostSessionId=seat['hostSessionId'], prompt='HOLD', runtimeIntent=f.intent))
    f.s.wait(lambda: f.call('/v1/runtimes/' + seat['runtimeId'] + '/seat')['probe']['seat']['state'] == 'turn-active', 10, 'held broker turn')
    try:
        armed = f.run(['restartme', '--handoff', pending['id']], extra=own)
        assert armed['exit'] == 0 and 'restart armed' in armed['stdout'], armed
    finally:
        cancelled = f.run(['restartme', '--cancel'], extra=own)
        assert cancelled['exit'] == 0 and 'restart cancelled' in cancelled['stdout'], cancelled
        f.call('/v1/interrupt', dict(runtimeId=seat['runtimeId']))
    f.s.wait(lambda: f.s.rows("SELECT * FROM hrc_events WHERE run_id=? AND event_kind='turn.completed'", (started['runId'],)), 20, 'held turn terminal')
    time.sleep(.3)
    after = f.call('/v1/sessions/resolve', {'sessionRef': seat['sessionRef']})
    assert (after['hostSessionId'], after['generation']) == (before['hostSessionId'], before['generation']), after
    assert f.call('/v1/runtimes/inspect', {'runtimeId': seat['runtimeId']})['status'] != 'terminated'
    floor = started['observation']['lifecycle']['fromSeq']
    facts = f.s.rows('SELECT event_kind,payload_json FROM hrc_events WHERE hrc_seq>=? AND runtime_id=?', (floor, seat['runtimeId']))
    for kind in ('session.restart_armed', 'session.restart_cancelled'):
        matching = [e for e in facts if e['event_kind'] == kind]
        assert len(matching) == 1, (kind, facts)
        payload = json.loads(matching[0]['payload_json'])
        completed = f.s.rows("SELECT payload_json FROM hrc_events WHERE run_id=? AND event_kind='turn.completed'", (started['runId'],))
        terminal = json.loads(completed[0]['payload_json'])
        assert payload['turnId'] == terminal['turnId'] and payload['turnId'].startswith('cli-turn-'), (payload, terminal)
        assert payload['invocationId'] == terminal['invocationId'] and payload['invocationId'].startswith('inv-'), (payload, terminal)
    assert not any(e['event_kind'] == 'session.restart_executed' for e in facts), facts
    (a.artifacts / 'continuity.json').write_text(json.dumps(dict(before=before, after=after, facts=facts), indent=2))
    results += [dict(case='arm-active', subject=armed, **{'pass': True}), dict(case='cancel-active', subject=cancelled, **{'pass': True})]
    return report(a, results)


if __name__ == '__main__':
    raise SystemExit(main())
