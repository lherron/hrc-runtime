#!/usr/bin/env python3
"""admin metrics/runs/broker-verify/events-drain/worktrees-audit: Bun oracle vs rusthrc.

Failure modes: metrics rollups drift on JS number semantics (percentile ranks,
toFixed ties, Math.round halves, Number() limits, Date range), files outside the
day window are read, malformed records are counted, route sort ties break
differently, the idle inventory goes stale; run repair parses Commander's view
instead of the raw argv Bun reads (first --older-than wins, --output json stays
human) or mutates on a non-TTY without --yes; broker-verify drops the exact-scope
filter, the 50-row limit or tie order; drain opens the live store, sends a wire
event Bun would not (the receiver refuses a divergent duplicate), mishandles
cursor files, retained runs or dead letters; worktree audit misreads wrkq,
git, occupancy or task tokens. Every --yes case selects nothing and the seat is
proven unchanged afterwards.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import tempfile
from datetime import datetime, timedelta, timezone

from metrics_isolation import isolated_suite
from n5b_common import Runner, normalize, scratch_env

NORMALIZATION = {
    # metrics routes: the window start is computed from the wall clock.
    'routes_cutoff_human': (r'(Request metrics since )-?\+?\d{4,6}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z', r'\1<cutoff>'),
    'routes_cutoff_json': (r'("since": ")-?\+?\d{4,6}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z(")', r'\1<cutoff>\2'),
    # drain: dead letters and server log lines are stamped when written.
    'dead_lettered_at': (r'("deadLetteredAt": ")\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z(")', r'\1<ts>\2'),
    'server_log_ts': (r'(\{"ts":")\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z(","level")', r'\1<ts>\2'),
}

# What a --yes sweep-zombies/reconcile-active writes to a run it selects.
SWEEP_ERROR_CODES = {
    'run_zombie_timeout', 'run_abandoned_by_runtime', 'runtime_terminated_with_active_run',
    'runtime_dead_with_active_run', 'runtime_ready_with_active_run', 'runtime_process_exited_with_active_run',
    'runtime_unavailable_with_active_run', 'runtime_busy_timeout_with_active_run',
}


def iso(t):
    return t.astimezone(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.') + f'{t.microsecond // 1000:03d}Z'


def sh(*args, cwd=None, env=None, check=True):
    c = subprocess.run(args, cwd=cwd, env=env, text=True, capture_output=True)
    if check and c.returncode != 0:
        raise RuntimeError(f'{args}: {c.stderr or c.stdout}')
    return c.stdout


def seat_snapshot(store, rid, host):
    """The seat facts a run-repair mutation could change. Runs may progress
    under concurrent use by the seat's owner; none may carry a sweep's mark."""
    db = sqlite3.connect(f'file:{store}?mode=ro', uri=True)
    runtime = db.execute('SELECT runtime_id, host_session_id, scope_ref, lane_ref, generation, transport, '
                         'active_invocation_id FROM runtimes WHERE runtime_id = ?', (rid,)).fetchone()
    session = db.execute('SELECT host_session_id, scope_ref, lane_ref, generation, status FROM sessions '
                         'WHERE host_session_id = ?', (host,)).fetchone()
    invocations = db.execute('SELECT invocation_id, invocation_state FROM broker_invocations WHERE runtime_id = ? '
                             'ORDER BY invocation_id', (rid,)).fetchall()
    marked = db.execute(f'SELECT run_id, status, error_code FROM runs WHERE runtime_id = ? AND '
                        f'(status = \'zombie\' OR error_code IN ({",".join("?" * len(SWEEP_ERROR_CODES))}))',
                        (rid, *sorted(SWEEP_ERROR_CODES))).fetchall()
    db.close()
    return dict(runtime=list(runtime), session=list(session), invocations=[list(r) for r in invocations],
                sweepMarkedRuns=[list(r) for r in marked])


def clone_row(db, table, where, params=(), **overrides):
    cols = [r[1] for r in db.execute(f'PRAGMA table_info({table})')]
    exprs = ['?' if c in overrides else c for c in cols]
    values = [overrides[c] for c in cols if c in overrides]
    db.execute(f'INSERT INTO {table} ({",".join(cols)}) SELECT {",".join(exprs)} FROM {table} WHERE {where}',
               values + list(params))


def store_copy(store, dest):
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists():
        dest.unlink()
    src = sqlite3.connect(f'file:{store}?mode=ro', uri=True)
    src.execute(f"VACUUM INTO '{dest}'")
    src.close()
    return sqlite3.connect(dest)


# -- metrics fixture --------------------------------------------------------------

def metrics_fixture(root, now):
    """Day files around a 7d window, with every record shape the readers judge."""
    day = lambda d: (now - timedelta(days=d)).strftime('%Y-%m-%d')
    ts = lambda **kw: iso(now - timedelta(**kw))
    cli = lambda cmd, dur, out, rpc=(), bin='hrc', at=None: dict(v=1, kind='cli', ts=at or ts(hours=1), bin=bin, cmd=cmd, durMs=dur, stdoutBytes=out, rpc=list(rpc))
    rpc = lambda i, ms, path='/v1/runtimes', status=200, nbytes=10: dict(id=i, path=path, method='GET', ms=ms, status=status, bytes=nbytes)
    srv = lambda route, ms, status=200, **kw: dict(v=1, kind='server', ts=kw.pop('at', ts(hours=2)), route=route, method=kw.pop('method', 'GET'), ms=ms, status=status, **kw)
    files = {}
    files[f'cli-{day(0)}.ndjson'] = [
        cli('monitor events', 19.944208, 140553, [rpc('r1', 3.25), rpc('r2', 1.5)]),
        cli('monitor events', 63.659125, 1200, [rpc('r3', 10)]),
        cli('monitor events', 5, 0),
        cli('monitor Events', 7.5, 33),
        cli('a-b', 1, 1), cli('a_b', 2, 2), cli('ab', 3, 3), cli('a.b', 4, 4), cli('A b', 5, 5),
        cli('send', 65.739667, 1355, bin='hrcchat'),
        cli('server status', 0.1 + 0.2, 7),
        dict(v=1.0, kind='cli', ts=ts(hours=3), bin='hrc', cmd='float version', durMs=2, stdoutBytes=2, rpc=[]),
        cli('bad rpc', 1, 1, [dict(id='x', path='/p', method='GET', ms=-1, status=200, bytes=1)]),
        dict(v=1, kind='cli', ts=ts(hours=1), bin='other', cmd='skip', durMs=1, stdoutBytes=1, rpc=[]),
        dict(v=1, kind='cli', ts=ts(hours=1), bin='hrc', cmd='neg', durMs=-1, stdoutBytes=1, rpc=[]),
        dict(v=1, kind='cli', ts='not a date', bin='hrc', cmd='bad ts', durMs=1, stdoutBytes=1, rpc=[]),
        dict(v=1, kind='launch', ts=ts(hours=1), bin='hrc', cmd='start', startupMs=812.5,
             phases=[dict(phase='resolve', ms=10), dict(phase='attach', ms=700.25)]),
        dict(v=1, kind='launch', ts=ts(hours=1), bin='hrc', cmd='start', startupMs=901,
             phases=[dict(phase='resolve', ms=12), dict(phase='attach', ms=650)]),
        dict(v=1, kind='launch', ts=ts(hours=1), bin='hrcchat', cmd='run', startupMs=44, phases=[dict(phase='resolve', ms=10)]),
        dict(v=1, kind='launch', ts=ts(hours=1), bin='hrc', cmd='bad phases', startupMs=1, phases=[dict(phase=3, ms=1)]),
    ]
    files[f'cli-{day(2)}.ndjson'] = [cli(f'monitor stats', i * 1.25, i * 100, at=ts(days=2, hours=1)) for i in range(1, 22)]
    # Name inside the window, records on both sides of the cutoff.
    files[f'cli-{day(7)}.ndjson'] = [
        cli('edge in', 9, 9, at=ts(days=7, hours=-2)),
        cli('edge out', 9, 9, at=ts(days=7, hours=2)),
    ]
    files[f'cli-{day(9)}.ndjson'] = [cli('old file', 1, 1, at=ts(hours=1))]
    files[f'server-{day(0)}.ndjson'] = [
        srv('/v1/runtimes', 27.48674999998184, bytes=9659, reqId='r1', client='hrc-cli/1'),
        srv('/v1/runtimes', 0.25, bytes=10, reqId='r2', client='hrc-cli/1', at=ts(hours=5)),
        srv('/v1/runtimes', 0.15, status=503, bytes=20, client='hrc-cli/2'),
        srv('/v1/runtimes', 0.05, stream=True, bytes=99999, client='hrc-cli/2'),
        srv('/v1/sessions/by-host/:hostSessionId', 1.0, bytes=5, sampleWeight=31),
        srv('/v1/sessions/by-host/:hostSessionId', 4.0, status=404, bytes=5),
        srv('/v1/status', 8.877666000000033, sampleWeight=3, bytes=2003, reqId='r3'),
        srv('/v1/ingest', 2.5, method='POST', listener='ingest', bytes=12, client='hrc-server/0.5'),
        srv('/v1/runs', 1.2, listener='peer', bytes=77, client='peer-x'),
        srv('/v1/runs', 3.3, bytes=78),
        srv('/v1/bindings', 0.75, listener='registry'),
        srv('/v1/skip', 1, listener='bogus'),
        srv('/v1/skip', 1, sampleWeight=1.5),
        srv('/v1/skip', 1, stream=False),
        srv('/v1/skip', 1, reqId=7),
        dict(v=1, kind='counter', ts=ts(hours=1), name='ledger.blob_miss', value=2),
        dict(v=1, kind='counter', ts=ts(hours=1), name='ledger.blob_miss', value=0.5),
        dict(v=1, kind='counter', ts=ts(hours=1), name='metrics.dropped', value=7),
        dict(v=1, kind='counter', ts=ts(hours=1), name='other', value=7),
        dict(v=1, kind='launch_span', ts=ts(hours=1), phase='broker-start-total', runtimeId='rt-1', ms=966.4),
        dict(v=1, kind='launch_span', ts=ts(hours=1), phase='broker-start-total', transport='headless', runtimeId='rt-2', ms=120),
        dict(v=1, kind='launch_span', ts=ts(hours=1), phase='precompile', transport='interactive', runtimeId='rt-3', ms=120),
        dict(v=1, kind='launch_span', ts=ts(hours=1), phase='bad', transport='tcp', runtimeId='rt-4', ms=1),
    ]
    files[f'server-{day(1)}.ndjson'] = [
        srv('/v1/runtimes', 36.21704200000386, bytes=1883, client='hrc-cli/1', at=ts(days=1)),
        srv('/v1/events', 0.95, bytes=1, at=ts(days=1, hours=1)),
    ]
    raw = {name: '\n'.join(json.dumps(r, separators=(',', ':')) for r in rows) + '\n' for name, rows in files.items()}
    raw[f'cli-{day(0)}.ndjson'] += '\nnot json\n   \n[1,2]\nnull\n{"v":1,"kind":"cli"}\r\n'
    raw[f'server-{day(1)}.ndjson'] = raw[f'server-{day(1)}.ndjson'].replace('\n', '\r\n')
    full = root / 'full' / 'metrics'
    full.mkdir(parents=True)
    for name, text in raw.items():
        (full / name).write_text(text)
    (full / 'cli-2026-1-1.ndjson').write_text(raw[f'cli-{day(0)}.ndjson'])
    (full / 'notes.txt').write_text('ignored\n')
    (full / f'server-{day(3)}.ndjson').mkdir()  # selected and counted, unreadable
    (root / 'empty' / 'metrics').mkdir(parents=True)
    (root / 'nodir').mkdir(parents=True)
    (root / 'file').mkdir(parents=True)
    (root / 'file' / 'metrics').write_text('not a directory\n')


# -- broker-verify fixture ----------------------------------------------------------

def broker_verify_fixture(store, root, seat):
    db = store_copy(store, root / 'state.sqlite')
    scope = 'agent:n5bbv:project:hrc-runtime:task:bv-fixture'
    rid, inv = seat['start']['runtimeId'], db.execute('SELECT invocation_id FROM broker_invocations LIMIT 1').fetchone()[0]
    providers = {'rt-bv-openai': 'openai', 'rt-bv-anthropic': 'anthropic', 'rt-bv-none': None}
    for runtime, provider in providers.items():
        clone_row(db, 'runtimes', 'runtime_id = ?', (rid,), runtime_id=runtime, scope_ref=scope, provider=provider, status='dead')
    drivers = ['codex-app-server', 'claude-code-tmux', 'pi-sdk', 'harness-x']
    next_seq = db.execute('SELECT MAX(stream_seq) FROM hrc_events').fetchone()[0]
    for i in range(55):
        runtime = list(providers)[i % 3]
        run = None if i % 4 == 0 else f'run-bv-{i:02d}'
        stamp = f'2026-10-01T00:00:{i // 3:02d}.000Z'
        clone_row(db, 'broker_invocations', 'invocation_id = ?', (inv,), invocation_id=f'inv-bv-{i:02d}',
                  operation_id=f'op-bv-{i:02d}', runtime_id=runtime, run_id=run, broker_driver=drivers[i % 4],
                  invocation_state=['ready', 'exited', 'failed'][i % 3], created_at='2026-10-01T00:00:00.000Z', updated_at=stamp)
        for seq in range(1, (i % 5) + 1):
            clone_row(db, 'broker_invocation_events', 'invocation_id = ? AND seq = ?', (inv, seq),
                      id=None, invocation_id=f'inv-bv-{i:02d}', runtime_id=runtime, run_id=run,
                      time=f'2026-10-01T00:01:{seq:02d}.000Z')
        for k in range(i % 3):
            next_seq += 1
            clone_row(db, 'hrc_events', 'stream_seq = 1', (), hrc_seq=None, stream_seq=next_seq,
                      runtime_id=runtime, run_id=run or 'run-other', scope_ref=scope)
    db.commit()
    db.close()
    return scope


# -- drain fixture --------------------------------------------------------------------

BIG_EVENTS = (400_000, 400_000, 400_000, 1_100_000)

def drain_fixture(store, root, seat):
    """A dead ledger whose local tails are real seat rows moved to an inert scope."""
    path = root / 'pristine' / 'dead.sqlite'
    db = store_copy(store, path)
    rid, host, scope = seat['start']['runtimeId'], seat['start']['hostSessionId'], seat['scope']
    runs = [r[0] for r in db.execute('SELECT run_id FROM runs WHERE runtime_id = ?', (rid,))]
    inv = db.execute('SELECT invocation_id FROM broker_invocations WHERE runtime_id = ?', (rid,)).fetchone()[0]
    keep = [r[0] for r in db.execute('SELECT hrc_seq FROM hrc_events WHERE source_ref IS NULL ORDER BY stream_seq LIMIT 12')]
    db.execute(f'DELETE FROM hrc_events WHERE hrc_seq NOT IN ({",".join(map(str, keep))})')
    keep_b = [r[0] for r in db.execute('SELECT id FROM broker_invocation_events WHERE source_ref IS NULL ORDER BY id LIMIT 10')]
    db.execute(f'DELETE FROM broker_invocation_events WHERE id NOT IN ({",".join(map(str, keep_b))})')
    db.execute('DELETE FROM tool_result_blobs')
    blob = json.dumps({'ok': 'blob', 'note': 'caf\u00e9'}, separators=(',', ':'), ensure_ascii=False)
    digest_src = json.dumps([list(r) for r in db.execute('SELECT * FROM hrc_events ORDER BY hrc_seq')] +
                            [list(r) for r in db.execute('SELECT * FROM broker_invocation_events ORDER BY id')] + [blob, BIG_EVENTS])
    tag = hashlib.sha1(digest_src.encode()).hexdigest()[:10]
    ids = {rid: f'rt-n5bdrain-{tag}', host: f'hsid-n5bdrain-{tag}', scope: f'agent:n5bdrain:project:hrc-runtime:task:drain-{tag}',
           inv: f'inv-n5bdrain-{tag}', **{run: f'run-n5bdrain-{tag}-{i}' for i, run in enumerate(runs)}}
    for table, columns in (('hrc_events', ('host_session_id', 'scope_ref', 'runtime_id', 'run_id', 'payload_json')),
                           ('broker_invocation_events', ('invocation_id', 'runtime_id', 'run_id', 'broker_event_json'))):
        for old, new in ids.items():
            for column in columns:
                db.execute(f'UPDATE {table} SET {column} = replace({column}, ?, ?)', (old, new))
    db.execute('UPDATE broker_invocation_events SET broker_envelope_json = NULL')
    db.execute(f"UPDATE hrc_events SET evidence_origin = 'retained' WHERE hrc_seq IN ({keep[4]},{keep[5]})")
    db.execute(f"UPDATE hrc_events SET source_ref = 'foreign-node', origin_seq = 1 WHERE hrc_seq = {keep[11]}")
    db.execute(f"UPDATE broker_invocation_events SET evidence_origin = 'retained' WHERE id = {keep_b[2]}")
    # Frame bounding: three ~400KB events overflow one 1MiB frame (prefix split);
    # the 1.1MB one can never be sent and is dead-lettered client-side.
    top = db.execute('SELECT MAX(stream_seq) FROM hrc_events').fetchone()[0]
    for i, size in enumerate(BIG_EVENTS, 1):
        clone_row(db, 'hrc_events', 'hrc_seq = ?', (keep[0],), hrc_seq=None, stream_seq=top + i,
                  payload_json=json.dumps({'pad': 'x' * size, 'i': i}, separators=(',', ':')))
    db.execute("INSERT INTO tool_result_blobs (blob_id, runtime_id, kind, bytes, complete, result_json, created_at) "
               "VALUES (?, ?, 'broker_raw', ?, 1, ?, '2026-10-01T00:00:00.000Z')",
               (f'blob-n5bdrain-{tag}', ids[rid], len(blob.encode()), blob))
    db.commit()
    db.close()
    empty = store_copy(path, root / 'pristine' / 'empty.sqlite')
    for table in ('hrc_events', 'broker_invocation_events', 'tool_result_blobs'):
        empty.execute(f'DELETE FROM {table}')
    empty.commit()
    empty.close()
    (root / 'garbage.sqlite').write_text('garbage\n')
    (root / 'a-directory.sqlite').mkdir()
    return f'n5b-admin-drain-{tag}', ids


# -- worktree fixture ----------------------------------------------------------------

def worktree_fixture(store, root, seat):
    git_env = {k: v for k, v in os.environ.items() if not k.startswith('GIT_')}
    git_env.update(GIT_AUTHOR_NAME='n5b', GIT_AUTHOR_EMAIL='n5b@example.invalid', GIT_COMMITTER_NAME='n5b',
                   GIT_COMMITTER_EMAIL='n5b@example.invalid', GIT_AUTHOR_DATE='2026-10-01T00:00:00Z',
                   GIT_COMMITTER_DATE='2026-10-01T00:00:00Z')
    git = lambda *a, cwd: sh('git', *a, cwd=cwd, env=git_env)
    root.mkdir(parents=True)
    wrkq_env = {k: v for k, v in os.environ.items() if not k.startswith(('WRKQ', 'HRC_'))}
    wrkq_env['WRKQ_DB'] = str(root / 'wrkq.db')
    wrkq = lambda *a: sh('wrkq', *a, cwd=root, env=wrkq_env)
    sh('wrkqadm', 'init', '--attach-dir', str(root / 'attach'), cwd=root, env=wrkq_env)
    for project in ('alpha', 'beta', 'gamma', 'delta', 'epsilon'):
        wrkq('mkdir', f'/{project}')
    states = ['completed', 'open', 'completed', 'completed', 'completed', 'completed', 'completed',
              'completed', 'completed', 'completed', 'cancelled']
    ids = []
    for i, state in enumerate(states, 1):
        out = json.loads(wrkq('touch', f'/alpha/t{i}', '--state', state, '--json'))
        ids.append(out[0]['id'] if isinstance(out, list) else out['id'])
    assert ids == [f'T-{i:05d}' for i in range(1, 12)], ids

    alpha = root / 'alpha'
    alpha.mkdir()
    git('init', '-q', '-b', 'main', cwd=alpha)
    (alpha / 'README').write_text('alpha\n')
    git('add', 'README', cwd=alpha)
    git('commit', '-q', '-m', 'init', cwd=alpha)
    wts = root / 'alpha-wt'
    branches = {
        'T-00001-done': 'w1', 'T-00002-open': 'w2', 'feature/T-00003-dirty': 'w3', 'T-00004-unmerged': 'w4',
        'T-00005-occupied': 'w5', 'T-00006-ident': 'w6', 'T-00007-last': 'w7', 'multi-T-00009-T-00002': 'w9',
        'T-77777-ghost': 'w-ghost', 'T-00001-gone': 'w-gone', 'no-token': 'w-none', 'T-00010-dead-occupant': 'w10',
        'work/XT-00011Z-edge': 'w11',
    }
    for branch, name in branches.items():
        git('worktree', 'add', '-q', '-b', branch, str(wts / name), cwd=alpha)
    git('worktree', 'add', '-q', '--detach', str(wts / 'detached-T-00008'), cwd=alpha)
    git('worktree', 'add', '-q', '--detach', str(wts / 'detached-plain'), cwd=alpha)
    (wts / 'w3' / 'scratch.txt').write_text('dirty\n')
    (wts / 'w4' / 'extra').write_text('x\n')
    git('add', 'extra', cwd=wts / 'w4')
    git('commit', '-q', '-m', 'unmerged', cwd=wts / 'w4')
    shutil.rmtree(wts / 'w-gone')
    (root / 'beta-plain').mkdir()
    wrkq('set', '/alpha', '--root', str(alpha))
    wrkq('set', '/beta', '--root', str(root / 'beta-plain'))
    wrkq('set', '/gamma', '--root', str(root / 'gamma-missing'))
    broken = root / 'epsilon-broken'
    (broken / '.git').mkdir(parents=True)
    wrkq('set', '/epsilon', '--root', str(broken))
    delta = root / 'search' / 'delta'
    delta.mkdir(parents=True)
    git('init', '-q', '-b', 'main', cwd=delta)
    (delta / 'README').write_text('delta\n')
    git('add', 'README', cwd=delta)
    git('commit', '-q', '-m', 'init', cwd=delta)
    git('worktree', 'add', '-q', '-b', 'T-00002-delta', str(root / 'delta-wt'), cwd=delta)

    db = store_copy(store, root / 'state' / 'state.sqlite')
    rid = seat['start']['runtimeId']
    inv = db.execute('SELECT invocation_id FROM broker_invocations WHERE runtime_id = ?', (rid,)).fetchone()[0]
    scope = seat['scope']
    spec = lambda cwd: json.dumps({'process': {'cwd': cwd}})
    occupants = [
        ('rt-wt-cwd', 'ready', 'inv-wt-cwd', [('inv-wt-cwd', spec(str(wts / 'w5' / 'sub')), '2026-10-01T00:00:00.000Z')]),
        ('rt-wt-ident', 'busy', None, []),
        ('rt-wt-last', 'ready', None, [('inv-wt-last-a', spec('/elsewhere'), '2026-10-01T00:00:00.000Z'),
                                       ('inv-wt-last-b', spec(str(wts / 'w7')), '2026-10-02T00:00:00.000Z')]),
        ('rt-wt-dead', 'dead', 'inv-wt-dead', [('inv-wt-dead', spec(str(wts / 'w10')), '2026-10-01T00:00:00.000Z')]),
    ]
    for runtime, status, active, invocations in occupants:
        runtime_scope = f'agent:wt:project:alpha:task:{runtime}'
        clone_row(db, 'runtimes', 'runtime_id = ?', (rid,), runtime_id=runtime, status=status,
                  active_invocation_id=active, scope_ref=runtime_scope, lane_ref='main')
        for invocation, projection, created in invocations:
            clone_row(db, 'broker_invocations', 'invocation_id = ?', (inv,), invocation_id=invocation,
                      operation_id=f'op-{invocation}', runtime_id=runtime, spec_projection_json=projection, created_at=created)
    db.execute("UPDATE runtimes SET scope_ref = 'agent:wt:project:alpha:task:T-00006' WHERE runtime_id = 'rt-wt-ident'")
    clone_row(db, 'continuities', 'scope_ref = ? AND lane_ref = ?', (scope, 'main'),
              scope_ref='agent:wt:project:alpha:task:T-00006', project_id='alpha', task_id='T-00006', agent_id='wt')
    db.commit()
    db.close()
    # An unmigrated ledger: wrkq refuses it the same way for both sides.
    sh('wrkq', 'projects', '--json', cwd=root, env={**wrkq_env, 'WRKQ_DB': str(root / 'unmigrated.db')}, check=False)
    return alpha


@isolated_suite
def main():
    p = argparse.ArgumentParser()
    for flag in ('binary', 'oracle', 'runtime-root', 'state-root', 'seat', 'artifacts'):
        p.add_argument('--' + flag, type=Path, required=True)
    args = p.parse_args()
    seat = json.loads(args.seat.read_text())
    rid, host, scope = seat['start']['runtimeId'], seat['start']['hostSessionId'], seat['scope']
    store = args.state_root / 'state.sqlite'
    before = seat_snapshot(store, rid, host)
    fix = Path(tempfile.mkdtemp(prefix='n5b-admin-', dir='/tmp')).resolve()
    base = scratch_env(args.runtime_root, args.state_root)
    runner = Runner(args.binary, args.oracle, args.artifacts, base, NORMALIZATION, timeout=120)
    tools = runner.artifacts / 'tools'
    tools.mkdir(exist_ok=True)
    for tool in ('wrkq', 'git'):
        target = tools / tool
        if target.is_symlink() or target.exists():
            target.unlink()
        target.symlink_to(shutil.which(tool))
    assert not (tools / 'bun').exists()
    runner.subject_path = f'{tools}:{runner.subject_path}'

    def fresh(argv, setup, env, name=None):
        """Each side gets its own pristine copy at the same path."""
        setup()
        oracle = runner.observe(argv, False, env)
        setup()
        subject = runner.observe(argv, True, env)
        ok = normalize(oracle, runner.normalization) == normalize(subject, runner.normalization)
        runner.results.append(dict(case=name or ' '.join(argv), argv=argv, oracle=oracle, subject=subject, **{'pass': ok}))

    # -- admin metrics report / routes ---------------------------------------------
    now = datetime.now(timezone.utc)
    metrics_fixture(fix / 'metrics', now)
    mstate = fix / 'mstate'

    def metrics_variant(variant):
        def setup():
            shutil.rmtree(mstate, ignore_errors=True)
            shutil.copytree(fix / 'metrics' / variant, mstate, symlinks=True)
        return setup
    menv = scratch_env(args.runtime_root, mstate)
    report_flags = [[], ['--json'], ['--ndjson'], ['--output', 'json'], ['--since', '1d'], ['--since', '2d', '--json'],
                    ['--since', '30d'], ['--since', '1.5h'], ['--since', '0s'], ['--since', '10000000d', '--json'],
                    ['--since', ' 3d '], ['--since', 'bogus'], ['--since', 'bogus', '--output', 'json'], ['--since', '-1d'],
                    ['--since', '999999999999d'], ['--since', '9' * 400 + 'd'], ['--since', ''],
                    ['--slowest', '0'], ['--slowest', '2', '--json'], ['--slowest', '1.5'], ['--slowest', '-1'],
                    ['--slowest', 'abc'], ['--slowest', ''], ['--slowest', '0x3'], ['--slowest', ' 4 '], ['--slowest', '1e1'],
                    ['--slowest', 'Infinity'], ['--slowest', '9007199254740993'], ['--largest', '3', '--ndjson'],
                    ['--largest', '-0'], ['--json', '--ndjson'], ['--ndjson', '--output', 'json']]
    for flags in report_flags:
        fresh(['admin', 'metrics', 'report'] + flags, metrics_variant('full'), menv)
    route_flags = [[], ['--json'], ['--by', 'client'], ['--by', 'route,client', '--json'], ['--by', 'client, route'],
                   ['--by', 'route,route'], ['--by', ''], ['--by', 'foo'], ['--by', 'route,'], ['--listener', 'main'],
                   ['--listener', 'ingest', '--json'], ['--listener', 'peer'], ['--listener', 'registry'], ['--listener', 'nope'],
                   ['--idle'], ['--idle', '--listener', 'peer'], ['--idle', '--json'], ['--idle', '--by', 'client'],
                   ['--since', '2d'], ['--since', '1h'], ['--since', 'bogus'], ['--since', '999999999999d'],
                   ['--since', '100000000d', '--json'], ['--output', 'json']]
    for flags in route_flags:
        fresh(['admin', 'metrics', 'routes'] + flags, metrics_variant('full'), menv)
    for variant in ('empty', 'nodir', 'file'):
        for argv in (['report'], ['report', '--json'], ['report', '--since', '999999999999d'], ['routes'], ['routes', '--json', '--idle']):
            fresh(['admin', 'metrics'] + argv, metrics_variant(variant), menv, name=f'[{variant}] admin metrics {" ".join(argv)}')

    # -- admin runs sweep-zombies / reconcile-active (live scratch daemon) ------------
    missing_daemon = scratch_env(fix / 'no-daemon', args.state_root)
    for verb in ('sweep-zombies', 'reconcile-active'):
        cmd = ['admin', 'runs', verb]
        for flags in ([], ['--json'], ['--output', 'json'], ['--dry-run'], ['--dry-run', '--json'],
                      ['--dry-run', '--older-than', '1ms'], ['--dry-run', '--older-than=1ms', '--json'],
                      ['--dry-run', '--output', 'json'], ['--older-than', 'bogus', '--dry-run'],
                      ['--older-than', 'bogus', '--dry-run', '--output', 'json'], ['--older-than=', '--dry-run'],
                      ['--older-than', '1ms', '--older-than', 'bogus', '--dry-run'], ['--older-than', '--yes'],
                      ['--yes', '--older-than', '3650d'], ['--yes', '--older-than', '3650d', '--json'],
                      ['--yes', '--dry-run', '--older-than', '3650d'], ['--older-than', '3650d', '--dry-run', '--yes', '--json'],
                      ['--dry-run', 'extra']):
            runner.case(cmd + flags)
        runner.case(cmd + ['--dry-run'], name=f'[no daemon] admin runs {verb} --dry-run', env=missing_daemon)

    # -- admin broker-verify candidates ---------------------------------------------
    bv_scope = broker_verify_fixture(store, fix / 'bv-state', seat)
    bv_env = scratch_env(args.runtime_root, fix / 'bv-state')
    for flags in ([], ['--json'], ['--output', 'json']):
        runner.case(['admin', 'broker-verify', 'candidates', scope] + flags)
        runner.case(['admin', 'broker-verify', 'candidates', bv_scope] + flags, name=f'[fixture] candidates bv {" ".join(flags)}', env=bv_env)
    for target in ('agent:nobody:project:none', scope + ':extra', ''):
        runner.case(['admin', 'broker-verify', 'candidates', target])
        runner.case(['admin', 'broker-verify', 'candidates', target, '--json'])
    runner.case(['admin', 'broker-verify', 'candidates'])
    runner.case(['admin', 'broker-verify', 'candidates', 'a', 'b'])
    nostore = scratch_env(args.runtime_root, fix / 'no-store')
    runner.case(['admin', 'broker-verify', 'candidates', scope], name='[no store] candidates', env=nostore)
    runner.case(['admin', 'broker-verify', 'candidates', scope, '--output', 'json'], name='[no store] candidates --output json', env=nostore)

    # -- admin events drain ----------------------------------------------------------
    source_ref, drain_ids = drain_fixture(store, fix / 'drain', seat)
    work = fix / 'drain' / 'work'
    dead = work / 'dead.sqlite'

    def drain_setup(ledger='dead', cursor=None):
        def setup():
            shutil.rmtree(work, ignore_errors=True)
            work.mkdir(parents=True)
            shutil.copyfile(fix / 'drain' / 'pristine' / f'{ledger}.sqlite', dead)
            if cursor is not None:
                (work / 'event-forward-cursors.json').write_text(cursor)
        return setup
    drain = ['admin', 'events', 'drain', str(dead), '--source-ref', source_ref]
    fresh(drain, drain_setup(), base, name='drain synthetic ledger (oracle inserts, subject must be an exact duplicate)')
    fresh(drain + ['--json'], drain_setup(), base, name='drain synthetic ledger --json')
    fresh(drain + ['--output', 'json'], drain_setup(), base, name='drain synthetic ledger --output json')
    partial = json.dumps({'version': 1, 'hrcEvents': 4, 'brokerInvocationEvents': 3.0, 'deadLetters': [{'kept': 1.0, '10': 'a', '2': 'b'}], 'extra': True})
    fresh(drain + ['--json'], drain_setup(cursor=partial), base, name='drain from a partial cursor file')
    fresh(drain, drain_setup(cursor='{not json'), base, name='drain with an unreadable cursor file')
    fresh(drain + ['--json'], drain_setup(cursor=json.dumps({'version': 2, 'hrcEvents': 99, 'brokerInvocationEvents': 99})), base,
          name='drain ignores a foreign cursor version')
    at_end = json.dumps({'version': 1, 'toolResultBlobs': 10**6, 'hrcEvents': 10**6, 'brokerInvocationEvents': 10**6, 'deadLetters': 'x'})
    fresh(drain + ['--json'], drain_setup(cursor=at_end), base, name='drain with cursors past the tails')
    fresh(drain + ['--json'], drain_setup(cursor=json.dumps({'version': 1, 'hrcEvents': 1.5, 'brokerInvocationEvents': 0})), base,
          name='drain resets a non-integer cursor')
    fresh(['admin', 'events', 'drain', str(dead), '--source-ref', '  ', '--json'], drain_setup(), base,
          name='drain dead-letters every item the receiver refuses')
    fresh(['admin', 'events', 'drain', str(dead), '--source-ref', 'n5b-admin-empty'], drain_setup('empty'), base, name='drain empty ledger')
    fresh(['admin', 'events', 'drain', str(dead), '--source-ref', 'n5b-admin-empty', '--json'], drain_setup('empty'), base, name='drain empty ledger --json')
    fresh(drain, drain_setup(), scratch_env(fix / 'no-ingest-run', args.state_root), name='drain with the ingest socket absent')

    # An older-schema dead ledger (the normal case for this recovery tool) is
    # handed to the same-release Bun CLI with identical argv (mable EN-35470).
    # 0127 is DROP TABLE IF EXISTS, so removing its ledger row is a faithful
    # pre-0127 ledger.
    older = fix / 'drain' / 'pristine' / 'older.sqlite'
    shutil.copyfile(fix / 'drain' / 'pristine' / 'dead.sqlite', older)
    with sqlite3.connect(older) as db:
        db.execute("DELETE FROM hrc_migrations WHERE id = '0127_permission_audit_removal'")
    bun_dir = str(Path(runner.bun).parent)
    # Bun's migration appends a store.migrated event (own pid/argv0/ts) to each
    # ledger copy, so only runs after a warm-up see the same receiver state;
    # the process identity in that one log line is declared nondeterministic.
    import re
    migrated_identity = (r'("pid":)\d+(,"argv0":)"[^"]*"', r'\1<pid>\2"<argv0>"')

    def same(a, b):
        strip = lambda o: {k: re.sub(*migrated_identity, v) if isinstance(v, str) else v for k, v in normalize(o, runner.normalization).items()}
        return strip(a) == strip(b)
    drain_setup('older')()
    warm = runner.observe(drain, False, base)
    for flags in ([], ['--json']):
        argv = drain + flags
        drain_setup('older')()
        oracle = runner.observe(argv, False, base)
        drain_setup('older')()
        no_bun = runner.observe(argv, True, base)
        drain_setup('older')()
        with_bun = subprocess.run([str(runner.binary)] + argv, cwd=runner.cwd, text=True, capture_output=True, timeout=60,
                                  env=dict(base, PATH=f'{runner.subject_path}:{bun_dir}'))
        subject = dict(exit=with_bun.returncode, stdout=with_bun.stdout, stderr=with_bun.stderr)
        with sqlite3.connect(f'file:{dead}?mode=ro', uri=True) as db:
            migrated = db.execute("SELECT COUNT(*) FROM hrc_migrations WHERE id = '0127_permission_audit_removal'").fetchone()[0]
        ok = (same(oracle, subject)
              and no_bun['exit'] == 1 and 'cannot exec Bun CLI' in no_bun['stderr'] and migrated == 1)
        runner.results.append(dict(case='drain older-schema ledger via same-release Bun ' + ' '.join(flags), argv=argv,
                                   oracle=oracle, subject=subject, subjectWithoutBun=no_bun, migratedAfter=migrated, warmup=warm,
                                   normalizedHere=[list(migrated_identity)], **{'pass': ok}))

    # Approved UNSUPPORTED (mable EN-35470): Bun creates a store at a missing path.
    missing = {side: work / f'missing-{side}' / 'x.sqlite' for side in ('oracle', 'subject')}
    shutil.rmtree(work, ignore_errors=True)
    for path in missing.values():
        path.parent.mkdir(parents=True)
    oracle = runner.observe(['admin', 'events', 'drain', str(missing['oracle']), '--source-ref', 'n5b-missing'], False, base)
    subject = runner.observe(['admin', 'events', 'drain', str(missing['subject']), '--source-ref', 'n5b-missing'], True, base)
    refused = (subject['exit'] == 1 and subject['stdout'] == '' and not missing['subject'].exists()
               and subject['stderr'] == f"hrc: cannot drain {missing['subject']}: no ledger exists at that path, and rusthrc never creates or migrates an HRC store\n")
    runner.results.append(dict(case='drain missing ledger path', argv=['admin', 'events', 'drain', '<missing>', '--source-ref', 'n5b-missing'],
                               oracle=oracle, subject=subject, rustRefusesWithoutCreating=refused, **{'pass': False},
                               unsupported='Bun creates and migrates a new HRC store at a nonexistent drain path and reports 0 drained; rusthrc refuses and never creates a store.'))
    runner.results.append(dict(case='drain missing ledger path: rusthrc refuses, exit 1, creates no file', argv=[], oracle={}, subject=subject,
                               **{'pass': refused}))
    ledger = sqlite3.connect(f"file:{store}?mode=ro", uri=True)
    drained_rows = {t: ledger.execute(f'SELECT COUNT(*) FROM {t} WHERE source_ref = ?', (source_ref,)).fetchone()[0]
                    for t in ('hrc_events', 'broker_invocation_events')}
    drained_rows["tool_result_blobs"] = ledger.execute('SELECT COUNT(*) FROM tool_result_blobs WHERE blob_id = ?',
                                                     (f'blob-n5bdrain-{source_ref.rsplit("-", 1)[1]}',)).fetchone()[0]
    ledger.close()
    live_link = fix / 'drain' / 'live-link.sqlite'
    live_link.symlink_to(store)
    for path in (store, live_link, args.state_root / '..' / args.state_root.name / 'state.sqlite'):
        runner.case(['admin', 'events', 'drain', str(path), '--source-ref', 'refused'])
        runner.case(['admin', 'events', 'drain', str(path), '--source-ref', 'refused', '--output', 'json'])
    for path in (fix / 'drain' / 'garbage.sqlite', fix / 'drain' / 'a-directory.sqlite'):
        runner.case(['admin', 'events', 'drain', str(path), '--source-ref', 'x'])
    runner.case(['admin', 'events', 'drain', str(dead)])
    runner.case(['admin', 'events', 'drain', '--source-ref', 'x'])
    runner.case(['admin', 'events', 'drain', 'a', 'b', '--source-ref', 'x'])

    # -- admin worktrees audit -------------------------------------------------------
    alpha = worktree_fixture(store, fix / 'wt', seat)
    wt_env = scratch_env(args.runtime_root, fix / 'wt' / 'state', WRKQ_DB=str(fix / 'wt' / 'wrkq.db'),
                         HRC_PROJECT_SEARCH_ROOTS=f' {fix / "wt" / "search"} :/nowhere')
    audit = ['admin', 'worktrees', 'audit']
    for flags in ([], ['--json'], ['--output', 'json'], ['--project', 'alpha'], ['--project', 'alpha', '--json'],
                  ['--project', 'delta'], ['--project', 'epsilon'], ['--project', 'nope'],
                  ['--project', 'alpha', '--root', str(alpha)], ['--project', 'zeta', '--root', str(alpha), '--json'],
                  ['--project', 'x', '--root', str(fix / 'wt' / 'missing')], ['--project', 'x', '--root', '.'],
                  ['--project', 'x', '--root', 'crates/../crates/'], ['--root', str(alpha)], ['--project', ''], ['extra']):
        runner.case(audit + flags, env=wt_env)
    unmigrated = dict(wt_env, WRKQ_DB=str(fix / 'wt' / 'unmigrated.db'))
    runner.case(audit, name='[wrkq refuses] admin worktrees audit', env=unmigrated)
    runner.case(audit + ['--project', 'alpha', '--root', str(alpha)], name='[wrkq refuses cat] audit --project alpha --root', env=unmigrated)
    runner.case(audit + ['--project', 'alpha', '--root', str(alpha), '--json'], name='[wrkq refuses cat] audit --json', env=unmigrated)
    runner.case(audit + ['--project', 'alpha'], name='[no store] audit --project alpha',
                env=dict(wt_env, HRC_STATE_DIR=str(fix / 'wt' / 'no-state')))

    # -- the seat is untouched -------------------------------------------------------
    after = seat_snapshot(store, rid, host)
    render = lambda snap: dict(exit=0, stdout=json.dumps(snap, indent=2, sort_keys=True) + '\n', stderr='')
    runner.results.append(dict(case='seat identity unchanged and no seat run carries a sweep mark', argv=[],
                               oracle=render(before), subject=render(after),
                               **{'pass': before == after and not after['sweepMarkedRuns']}))
    zero = lambda out: all('matched=0' in line or '"matched":0' in line for line in out.splitlines() if 'summary' in line or '"matched"' in line) and 'matched' in out
    mutating = [r for r in runner.results if r['argv'][:2] == ['admin', 'runs'] and '--yes' in r['argv'] and '--dry-run' not in r['argv']]
    proof = {r['case']: [zero(r['oracle']['stdout']) or r['oracle']['exit'] != 0, zero(r['subject']['stdout']) or r['subject']['exit'] != 0] for r in mutating}
    runner.results.append(dict(case='every --yes run-repair case selected nothing (matched=0 or refused)', argv=[],
                               oracle=render(proof), subject=render({k: [True, True] for k in proof}),
                               **{'pass': bool(proof) and all(all(v) for v in proof.values())}))
    return runner.finish(seat=rid, fixtureRoot=str(fix), drainSourceRef=source_ref, drainIds=drain_ids, drainedHostRows=drained_rows,
                         execution='native-required; Bun absent from subject PATH (tools: wrkq, git only)')


if __name__ == '__main__':
    raise SystemExit(main())
