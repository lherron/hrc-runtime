#!/usr/bin/env python3
"""Real model qualification on an explicitly owned daemon and scratch project.

Failures: CLI delegates with Bun absent, wrong run/seat, receipt mistaken for
completion, missing final render, summary seats leak, attach mutates continuity.
Each birth uses a fresh task; every created runtime is terminated in finally.
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
import urllib.parse
import uuid

from metrics_isolation import isolated_suite
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'hrc-native/e2e'))
from foundation import UnixHTTP


@isolated_suite
def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for key in ('binary', 'oracle', 'runtime-root', 'state-root', 'token-file', 'cwd', 'artifacts'):
        parser.add_argument('--' + key, type=Path, required=True)
    parser.add_argument('--authority', required=True)
    parser.add_argument('--project', required=True)
    parser.add_argument('--agent', default='tabularasa')
    parser.add_argument('--mode', choices=('stream', 'wait', 'stacked'), default='stream')
    args = parser.parse_args()
    assert args.project.startswith('n5-'), 'use a unique scratch project'
    assert str(args.runtime_root.resolve()).startswith('/private/tmp/') or str(args.runtime_root).startswith('/tmp/')
    args.artifacts.mkdir(parents=True, exist_ok=True)
    env = {k: v for k, v in os.environ.items() if not k.startswith(('ASP_', 'HRC_', 'WRKQ', 'HARNESS_BROKER_'))}
    env.update(HRC_RUNTIME_DIR=str(args.runtime_root), HRC_STATE_DIR=str(args.state_root),
               WRKQ_DB=args.authority, HRC_WRKQ_DB=args.authority,
               WRKQD_TOKEN_FILE=str(args.token_file), HRC_WRKQD_TOKEN_FILE=str(args.token_file),
               NO_COLOR='1', FORCE_COLOR='0')

    def call(path, body=None):
        client = UnixHTTP(args.runtime_root / 'hrc.sock')
        client.request('POST' if body is not None else 'GET', path,
                       json.dumps(body) if body is not None else None, {'Content-Type': 'application/json'})
        response = client.getresponse()
        value = json.loads(response.read())
        client.close()
        assert 200 <= response.status < 300, value
        return value

    def rows(scope=None):
        query = {'limit': 500, 'all': 'true'}
        if scope:
            query['scope'] = scope
        return call('/v1/runtimes?' + urllib.parse.urlencode(query))

    assert call('/v1/status')['runtimeRoot'] == str(args.runtime_root)
    before = {r['runtimeId'] for r in rows()}
    owned_scopes, owned_summaries, observations, terminated = set(), set(), [], []
    try:
        for label, command in [('oracle', [shutil.which('bun'), str(args.oracle.resolve())]),
                               ('subject', [str(args.binary.resolve())])]:
            task = 'n5-turn-' + uuid.uuid4().hex
            scope = f'agent:{args.agent}:project:{args.project}:task:{task}'
            owned_scopes.add(scope)
            target = f'{args.agent}@{args.project}:{task}+remote=false'
            flags = {'stream': ['--format', 'ndjson'], 'wait': ['--wait', 'final', '--timeout', '90s'],
                     'stacked': ['--stacked', '30s']}[args.mode]
            child_env = dict(env)
            if label == 'subject':
                child_env['PATH'] = str(args.artifacts / 'no-bun')
            started = time.time()
            child = subprocess.run(command + ['turn', target, 'Reply with exactly the word OK and nothing else. No tools.',
                                               '--as', 'human', '--stall-after', '90s'] + flags,
                                   env=child_env, cwd=args.cwd, capture_output=True, text=True, timeout=150)
            observed = dict(label=label, target=target, exit=child.returncode, stdout=child.stdout,
                            stderr=child.stderr, durationSeconds=time.time()-started)
            (args.artifacts / (label + '.json')).write_text(json.dumps(observed, indent=2))
            assert child.returncode == 0, observed
            output = [json.loads(line) for line in child.stdout.splitlines()]
            assert output, observed
            if args.mode == 'stacked':
                run_id = output[-1]['runId']
                owned_summaries.add((f'agent:summarizer:project:{args.project}:task:stacked:role:{run_id[:8]}', 'main'))
            if args.mode == 'stream':
                assert output[-1]['type'] == 'render_frame' and output[-1]['phase'] == 'final', output
                assert any(b.get('md') == 'OK' for b in output[-1]['blocks']), output
            elif args.mode == 'stacked':
                assert output[-1]['type'] == 'turn_stacked' and output[-1]['phase'] == 'final', output
                assert output[-1]['result'] == 'success' and output[-1]['exitCode'] == 0, output
            runtimes = rows(scope)
            assert len(runtimes) == 1 and runtimes[0]['scopeRef'] == scope, runtimes
            runtime = runtimes[0]
            inspected = call('/v1/runtimes/inspect', {'runtimeId': runtime['runtimeId']})
            session = call('/v1/sessions/resolve', {'sessionRef': scope + '/lane:main'})
            assert session['found'] and session['hostSessionId'] == runtime['hostSessionId'], session
            events = call('/v1/events/tail?' + urllib.parse.urlencode({'limit': 500, 'runtimeId': runtime['runtimeId']}))['events']
            completed = [e for e in events if e['eventKind'] == 'turn.completed']
            assert len(completed) == 1 and completed[0]['payload']['success'] is True, events
            run_id = completed[0]['runId']
            run = call('/v1/runs?' + urllib.parse.urlencode({'runId': run_id, 'limit': 1}))
            assert len(run) == 1 and run[0]['status'] == 'completed', run
            terminal = run[0].get('terminal')
            if args.mode == 'stacked':
                summary_rows = [r for r in rows(f'agent:summarizer:project:{args.project}:task:stacked:role:{run_id[:8]}') if r['laneRef'] == 'main' and r['runtimeId'] not in before]
                (args.artifacts / (label + '-summary-cleanup.json')).write_text(json.dumps(summary_rows, indent=2))
                assert summary_rows and all(r['status'] == 'terminated' for r in summary_rows), summary_rows
            # The authoritative normalized message lives in the lifecycle ledger.
            messages = [e['payload'] for e in events if e['eventKind'] == 'turn.message']
            assert messages and any('OK' in json.dumps(m) for m in messages), messages
            for frame in output:
                assert frame.get('runId', run_id) == run_id, (frame, run_id)
            observed.update(runtime=runtime, inspected=inspected, session=session, run=run,
                            terminal=terminal, events=events)
            (args.artifacts / (label + '-evidence.json')).write_text(json.dumps(observed, indent=2))
            observations.append(observed)
    finally:
        current = rows()
        for runtime in current:
            scope = runtime['scopeRef']
            own_summary = (scope, runtime['laneRef']) in owned_summaries
            if runtime['runtimeId'] not in before and (scope in owned_scopes or own_summary):
                if runtime['status'] != 'terminated':
                    call('/v1/terminate', {'runtimeId': runtime['runtimeId'], 'dropContinuation': True,
                                           'reason': 'N5 owned turn qualification cleanup', 'source': 'hrc-cli/e2e/turn_live.py'})
                terminated.append(runtime['runtimeId'])
        cleanup_rows = [r for r in rows() if r['runtimeId'] in terminated]
        assert {r['runtimeId'] for r in cleanup_rows} == set(terminated), cleanup_rows
        assert all(r['status'] == 'terminated' for r in cleanup_rows), cleanup_rows
        (args.artifacts / 'cleanup.json').write_text(json.dumps({'terminated': terminated, 'runtimes': cleanup_rows}, indent=2))
    report = {'pass': len(observations) == 2, 'mode': args.mode, 'subjects': len(observations),
              'terminated': terminated}
    (args.artifacts / 'results.json').write_text(json.dumps(report, indent=2))
    print(json.dumps(report))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
