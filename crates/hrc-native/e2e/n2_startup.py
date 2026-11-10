#!/usr/bin/env python3
"""N2 startup reconciliation on rusthrc with real hrcpty seats.

Two real seats are born and go idle; the owner stops. While it is down, seat
B's hrc-pty supervisor is killed with its tree, and two rows are planted: a
legacy runtime with no controller kind, and a terminated runtime still naming
an accepted run. On restart seat A must be reattached ready (and take a warm
turn), seat B staled with a reason, the legacy row staled, the terminal run
settled once, and warmup logged. Failure modes: a dead seat left ready, a live
seat staled, a terminal runtime's run left accepted, and the warmup counting
rows the classifier staled.

The tmux lease GC half (btmux orphan servers, dead lease sockets, renderer
control sockets, the 300 s GC tick) is gone with the substrate.
"""
import argparse
import json
import os
import signal
import sqlite3
import subprocess
import time
from pathlib import Path

from n2_scratch import Scratch

PROMPT = 'Reply with exactly the word OK and nothing else. No tools.'


def born(s, scope):
    cold = s.command('cold-start-' + scope.rsplit(':', 1)[-1], ['hrc', 'start', scope, '--project-id', s.project_id, '--project-root',
                                                                 s.project, '--cwd', s.project, '--json', '-p', PROMPT])
    runtime = cold['runtime']['runtimeId']
    s.wait_completed(cold['runtime']['runId'])
    s.wait(lambda: s.rows("SELECT 1 FROM runtimes WHERE runtime_id=? AND status='ready' AND active_run_id IS NULL", (runtime,)), 300, 'idle')
    return runtime, cold['hostSessionId']


def plant_rows(db_path, template_runtime):
    db = sqlite3.connect(db_path)
    db.row_factory = sqlite3.Row
    t = dict(db.execute('SELECT * FROM runtimes WHERE runtime_id=?', (template_runtime,)).fetchone())
    now = time.strftime('%Y-%m-%dT%H:%M:%S.000Z', time.gmtime())
    cols = [k for k in t]

    def insert(overrides):
        row = dict(t, **overrides)
        db.execute(f"INSERT INTO runtimes ({','.join(cols)}) VALUES ({','.join('?' * len(cols))})", [row[c] for c in cols])
    insert({'runtime_id': 'rt-n2-legacy', 'controller_kind': None, 'transport': 'headless', 'status': 'ready', 'tmux_json': None,
            'runtime_state_json': None, 'active_run_id': None, 'active_invocation_id': None, 'active_operation_id': None,
            'created_at': now, 'updated_at': now, 'status_changed_at': now})
    insert({'runtime_id': 'rt-n2-terminal', 'status': 'terminated', 'active_run_id': 'run-n2-terminal', 'active_invocation_id': None,
            'active_operation_id': None, 'tmux_json': None, 'runtime_state_json': json.dumps({'status': 'terminated'}),
            'created_at': now, 'updated_at': now, 'status_changed_at': now})
    db.execute("INSERT INTO runs (run_id, host_session_id, runtime_id, scope_ref, lane_ref, generation, transport, status, accepted_at, updated_at, execution_format) VALUES ('run-n2-terminal', ?, 'rt-n2-terminal', ?, ?, ?, 'headless', 'accepted', ?, ?, 'format1')",
               (t['host_session_id'], t['scope_ref'], t['lane_ref'], t['generation'], now, now))
    db.commit()
    db.close()


def kill_tree(runtime):
    """SIGKILL the runtime's hrc-pty supervisor and everything under it (a dead lease)."""
    out = subprocess.run(['/bin/ps', '-axo', 'pid=,ppid=,command='], capture_output=True, text=True).stdout
    procs = [(int(x), int(y), c) for x, y, c in (l.split(None, 2) for l in out.splitlines() if len(l.split(None, 2)) == 3)]
    doomed = {pid for pid, _, cmd in procs if 'hrc-pty serve' in cmd and runtime in cmd}
    roots, grew = sorted(doomed), True
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
    return roots


def events_for(s, runtime, before):
    return [{'kind': r['event_kind'], 'payload': json.loads(r['payload_json'] or 'null')}
            for r in s.rows('SELECT event_kind, payload_json FROM hrc_events WHERE hrc_seq>? AND runtime_id=? ORDER BY hrc_seq', (before, runtime))]


def log_events(path, name):
    out = []
    for line in Path(path).read_text().splitlines():
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        if isinstance(entry, dict) and entry.get('event') == name:
            out.append(entry.get('data'))
    return out


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
    out = {}
    try:
        s.init_substrate()
        owner = s.up('native', 'a')
        a, host_a = born(s, prefix + 'startup-a')
        b, _ = born(s, prefix + 'startup-b')
        time.sleep(2)
        out['downExit'] = s.down(owner)
        out['killedB'] = kill_tree(b)
        assert out['killedB'], 'no hrc-pty supervisor for seat B'
        time.sleep(1)
        plant_rows(s.db_path, a)
        before = s.rows('SELECT COALESCE(MAX(hrc_seq),0) AS m FROM hrc_events')[0]['m']
        owner = s.up('native', 'b')
        log = args.artifacts / 'native-b.log'
        s.wait(lambda: log_events(log, 'broker.warmup.complete'), 120, 'warmup complete')
        labels = {a: 'seatA', b: 'seatB', 'rt-n2-legacy': 'legacy', 'rt-n2-terminal': 'terminal'}
        out['runtimes'] = {}
        for rid, label in labels.items():
            r = s.rows('SELECT status, active_run_id, runtime_state_json FROM runtimes WHERE runtime_id=?', (rid,))[0]
            st = json.loads(r['runtime_state_json'] or '{}')
            out['runtimes'][label] = {'status': r['status'], 'activeRun': r['active_run_id'] is not None,
                                      'staleReason': st.get('staleReason'), 'control': st.get('control'),
                                      'events': events_for(s, rid, before)}
        out['terminalRun'] = s.rows("SELECT status, error_code, error_message FROM runs WHERE run_id='run-n2-terminal'")[0]
        out['warmup'] = log_events(log, 'broker.warmup.complete')
        out['warmupRuntimes'] = [dict(d, runtimeId=labels.get(d.get('runtimeId'), d.get('runtimeId'))) for d in log_events(log, 'broker.warmup.runtime')]
        out['terminalReconciled'] = [{k: d.get(k) for k in ('priorStatus', 'runStatusBefore', 'runStatusAfter')}
                                     for d in log_events(log, 'runtime.terminal_active_run.reconciled')]
        status, warm = s.http('POST', '/v1/turns', {'hostSessionId': host_a, 'prompt': PROMPT, 'waitFor': 'terminal'}, timeout=600)
        out['warmTurn'] = {'status': status, 'outcome': warm.get('outcome') if isinstance(warm, dict) else None}
        (args.artifacts / 'startup.json').write_text(json.dumps(out, indent=1, default=str) + '\n')
        s.dump('rows')
        rts = out['runtimes']
        assert rts['seatA']['status'] == 'ready' and not rts['seatA']['activeRun'], rts['seatA']
        assert out['warmTurn'] == {'status': 200, 'outcome': 'completed'}, out['warmTurn']
        assert rts['seatB']['status'] == 'stale' and rts['seatB']['staleReason'], rts['seatB']
        assert rts['legacy']['status'] == 'stale', rts['legacy']
        assert rts['terminal']['status'] == 'terminated' and not rts['terminal']['activeRun'], rts['terminal']
        assert out['terminalRun']['status'] not in ('accepted', 'running'), out['terminalRun']
        assert len(out['terminalReconciled']) == 1 and out['terminalReconciled'][0]['runStatusBefore'] == 'accepted', out['terminalReconciled']
        # Only seat A is warmed: rows the classifier staled are not counted.
        assert len(out['warmup']) == 1 and out['warmup'][0]['total'] == 1 and out['warmup'][0]['attached'] == 1, out['warmup']
        print(json.dumps({'pass': True, 'warmup': out['warmup'], 'seatB': rts['seatB']['staleReason']}))
    finally:
        (args.artifacts / 'steps.json').write_text(json.dumps(s.steps, indent=1) + '\n')
        s.cleanup(prefix)


if __name__ == '__main__':
    main()
