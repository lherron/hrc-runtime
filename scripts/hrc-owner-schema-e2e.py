#!/usr/bin/env python3
"""Drive schema preparation against an installed release and a private SQLite store.

Failure modes: dry run mutates; failed preflight mutates; backup loses old schema;
remote preparation restarts without caller credentials; stage runs before migration.
No daemon or launchd job is started. Output is a repeatable result.json and transcript.
"""
import argparse
import json
import os
from pathlib import Path
import plistlib
import sqlite3
import subprocess
import tempfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--release', type=Path, required=True)
parser.add_argument('--scratch', type=Path, required=True)
parser.add_argument('--out', type=Path, required=True)
args = parser.parse_args()
release = args.release.resolve()
repo = Path(__file__).resolve().parent.parent
args.out.mkdir(parents=True, exist_ok=True)
args.scratch.mkdir(parents=True, exist_ok=True)
root = Path(tempfile.mkdtemp(prefix='schema-', dir=args.scratch))
state, run = root / 'state', root / 'run'
state.mkdir()
run.mkdir()
db = state / 'state.sqlite'
log = root / 'owner.log'
log.touch()
plist = root / 'owner.plist'
plist.write_bytes(plistlib.dumps({
    'Label': 'com.praesidium.hrc-server',
    'ProgramArguments': [str(release / 'bin/rusthrc'), 'server', 'serve'],
    'EnvironmentVariables': {'HRC_STATE_DIR': str(state), 'HRC_RUNTIME_DIR': str(run)},
    'StandardOutPath': str(log),
}))
env = {k: v for k, v in os.environ.items() if not k.startswith(('HRC_', 'HARNESS', 'WRKQ', 'CLAUDE', 'CODEX', 'AGENT', 'ASP_'))}
env.update(HRC_OWNER_PLIST=str(plist), OWNER_ROOT=str(root / 'owner'),
           INSTALLED_LINK=str(release), HRC_CODESIGN_IDENTITY='',
           HRC_STATE_DIR=str(state), HRC_RUNTIME_DIR=str(run))
sha = json.loads((release / 'praesidium-release.json').read_text())['hrcBuild']['sourceCommit']
transcript = []
checks = []


def command(argv, success=True):
    p = subprocess.run(argv, env=env, capture_output=True, text=True)
    transcript.append({'argv': argv, 'exit': p.returncode, 'stdout': p.stdout, 'stderr': p.stderr})
    (args.out / 'transcript.json').write_text(json.dumps(transcript, indent=2))
    assert (p.returncode == 0) == success, transcript[-1]
    return p


def check(name, condition):
    assert condition, name
    checks.append(name)


command(['bun', '-e', '''
const rel = process.argv[1], path = process.argv[2];
const {openHrcDatabase} = await import(`${rel}/packages/hrc-store-sqlite/dist/database.js`);
openHrcDatabase(path).close();
const {Database} = await import('bun:sqlite');
const db = new Database(path);
db.exec("DROP TABLE seat_handoffs; DELETE FROM hrc_migrations WHERE id = '0130_seat_handoffs'");
db.close();
''', str(release), str(db)])


def version(path):
    with sqlite3.connect(f'file:{path}?mode=ro', uri=True) as conn:
        return conn.execute('SELECT id FROM hrc_migrations ORDER BY id DESC LIMIT 1').fetchone()[0]


try:
    check('fixture schema is 0129', version(db) == '0129_seat_kind_work')
    check('installed release sees pending schema', command(['bash', str(repo / 'scripts/hrc-owner.sh'), 'schema-state']).stdout.strip() == 'pending')
    base = ['bash', str(repo / 'scripts/hrc-owner.sh'), 'activate', '--expect-commit', sha]
    command(base + ['--expect-pending', 'wrong', '--prepare-only'], success=False)
    check('failed preflight leaves schema unchanged', version(db) == '0129_seat_kind_work')
    check('failed preflight creates no owner or backup', not (root / 'owner').exists() and not (state / 'backups').exists())
    command(base + ['--expect-pending', '0130_seat_handoffs', '--dry-run'])
    check('dry run leaves schema unchanged', version(db) == '0129_seat_kind_work')
    check('dry run creates no owner or backup', not (root / 'owner').exists() and not (state / 'backups').exists())
    command(base + ['--expect-pending', '0130_seat_handoffs', '--prepare-only'])
    check('preparation applies pending migration', version(db) == '0130_seat_handoffs')
    check('installed release sees current schema', command(['bash', str(repo / 'scripts/hrc-owner.sh'), 'schema-state']).stdout.strip() == 'current')
    backups = list((state / 'backups').glob('*.sqlite'))
    check('one readable backup retains old schema', len(backups) == 1 and version(backups[0]) == '0129_seat_kind_work')
    check('owner staged after migration', (root / 'owner/bin/rusthrc').is_file() and (root / 'owner/hrc-runtime-current').is_symlink())
    check('remote preparation starts no daemon', not (run / 'hrc.sock').exists() and not log.read_text())
    command(base + ['--prepare-only'], success=False)
    check('empty pending set creates no extra backup', len(list((state / 'backups').glob('*.sqlite'))) == 1)
finally:
    (args.out / 'result.json').write_text(json.dumps({'passed': len(checks), 'checks': checks, 'scratch': str(root)}, indent=2))
print(json.dumps({'passed': len(checks), 'out': str(args.out)}))
