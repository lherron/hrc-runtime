#!/usr/bin/env python3
"""Native no-intent refusal and deterministic revival from stored placement."""
import json
from pathlib import Path
from no_intent_fixture import Fixture, arguments, report, isolated_suite, seed, refused, completed, steer


@isolated_suite
def main():
    p = arguments()
    p.add_argument('--harness-config', type=Path)
    p.add_argument('--aspd-socket', type=Path)
    a = p.parse_args()
    if a.harness_config:
        assert a.aspd_socket and a.aspd_socket.is_socket(), 'explicit compiler socket required'
    else:
        print(json.dumps({'skipped': 'real-harness-revival', 'reason': 'Pass --harness-config and --aspd-socket explicitly for model qualification.'}))
    timeout = 180 if a.harness_config else 30
    with Fixture(a) as f:
        ref, _ = seed(f, 'never-steer')
        results = [refused(f, ref)]
        prompt = 'Reply with exactly the word OK and nothing else. No tools.' if a.harness_config else 'fixture turn CONT'
        if a.harness_config:
            ref = f.prefix + 'revive-steer/lane:main'
            session = f.call('/v1/sessions/resolve', dict(sessionRef=ref, create=True, summonIntent='explicit_local', runtimeIntent=f.intent))
            born = f.call('/v1/turns', dict(hostSessionId=session['hostSessionId'], prompt=prompt, runtimeIntent=f.intent))
            born.update(sessionRef=ref, hostSessionId=session['hostSessionId'])
            f.s.wait_completed(born['runId'], 180)
        else:
            born = f.birth('revive-steer')
        f.call('/v1/terminate', dict(runtimeId=born['runtimeId'], reason='private revival probe'))
        code, value = steer(f, born['sessionRef'], prompt, timeout=timeout)
        assert code in (200, 202), (code, value)
        messages = completed(f, born['hostSessionId'], 2, 'OK' if a.harness_config else 'stub ok', timeout=timeout)
        rows = f.s.rows('SELECT runtime_id,host_session_id,generation,status FROM runtimes WHERE host_session_id=? ORDER BY created_at,runtime_id', (born['hostSessionId'],))
        assert len(rows) == 2 and rows[0]['runtime_id'] == born['runtimeId'] and rows[0]['status'] == 'terminated', rows
        assert rows[1]['runtime_id'] != rows[0]['runtime_id'] and rows[1]['status'] != 'terminated', rows
        session = f.call('/v1/sessions/resolve', dict(sessionRef=born['sessionRef']))['session']
        assert all(r['generation'] == session['generation'] for r in rows), (rows, session)
        results.append(dict(case='stored-intent-revival', response=value, runtimes=rows, messages=messages, **{'pass': True}))
        f.call('/v1/terminate', dict(runtimeId=rows[1]['runtime_id'], reason='CLI revival control'))
        out = f.run(['turn', 'tabularasa@n5-t11819:revive-steer+remote=false', prompt,
                     '--as', 'human', '--wait', 'final', '--timeout', str(timeout) + 's'], timeout=timeout + 30)
        assert out['exit'] == 0, out
        messages = completed(f, born['hostSessionId'], 3, 'OK' if a.harness_config else 'stub ok', timeout=timeout)
        rows = f.s.rows('SELECT runtime_id,host_session_id,generation,status FROM runtimes WHERE host_session_id=? ORDER BY created_at,runtime_id', (born['hostSessionId'],))
        assert len(rows) == 3 and [r['status'] for r in rows[:2]] == ['terminated', 'terminated'], rows
        assert len({r['runtime_id'] for r in rows}) == 3 and rows[-1]['status'] != 'terminated', rows
        results.append(dict(case='cli-stored-intent-revival', output=out, runtimes=rows, messages=messages, **{'pass': True}))
    return report(a, results, realHarness={'skipped': not bool(a.harness_config), 'reason': 'Explicit model harness configured' if a.harness_config else 'No model harness configured; pass --harness-config and --aspd-socket explicitly.'})


if __name__ == '__main__':
    raise SystemExit(main())
