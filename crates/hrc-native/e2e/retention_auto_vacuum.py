#!/usr/bin/env python3
"""Keep-manual: non-incremental stores retain bundles after retention refusal.
Run from the repository root. Uses a small migrated scratch store seeded with
one terminal runtime from the offline real-store copy; never opens live state.
"""
import argparse
import json
from pathlib import Path
import shutil
import sqlite3
import subprocess
import tempfile
import time
from nightly_retention import bundle_fixture, digest, reports, tz_for
from ledger_prune import Owner


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--binary', type=Path, required=True)
    p.add_argument('--source', type=Path, required=True)
    p.add_argument('--out', type=Path, required=True)
    p.add_argument('--reproduce', action='store_true')
    args = p.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    seed = Path(tempfile.mkdtemp(prefix='t13046-mode0-', dir='/tmp'))
    owner = None
    try:
        db_path = seed / 'state.sqlite'
        subprocess.run([str(args.binary.resolve()), 'store', 'migrate', str(db_path)], check=True,
                       stdout=subprocess.DEVNULL)
        db = sqlite3.connect(db_path)
        db.execute('ATTACH DATABASE ? AS real', (f'file:{args.source.resolve()}?mode=ro',))
        db.execute("INSERT INTO runtimes SELECT * FROM real.runtimes WHERE status='terminated' LIMIT 1")
        db.commit()
        db.close()
        owner = Owner('retention-mode0', db_path, args.binary.resolve(), args.out, None, None)
        bundle_fixture(owner.root)
        db = sqlite3.connect(owner.db)
        db.execute('PRAGMA auto_vacuum=NONE')
        db.execute('VACUUM')
        db.close()
        owner.env['TZ'] = tz_for()
        owner.up()
        before = digest(owner.db)
        bundle = next((owner.root / 'run/artifacts').glob('*/first-turn-missing/900000001'))
        assert bundle.exists()
        limit = time.time() + 150
        while time.time() < limit and 'retention.report' not in reports(owner):
            time.sleep(1)
        logged = reports(owner)
        assert 'retention.report' in logged, logged
        after = digest(owner.db)
        kept = bundle.exists() and all(before[t] == after[t] for t in
                                      ['runtime_artifacts', 'runtime_first_turn_watch'])
        result = {'pass': kept, 'reproduced': not kept, 'bundleKept': bundle.exists(),
                  'before': before, 'after': after, 'reports': logged}
        (args.out / 'result.json').write_text(json.dumps(result, indent=2))
        print(json.dumps({'pass': kept, 'reproduced': not kept, 'reports': logged}), flush=True)
        assert (not kept) if args.reproduce else kept, result
    finally:
        if owner:
            if owner.proc and owner.proc.poll() is None:
                owner.down()
            owner.cleanup()
        shutil.rmtree(seed)


if __name__ == '__main__':
    main()
