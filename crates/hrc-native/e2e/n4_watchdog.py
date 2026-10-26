#!/usr/bin/env python3
"""N4 first-turn watchdog: Bun then native trip the same armed rows.

One fixture store holds armed runtime_first_turn_watch rows already past their
deadline; each owner boots on its own fresh copy with a 1s evaluation interval
and must trip, stamp, fail the armed run and publish the diagnostic bundle
exactly as the other does. Cases:
  open-run      run still open, invocation spec with prompt-bearing argv and
                env (redacted), a fake harness answering --version, and a live
                private tmux pane (captured)
  completed-run run already terminal: tripped, run left alone; no spec, no pane
  no-runtime    no runtime row
  rotated       runtime generation moved on: pane capture refused
  future        deadline not reached: untouched
  disarmed      disarmed row: untouched
  started       first turn already observed: untouched

Failure modes: a row tripped early or twice, a trip without its stamp, a run
re-terminated, a bundle field missing instead of named in failures, a prompt
written in clear, a pointer published before its directory, and event or
manifest key-order drift.
"""
import argparse
import datetime
import json
from pathlib import Path
import re
import shutil
import sqlite3
import subprocess
import time

from n3_scratch import Scratch

PROJECT = 'n4-t11872w'
CASES = ['open-run', 'completed-run', 'no-runtime', 'rotated', 'future', 'disarmed', 'started']
TRIPPED = 4
PROMPT = 'n4 watchdog priming prompt'


def iso(dt):
    return dt.strftime('%Y-%m-%dT%H:%M:%S.') + f'{dt.microsecond // 1000:03d}Z'


def scope(case):
    return f'agent:hunter:project:{PROJECT}:task:{case}'


def fixtures(db_path, root, tmux):
    now = datetime.datetime.now(datetime.timezone.utc)
    stamp = iso(now)
    harness = root / 'fake-harness'
    harness.write_text('#!/bin/sh\necho "fake-harness 1.2.3 (n4)"\necho second line\n')
    harness.chmod(0o755)
    spec = {'harness': {'frontend': 'claude-code', 'provider': 'anthropic'},
            'process': {'command': str(harness), 'cwd': str(root),
                        'args': ['--model', 'opus', '-p', PROMPT, '--append-system-prompt=be terse', '--', 'tail'],
                        'lockedEnv': {'ASP_PRIMING_PROMPT': PROMPT, 'OTHER': 'x'}},
            'continuation': {'provider': 'anthropic', 'key': 'cont-n4'},
            'launch': {'initialPrompt': PROMPT}, 'sdk': {'modelId': 'claude-opus'}}
    db = sqlite3.connect(db_path)
    with db:
        for i, case in enumerate(CASES):
            hsid, rt = f'hsid-w-{case}', f'rt-w-{case}'
            deadline = now + datetime.timedelta(minutes=10) if case == 'future' else now - datetime.timedelta(seconds=60 - i)
            sent = deadline - datetime.timedelta(seconds=120)
            db.execute('INSERT INTO sessions (host_session_id, scope_ref, lane_ref, generation, status, created_at, updated_at) '
                       'VALUES (?,?,?,?,?,?,?)', (hsid, scope(case), 'main', 2 if case == 'rotated' else 1, 'active', stamp, stamp))
            if case != 'no-runtime':
                tmux_json = json.dumps(tmux) if case in ('open-run', 'rotated') else None
                db.execute('INSERT INTO runtimes (runtime_id, host_session_id, scope_ref, lane_ref, generation, transport, '
                           'harness, provider, status, tmux_json, supports_inflight_input, created_at, updated_at) '
                           'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
                           (rt, hsid, scope(case), 'main', 2 if case == 'rotated' else 1, 'tmux', 'claude-code',
                            'anthropic', 'terminated', tmux_json, 0, stamp, stamp))
                done = case == 'completed-run'
                db.execute('INSERT INTO runs (run_id, host_session_id, runtime_id, scope_ref, lane_ref, generation, '
                           'transport, status, accepted_at, completed_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
                           (f'run-w-{case}', hsid, rt, scope(case), 'main', 1, 'tmux',
                            'completed' if done else 'accepted', stamp, stamp if done else None, stamp))
            if case == 'open-run':
                db.execute('INSERT INTO broker_invocations (invocation_id, operation_id, runtime_id, run_id, broker_protocol, '
                           'broker_driver, invocation_state, capabilities_json, spec_hash, start_request_hash, '
                           'selected_profile_hash, spec_projection_json, created_at, updated_at) '
                           'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
                           (f'inv-w-{case}', f'op-w-{case}', rt, f'run-w-{case}', 'harness-broker/0.2', 'claude-code-tmux',
                            'exited', '{}', 'h', 'h', 'h', json.dumps(spec), stamp, stamp))
            db.execute('INSERT INTO runtime_first_turn_watch (runtime_id, generation, host_session_id, scope_ref, lane_ref, '
                       'run_id, invocation_id, transport, priming_dispatched_at, first_turn_deadline_at, first_turn_at, '
                       'disarmed_at, disarm_reason, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
                       (rt, 1, hsid, scope(case), 'main', None if case == 'no-runtime' else f'run-w-{case}',
                        f'inv-w-{case}' if case == 'open-run' else None, 'tmux', iso(sent), iso(deadline),
                        stamp if case == 'started' else None, stamp if case == 'disarmed' else None,
                        'n4 fixture' if case == 'disarmed' else None, iso(sent), iso(sent)))
    # The schema runs in WAL mode: fold the fixtures into the main file.
    db.execute('PRAGMA wal_checkpoint(TRUNCATE)')
    db.close()


TS = re.compile(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z')


def observe(s, root):
    events = s.rows("SELECT hrc_seq, event_kind, error_code, host_session_id, scope_ref, lane_ref, generation, runtime_id, "
                    "run_id, transport, payload_json FROM hrc_events WHERE event_kind LIKE 'first_turn_missing%' "
                    "ORDER BY hrc_seq")
    ordinal = {e['hrc_seq']: i + 1 for i, e in enumerate(events)}

    def seq(n):
        return f'#{ordinal.get(n, "?")}' if isinstance(n, int) else n

    def text(v):
        v = v.replace(str(root), '<root>')
        v = re.sub(r'(diagnostics |first-turn-missing[-/])(\d+)', lambda m: m[1] + seq(int(m[2])), v)
        return TS.sub('<ts>', v)

    def norm(v, key=None):
        if isinstance(v, dict):
            return {k: norm(x, k) for k, x in v.items()}
        if isinstance(v, list):
            return [norm(x) for x in v]
        if key in ('tripEventSeq', 'trip_event_seq', 'diagnostics_event_seq', 'hrc_seq'):
            return seq(v)
        return text(v) if isinstance(v, str) else v

    out = {'events': [norm({**{k: v for k, v in e.items() if k != 'payload_json'},
                            'payload': json.loads(e['payload_json'])}) for e in events]}
    out['watches'] = norm(s.rows('SELECT * FROM runtime_first_turn_watch ORDER BY runtime_id'))
    out['runs'] = norm(s.rows('SELECT run_id, status, completed_at, error_code, error_message FROM runs ORDER BY run_id'))
    out['artifacts'] = norm(s.rows("SELECT artifact_id, operation_id, artifact_kind, media_type, storage_kind, "
                                   "artifact_path, artifact_json FROM runtime_artifacts ORDER BY artifact_id"))
    bundles = {}
    for w in s.rows('SELECT runtime_id, bundle_dir FROM runtime_first_turn_watch WHERE bundle_dir IS NOT NULL'):
        d = Path(w['bundle_dir'])
        bundles[w['runtime_id']] = {
            'files': sorted(p.name for p in d.iterdir()),
            'modes': {p.name: oct(p.stat().st_mode & 0o777) for p in sorted(d.iterdir())} | {'.': oct(d.stat().st_mode & 0o777)},
            'manifest': norm(json.loads((d / 'manifest.json').read_text())),
            'manifestTrailingNewline': (d / 'manifest.json').read_text().endswith('}\n'),
            'pane': (d / 'pane.txt').read_text() if (d / 'pane.txt').exists() else None,
        }
    out['bundles'] = bundles
    return out


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--binary', type=Path, required=True)
    p.add_argument('--installed-release', type=Path, required=True)
    p.add_argument('--aspd-socket', type=Path, required=True)
    p.add_argument('--scratch-root', type=Path, required=True)
    p.add_argument('--artifacts', type=Path, required=True)
    args = p.parse_args()
    s = Scratch(args.scratch_root, args.installed_release, args.aspd_socket, args.binary, args.artifacts,
                project_id=PROJECT)
    s.env.update(HRC_FIRST_TURN_EVAL_INTERVAL_SECONDS='1')
    sock = s.root / 'run/n4w-tmux.sock'
    out = {}
    try:
        s.init_substrate()
        subprocess.run(['tmux', '-S', str(sock), 'new-session', '-d', '-s', 'n4w', '-x', '80', '-y', '6',
                        "printf 'n4 watchdog pane\\nsecond line\\n'; sleep 900"], env=s.env, check=True)
        pane = subprocess.run(['tmux', '-S', str(sock), 'display', '-p', '-t', 'n4w', '#{pane_id}'],
                              env=s.env, check=True, capture_output=True, text=True).stdout.strip()
        tmux = {'socketPath': str(sock), 'sessionName': 'n4w', 'windowName': 'tui', 'windowId': '@0',
                'paneId': pane, 'hrcRole': 'tui'}
        fixtures(s.db_path, s.root, tmux)
        frozen = s.root / 'frozen.sqlite'
        with sqlite3.connect(s.db_path) as src, sqlite3.connect(frozen) as dst:
            src.backup(dst)
        assert sqlite3.connect(frozen).execute('SELECT COUNT(*) FROM runtime_first_turn_watch').fetchone()[0] == len(CASES)
        for owner in ('bun', 'native'):
            for suffix in ('', '-wal', '-shm'):
                Path(str(s.db_path) + suffix).unlink(missing_ok=True)
            shutil.rmtree(s.root / 'run/artifacts', ignore_errors=True)
            with sqlite3.connect(frozen) as src, sqlite3.connect(s.db_path) as dst:
                src.backup(dst)
            proc = s.up(owner, 'watchdog')
            s.wait(lambda: len(s.rows("SELECT 1 FROM hrc_events WHERE event_kind='first_turn_missing.diagnostics'"))
                   >= TRIPPED, timeout=60, what=f'{owner} diagnostics')
            # Two more evaluation intervals: nothing else may trip.
            time.sleep(2.5)
            s.down(proc)
            out[owner] = observe(s, s.root)
            (args.artifacts / owner).mkdir(exist_ok=True)
            (args.artifacts / owner / 'watchdog.json').write_text(json.dumps(out[owner], indent=1) + '\n')
        print(json.dumps({o: {'events': len(v['events']), 'bundles': len(v['bundles'])} for o, v in out.items()}))
    finally:
        subprocess.run(['tmux', '-S', str(sock), 'kill-server'], capture_output=True, timeout=5)
        (args.artifacts / 'steps.json').write_text(json.dumps(s.steps, indent=1) + '\n')
        s.cleanup('agent:')


if __name__ == '__main__':
    main()
