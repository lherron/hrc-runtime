#!/usr/bin/env python3
"""Keep-manual C1b retention against the last Bun-verified golden (T-13053).
Requires --source (the same offline pre-prune store identified by golden SHA256),
--binary (built rusthrc), --out. No Bun leg or live writes. Golden freezes exact
survivor keys and normalized bundle rows; unrelated table digests, protected
backups, bounded write holds, checkpoint and 20k-page vacuum remain asserted.
"""
import argparse
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import time
# The artifact copy is runnable from the repository as well as from e2e/.
REPO = Path(__file__).resolve().parents[3]
if not (REPO / 'crates/hrc-native/e2e/ledger_prune.py').exists():
    REPO = Path(subprocess.check_output(['git', 'rev-parse', '--show-toplevel'], text=True).strip())
sys.path.insert(0, str(REPO / 'crates/hrc-native/e2e'))
from ledger_prune import Owner, ro

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


def normalized_digest(rows):
    encoded = json.dumps(rows, sort_keys=True, separators=(',', ':')).encode()
    return {'rows': len(rows), 'sha256': hashlib.sha256(encoded).hexdigest()}


def survivors(path, root):
    return {'keys': {k: normalized_digest(v) for k, v in keys(path).items()},
            'bundles': {k: normalized_digest(v) for k, v in bundle_state(path, root).items()}}


def normalized_backups(names):
    import re
    return sorted(re.sub(r'pre-activate-(?!20260230|20261301)[0-9]{8}T[0-9]{6}Z-', 'pre-activate-<stamp>-', n)
                  for n in names)


def main():
    a = argparse.ArgumentParser(description=__doc__)
    a.add_argument('--source', type=Path, required=True)
    a.add_argument('--binary', type=Path, required=True)
    a.add_argument('--out', type=Path, required=True)
    args = a.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    golden_path = REPO / 'crates/hrc-native/e2e/fixtures/nightly-retention-golden.json'
    golden = json.loads(golden_path.read_text())
    with args.source.open('rb') as source:
        source_sha = hashlib.file_digest(source, 'sha256').hexdigest()
    assert source_sha == golden['sourceSha256'], 'golden requires its recorded offline source; never a live SQLite file'
    outcomes = []
    for case, window in [('no-window', None), ('no-mark', '14d')]:
        (args.out / case).mkdir(exist_ok=True)
        o = Owner('retention-' + case, args.source.resolve(), args.binary.resolve(), args.out, None, window, tz=tz_for())
        try:
            initial_backups = backups(o.root)
            bundle_fixture(o.root)
            table_fixtures(o.root)
            o.env['TZ'] = tz_for()
            o.up()
            before_native = digest(o.db)
            start = time.time()
            while time.time() - start < 1800 and 'retention.report' not in reports(o):
                time.sleep(1)
            logged = reports(o)
            assert set(logged) == {'prune.report', 'retention.report'}, logged
            native = logged['retention.report']['data']
            after_native = digest(o.db)
            observed = survivors(o.db, o.root)
            assert observed == golden['cases'][case]['survivors'], ('survivor golden mismatch', observed)
            changed = [t for t in before_native if before_native[t] != after_native[t] and t not in (*TARGETS, *BUNDLE_TABLES)]
            assert not changed, changed
            kept = sorted(p.name for p in (o.root / 'state/backups').iterdir())
            assert normalized_backups(kept) == golden['cases'][case]['backupsKept']
            assert len(kept) == len(initial_backups) - 2
            assert native['firstTurnBundles']['expired'] >= 1 and native['firstTurnBundles']['orphanDirs'] >= 1
            assert not list((o.root / 'run/artifacts').glob('*/first-turn-missing/900000001'))
            assert native['checkpointed'] is True
            assert native['pagesReturned'] == 20000
            assert all(native['rowsDeleted'][t] > 0 for t in TARGETS)
            assert native['maxWriteHoldMs'] <= 500, native
            assert native['stopReason'] == 'complete', native
            assert logged['prune.report']['data']['stopReason'] == ('no_window' if window is None else 'no_mark')
            outcome = {'case': case, 'pass': True, 'reports': logged, 'backupsKept': kept,
                       'survivors': observed, 'nativeBefore': before_native, 'nativeAfter': after_native}
            (args.out / case / 'result.json').write_text(json.dumps(outcome, indent=2))
            outcomes.append({'case': case, 'pass': True, 'retention': native})
            print(json.dumps(outcomes[-1]), flush=True)
        finally:
            if o.proc and o.proc.poll() is None:
                o.down()
            o.cleanup()
    (args.out / 'result.json').write_text(json.dumps(outcomes, indent=2))


if __name__ == '__main__':
    main()
