#!/usr/bin/env python3
"""monitor watch against a real owned seat: replay, conditions, follow, live.

Failure modes: replay windows (--last/--from-seq/default 100) cut differently,
selector and --kind/--tool/--grep/--milestone filters drop or add events, the
JSON projection reorders or invents fields, tree/compact/verbose renderers
drift (bands, tool pairing, truncation, badges), flag errors land on the wrong
stream or prefix (parse-time `hrc:` vs run-time `error:`), and a live follow
misses or duplicates events of a real turn. Live cases arm both CLIs, then
dispatch one real prompt to the scratch seat.
"""
import argparse
import json
from pathlib import Path
import subprocess

from metrics_isolation import isolated_suite
from n5b_common import Runner, scratch_env
from n5b_monitor_wait import live_case

NORMALIZATION = {
    'timestamp': (r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z', '<timestamp>'),
    'uptime_json': (r'("uptime": ?)\d+', r'\1<uptime>'),
    'cli_pid': (r'("pid": ?)\d+', r'\1<pid>'),
    # The rendered completion stamps the observation clock (now) as HH:MM:SS.
    'completion_clock_tree': (r'\d\d:\d\d:\d\d(  \S+  \S+ (?:completed|monitor\.completed))', r'<clock>\1'),
    'completion_clock_compact': (r'\d\d:\d\d:\d\d( \S+ monitor\.completed)', r'<clock>\1'),
}


@isolated_suite
def main():
    p = argparse.ArgumentParser()
    for flag in ('binary', 'oracle', 'runtime-root', 'state-root', 'seat', 'artifacts'):
        p.add_argument('--' + flag, type=Path, required=True)
    p.add_argument('--no-live', action='store_true')
    args = p.parse_args()
    seat = json.loads(args.seat.read_text())
    rid, host, scope, handle = seat['start']['runtimeId'], seat['start']['hostSessionId'], seat['scope'], seat['handle']
    env = scratch_env(args.runtime_root, args.state_root)
    runner = Runner(args.binary, args.oracle, args.artifacts, env, NORMALIZATION, timeout=60)
    w = ['monitor', 'watch']
    rt = 'runtime:' + rid
    # Replay (no --follow): every output format and filter.
    for fmt in ([], ['--json'], ['--pretty'], ['--format', 'tree'], ['--format=compact'], ['--format', 'verbose'],
                ['--format', 'invocation-events'], ['--format', 'json'], ['--format', 'ndjson']):
        runner.case(w + [rt] + fmt)
    for extra in (['--last', '3'], ['--last', '3', '--format', 'tree'], ['--from-seq', '1'], ['--from-seq', '20', '--format', 'tree'],
                  ['--from-seq', '25', '--format', 'tree', '--max-lines', '2'], ['--format', 'tree', '--max-lines', '0'],
                  ['--format', 'tree', '--scope-width', '8'], ['--format', 'tree', '--scope-width', '2'], ['--kind', 'turn.started,turn.completed'],
                  ['--tool', 'Bash', '--format', 'tree'], ['--grep', 'DONE'], ['--milestone'], ['--all-events', '--last', '4'],
                  ['--kind', 'nope'], ['--last', '1000'], ['--from-seq', '5abc', '--last', '2'][:2]):
        runner.case(w + [rt] + extra)
    for sel in (rid, handle, 'scope:' + scope, scope, 'host:' + host, 'session:' + seat['sessionRef'], 'scope:agent:tabularasa:*',
                'T-11821', 'runtime:rt-missing', 'msg:missing', 'nobody@hrc-runtime:none'):
        runner.case(w + [sel, '--last', '5'])
        runner.case(w + [sel, '--last', '5', '--format', 'compact'])
    runner.case(w + ['--last', '5'])
    runner.case(w + [rt, 'host:' + host, '--last', '5'])
    runner.case(w + [rt, 'host:' + host, '--last', '5', '--all-events'])
    # Flag errors: parse-time (hrc:) and run-time (error:).
    for extra in (['--last', '0'], ['--last', 'x'], ['--from-seq', '-1'], ['--max-lines', '-1'], ['--scope-width', 'x'],
                  ['--format', 'bogus'], ['--timeout', '5x'], ['--stall-after', 'soon'], ['--kind', ''], ['--tool', ' '],
                  ['--last', '2', '--from-seq', '1'], ['--last', '2', '--until', 'idle'], ['--since', '5'], ['--until', 'nope'],
                  ['--until-any', 'idle'], ['--last', '0', '--format', 'bogus']):
        runner.case(w + [rt] + extra)
    for sel in ('wat:foo', 'scope::*', 'runtime:', 'Bad Handle'):
        runner.case(w + [sel])
    # Conditions without --follow, and follow plans that settle at arm or time out.
    runner.case(w + [rt, '--until', 'idle'])
    runner.case(w + [rt, '--until', 'idle', '--json'])
    runner.case(w + [rt, '--until', 'busy', '--timeout', '300ms', '--format', 'tree'])
    runner.case(w + [rt, '--follow', '--until', 'idle', '--json'])
    runner.case(w + [handle, '--follow', '--until', 'idle'])
    runner.case(w + [rt, '--follow', '--timeout', '500ms'])
    runner.case(w + [rt, '--follow', '--timeout', '500ms', '--format', 'tree'])
    runner.case(w + [rt, '--follow', '--until', 'busy', '--stall-after', '300ms'])
    runner.case(w + ['scope:agent:tabularasa:*', '--follow', '--until-any', 'idle'])
    runner.case(w + ['scope:agent:tabularasa:*', '--follow', '--timeout', '400ms'])
    runner.case(w + [rt, '--follow', '--until', 'turn-finished', '--from-seq', '1', '--timeout', '500ms', '--json'])
    # --forever streams; with no traffic it reports the snapshot then times out.
    runner.case(w + [rt, '--follow', '--forever', '--timeout', '600ms'])
    runner.case(w + [rt, '--follow', '--forever', '--timeout', '600ms', '--last', '3'])
    runner.case(w + [rt, '--follow', '--forever', '--timeout', '600ms', '--last', '3', '--format', 'tree'])
    runner.case(w + [rt, '--follow', '--forever', '--timeout', '600ms', '--kind', 'turn.completed'])
    runner.case(w + [rt, '--follow', '--forever', '--timeout', '600ms', '--from-seq', '30', '--format', 'compact'])

    if not args.no_live:
        sender = [runner.bun, str(runner.oracle), 'send', handle]
        idle = [runner.bun, str(runner.oracle), 'monitor', 'wait', rt, '--until', 'idle', '--timeout', '120s']
        live_case(runner, w + [rt, '--follow', '--timeout', '120s'],
                  'Reply with exactly the word FIVE and nothing else. No tools.', env, sender, 'live watch default plan')
        subprocess.run(idle, env=env, capture_output=True, timeout=150)
        live_case(runner, w + [rt, '--follow', '--forever', '--timeout', '25s'],
                  'Use the Bash tool exactly once to run: echo watch-ndjson. Then reply with exactly SIX.', env, sender,
                  'live watch forever ndjson')
        subprocess.run(idle, env=env, capture_output=True, timeout=150)
        live_case(runner, w + [rt, '--follow', '--forever', '--timeout', '25s', '--format', 'tree', '--last', '2'],
                  'Use the Bash tool exactly once to run: printf "a\\nb\\nc\\n". Then reply with exactly SEVEN.', env, sender,
                  'live watch forever tree')
        subprocess.run(idle, env=env, capture_output=True, timeout=150)
        live_case(runner, w + ['scope:agent:tabularasa:*', '--follow', '--forever', '--timeout', '25s', '--format', 'compact'],
                  'Reply with exactly the word EIGHT and nothing else. No tools.', env, sender, 'live watch forever fan-in compact')
        subprocess.run(idle, env=env, capture_output=True, timeout=150)
    return runner.finish(seat=rid, execution='native-required; Bun absent from subject PATH')


if __name__ == '__main__':
    raise SystemExit(main())
