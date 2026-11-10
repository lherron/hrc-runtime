"""No-intent session seed and authoritative completion checks shared by two drivers."""
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'crates/hrc-cli/e2e'))
from native_seat import Fixture, arguments, report
from metrics_isolation import isolated_suite


def seed(f, task):
    ref = f.prefix + task + '/lane:main'
    value = f.call('/v1/targets/ensure', dict(sessionRef=ref, runtimeIntent=f.intent, persistIntent=False))
    rows = f.s.rows('SELECT host_session_id,last_applied_intent_json FROM sessions WHERE scope_ref=?', (ref.split('/')[0],))
    assert len(rows) == 1 and rows[0]['last_applied_intent_json'] is None, (value, rows)
    return ref, rows[0]['host_session_id']


def steer(f, ref, prompt='fixture turn CONT', timeout=60):
    return f.s.http('POST', '/v1/submissions/steer', dict(target=ref, body=prompt,
                    origin=dict(principalRef='agent:clod'), wait=True), timeout=timeout)


def refused(f, ref):
    before = f.s.rows('SELECT * FROM runtimes')
    code, value = steer(f, ref)
    assert code == 422 and value['error']['code'] == 'missing_runtime_intent', (code, value)
    assert f.s.rows('SELECT * FROM runtimes') == before
    assert not f.s.rows('SELECT runtime_id FROM runtimes WHERE scope_ref=?', (ref.split('/')[0],))
    return dict(case='missing-intent-refused', status=code, response=value, **{'pass': True})


def completed(f, host, expected_runs, expected='stub ok', timeout=30):
    def finished():
        runs = f.s.rows('SELECT run_id,status FROM runs WHERE host_session_id=? ORDER BY run_id', (host,))
        return len(runs) == expected_runs and all(r['status'] == 'completed' for r in runs)
    f.s.wait(finished, timeout, 'completed turns')
    messages = f.s.rows("SELECT run_id,payload_json FROM hrc_events WHERE host_session_id=? AND event_kind='turn.message' ORDER BY hrc_seq", (host,))
    assert len(messages) == expected_runs and all(expected in r['payload_json'] for r in messages), messages
    return messages
