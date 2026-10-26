#!/usr/bin/env python3
"""N2 route cases on one owner (bun or native), recorded for `compare --suite n2-routes`.

One real seat is born, then each case sends one request and records status
and body; turns run to completion between cases so every case starts from the
same idle seat. Failure modes: a door that answers a different status or body
shape, a refusal that mutates, a wait stage that returns before its stage, and
a malformed body that reaches the broker.
"""
import argparse
import json
from pathlib import Path
import time

from n2_scratch import Scratch

PROMPT = 'Reply with exactly the word OK and nothing else. No tools.'


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--owner', choices=['bun', 'native'], required=True)
    p.add_argument('--binary', type=Path, required=True)
    p.add_argument('--installed-release', type=Path, required=True)
    p.add_argument('--aspd-socket', type=Path, required=True)
    p.add_argument('--scratch-root', type=Path, required=True)
    p.add_argument('--artifacts', type=Path, required=True)
    p.add_argument('--only', default='')
    args = p.parse_args()
    s = Scratch(args.scratch_root, args.installed_release, args.aspd_socket, args.binary, args.artifacts)
    prefix = 'agent:tabularasa:project:n2-t11823:task:'
    scope = prefix + 'routes-' + args.owner
    session_ref = scope + '/lane:main'
    observations = []
    try:
        s.init_substrate()
        s.up(args.owner, 'routes')
        cold = s.command('cold-start', ['hrc', 'start', scope, '--project-id', s.project_id, '--project-root',
                                        s.project, '--cwd', s.project, '--json', '-p', PROMPT])
        runtime, host = cold['runtime']['runtimeId'], None
        s.wait_completed(cold['runtime']['runId'])
        host = s.rows('SELECT host_session_id FROM runtimes WHERE runtime_id=?', (runtime,))[0]['host_session_id']

        def idle():
            s.wait(lambda: s.rows("SELECT 1 FROM runtimes WHERE runtime_id=? AND status='ready' AND active_run_id IS NULL",
                                  (runtime,)), 300, 'idle seat')
            time.sleep(1)

        def case(name, method, path, body=None, settle=False):
            if args.only and name not in args.only.split(','):
                return
            before = s.rows('SELECT MAX(hrc_seq) AS m FROM hrc_events')[0]['m']
            status, value = s.http(method, path, body, timeout=600)
            run_id = value.get('runId') if isinstance(value, dict) else None
            if settle and run_id:
                s.wait_completed(run_id)
            if settle:
                idle()
            kinds = [r['event_kind'] for r in s.rows('SELECT event_kind FROM hrc_events WHERE hrc_seq>? ORDER BY hrc_seq', (before,))]
            run = s.rows('SELECT * FROM runs WHERE run_id=?', (run_id,)) if run_id else []
            observations.append({'case': name, 'method': method, 'path': path, 'request': body,
                                 'status': status, 'body': value, 'eventKinds': kinds, 'run': run[0] if run else None})

        idle()
        turns = '/v1/turns'
        case('turns:not-object', 'POST', turns, [])
        case('turns:missing-host', 'POST', turns, {'prompt': PROMPT})
        case('turns:missing-prompt', 'POST', turns, {'hostSessionId': host})
        case('turns:unknown-field', 'POST', turns, {'hostSessionId': host, 'prompt': PROMPT, 'bogus': 1})
        case('turns:bad-wait', 'POST', turns, {'hostSessionId': host, 'prompt': PROMPT, 'waitFor': 'soon'})
        case('turns:unknown-host', 'POST', turns, {'hostSessionId': 'hsid-00000000-0000-0000-0000-000000000000', 'prompt': PROMPT})
        case('turns:stale-fence', 'POST', turns, {'hostSessionId': host, 'prompt': PROMPT, 'fences': {'expectedGeneration': 99}})
        case('turns:warm-accepted', 'POST', turns, {'hostSessionId': host, 'prompt': PROMPT}, settle=True)
        case('turns:warm-turn-started', 'POST', turns, {'hostSessionId': host, 'prompt': PROMPT, 'waitFor': 'turn_started'}, settle=True)
        case('turns:warm-terminal', 'POST', turns, {'hostSessionId': host, 'prompt': PROMPT, 'waitFor': 'terminal'}, settle=True)
        case('turns:idempotent-first', 'POST', turns, {'hostSessionId': host, 'prompt': PROMPT, 'idempotencyKey': 'n2-k1'}, settle=True)
        case('turns:idempotent-replay', 'POST', turns, {'hostSessionId': host, 'prompt': PROMPT, 'idempotencyKey': 'n2-k1'})
        invoke = '/v1/submissions/invoke'
        origin = {'principalRef': 'agent:clod'}
        case('invoke:not-object', 'POST', invoke, [])
        case('invoke:missing-origin', 'POST', invoke, {'target': session_ref, 'body': PROMPT})
        case('invoke:unknown-target', 'POST', invoke, {'target': prefix + 'nobody/lane:main', 'body': PROMPT, 'origin': origin})
        case('invoke:bad-turn-policy', 'POST', invoke, {'target': session_ref, 'body': PROMPT, 'origin': origin, 'turnPolicy': 'loose'})
        case('invoke:warm', 'POST', invoke, {'target': session_ref, 'body': PROMPT, 'origin': origin}, settle=True)
        case('invoke:warm-host-target', 'POST', invoke, {'target': host, 'body': PROMPT, 'origin': origin, 'wait': True}, settle=True)
        case('turns:wrong-method', 'GET', turns)
        runs = '/v1/runs'
        for name, query in [('all', ''), ('runtime', f'?runtimeId={runtime}'), ('host', f'?hostSessionId={host}'),
                            ('scope', f'?scopeRef={scope}'), ('lane', f'?laneRef=main'), ('generation', '?generation=1'),
                            ('status', '?status=completed'), ('status-list', '?status=failed,%20completed,'),
                            ('limit', '?limit=2'), ('limit-zero', '?limit=0'), ('limit-float', '?limit=2.0'),
                            ('limit-hex', '?limit=0x2'), ('limit-bad', '?limit=two'), ('limit-negative', '?limit=-1'),
                            ('generation-bad', '?generation=1.5'), ('trimmed', f'?runtimeId=%20{runtime}%20'),
                            ('blank', '?runtimeId=&status='), ('unknown', '?runId=run-nope'), ('first-wins', '?limit=1&limit=5')]:
            case('runs:' + name, 'GET', runs + query)
        case('runs:wrong-method', 'POST', runs, {})
        (args.artifacts / f'{args.owner}.json').write_text(json.dumps(
            {'observations': observations, 'scratchRoot': str(s.root), 'scope': scope, 'runtimeId': runtime,
             'hostSessionId': host}, indent=1, default=str) + '\n')
        s.dump(args.owner + '-rows')
        print(json.dumps({'owner': args.owner, 'cases': len(observations)}))
    finally:
        (args.artifacts / f'{args.owner}-steps.json').write_text(json.dumps(s.steps, indent=1) + '\n')
        s.cleanup(prefix)


if __name__ == '__main__':
    main()
