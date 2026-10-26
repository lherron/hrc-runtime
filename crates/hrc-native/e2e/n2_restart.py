#!/usr/bin/env python3
"""N2 gate 2: restart rusthrc mid-turn, then hand the seat to the named Bun copy.

Failure modes: a turn lost across the restart (events stranded unACKed in the
broker ledger), a duplicate lifecycle row, run or reply from replaying already
committed seqs, a broker disposed by owner shutdown, an ACK cursor ahead of the
committed projection, and rows Bun cannot continue from.
"""
import argparse
import collections
import json
import os
from pathlib import Path
import time

from n2_scratch import Scratch


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
    scope = prefix + 'restart-' + str(time.time_ns())
    checks = {}
    try:
        s.init_substrate()
        native = s.up('native', 'a')
        start = ['hrc', 'start', scope, '--project-id', s.project_id, '--project-root', s.project,
                 '--cwd', s.project, '--json', '-p']
        cold = s.command('cold-start-long', start + [
            'Use the Bash tool exactly once to run `python3 -c "import time; time.sleep(25)"`, then reply with exactly the word DONE.'])
        run1, runtime = cold['runtime']['runId'], cold['runtime']['runtimeId']
        s.wait(lambda: s.rows("SELECT 1 FROM hrc_events WHERE run_id=? AND event_kind='turn.tool_call'", (run1,)),
               300, 'mid-turn tool call')
        assert not s.rows("SELECT 1 FROM hrc_events WHERE run_id=? AND event_kind='turn.completed'", (run1,))
        state = json.loads(s.rows('SELECT runtime_state_json FROM runtimes WHERE runtime_id=?', (runtime,))[0]['runtime_state_json'])
        broker_pid = state['broker']['brokerPid']
        before = s.rows('SELECT last_projected_seq FROM broker_invocations WHERE runtime_id=?', (runtime,))[0]['last_projected_seq']
        checks['downExit'] = s.down(native)
        os.kill(broker_pid, 0)
        native = s.up('native', 'b')
        s.wait_completed(run1)
        inv = s.rows('SELECT * FROM broker_invocations WHERE runtime_id=?', (runtime,))[0]
        assert inv['owner_server_instance_id'] == f'hrc-server:{native.pid}', inv['owner_server_instance_id']
        time.sleep(3)
        events = s.rows('SELECT * FROM hrc_events WHERE run_id=? ORDER BY hrc_seq', (run1,))
        counts = collections.Counter(e['event_kind'] for e in events)
        broker = s.rows('SELECT seq FROM broker_invocation_events WHERE invocation_id=?', (inv['invocation_id'],))
        dispositions = s.rows('SELECT seq FROM broker_projection_dispositions WHERE invocation_id=?', (inv['invocation_id'],))
        checks.update({
            'brokerPid': broker_pid, 'projectedBeforeRestart': before,
            'projectedAfter': inv['last_projected_seq'], 'runtimeStatus': s.rows('SELECT status FROM runtimes WHERE runtime_id=?', (runtime,))[0]['status'],
            'runs': len(s.rows('SELECT run_id FROM runs')), 'eventCounts': counts,
            'brokerRows': len(broker), 'uniqueBrokerSeqs': len({r['seq'] for r in broker}),
            'dispositions': len(dispositions),
        })
        assert counts['turn.completed'] == 1 and counts['turn.started'] == 1 and counts['turn.accepted'] == 1, counts
        assert counts['turn.tool_call'] == 1 and counts['turn.tool_result'] == 1, counts
        # Every reply row is one broker message; the broker itself may emit a
        # hook fallback final beside the transcript's (harness race, not replay).
        messages = s.rows("SELECT seq FROM broker_invocation_events WHERE invocation_id=? AND type='assistant.message.completed' AND run_id=?", (inv['invocation_id'], run1))
        checks['replyRows'] = counts['turn.message']
        checks['brokerMessages'] = len(messages)
        assert counts['turn.message'] == len(messages) >= 1, (counts, messages)
        assert checks['runs'] == 1 and len(broker) == len({r['seq'] for r in broker}), checks
        assert before < inv['last_projected_seq'], (before, inv['last_projected_seq'])
        checks['gate2a'] = 'pass'
        checks['nativeDownExit'] = s.down(native)
        os.kill(broker_pid, 0)
        hrc_before = s.rows('SELECT COUNT(*) AS n FROM hrc_events')[0]['n']
        bun = s.up('bun', 'c')
        s.wait(lambda: s.rows('SELECT 1 FROM broker_invocations WHERE runtime_id=? AND owner_server_instance_id=?',
                              (runtime, f'hrc-server:{bun.pid}')), 120, 'bun reattach')
        status = s.rows('SELECT status FROM runtimes WHERE runtime_id=?', (runtime,))[0]['status']
        new_rows = [r['event_kind'] for r in s.rows('SELECT event_kind FROM hrc_events WHERE hrc_seq>? ORDER BY hrc_seq', (hrc_before,))]
        checks['bunAttach'] = {'status': status, 'newEventKinds': new_rows}
        assert status == 'ready' and not [k for k in new_rows if k.startswith('turn.')], checks['bunAttach']
        second = s.command('bun-warm-turn', start + ['Reply with exactly the word AGAIN and nothing else. No tools.'])
        run2 = second['runtime']['runId']
        assert run2 != run1 and second['runtime']['runtimeId'] == runtime, second
        s.wait_completed(run2)
        checks['bunRun'] = run2
        checks['gate2b'] = 'pass'
        s.dump('restart', {'checks': checks, 'scope': scope, 'runtimeId': runtime, 'steps': s.steps})
        print(json.dumps({'pass': ['2'], 'checks': checks}, default=str))
    finally:
        (args.artifacts / 'restart-steps.json').write_text(json.dumps({'checks': checks, 'steps': s.steps}, indent=1, default=str) + '\n')
        s.cleanup(prefix)


if __name__ == '__main__':
    main()
