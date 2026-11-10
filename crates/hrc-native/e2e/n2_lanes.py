#!/usr/bin/env python3
"""N2 non-main lane on rusthrc.

A seat on lane `side` is born through `hrc start <handle>~side`, then a warm
/v1/turns turn and a capture-by-selector address it. The warm turn must
complete, the selector must echo `<scope>/lane:side`, the session view must
report the canonical laneRef `lane:side`, and every stored lane_ref (sessions, continuities,
runtimes, runs, hrc_events, first-turn watch) must be the raw lane `side`.
Failure modes: the API's canonical `lane:side` written into rows or used as a
SQL predicate (404 unknown_host_session on the warm turn), and a doubled
`lane:lane:side` selector.
"""
import argparse
import json
from pathlib import Path

from n2_scratch import Scratch

PROMPT = 'Reply with exactly the word OK and nothing else. No tools.'


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--binary', type=Path, required=True)
    p.add_argument('--installed-release', type=Path, required=True)
    p.add_argument('--aspd-socket', type=Path, required=True)
    p.add_argument('--scratch-root', type=Path, required=True)
    p.add_argument('--artifacts', type=Path, required=True)
    args = p.parse_args()
    s = Scratch(args.scratch_root, args.installed_release, args.aspd_socket, args.binary, args.artifacts)
    prefix = 'agent:tabularasa:project:n2-t11823:task:'
    task = 'lanes'
    out = {}
    try:
        s.init_substrate()
        s.up('native', 'lanes')
        cold = s.command('cold-start', ['hrc', 'start', f'tabularasa@{s.project_id}:{task}~side', '--project-id', s.project_id,
                                        '--project-root', s.project, '--cwd', s.project, '--json', '-p', PROMPT])
        host = cold['hostSessionId']
        s.wait_completed(cold['runtime']['runId'])
        runtime = cold['runtime']['runtimeId']
        s.wait(lambda: s.rows("SELECT 1 FROM runtimes WHERE runtime_id=? AND status='ready' AND active_run_id IS NULL", (runtime,)), 300, 'idle')
        status, warm = s.http('POST', '/v1/turns', {'hostSessionId': host, 'prompt': PROMPT, 'waitFor': 'terminal'}, timeout=600)
        out['warm'] = {'status': status, 'error': warm.get('error', {}).get('code') if isinstance(warm, dict) else None,
                       'outcome': warm.get('outcome') if isinstance(warm, dict) else None}
        status, cap = s.http('POST', '/v1/capture/by-selector', {'selector': {'sessionRef': prefix + task + '/lane:side'}})
        out['capture'] = {'status': status, 'sessionRef': cap.get('sessionRef') if isinstance(cap, dict) else None}
        status, view = s.http('GET', f'/v1/sessions/by-host/{host}')
        out['sessionView'] = view.get('laneRef') if isinstance(view, dict) else None
        out['stored'] = {
            'sessions': sorted({r['lane_ref'] for r in s.rows('SELECT lane_ref FROM sessions WHERE host_session_id=?', (host,))}),
            'continuities': sorted({r['lane_ref'] for r in s.rows('SELECT lane_ref FROM continuities WHERE scope_ref=?', (prefix + task,))}),
            'runtimes': sorted({r['lane_ref'] for r in s.rows('SELECT lane_ref FROM runtimes WHERE host_session_id=?', (host,))}),
            'runs': sorted({r['lane_ref'] for r in s.rows('SELECT lane_ref FROM runs WHERE host_session_id=?', (host,))}),
            'hrc_events': sorted({r['lane_ref'] for r in s.rows('SELECT lane_ref FROM hrc_events WHERE host_session_id=?', (host,))}),
            'firstTurnWatch': sorted({r['lane_ref'] for r in s.rows('SELECT lane_ref FROM runtime_first_turn_watch WHERE host_session_id=?', (host,))}),
        }
        (args.artifacts / 'lanes.json').write_text(json.dumps(out, indent=1) + '\n')
        assert out['warm'] == {'status': 200, 'error': None, 'outcome': 'completed'}, out['warm']
        assert out['capture'] == {'status': 200, 'sessionRef': prefix + task + '/lane:side'}, out['capture']
        # The API view is canonical; only the stored rows keep the raw lane.
        assert out['sessionView'] == 'lane:side', out['sessionView']
        bad = {table: lanes for table, lanes in out['stored'].items() if lanes != ['side']}
        assert not bad, ('stored lane_ref is not the raw lane', bad)
        print(json.dumps({'pass': True, **out}))
    finally:
        (args.artifacts / 'steps.json').write_text(json.dumps(s.steps, indent=1) + '\n')
        s.cleanup(prefix)


if __name__ == '__main__':
    main()
