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
        literal = '/v1/literal-input/by-selector'
        sel = {'sessionRef': session_ref}
        case('literal:no-selector', 'POST', literal, {'text': 'x'})
        case('literal:no-text', 'POST', literal, {'selector': sel})
        case('literal:unknown-session', 'POST', literal, {'selector': {'sessionRef': prefix + 'nobody/lane:main'}, 'text': 'x'})
        case('literal:stale-fence', 'POST', literal, {'selector': sel, 'text': 'x', 'fences': {'expectedGeneration': 99}})
        case('literal:buffer', 'POST', literal, {'selector': sel, 'text': 'Reply with exactly the word OK and nothing else.', 'enter': False})
        case('literal:flush', 'POST', literal, {'selector': sel, 'text': ' No tools.'}, settle=True)
        case('literal:empty-enter', 'POST', literal, {'selector': sel, 'text': ''})
        idle()
        contributions = '/v1/active-run-contributions'
        case('contrib:malformed', 'POST', contributions, {'inputApplicationId': 'app-1'})
        case('contrib:no-runtime', 'POST', contributions, {'inputApplicationId': 'app-1', 'inputAttemptId': 'att-1', 'prompt': 'x', 'selector': {'runtimeId': 'rt-nope'}})
        case('contrib:replay', 'POST', contributions, {'inputApplicationId': 'app-1', 'inputAttemptId': 'att-2', 'prompt': 'y'})
        case('contrib:no-active-run', 'POST', contributions, {'inputApplicationId': 'app-2', 'inputAttemptId': 'att-1', 'prompt': 'x', 'selector': {'hostSessionId': host}})
        interrupt, terminate = '/v1/interrupt', '/v1/terminate'
        case('interrupt:not-object', 'POST', interrupt, [])
        case('interrupt:missing-runtime', 'POST', interrupt, {})
        case('interrupt:bad-owner', 'POST', interrupt, {'runtimeId': runtime, 'ownerRunId': ' '})
        case('interrupt:unknown', 'POST', interrupt, {'runtimeId': 'rt-nope'})
        case('interrupt:owner-idle', 'POST', interrupt, {'runtimeId': runtime, 'ownerRunId': 'run-nope'})
        if not args.only or 'interrupt:active' in args.only.split(','):
            slow = 'Count from 1 to 400, one number per line, with no other text. No tools.'
            _, started = s.http('POST', turns, {'hostSessionId': host, 'prompt': slow, 'waitFor': 'turn_started'}, timeout=600)
            time.sleep(4)
            case('interrupt:active-other-owner', 'POST', interrupt, {'runtimeId': runtime, 'ownerRunId': 'run-nope'})
            case('contrib:queue-recommended', 'POST', contributions, {'inputApplicationId': 'app-3', 'inputAttemptId': 'att-1', 'prompt': 'x', 'selector': {'runtimeId': runtime}})
            case('contrib:run-mismatch', 'POST', contributions, {'inputApplicationId': 'app-4', 'inputAttemptId': 'att-1', 'prompt': 'x', 'selector': {'runtimeId': runtime}, 'expectedRunId': 'run-other'})
            case('interrupt:active', 'POST', interrupt, {'runtimeId': runtime, 'ownerRunId': started['runId']})
            s.wait(lambda: s.rows("SELECT 1 FROM runs WHERE run_id=? AND completed_at IS NOT NULL", (started['runId'],)),
                   300, 'interrupted run settles')
            idle()
            observations[-1]['settledRun'] = s.rows('SELECT status, error_code FROM runs WHERE run_id=?', (started['runId'],))[0]
        case('interrupt:idle', 'POST', interrupt, {'runtimeId': runtime})
        idle()
        case('attach:missing', 'GET', '/v1/attach')
        case('attach:unknown', 'GET', '/v1/attach?runtimeId=rt-nope')
        case('attach:ok', 'GET', f'/v1/attach?runtimeId={runtime}')
        case('capture:missing', 'GET', '/v1/capture?runtimeId=%20')
        case('capture:unknown', 'GET', '/v1/capture?runtimeId=rt-nope')
        case('capture:ok', 'GET', f'/v1/capture?runtimeId={runtime}')
        by_selector = '/v1/capture/by-selector'
        case('capture-selector:no-selector', 'POST', by_selector, {'lines': 3})
        case('capture-selector:no-ref', 'POST', by_selector, {'selector': {'sessionRef': ''}})
        case('capture-selector:unknown', 'POST', by_selector, {'selector': {'sessionRef': prefix + 'nobody/lane:main'}})
        case('capture-selector:ok', 'POST', by_selector, {'selector': {'sessionRef': session_ref}})
        case('capture-selector:lines', 'POST', by_selector, {'selector': {'sessionRef': session_ref}, 'lines': 2})
        status_door = '/v1/runtimes/capture/status'
        case('capture-status:not-object', 'POST', status_door, 'x')
        case('capture-status:missing', 'POST', status_door, {'runtimeId': '  '})
        case('capture-status:unknown', 'POST', status_door, {'runtimeId': 'rt-nope'})
        case('capture-status:ok', 'POST', status_door, {'runtimeId': runtime})
        inspect = '/v1/runtimes/broker/inspect'
        case('broker-inspect:missing', 'POST', inspect, {})
        case('broker-inspect:bad-flag', 'POST', inspect, {'runtimeId': runtime, 'includeDisposed': 1})
        case('broker-inspect:bad-recover', 'POST', inspect, {'runtimeId': runtime, 'recoverFinalSummary': {'timeoutMs': -1}})
        case('broker-inspect:unknown', 'POST', inspect, {'runtimeId': 'rt-nope'})
        case('broker-inspect:no-invocations', 'POST', inspect, {'runtimeId': runtime, 'includeInvocations': False})
        case('broker-inspect:ok', 'POST', inspect, {'runtimeId': runtime, 'includeDisposed': True})
        for o in observations:
            # Pane text is each owner's own screen; the shape is what compares.
            if o['case'].startswith('capture') and isinstance(o['body'], dict) and isinstance(o['body'].get('text'), str):
                text = o['body']['text']
                o['body'] = dict(o['body'], text='<text:nonempty>' if text.strip() else '<text:empty>')
                if o['case'] == 'capture-selector:lines':
                    o['body']['lineCount'] = len(text.split('\n'))
        case('terminate:not-object', 'POST', terminate, [])
        case('terminate:missing-runtime', 'POST', terminate, {'dropContinuation': True})
        case('terminate:bad-drop', 'POST', terminate, {'runtimeId': runtime, 'dropContinuation': 'yes'})
        case('terminate:bad-reason', 'POST', terminate, {'runtimeId': runtime, 'reason': 7})
        case('terminate:unknown', 'POST', terminate, {'runtimeId': 'rt-nope'})
        case('terminate:final', 'POST', terminate, {'runtimeId': runtime, 'reason': 'n2 route case', 'source': 'e2e',
                                                     'actor': 'agent:clod'})
        time.sleep(2)
        case('terminate:again', 'POST', terminate, {'runtimeId': runtime})
        case('interrupt:terminated', 'POST', interrupt, {'runtimeId': runtime})
        case('attach:terminated', 'GET', f'/v1/attach?runtimeId={runtime}')
        case('capture:terminated', 'GET', f'/v1/capture?runtimeId={runtime}')
        case('capture-status:terminated', 'POST', status_door, {'runtimeId': runtime})
        case('capture-selector:terminated', 'POST', by_selector, {'selector': {'sessionRef': session_ref}})
        case('broker-inspect:terminated', 'POST', inspect, {'runtimeId': runtime})
        if not args.only or 'terminate:final' in args.only.split(','):
            [o for o in observations if o['case'] == 'terminate:final'][0]['finalRows'] = {
                'runtime': s.rows('SELECT status, active_run_id, active_invocation_id FROM runtimes WHERE runtime_id=?', (runtime,)),
                'session': s.rows('SELECT continuation_reuse_disabled FROM sessions WHERE host_session_id=?', (host,)),
                'invocation': s.rows('SELECT invocation_state FROM broker_invocations WHERE runtime_id=? ORDER BY created_at DESC LIMIT 1', (runtime,)),
                'lease': s.rows("SELECT event_kind, payload_json FROM hrc_events WHERE runtime_id=? AND event_kind IN ('runtime.terminated','runtime.crashed','runtime.stale','runtime.dead') ORDER BY hrc_seq", (runtime,)),
            }
        for o in observations:
            # Broker-reported pass-through: transcript diagnostic counts and the
            # live seq/context reading move with harness timing, not with HRC.
            body = o['body'] if isinstance(o['body'], dict) else {}
            for row in (body.get('capture') or {}).get('blockedUnknown', []) if isinstance(body.get('capture'), dict) else []:
                row['count'] = '<count>'
            for inv in body.get('invocations', []) if isinstance(body.get('invocations'), list) else []:
                for key in ('currentSeq', 'context'):
                    if key in inv:
                        inv[key] = '<' + key + '>'
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
