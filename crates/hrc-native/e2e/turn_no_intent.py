#!/usr/bin/env python3
"""Native CLI handoff fallback births the same session and persists its intent."""
from no_intent_fixture import Fixture, arguments, report, isolated_suite, seed, refused, completed
import json


@isolated_suite
def main():
    a = arguments().parse_args()
    with Fixture(a) as f:
        results = []
        for mode, flags in [('wait', ['--wait', 'final', '--timeout', '30s']), ('stream', ['--format', 'ndjson'])]:
            task = 'never-turn-' + mode
            ref, host = seed(f, task)
            results.append(dict(refused(f, ref), mode=mode))
            out = f.run(['turn', 'tabularasa@n5-t11819:' + task + '+remote=false',
                         'fixture turn CONT', '--as', 'human', *flags])
            assert out['exit'] == 0, out
            messages = completed(f, host, 1)
            sessions = f.s.rows('SELECT host_session_id,last_applied_intent_json FROM sessions WHERE scope_ref=?', (ref.split('/')[0],))
            assert len(sessions) == 1 and sessions[0]['host_session_id'] == host, sessions
            stored = json.loads(sessions[0]['last_applied_intent_json'])
            assert stored['placement']['projectRoot'] == str(f.project) and stored['placement']['agentRoot'] == str(f.root / 'agents/tabularasa'), stored
            runtimes = f.s.rows('SELECT runtime_id,host_session_id FROM runtimes WHERE host_session_id=?', (host,))
            assert len(runtimes) == 1 and runtimes[0]['host_session_id'] == host, runtimes
            results.append(dict(case='cli-fallback-same-session', mode=mode, output=out, messages=messages,
                                storedIntent=stored, runtimes=runtimes, **{'pass': True}))
    return report(a, results, drops=['historical base executable and cross-engine comparison; no longer a product contract'])


if __name__ == '__main__':
    raise SystemExit(main())
