#!/usr/bin/env python3
"""Keep-manual C1b differential, using APFS clones of a real pre-prune store.
Requires --source (offline state.sqlite), --binary (built rusthrc), --out.
Reconstructs the pre-change Bun job from --bun-ref into /tmp; no live writes.
"""
import argparse
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
# The artifact copy is runnable from the repository as well as from e2e/.
REPO = Path(__file__).resolve().parents[3]
if not (REPO / 'crates/hrc-native/e2e/ledger_prune.py').exists():
    REPO = Path(subprocess.check_output(['git', 'rev-parse', '--show-toplevel'], text=True).strip())
sys.path.insert(0, str(REPO / 'crates/hrc-native/e2e'))
from ledger_prune import Owner, relocate, ro

TARGETS = ('runtime_buffers', 'broker_projection_dispositions', 'hrcmail_stop_refusals')
BUNDLE_TABLES = ('runtime_artifacts', 'runtime_first_turn_watch')


def digest(path):
    db = ro(path)
    result = {}
    for (table,) in db.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").fetchall():
        h = hashlib.sha256()
        n = 0
        # SQLite's table btree order is stable across these deletes/vacuum.
        cols = [r[1] for r in db.execute(f'PRAGMA table_info("{table}")')]
        order = ','.join('"' + c + '"' for c in cols)
        for row in db.execute(f'SELECT * FROM "{table}" ORDER BY {order}'):
            h.update(repr(tuple(row)).encode())
            n += 1
        result[table] = {'rows': n, 'sha256': h.hexdigest()}
    db.close()
    return result


def keys(path):
    db = ro(path)
    out = {}
    for table in TARGETS:
        columns = [r[1] for r in sorted(db.execute(f'PRAGMA table_info({table})'), key=lambda r: r[5]) if r[5]]
        sql = ','.join('"' + c + '"' for c in columns) or 'rowid'
        out[table] = sorted([tuple(r) for r in db.execute(f'SELECT {sql} FROM {table}')], key=repr)
    db.close()
    return out


def tz_for():
    now = dt.datetime.now(dt.timezone.utc)
    want = now.replace(hour=3, minute=59, second=0, microsecond=0)
    delta = (want - now).total_seconds() % 86400
    if delta > 43200:
        delta -= 86400
    off = -int(round(delta))
    sign = '-' if off < 0 else '+'
    off = abs(off)
    return f'PRU{sign}{off // 3600:02d}:{off % 3600 // 60:02d}:{off % 60:02d}'


def backups(root):
    """Strict subset vs rollback and all fail-closed keep witnesses."""
    state = root / 'state'
    db = ro(state / 'state.sqlite')
    ids = [r[0] for r in db.execute('SELECT id FROM hrc_migrations ORDER BY id')]
    db.close()
    directory = state / 'backups'
    directory.mkdir()
    old = time.time() - 20 * 86400
    stamp = dt.datetime.fromtimestamp(old, dt.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    young = dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    variants = {'1': ids[:-1], '2': ids, '3': [*ids[:-1], 'unknown-migration'], '4': [], '5': ids[:-1]}
    for pid, migrations in variants.items():
        path = directory / f'pre-activate-{stamp}-{pid}.sqlite'
        conn = sqlite3.connect(path)
        conn.execute('CREATE TABLE hrc_migrations (id TEXT PRIMARY KEY)')
        conn.executemany('INSERT INTO hrc_migrations VALUES (?)', [(v,) for v in migrations])
        conn.commit()
        conn.close()
        os.utime(path, (old, old) if pid != '5' else (time.time(), time.time()))
    for name in (f'pre-activate-{young}-6.sqlite', 'pre-activate-malformed.sqlite'):
        (directory / name).write_text('unreadable')
        os.utime(directory / name, (old, old))
    (directory / f'pre-activate-{stamp}-7.sqlite').symlink_to(f'pre-activate-{stamp}-2.sqlite')
    (directory / f'pre-activate-{stamp}-8.sqlite').mkdir()
    (directory / f'pre-activate-{stamp}-9.sqlite').write_text('unreadable')
    os.utime(directory / f'pre-activate-{stamp}-9.sqlite', (old, old))
    # Date.parse normalizes February 30; invalid month stays unreadable.
    for date in ['20260230T000000Z', '20261301T000000Z']:
        path = directory / f'pre-activate-{date}-10.sqlite'
        conn = sqlite3.connect(path)
        conn.execute('CREATE TABLE hrc_migrations (id TEXT PRIMARY KEY)')
        conn.executemany('INSERT INTO hrc_migrations VALUES (?)', [(v,) for v in ids[:-1]])
        conn.commit(); conn.close()
        os.utime(path, (old, old))
    return sorted(p.name for p in directory.iterdir())


def bundle_fixture(root):
    db = sqlite3.connect(root / 'state/state.sqlite')
    runtime = db.execute('SELECT runtime_id FROM runtimes LIMIT 1').fetchone()[0]
    directory = root / 'run/artifacts' / runtime / 'first-turn-missing'
    old = directory / '900000001'
    old.mkdir(parents=True)
    (old / 'bundle.json').write_text('{}')
    orphan = directory / 'orphan'
    orphan.mkdir()
    os.utime(orphan, (time.time() - 60, time.time() - 60))
    # The watch table's primary key is (runtime_id,generation), hence keep-N
    # is presently at most one row per generation, just as the Bun pass sees it.
    db.execute("INSERT INTO runtime_first_turn_watch (runtime_id,generation,host_session_id,lane_ref,scope_ref,run_id,first_turn_missing_tripped_at,trip_event_seq,diagnostics_event_seq,bundle_dir,created_at,updated_at) VALUES (?,987654,'test-host','test-lane','test:retention','test-retention','2000-01-01T00:00:00.000Z',900000001,900000002,?,'2000-01-01T00:00:00.000Z','2000-01-01T00:00:00.000Z')", (runtime, str(old)))
    db.execute("INSERT INTO runtime_artifacts (artifact_id,operation_id,media_type,content_hash,artifact_kind,storage_kind,artifact_path,created_at) VALUES ('first-turn-missing-900000001','test-op','application/json','test-hash','first-turn-missing-bundle','file-path',?,'2000-01-01T00:00:00.000Z')", (str(old),))
    db.commit()
    db.close()


def table_fixtures(root):
    db = sqlite3.connect(root / 'state/state.sqlite')
    db.row_factory = sqlite3.Row
    old = '2000-01-01T00:00:00.000Z'
    future = '2099-01-01T00:00:00.000Z'
    def clone(table, changes):
        row = dict(db.execute(f'SELECT * FROM {table} LIMIT 1').fetchone())
        row.update(changes)
        cols = list(row)
        db.execute(f"INSERT INTO {table} ({','.join(cols)}) VALUES ({','.join('?' for _ in cols)})", [row[c] for c in cols])
    for i, status in enumerate(['terminated','dead','stale','crashed','detached']):
        runtime, run = f'retention-runtime-{i}', f'retention-run-{i}'
        clone('runtimes', {'runtime_id':runtime,'status':status,'active_run_id':None,'updated_at':old})
        clone('runs', {'run_id':run,'runtime_id':runtime,'status':'completed','updated_at':old})
        for seq, created in enumerate([old, future]):
            db.execute('INSERT INTO runtime_buffers VALUES (?,?,?,?,?)', (runtime, run, seq, 'retention witness', created))
        db.execute('INSERT INTO hrcmail_stop_refusals (runtime_id,target_session_ref,created_at,updated_at) VALUES (?,?,?,?)', (runtime,'retention-target',old,old))
    # Orphan dispositions delete immediately; owning invocations keep islands,
    # invalid dates, nonterminal states and recently updated committed prefixes.
    for i, (state, updated) in enumerate([('exited',old),('failed',old),('disposed',old),('running',old),('exited','invalid'),('exited',future)]):
        invocation = f'retention-invocation-{i}'
        clone('broker_invocations', {'invocation_id':invocation,'runtime_id':'retention-runtime-0','invocation_state':state,'updated_at':updated,'last_projected_seq':10})
        for seq in [5, 15]:
            db.execute('INSERT INTO broker_projection_dispositions VALUES (?,?,?,?,?)', (invocation,seq,'hash','retention-witness',old))
    db.execute('INSERT INTO broker_projection_dispositions VALUES (?,?,?,?,?)', ('retention-orphan',1,'hash','retention-witness',old))
    db.commit()
    # A freelist bigger than the nightly budget discriminates a real cap from
    # vacuum-until-empty. The temporary allocation table is gone at baseline.
    db.execute('CREATE TABLE vacuum_witness (payload BLOB)')
    db.executemany('INSERT INTO vacuum_witness VALUES (zeroblob(4096))', [()] * 25000)
    db.commit()
    db.execute('DROP TABLE vacuum_witness')
    db.commit()
    assert db.execute('PRAGMA freelist_count').fetchone()[0] > 20000
    db.close()


def bundle_state(path, root):
    db = ro(path)
    result = {}
    for table in BUNDLE_TABLES:
        rows = []
        for row in db.execute(f'SELECT * FROM {table}'):
            row = dict(row)
            # clearBundle writes the run's time, a few seconds apart in the
            # independently scheduled native and Bun passes.
            if table == 'runtime_first_turn_watch' and row.get('bundle_dir') is None:
                row.pop('updated_at', None)
            rows.append({k: v.replace(str(root), '<root>') if isinstance(v, str) else v for k,v in row.items()})
        result[table] = sorted(rows, key=lambda r: json.dumps(r, sort_keys=True))
    db.close()
    return result


def reports(owner):
    result = {}
    for path in [owner.log_path, *sorted((owner.root / 'run').glob('logs/*'))]:
        if path.is_file():
            for line in path.read_text(errors='replace').splitlines():
                if '"retention.report"' in line or '"prune.report"' in line:
                    row = json.loads(line)
                    result[row['event']] = row
    return result


def main():
    a = argparse.ArgumentParser(description=__doc__)
    a.add_argument('--source', type=Path, required=True)
    a.add_argument('--binary', type=Path, required=True)
    a.add_argument('--out', type=Path, required=True)
    a.add_argument('--bun-ref', default='f682cba8')
    args = a.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    repo = REPO
    reference = Path(tempfile.mkdtemp(prefix='t13046-bun-', dir='/tmp'))
    archive = subprocess.Popen(['git', 'archive', args.bun_ref], cwd=repo, stdout=subprocess.PIPE)
    subprocess.run(['tar', '-xf', '-', '-C', str(reference)], stdin=archive.stdout, check=True)
    assert archive.wait() == 0
    (reference / 'node_modules').symlink_to(Path.home() / 'praesidium/node_modules', target_is_directory=True)
    outcomes = []
    try:
        for case, window in [('no-window', None), ('no-mark', '14d')]:
            (args.out / case).mkdir(exist_ok=True)
            o = Owner('retention-' + case, args.source.resolve(), args.binary.resolve(), args.out, None, window, tz=tz_for())
            bun_root = Path(tempfile.mkdtemp(prefix='t13046-compare-', dir='/tmp'))
            try:
                initial_backups = backups(o.root)
                bundle_fixture(o.root)
                table_fixtures(o.root)
                (bun_root / 'state').mkdir()
                (bun_root / 'run').mkdir()
                # A second APFS clone, with exactly the same relational and file fixtures.
                subprocess.run(['cp', '-c', str(o.db), str(bun_root / 'state/state.sqlite')], check=True)
                relocate(bun_root / 'state/state.sqlite', bun_root)
                conn = sqlite3.connect(bun_root / 'state/state.sqlite')
                for table, col in [('runtime_first_turn_watch', 'bundle_dir'), ('runtime_artifacts', 'artifact_path')]:
                    conn.execute(f'UPDATE {table} SET {col}=replace({col},?,?)', (str(o.root), str(bun_root)))
                conn.commit()
                conn.close()
                shutil.copytree(o.root / 'state/backups', bun_root / 'state/backups', symlinks=True)
                shutil.copytree(o.root / 'run/artifacts', bun_root / 'run/artifacts', dirs_exist_ok=True)
                before_bun = digest(bun_root / 'state/state.sqlite')
                o.env['TZ'] = tz_for()
                o.up()
                before_native = digest(o.db)
                start = time.time()
                # Run the old plist's max3 arguments (three tables) against the clone.
                cmd = ['bun', str(reference / 'scripts/prune-hrc-event-deltas.ts'), '--db', str(bun_root / 'state/state.sqlite'), '--runtime-root', str(bun_root / 'run'), '--apply', '--tables', ','.join(TARGETS), '--runtime-buffer-retention-days', '1', '--incremental-vacuum-pages', '20000', '--deadline-minutes', '30', '--pace-millis', '250', '--max-write-hold-millis', '500', '--max-duty-cycle', '.25', '--incremental-vacuum-chunk-pages', '100']
                result = subprocess.run(cmd, cwd=reference, capture_output=True, text=True, timeout=1900)
                (args.out / case / 'bun.log').write_text(result.stdout + result.stderr)
                assert result.returncode == 0, result.stdout + result.stderr
                while time.time() - start < 1800 and 'retention.report' not in reports(o):
                    time.sleep(1)
                logged = reports(o)
                assert set(logged) == {'prune.report', 'retention.report'}, logged
                native = logged['retention.report']['data']
                after_native, after_bun = digest(o.db), digest(bun_root / 'state/state.sqlite')
                assert keys(o.db) == keys(bun_root / 'state/state.sqlite'), 'primary key differential'
                # Native daemon boot/stop changes are outside the baseline interval.
                for name, before, after in [('native', before_native, after_native), ('bun', before_bun, after_bun)]:
                    changed = [t for t in before if before[t] != after[t] and t not in (*TARGETS, *BUNDLE_TABLES)]
                    assert not changed, (name, changed)
                kept_native = sorted(p.name for p in (o.root / 'state/backups').iterdir())
                kept_bun = sorted(p.name for p in (bun_root / 'state/backups').iterdir())
                assert kept_native == kept_bun and len(kept_native) == len(initial_backups) - 2
                assert native['firstTurnBundles']['expired'] >= 1 and native['firstTurnBundles']['orphanDirs'] >= 1
                assert not list((o.root / 'run/artifacts').glob('*/first-turn-missing/900000001'))
                assert not list((bun_root / 'run/artifacts').glob('*/first-turn-missing/900000001'))
                assert bundle_state(o.db, o.root) == bundle_state(bun_root / 'state/state.sqlite', bun_root), 'bundle row differential'
                assert native['checkpointed'] is True
                assert native['pagesReturned'] == 20000
                assert all(native['rowsDeleted'][t] > 0 for t in TARGETS)
                assert native['maxWriteHoldMs'] <= 500, native
                assert native['stopReason'] == 'complete', native
                assert logged['prune.report']['data']['stopReason'] == ('no_window' if window is None else 'no_mark')
                outcome = {'case': case, 'pass': True, 'reports': logged, 'backupsKept': kept_native, 'nativeBefore': before_native, 'nativeAfter': after_native, 'bunBefore': before_bun, 'bunAfter': after_bun}
                (args.out / case / 'result.json').write_text(json.dumps(outcome, indent=2))
                outcomes.append({'case': case, 'pass': True, 'retention': native})
                print(json.dumps(outcomes[-1]), flush=True)
            finally:
                if o.proc and o.proc.poll() is None:
                    o.down()
                o.cleanup()
                shutil.rmtree(bun_root)
    finally:
        shutil.rmtree(reference)
    (args.out / 'result.json').write_text(json.dumps(outcomes, indent=2))


if __name__ == '__main__':
    main()
