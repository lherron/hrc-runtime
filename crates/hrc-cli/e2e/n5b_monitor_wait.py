#!/usr/bin/env python3
"""monitor wait (and blocking watch) against a real owned seat, at arm and live.

Failure modes: a level reads the raw status instead of the projected one, an
edge before the fence satisfies a wait, --since/--timeout/--stall-after change
precedence, set-shaped and exact plans accept each other's families, role-tree
binding resolves the wrong runtime, early errors exit with the wrong code or
stream, and a live turn's busy/turn-finished edges are missed or misordered.
Live cases arm Bun and rusthrc together, then dispatch one real prompt.
"""
import argparse
import json
import os
from pathlib import Path
import subprocess
import time

from metrics_isolation import isolated_suite
from n5b_common import Runner, normalize, scratch_env

NORMALIZATION = {
    'timestamp': (r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z', '<timestamp>'),
    'uptime_json': (r'("uptime": ?)\d+', r'\1<uptime>'),
}


def live_case(runner, argv, prompt, send_env, sender, name, delay=2.0):
    """Arm both CLIs, dispatch one real prompt, compare the completions."""
    procs = []
    for subject in (False, True):
        env = dict(runner.env)
        command = [str(runner.binary)] if subject else [runner.bun, str(runner.oracle)]
        if subject:
            env['PATH'] = runner.subject_path
        procs.append(subprocess.Popen(command + argv, cwd=runner.cwd, env=env, text=True,
                                      stdout=subprocess.PIPE, stderr=subprocess.PIPE))
    time.sleep(delay)
    sent = subprocess.run(sender + [prompt, '--json'], env=send_env, text=True, capture_output=True, timeout=60)
    observed = []
    for p in procs:
        out, err = p.communicate(timeout=180)
        observed.append(dict(exit=p.returncode, stdout=out, stderr=err))
    ok = normalize(observed[0], runner.normalization) == normalize(observed[1], runner.normalization)
    runner.results.append(dict(case=name, argv=argv, live=True, send=dict(exit=sent.returncode, stdout=sent.stdout),
                               oracle=observed[0], subject=observed[1], **{'pass': ok}))


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
    w = ['monitor', 'wait']
    # At arm: the seat is idle.
    for sel in ('runtime:' + rid, rid, handle, 'scope:' + scope, 'session:' + seat['sessionRef'], 'host:' + host):
        for json_flag in ([], ['--json']):
            runner.case(w + [sel, '--until', 'idle'] + json_flag)
    runner.case(w + ['runtime:' + rid, '--until', 'busy', '--until', 'idle', '--json'])
    runner.case(w + ['runtime:' + rid, '--until=busy', '--timeout', '300ms'])
    runner.case(w + ['runtime:' + rid, '--until', 'busy', '--timeout', '300ms', '--json'])
    runner.case(w + ['runtime:' + rid, '--until', 'runtime-dead', '--timeout', '300ms', '--json'])
    runner.case(w + ['runtime:' + rid, '--timeout', '400ms'])
    runner.case(w + ['runtime:' + rid, '--until', 'busy', '--stall-after', '300ms', '--json'])
    runner.case(w + ['runtime:' + rid, '--until', 'turn-finished', '--since', '1', '--json'])
    runner.case(w + ['runtime:' + rid, '--until', 'turn-finished', '--since', '1'])
    runner.case(w + ['runtime:' + rid, '--until', 'turn-finished', '--since', '9999h', '--json'])
    runner.case(w + ['runtime:' + rid, '--until', 'turn-finished', '--since', '1ms', '--timeout', '300ms', '--json'])
    runner.case(w + ['runtime:' + rid, '--until', 'turn-finished', '--since', '0'])
    runner.case(w + ['runtime:' + rid, '--until', 'idle', '--since', '1'])
    runner.case(w + ['runtime:' + rid, '--until', 'turn-finished', '--since', 'soon'])
    runner.case(w + ['runtime:' + rid, '--until', 'idle', '--timeout', '0s', '--json'])
    for extra in (['--until-any', 'idle'], ['--until-all', 'idle'], ['--until', 'idle', '--until-any', 'busy'],
                  ['--until', 'nope'], ['--until', 'response'], ['--timeout', 'forever', '--until', 'idle'],
                  ['--stall-after', '5x', '--until', 'idle'], ['--until-all', 'turn-finished']):
        runner.case(w + ['runtime:' + rid] + extra)
    runner.case(w + ['--until', 'idle'])
    runner.case(w)
    for sel in ('runtime:rt-missing', 'wat:foo', 'nobody@hrc-runtime:none', 'scope:agent:nobody:project:x:task:y',
                'msg:missing', 'seq:999', 'host:hsid-missing', 'runtime:'):
        runner.case(w + [sel, '--until', 'idle', '--timeout', '300ms'])
    runner.case(w + ['msg:missing', '--until', 'response', '--timeout', '300ms', '--json'])
    # Set-shaped plans.
    runner.case(w + ['T-11821', '--until-any', 'idle', '--timeout', '300ms', '--json'])
    runner.case(w + ['n5b-11821-acceptance'[:0] + 'T-11821.sub', '--until-any', 'idle', '--timeout', '300ms'])
    runner.case(w + ['T-11821', '--until', 'idle'])
    runner.case(w + ['scope:agent:tabularasa:*', '--until-any', 'idle', '--json'])
    runner.case(w + ['scope:agent:tabularasa:*', '--until-all', 'idle', '--json'])
    runner.case(w + ['scope:agent:nobody:*', '--until-all', 'idle', '--timeout', '300ms'])
    runner.case(w + ['scope::*', '--until-any', 'idle', '--timeout', '300ms'])
    runner.case(w + ['runtime:' + rid, 'host:' + host, '--until-any', 'idle', '--json'])
    runner.case(w + ['runtime:' + rid, 'host:' + host, '--until-all', 'idle', '--until-all', 'busy', '--timeout', '300ms'])
    runner.case(w + ['runtime:' + rid, 'runtime:rt-missing', '--until-any', 'idle', '--timeout', '300ms'])

    if not args.no_live:
        send_env = dict(env)
        sender = [runner.bun, str(runner.oracle), 'send', handle]
        live_case(runner, w + ['runtime:' + rid, '--until', 'busy', '--timeout', '120s', '--json'],
                  'Reply with exactly the word ONE and nothing else. No tools.', send_env, sender, 'live wait busy')
        subprocess.run([runner.bun, str(runner.oracle), 'monitor', 'wait', 'runtime:' + rid, '--until', 'idle', '--timeout', '120s'],
                       env=env, capture_output=True, timeout=150)
        live_case(runner, w + ['runtime:' + rid, '--until', 'turn-finished', '--timeout', '120s'],
                  'Reply with exactly the word TWO and nothing else. No tools.', send_env, sender, 'live wait turn-finished')
        live_case(runner, w + [handle, '--timeout', '120s', '--json'],
                  'Reply with exactly the word THREE and nothing else. No tools.', send_env, sender, 'live wait implicit plan')
        live_case(runner, w + ['scope:agent:tabularasa:*', '--until-any', 'busy', '--timeout', '120s', '--json'],
                  'Reply with exactly the word FOUR and nothing else. No tools.', send_env, sender, 'live wait set busy')
        subprocess.run([runner.bun, str(runner.oracle), 'monitor', 'wait', 'runtime:' + rid, '--until', 'idle', '--timeout', '120s'],
                       env=env, capture_output=True, timeout=150)
    return runner.finish(seat=rid, execution='native-required; Bun absent from subject PATH')


if __name__ == '__main__':
    raise SystemExit(main())
