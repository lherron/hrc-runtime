#!/usr/bin/env python3
"""N2 retained-evidence recovery on one owner (bun or native), for
`compare --suite n2-retained`.

A real claude-code-tmux seat is born and goes idle. The owner is killed
(SIGKILL), and while it is down a human turn is typed into the TUI and the
operator quits: the broker commits those envelopes to its ledger with nobody
projecting them. The lease tmux server is then killed (a reboot), ending the
broker. The
owner restarts with a zero revivable hold, so its startup pass recovers the
unprojected tail offline through the release's evidence-read mode. Both owners
must record the same outcome and project the same rows under
evidence_origin = 'retained'. Failure modes: the tail lost, a retained row
written as live, the runtime's current state changed by history, and a
recovery that spawns against a live worker.
"""
import argparse
import json
import signal
import subprocess
import time
from pathlib import Path

from n2_scratch import Scratch

PROMPT = 'Reply with exactly the word OK and nothing else. No tools.'


def tail(ledger, offset):
    """The ledger bytes written after `offset`, decoded."""
    with open(ledger, 'rb') as f:
        f.seek(offset)
        return f.read().decode('utf-8', 'replace')


def parse(line):
    try:
        value = json.loads(line)
    except ValueError:
        return None
    return value if isinstance(value, dict) and isinstance(value.get('type'), str) else None


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
    scope = prefix + 'retained-' + args.owner
    out = {}
    try:
        s.init_substrate()
        owner = s.up(args.owner, 'a')
        cold = s.command('cold-start', ['hrc', 'start', scope, '--project-id', s.project_id, '--project-root',
                                        s.project, '--cwd', s.project, '--json', '-p', PROMPT])
        runtime = cold['runtime']['runtimeId']
        s.wait_completed(cold['runtime']['runId'])
        s.wait(lambda: s.rows("SELECT 1 FROM runtimes WHERE runtime_id=? AND status='ready' AND active_run_id IS NULL", (runtime,)), 300, 'idle')
        time.sleep(2)
        state = json.loads(s.rows('SELECT runtime_state_json FROM runtimes WHERE runtime_id=?', (runtime,))[0]['runtime_state_json'])
        tmux, lease = state['tmux'], state['broker']['brokerWindow']['socketPath']
        invocation = s.rows('SELECT active_invocation_id FROM runtimes WHERE runtime_id=?', (runtime,))[0]['active_invocation_id']
        projected_before = s.rows('SELECT last_projected_seq FROM broker_invocations WHERE invocation_id=?', (invocation,))[0]['last_projected_seq']
        out['ownerKilled'] = s.down(owner, signal.SIGKILL)
        # rusthrc does not yet reclaim a dead owner's server lock (Bun does; N5's
        # server lifecycle). The harness clears it only after proving the pid gone.
        run_dir = s.root / 'run'
        if args.owner == 'native' and (run_dir / 'server.lock').exists():
            subprocess.run(['kill', '-0', str(owner.pid)], capture_output=True, check=False).returncode != 0 or (_ for _ in ()).throw(AssertionError('owner still alive'))
            for name in ('server.lock', 'server.pid', 'hrc.sock'):
                (run_dir / name).unlink(missing_ok=True)
            out['nativeStaleLockCleared'] = True
        ledger = Path(state['broker']['brokerCommand'].split("'--event-ledger' '")[1].split("'")[0]) if "'--event-ledger' '" in state['broker']['brokerCommand'] \
            else Path(state['broker']['brokerCommand'].split('--event-ledger ')[1].split()[0])
        size = ledger.stat().st_size
        subprocess.run(['tmux', '-S', tmux['socketPath'], 'send-keys', '-t', tmux['paneId'], '-l', 'Reply with exactly the word UNSEEN and nothing else. No tools.'], check=True)
        time.sleep(.5)
        subprocess.run(['tmux', '-S', tmux['socketPath'], 'send-keys', '-t', tmux['paneId'], 'Enter'], check=True)
        s.wait(lambda: 'turn.completed' in tail(ledger, size), 300, 'unprojected turn completed in the ledger')
        time.sleep(2)
        subprocess.run(['tmux', '-S', tmux['socketPath'], 'send-keys', '-t', tmux['paneId'], '-l', '/quit'], check=True)
        time.sleep(.5)
        subprocess.run(['tmux', '-S', tmux['socketPath'], 'send-keys', '-t', tmux['paneId'], 'Enter'], check=True)
        # With no owner to reap the lease, the broker stays up after the quit;
        # the reboot below ends it.
        s.wait(lambda: any(k in tail(ledger, size) for k in ('continuation.cleared', 'invocation.exited')), 120, 'quit recorded in the ledger')
        time.sleep(2)
        subprocess.run(['tmux', '-S', lease, 'kill-server'], capture_output=True)
        out['ledgerTailTypes'] = sorted({e['type'] for e in map(parse, tail(ledger, size).splitlines()) if e and not e['type'].endswith('.delta')})
        s.env['HRC_BROKER_HOLD_MAX_AGE_MS'] = '0'
        s.up(args.owner, 'b')
        s.wait(lambda: s.rows('SELECT 1 FROM retained_evidence_outcomes WHERE runtime_id=?', (runtime,)), 120, 'retained outcome recorded')
        time.sleep(3)
        out['outcomes'] = s.rows('SELECT outcome, outcome_class, trigger, attempts FROM retained_evidence_outcomes WHERE runtime_id=? ORDER BY outcome_id', (runtime,))
        detail = json.loads(s.rows('SELECT detail_json FROM retained_evidence_outcomes WHERE runtime_id=? ORDER BY outcome_id DESC LIMIT 1', (runtime,))[0]['detail_json'])
        out['outcomeDetailKeys'] = sorted(detail)
        inv = s.rows('SELECT invocation_state, lifecycle_terminal_reason, last_projected_seq, retained_projected_through_seq, last_event_seq FROM broker_invocations WHERE invocation_id=?', (invocation,))[0]
        out['invocation'] = {'state': inv['invocation_state'], 'terminalReason': inv['lifecycle_terminal_reason'],
                             'cursorAdvanced': inv['last_projected_seq'] > projected_before,
                             'fenceEqualsCursor': inv['retained_projected_through_seq'] == inv['last_projected_seq'],
                             'lastEventIsCursor': inv['last_event_seq'] == inv['last_projected_seq']}
        out['retainedMirror'] = [r['type'] for r in s.rows("SELECT type FROM broker_invocation_events WHERE invocation_id=? AND evidence_origin='retained' ORDER BY seq", (invocation,))]
        out['liveMirrorAfter'] = s.rows("SELECT COUNT(*) AS n FROM broker_invocation_events WHERE invocation_id=? AND seq>? AND (evidence_origin IS NULL OR evidence_origin!='retained')", (invocation, projected_before))[0]['n']
        out['retainedLifecycle'] = [r['event_kind'] for r in s.rows("SELECT event_kind FROM hrc_events WHERE runtime_id=? AND evidence_origin='retained' ORDER BY hrc_seq", (runtime,))]
        rt = s.rows('SELECT status, runtime_state_json FROM runtimes WHERE runtime_id=?', (runtime,))[0]
        st = json.loads(rt['runtime_state_json'] or '{}')
        out['runtime'] = {'status': rt['status'], 'staleReason': st.get('staleReason'), 'hasFinalSummary': st.get('finalSummary') is not None}
        status, inspect = s.http('POST', '/v1/runtimes/broker/inspect', {'runtimeId': runtime})
        out['inspectRetained'] = [{k: e.get(k) for k in ('outcome', 'class', 'trigger', 'attempts')} for e in (inspect.get('retainedEvidence') or [])] if isinstance(inspect, dict) else status
        (args.artifacts / f'{args.owner}.json').write_text(json.dumps(out, indent=1, default=str) + '\n')
        s.dump(args.owner + '-rows')
        print(json.dumps({'owner': args.owner, 'outcomes': out['outcomes'], 'retainedMirror': len(out['retainedMirror'])}))
    finally:
        (args.artifacts / f'{args.owner}-steps.json').write_text(json.dumps(s.steps, indent=1) + '\n')
        s.cleanup(prefix)


if __name__ == '__main__':
    main()
