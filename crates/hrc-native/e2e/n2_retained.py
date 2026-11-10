#!/usr/bin/env python3
"""N2 retained-evidence recovery on a real hrcpty seat, on rusthrc.

A real claude-hrcpty seat is born and goes idle. The owner is killed (SIGKILL),
and while it is down the operator attaches (the argv GET /v1/attach served),
types a turn and quits: the broker commits those envelopes to its ledger with
nobody projecting them. The hrc-pty supervisor is then killed with its tree (a
reboot), ending the broker. The owner restarts with a zero revivable hold, so
its startup pass recovers the unprojected tail offline. It must record a
recovered outcome, mirror the ledger tail envelope for envelope under
evidence_origin = 'retained' with no live rows, write retained lifecycle rows,
and leave the cursors and the retained fence equal. Failure modes: the tail
lost, a retained row written as live, the runtime's current state changed by
history, and a recovery that spawns against a live worker.
"""
import argparse
import fcntl
import os
import pty
import struct
import termios
import threading
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


class Attached:
    """The operator's hrc-pty attach client on a real terminal."""
    def __init__(self, s, argv):
        self.master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 120, 0, 0))
        self.proc = subprocess.Popen(argv, env=s.env, cwd=s.project, stdin=slave, stdout=slave, stderr=slave,
                                     start_new_session=True)
        os.close(slave)
        threading.Thread(target=self._drain, daemon=True).start()
        time.sleep(3)

    def _drain(self):
        while True:
            try:
                if not os.read(self.master, 65536):
                    return
            except OSError:
                return

    def type(self, text):
        for ch in text:
            os.write(self.master, ch.encode())
            time.sleep(.05)
        time.sleep(1)
        os.write(self.master, b'\r')


def kill_tree(runtime):
    out = subprocess.run(['/bin/ps', '-axo', 'pid=,ppid=,command='], capture_output=True, text=True).stdout
    procs = [(int(a), int(b), c) for a, b, c in (l.split(None, 2) for l in out.splitlines() if len(l.split(None, 2)) == 3)]
    doomed = {pid for pid, _, cmd in procs if 'hrc-pty serve' in cmd and runtime in cmd}
    roots, grew = set(doomed), True
    while grew:
        grew = False
        for pid, ppid, _ in procs:
            if ppid in doomed and pid not in doomed:
                doomed.add(pid)
                grew = True
    for pid in doomed:
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    return sorted(roots)


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
    scope = prefix + 'retained'
    out = {}
    try:
        s.init_substrate()
        owner = s.up('native', 'a')
        cold = s.command('cold-start', ['hrc', 'start', scope, '--project-id', s.project_id, '--project-root',
                                        s.project, '--cwd', s.project, '--json', '-p', PROMPT])
        runtime = cold['runtime']['runtimeId']
        s.wait_completed(cold['runtime']['runId'])
        s.wait(lambda: s.rows("SELECT 1 FROM runtimes WHERE runtime_id=? AND status='ready' AND active_run_id IS NULL", (runtime,)), 300, 'idle')
        time.sleep(2)
        status, attach = s.http('GET', f'/v1/attach?runtimeId={runtime}')
        assert status == 200 and attach.get('transport') == 'hrcpty', attach
        invocation = s.rows('SELECT active_invocation_id FROM runtimes WHERE runtime_id=?', (runtime,))[0]['active_invocation_id']
        projected_before = s.rows('SELECT last_projected_seq FROM broker_invocations WHERE invocation_id=?', (invocation,))[0]['last_projected_seq']
        ledgers = [l for l in (s.root / 'run/bipc').glob('*/events.ndjson') if invocation in l.read_text()]
        assert len(ledgers) == 1, ledgers
        ledger = ledgers[0]
        out['ownerKilled'] = s.down(owner, signal.SIGKILL)
        # Native serve fails closed on a crashed owner's files; the owner is dead.
        for name in ('server.lock', 'server.pid', 'hrc.sock'):
            (s.root / 'run' / name).unlink(missing_ok=True)
        size = ledger.stat().st_size
        operator = Attached(s, attach['argv'])
        operator.type('Reply with exactly the word UNSEEN and nothing else. No tools.')
        s.wait(lambda: 'turn.completed' in tail(ledger, size), 300, 'unprojected turn completed in the ledger')
        time.sleep(2)
        operator.type('/quit')
        # With no owner to reap the lease, the supervisor stays up after the
        # quit; the reboot below ends it.
        s.wait(lambda: any(k in tail(ledger, size) for k in ('continuation.cleared', 'invocation.exited')), 120, 'quit recorded in the ledger')
        time.sleep(2)
        out['killedSupervisors'] = kill_tree(runtime)
        assert out['killedSupervisors'], 'no hrc-pty supervisor to kill'
        operator.proc.kill()
        out['ledgerTailTypes'] = sorted({e['type'] for e in map(parse, tail(ledger, size).splitlines()) if e and not e['type'].endswith('.delta')})
        s.env['HRC_BROKER_HOLD_MAX_AGE_MS'] = '0'
        s.up('native', 'b')
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
        # The broker wrote this tail with no owner up: it is this run's input,
        # and every non-delta envelope must be mirrored once, in order.
        out['ledgerTail'] = [e['type'] for e in map(parse, ledger.read_text().splitlines())
                             if e and e.get('invocationId') == invocation and e.get('seq', 0) > projected_before and not e['type'].endswith('.delta')]
        out['liveMirrorAfter'] = s.rows("SELECT COUNT(*) AS n FROM broker_invocation_events WHERE invocation_id=? AND seq>? AND (evidence_origin IS NULL OR evidence_origin!='retained')", (invocation, projected_before))[0]['n']
        out['retainedLifecycle'] = [r['event_kind'] for r in s.rows("SELECT event_kind FROM hrc_events WHERE runtime_id=? AND evidence_origin='retained' ORDER BY hrc_seq", (runtime,))]
        rt = s.rows('SELECT status, runtime_state_json FROM runtimes WHERE runtime_id=?', (runtime,))[0]
        st = json.loads(rt['runtime_state_json'] or '{}')
        out['runtime'] = {'status': rt['status'], 'staleReason': st.get('staleReason'), 'hasFinalSummary': st.get('finalSummary') is not None}
        status, inspect = s.http('POST', '/v1/runtimes/broker/inspect', {'runtimeId': runtime})
        out['inspectRetained'] = [{k: e.get(k) for k in ('outcome', 'class', 'trigger', 'attempts')} for e in (inspect.get('retainedEvidence') or [])] if isinstance(inspect, dict) else status
        (args.artifacts / 'retained.json').write_text(json.dumps(out, indent=1, default=str) + '\n')
        s.dump('rows')
        assert out['outcomes'] and out['outcomes'][-1]['outcome'] in ('recovered', 'recovered_torn_tail'), out['outcomes']
        assert out['retainedMirror'] and out['liveMirrorAfter'] == 0, (len(out['retainedMirror']), out['liveMirrorAfter'])
        assert out['ledgerTail'] == out['retainedMirror'], ('retained mirror is not the ledger tail', out['ledgerTail'], out['retainedMirror'])
        assert 'turn.completed' in out['retainedLifecycle'], out['retainedLifecycle']
        assert out['invocation']['cursorAdvanced'] and out['invocation']['fenceEqualsCursor'] and out['invocation']['lastEventIsCursor'], out['invocation']
        assert out['runtime']['status'] in ('terminated', 'stale', 'dead', 'crashed'), out['runtime']
        assert out['inspectRetained'] and out['inspectRetained'][-1]['outcome'] == out['outcomes'][-1]['outcome'], out['inspectRetained']
        print(json.dumps({'pass': True, 'outcomes': out['outcomes'], 'retainedMirror': len(out['retainedMirror'])}))
    finally:
        (args.artifacts / 'steps.json').write_text(json.dumps(s.steps, indent=1) + '\n')
        s.cleanup(prefix)


if __name__ == '__main__':
    main()
