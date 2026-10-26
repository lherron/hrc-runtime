#!/usr/bin/env python3
"""N2 cold-boot input recovery on one owner (bun or native), for `compare --suite n2-recovery`.

A real seat is born and goes idle; the owner stops; three accepted headless
runs with the durable cold-boot input shape Bun writes are planted in the
scratch store: one owed to the live seat, one whose runtime is gone, one with
no durable prompt. The owner restarts and its startup recovery must deliver
the first and fail the other two with cold_input_continuation_lost. Failure
modes: a lost run left accepted (it would age into a zombie), the owed prompt
never delivered or delivered twice, and recovery touching a non-candidate.
"""
import argparse
import json
from pathlib import Path
import sqlite3
import time

from n2_scratch import Scratch

PROMPT = 'Reply with exactly the word OK and nothing else. No tools.'
OWED = 'Reply with exactly the word RECOVERED and nothing else. No tools.'


def plant(db_path, runtime, session):
    db = sqlite3.connect(db_path)
    now = time.strftime('%Y-%m-%dT%H:%M:%S.000Z', time.gmtime())
    cold = {'kind': 'durable_cold_boot_turn_input', 'prompt': OWED, 'source': 'cold_boot',
            'dispatch': {'submissionDoor': 'invoke'}}
    rows = [('run-n2-recover-live', runtime, json.dumps(cold)),
            ('run-n2-recover-missing', 'rt-n2-recover-gone', json.dumps(cold)),
            ('run-n2-recover-nondurable', runtime, None)]
    for run_id, rt, correlation in rows:
        db.execute("INSERT INTO runs (run_id, host_session_id, runtime_id, scope_ref, lane_ref, generation, transport, status, accepted_at, updated_at, correlation_json, execution_format) VALUES (?, ?, ?, ?, ?, ?, 'headless', 'accepted', ?, ?, ?, 'format1')",
                   (run_id, session['host_session_id'], rt, session['scope_ref'], session['lane_ref'], session['generation'], now, now, correlation))
    db.commit()
    db.close()
    return [r[0] for r in rows]


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
    scope = prefix + 'recovery-' + args.owner
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
        session = s.rows('SELECT host_session_id, scope_ref, lane_ref, generation FROM sessions WHERE host_session_id=(SELECT host_session_id FROM runtimes WHERE runtime_id=?)', (runtime,))[0]
        out['downExit'] = s.down(owner)
        planted = plant(s.db_path, runtime, session)
        before = s.rows('SELECT COALESCE(MAX(hrc_seq),0) AS m FROM hrc_events')[0]['m']
        owner = s.up(args.owner, 'b')
        s.wait(lambda: all(r['status'] != 'accepted' for r in s.rows(f"SELECT status FROM runs WHERE run_id IN ({','.join('?' * len(planted))})", planted)), 300, 'planted runs settled')
        s.wait(lambda: s.rows("SELECT 1 FROM runs WHERE run_id='run-n2-recover-live' AND completed_at IS NOT NULL"), 300, 'owed turn completed')
        time.sleep(2)
        out['runs'] = {r['run_id']: {'status': r['status'], 'errorCode': r['error_code'], 'dispatched': r['dispatched_input_id'] is not None}
                       for r in s.rows(f"SELECT run_id, status, error_code, dispatched_input_id FROM runs WHERE run_id IN ({','.join('?' * len(planted))})", planted)}
        out['events'] = {rid: [r['event_kind'] for r in s.rows('SELECT event_kind FROM hrc_events WHERE hrc_seq>? AND run_id=? ORDER BY hrc_seq', (before, rid))]
                         for rid in planted}
        out['failedPayloads'] = {r['run_id']: json.loads(r['payload_json']) for r in s.rows("SELECT run_id, payload_json FROM hrc_events WHERE hrc_seq>? AND event_kind='turn.failed'", (before,))}
        out['userPrompts'] = [json.loads(r['payload_json']) for r in s.rows("SELECT payload_json FROM hrc_events WHERE hrc_seq>? AND event_kind='turn.user_prompt'", (before,))]
        out['otherRunsTouched'] = s.rows("SELECT COUNT(*) AS n FROM runs WHERE run_id NOT IN ('run-n2-recover-live','run-n2-recover-missing','run-n2-recover-nondurable') AND updated_at > (SELECT ts FROM hrc_events WHERE hrc_seq=?)", (before,))[0]['n'] if before else 0
        (args.artifacts / f'{args.owner}.json').write_text(json.dumps(out, indent=1, default=str) + '\n')
        s.dump(args.owner + '-rows')
        print(json.dumps({'owner': args.owner, 'runs': out['runs']}))
    finally:
        (args.artifacts / f'{args.owner}-steps.json').write_text(json.dumps(s.steps, indent=1) + '\n')
        s.cleanup(prefix)


if __name__ == '__main__':
    main()
