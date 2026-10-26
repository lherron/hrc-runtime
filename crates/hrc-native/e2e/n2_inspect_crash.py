#!/usr/bin/env python3
"""N2 broker death mid-turn, then broker inspect with recoverFinalSummary, on
one owner (bun or native), for `compare --suite n2-inspect-crash`.

A real seat starts a long turn; once the broker reports turn.started its
process is SIGKILLed (the daemon stays up). The owner's close path settles the
runtime, and POST /v1/runtimes/broker/inspect asks for the final summary. Both
owners must leave the same runtime and run state, answer inspect with the same
status, recovery state and retained-evidence view, and record the same
retained outcomes. Failure modes: the runtime left non-terminal, a report path
that attaches to (or reports) a dead broker as live, and a missing summary
recovery where Bun recovers one.
"""
import argparse
import json
import os
import signal
import time
from pathlib import Path

from n2_scratch import Scratch

PROMPT = 'Reply with exactly the word OK and nothing else. No tools.'
LONG = 'Write the numbers from 1 to 400, one per line, with no other text. No tools.'


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
    scope = prefix + 'crash-' + args.owner
    out = {}
    try:
        s.init_substrate()
        s.up(args.owner, 'a')
        cold = s.command('cold-start', ['hrc', 'start', scope, '--project-id', s.project_id, '--project-root',
                                        s.project, '--cwd', s.project, '--json', '-p', PROMPT])
        runtime, host = cold['runtime']['runtimeId'], cold['hostSessionId']
        s.wait_completed(cold['runtime']['runId'])
        s.wait(lambda: s.rows("SELECT 1 FROM runtimes WHERE runtime_id=? AND status='ready' AND active_run_id IS NULL", (runtime,)), 300, 'idle')
        time.sleep(2)
        before = s.rows('SELECT COALESCE(MAX(hrc_seq),0) AS m FROM hrc_events')[0]['m']
        status, turn = s.http('POST', '/v1/turns', {'hostSessionId': host, 'prompt': LONG})
        run = turn.get('runId') if isinstance(turn, dict) else None
        s.wait(lambda: s.rows("SELECT 1 FROM hrc_events WHERE hrc_seq>? AND runtime_id=? AND event_kind='turn.started'", (before, runtime)), 120, 'turn started')
        pid = json.loads(s.rows('SELECT runtime_state_json FROM runtimes WHERE runtime_id=?', (runtime,))[0]['runtime_state_json'])['broker']['brokerPid']
        os.kill(pid, signal.SIGKILL)
        s.wait(lambda: s.rows("SELECT 1 FROM runtimes WHERE runtime_id=? AND status IN ('terminated','failed','crashed','dead','stale')", (runtime,)), 120, 'runtime settled after broker death')
        time.sleep(3)
        status, inspect = s.http('POST', '/v1/runtimes/broker/inspect', {'runtimeId': runtime, 'recoverFinalSummary': {'timeoutMs': 2000}}, timeout=60)
        out['inspect'] = {'status': status,
                          'runtimeStatus': inspect.get('status') if isinstance(inspect, dict) else None,
                          'finalSummaryRecovery': inspect.get('finalSummaryRecovery') if isinstance(inspect, dict) else None,
                          'hasFinalSummary': isinstance(inspect, dict) and inspect.get('finalSummary') is not None,
                          'retainedEvidence': [{k: e.get(k) for k in ('outcome', 'class', 'trigger', 'attempts')} for e in inspect.get('retainedEvidence', [])] if isinstance(inspect, dict) else None,
                          'error': inspect.get('error', {}).get('code') if isinstance(inspect, dict) and 'error' in inspect else None}
        time.sleep(3)
        r = s.rows('SELECT status, active_run_id, runtime_state_json FROM runtimes WHERE runtime_id=?', (runtime,))[0]
        st = json.loads(r['runtime_state_json'] or '{}')
        out['runtime'] = {'status': r['status'], 'activeRun': r['active_run_id'] is not None, 'hasFinalSummary': st.get('finalSummary') is not None}
        out['run'] = s.rows('SELECT status, error_code FROM runs WHERE run_id=?', (run,))[0] if run else None
        out['outcomes'] = s.rows('SELECT outcome, outcome_class, trigger, attempts FROM retained_evidence_outcomes WHERE runtime_id=? ORDER BY outcome_id', (runtime,))
        out['events'] = [e['event_kind'] for e in s.rows("SELECT event_kind FROM hrc_events WHERE hrc_seq>? AND runtime_id=? AND event_kind LIKE 'runtime.%' ORDER BY hrc_seq", (before, runtime))]
        (args.artifacts / f'{args.owner}.json').write_text(json.dumps(out, indent=1, default=str) + '\n')
        s.dump(args.owner + '-rows')
        print(json.dumps({'owner': args.owner, **out}, default=str))
    finally:
        (args.artifacts / f'{args.owner}-steps.json').write_text(json.dumps(s.steps, indent=1) + '\n')
        s.cleanup(prefix)


if __name__ == '__main__':
    main()
