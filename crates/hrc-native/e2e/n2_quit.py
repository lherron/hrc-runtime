#!/usr/bin/env python3
"""N2 human /quit on one owner (bun or native), for `compare --suite n2-quit`.

A real claude-code-tmux seat is born and goes idle; `/quit` is typed into its
TUI pane. The broker reports a prompt-input-exit continuation clear, then the
invocation summary and exit. Both owners must schedule the summary-aware lease
reap, end the runtime as a user-initiated termination, kill the lease tmux
server, and write the same lifecycle rows. Failure modes: the lease left alive
after the harness quit, the runtime marked crashed instead of terminated, and a
reap that fires twice or never.
"""
import argparse
import json
import subprocess
import time
from pathlib import Path

from n2_scratch import Scratch

PROMPT = 'Reply with exactly the word OK and nothing else. No tools.'


def log_events(path, prefix):
    out = []
    for line in Path(path).read_text().splitlines():
        try:
            e = json.loads(line)
        except ValueError:
            continue
        if isinstance(e, dict) and str(e.get('event', '')).startswith(prefix):
            out.append(e['event'])
    return out


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--owner', choices=['bun', 'native'], required=True)
    p.add_argument('--binary', type=Path, required=True)
    p.add_argument('--installed-release', type=Path, required=True)
    p.add_argument('--aspd-socket', type=Path, required=True)
    p.add_argument('--scratch-root', type=Path, required=True)
    p.add_argument('--artifacts', type=Path, required=True)
    args = p.parse_args()
    s = Scratch(args.scratch_root, args.installed_release, args.aspd_socket, args.binary, args.artifacts)
    prefix = 'agent:tabularasa:project:n2-t11823:task:'
    scope = prefix + 'quit-' + args.owner
    out = {}
    try:
        s.init_substrate()
        s.up(args.owner, 'a')
        cold = s.command('cold-start', ['hrc', 'start', scope, '--project-id', s.project_id, '--project-root',
                                        s.project, '--cwd', s.project, '--json', '-p', PROMPT])
        runtime = cold['runtime']['runtimeId']
        s.wait_completed(cold['runtime']['runId'])
        s.wait(lambda: s.rows("SELECT 1 FROM runtimes WHERE runtime_id=? AND status='ready' AND active_run_id IS NULL", (runtime,)), 300, 'idle')
        time.sleep(2)
        state = json.loads(s.rows('SELECT runtime_state_json FROM runtimes WHERE runtime_id=?', (runtime,))[0]['runtime_state_json'])
        tmux = state['tmux']
        lease = state['broker']['brokerWindow']['socketPath']
        before = s.rows('SELECT COALESCE(MAX(hrc_seq),0) AS m FROM hrc_events')[0]['m']
        subprocess.run(['tmux', '-S', tmux['socketPath'], 'send-keys', '-t', tmux['paneId'], '-l', '/quit'], check=True)
        time.sleep(.5)
        subprocess.run(['tmux', '-S', tmux['socketPath'], 'send-keys', '-t', tmux['paneId'], 'Enter'], check=True)
        s.wait(lambda: s.rows("SELECT 1 FROM runtimes WHERE runtime_id=? AND status IN ('terminated','dead','stale','crashed')", (runtime,)), 120, 'runtime ended')
        s.wait(lambda: subprocess.run(['tmux', '-S', lease, 'has-session'], capture_output=True).returncode != 0, 30, 'lease reaped')
        time.sleep(3)
        r = s.rows('SELECT status, active_run_id, runtime_state_json, lifecycle_terminal_reason FROM runtimes WHERE runtime_id=?', (runtime,))[0]
        st = json.loads(r['runtime_state_json'] or '{}')
        out['runtime'] = {'status': r['status'], 'activeRun': r['active_run_id'], 'lifecycleTerminalReason': r['lifecycle_terminal_reason'],
                          'terminationReason': st.get('terminationReason'), 'userExitReason': st.get('userExitReason'),
                          'invocationState': s.rows('SELECT invocation_state FROM broker_invocations WHERE runtime_id=? ORDER BY created_at DESC LIMIT 1', (runtime,))[0]['invocation_state']}
        out['events'] = [{'kind': e['event_kind'], 'payload': json.loads(e['payload_json'] or 'null')}
                         for e in s.rows("SELECT event_kind, payload_json FROM hrc_events WHERE hrc_seq>? AND runtime_id=? ORDER BY hrc_seq", (before, runtime))]
        out['leaseAlive'] = subprocess.run(['tmux', '-S', lease, 'has-session'], capture_output=True).returncode == 0
        log = args.artifacts / f'{args.owner}-a.log'
        out['reapLogs'] = sorted(set(log_events(log, 'broker-tmux prompt exit')))
        (args.artifacts / f'{args.owner}.json').write_text(json.dumps(out, indent=1, default=str) + '\n')
        s.dump(args.owner + '-rows')
        print(json.dumps({'owner': args.owner, 'runtime': out['runtime'], 'leaseAlive': out['leaseAlive']}))
    finally:
        (args.artifacts / f'{args.owner}-steps.json').write_text(json.dumps(s.steps, indent=1) + '\n')
        s.cleanup(prefix)


if __name__ == '__main__':
    main()
