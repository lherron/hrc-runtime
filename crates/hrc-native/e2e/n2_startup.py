#!/usr/bin/env python3
"""N2 startup reconciliation and broker lease GC on one owner (bun or native),
for `compare --suite n2-startup`.

Two real seats are born and go idle; the owner stops. While it is down, seat
B's lease tmux server is killed, an unclaimed live lease server, a dead lease
socket file and an unheld renderer-control socket are planted under btmux/, and
two rows are planted: a legacy runtime with no controller kind, and a terminated
runtime still naming an accepted run. The owner restarts with a zero orphan
grace. Seat A must be attached (and take a warm turn), seat B staled with
Bun's reason, the orphans reclaimed, the legacy row staled, the terminal run
settled, the warmup summary equal to Bun's, and one recurring GC tick logged. Failure modes: a dead seat left
ready, a live seat staled, a claimed lease killed, an unclaimed one kept, a
held or young socket removed, and the warmup counting rows the classifier staled.
"""
import argparse
import json
import socket
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


def plant_files(btmux):
    btmux.mkdir(parents=True, exist_ok=True)
    orphan = btmux / 'n2-orphan.sock'
    subprocess.run(['tmux', '-S', str(orphan), 'new-session', '-d', '-s', 'hrc-n2-orphan', 'sleep 900'], check=True)
    dead = btmux / 'n2-dead.sock'
    dead.write_text('')
    renderer = btmux / 'codex-app-server-renderer-control.n2.sock'
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.bind(str(renderer))
    sock.close()
    # Age every planted entry past any grace by mtime.
    old = time.time() - 3600
    for p in (orphan, dead, renderer):
        import os
        os.utime(p, (old, old), follow_symlinks=False)
    return orphan, dead, renderer


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
    p.add_argument('--owner', choices=['bun', 'native'], required=True)
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
        owner = s.up(args.owner, 'a')
        a, host_a = born(s, prefix + 'startup-a-' + args.owner)
        b, _ = born(s, prefix + 'startup-b-' + args.owner)
        time.sleep(2)
        out['downExit'] = s.down(owner)
        state_b = json.loads(s.rows('SELECT runtime_state_json FROM runtimes WHERE runtime_id=?', (b,))[0]['runtime_state_json'])
        lease_b = state_b['broker']['brokerWindow']['socketPath']
        subprocess.run(['tmux', '-S', lease_b, 'kill-server'], check=False)
        btmux = (s.root / 'run') / 'btmux'
        orphan, dead, renderer = plant_files(btmux)
        plant_rows(s.db_path, a)
        before = s.rows('SELECT COALESCE(MAX(hrc_seq),0) AS m FROM hrc_events')[0]['m']
        s.env['HRC_BROKER_ORPHAN_SWEEP_GRACE_MS'] = '0'
        owner = s.up(args.owner, 'b')
        log = args.artifacts / f'{args.owner}-b.log'
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
        out['files'] = {'orphanSocket': orphan.exists(), 'deadSocket': dead.exists(), 'renderer': renderer.exists(),
                        'orphanServerAlive': subprocess.run(['tmux', '-S', str(orphan), 'has-session'], capture_output=True).returncode == 0}
        out['warmup'] = log_events(log, 'broker.warmup.complete')
        out['warmupRuntimes'] = [dict(d, runtimeId=labels.get(d.get('runtimeId'), d.get('runtimeId'))) for d in log_events(log, 'broker.warmup.runtime')]
        out['renderer'] = [{k: v for k, v in d.items() if k not in ('holderEnumerationMs',)} for d in log_events(log, 'broker.renderer_control_socket_sweep_complete')]
        out['orphanSwept'] = [d.get('sessions') for d in log_events(log, 'broker.orphan_lease_swept')]
        out['deadRemoved'] = len(log_events(log, 'broker.dead_lease_socket_removed'))
        out['terminalReconciled'] = [{k: d.get(k) for k in ('priorStatus', 'runStatusBefore', 'runStatusAfter')}
                                     for d in log_events(log, 'runtime.terminal_active_run.reconciled')]
        status, warm = s.http('POST', '/v1/turns', {'hostSessionId': host_a, 'prompt': PROMPT, 'waitFor': 'terminal'}, timeout=600)
        out['warmTurn'] = {'status': status, 'outcome': warm.get('outcome') if isinstance(warm, dict) else None}
        # The recurring lease GC ticks one 300 s cadence after boot.
        s.wait(lambda: log_events(log, 'broker.lease_gc_sweep_complete'), 420, 'recurring lease GC tick')
        out['gcTick'] = log_events(log, 'broker.lease_gc_sweep_complete')[0]
        (args.artifacts / f'{args.owner}.json').write_text(json.dumps(out, indent=1, default=str) + '\n')
        s.dump(args.owner + '-rows')
        print(json.dumps({'owner': args.owner, 'warmup': out['warmup'], 'files': out['files']}))
    finally:
        (args.artifacts / f'{args.owner}-steps.json').write_text(json.dumps(s.steps, indent=1) + '\n')
        s.cleanup(prefix)
        subprocess.run(['tmux', '-S', str((s.root / 'run') / 'btmux' / 'n2-orphan.sock'), 'kill-server'], capture_output=True)


if __name__ == '__main__':
    main()
