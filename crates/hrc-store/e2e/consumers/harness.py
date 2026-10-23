#!/usr/bin/env python3
"""Standalone P1 consumer adapter. See README for required native scenarios."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import time
import traceback
from assertions import EvidenceError, require
from requirements import REQUIRED

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[3]
QUALIFIED_RELEASE = 'release-20261023084446986-41220'
QUALIFIED_COMMIT = 'fbc32e43be56885b30a81df5128d2186fe32376d'


class Gap(Exception):
    pass


class InfraError(Exception):
    pass


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def save(path, value):
    Path(path).write_text(json.dumps(value, indent=2, ensure_ascii=True) + '\n')


def rows(path, sql, values=()):
    with sqlite3.connect(Path(path).as_uri() + '?mode=ro', uri=True) as db:
        db.row_factory = sqlite3.Row
        return [dict(r) for r in db.execute(sql, values)]


def backup(source, target):
    with sqlite3.connect(Path(source).as_uri() + '?mode=ro', uri=True) as a, sqlite3.connect(target) as b:
        a.backup(b)


def store_snapshot(path):
    names = {r['name'] for r in rows(path, "SELECT name FROM sqlite_master WHERE type='table'")}
    return {name: rows(path, 'SELECT * FROM ' + name) for name in (
        'runs', 'runtimes', 'events', 'events_legacy', 'hrc_events', 'broker_invocations',
        'broker_invocation_events', 'runtime_artifacts', 'runtime_buffers', 'tool_result_blobs',
        'event_stream_cursor', 'sqlite_sequence') if name in names}


class Context:
    def __init__(self, args):
        self.args = args
        self.root = Path(args.scratch_root).absolute()
        self.out = Path(args.out).absolute()
        self.release = Path(args.release).resolve(strict=True)
        self.native = Path(args.native).resolve(strict=True)
        self.bun = Path(args.bun).resolve(strict=True)
        self.cli = [str(self.bun), str(self.release / 'packages/hrc-cli/src/cli.ts')]
        self.cleanup_failed = False
        self.counter = 0
        self.current = None
        self.summary = {'schema': 1, 'complete': False, 'status': 'INCOMPLETE',
                        'claim': 'source-native-with-installed-Bun-consumers',
                        'installedNativeAcceptance': False, 'fullP1Qualified': False,
                        'fullParityQualified': False, 'held': ['D01-D09', 'LD01-LD05'], 'cases': []}

    def admit(self):
        require(str(self.root).startswith('/tmp/hrcp1-consumers-'), 'fresh /tmp/hrcp1-consumers-* root required')
        require(not self.root.exists() and not self.root.is_symlink(), 'scratch root must not exist')
        require(not self.out.resolve().is_relative_to(self.root.resolve()), 'artifacts must survive scratch cleanup')
        require(self.root.parent.resolve() == Path('/tmp').resolve(), 'scratch parent escape')
        require(self.out.exists() is False, 'artifact output must be new')
        manifest = json.loads((self.release / 'praesidium-release.json').read_text())
        require(manifest['releaseId'] == QUALIFIED_RELEASE and manifest['hrcBuild']['sourceCommit'] == QUALIFIED_COMMIT,
                'qualified immutable Bun tuple drift; disclose/requalify instead of substituting')
        for p in [self.bun, self.native, Path(self.cli[1]), self.release / 'packages/hrc-store-sqlite/src/index.ts']:
            require(p.is_file(), 'required real executable/module absent: ' + str(p))
        magic = self.native.read_bytes()[:4]
        require(magic in (b'\xcf\xfa\xed\xfe', b'\xfe\xed\xfa\xcf', b'\x7fELF', b'\xca\xfe\xba\xbe'), 'native must be an actual native executable')
        self.native_hash = digest(self.native)
        if self.args.native_sha256:
            require(self.native_hash == self.args.native_sha256, 'declared native hash mismatch')
        self.out.mkdir(parents=True)
        save(self.out / 'summary.json', self.summary)
        self.root.mkdir(mode=0o700)
        self.identity = {'nativeRealpath': str(self.native), 'nativeHashBefore': self.native_hash,
                         'nativeOrigin': self.args.native_origin, 'bunRealpath': str(self.bun),
                         'bunHash': digest(self.bun), 'releaseRoot': str(self.release), 'release': manifest,
                         'cliArgv': self.cli, 'cliHash': digest(self.cli[1]),
                         'sourceHead': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=REPO, text=True).strip(),
                         'sourceStatus': subprocess.check_output(['git', 'status', '--short'], cwd=REPO, text=True),
                         'scratchRoot': str(self.root.resolve()), 'validationSurface': self.summary['claim']}
        sources = sorted(p for p in HERE.iterdir() if p.suffix in ('.py', '.ts', '.md')) + [HERE.parent / 'oracle.ts']
        self.source_hashes = {str(p): digest(p) for p in sources}
        self.identity['harnessSources'] = self.source_hashes
        for p in sources:
            target = self.out / 'sources' / (p.name if p.parent == HERE else 'parent-oracle.ts')
            target.parent.mkdir(exist_ok=True)
            target.write_bytes(p.read_bytes())
        save(self.out / 'identity.json', self.identity)

    def env(self, root):
        env = {k: v for k, v in os.environ.items() if not k.startswith(('HRC_', 'ASP_', 'WRKQ'))}
        env.update(HRC_STATE_DIR=str(root / 'state'), HRC_DB_PATH=str(root / 'state/state.sqlite'),
                   HRC_RUNTIME_DIR=str(root / 'run'), HRC_SOCKET_PATH=str(root / 'run/absent.sock'),
                   HRC_WRKQ_DB=str(root / 'wrkq.sqlite'), WRKQ_DB=str(root / 'wrkq.sqlite'),
                   ASP_AGENTS_ROOT=str(root / 'agents'), HRC_PROJECT_SEARCH_ROOTS=str(root / 'project'),
                   HRC_PEER_CONFIG_FILE=str(root / 'peers.json'), HRC_ACP_WEBHOOK_URL='')
        return env

    def command(self, name, argv, root, exits=(0,), parse=True, env=None, timeout=45):
        self.counter += 1
        started = time.time()
        selected = self.env(root) if env is None else env
        record = {'argv': list(map(str, argv)), 'startedAt': started,
                  'environment': {k: v for k, v in selected.items() if k.startswith(('HRC_', 'ASP_', 'WRKQ')) and 'TOKEN' not in k},
                  'nativeHash': self.native_hash}
        try:
            process = subprocess.run(record['argv'], env=selected, capture_output=True, text=True, timeout=timeout)
            record.update(exit=process.returncode, stdout=process.stdout, stderr=process.stderr)
        except subprocess.TimeoutExpired as e:
            record.update(exit=None, stdout=str(e.stdout), stderr=str(e.stderr), timeout=True)
            raise InfraError('timeout: ' + name) from e
        finally:
            record['endedAt'] = time.time()
            save(self.caseout / f'{self.counter:03d}-{name}.json', record)
        require(record['exit'] in exits, f'{name}: exit {record["exit"]}, expected {exits}')
        if not parse:
            return record
        try:
            body = json.loads(record['stdout'])
        except json.JSONDecodeError as e:
            raise EvidenceError(name + ': malformed/truncated JSON output') from e
        record['body'] = body
        save(self.caseout / f'{self.counter:03d}-{name}.json', record)
        return body

    def cli_call(self, name, args, root, **kw):
        return self.command(name, self.cli + args, root, **kw)

    def native_call(self, name, scenario, root, extra=()):
        require(digest(self.native) == self.native_hash, 'native binary changed before command')
        result = self.command(name, [self.native, scenario, '--db', root / 'state/state.sqlite', *extra], root,
                              exits=(0, 1))
        require(digest(self.native) == self.native_hash, 'native binary changed during command')
        if isinstance(result, dict) and 'unknown scenario' in result.get('error', {}).get('message', ''):
            raise Gap('native fixed scenario unavailable: ' + scenario)
        require(not isinstance(result, dict) or 'error' not in result, 'native scenario refused: ' + repr(result))
        return result

    def subject(self, label):
        root = self.root / self.current / label
        root.mkdir(parents=True)
        (root / 'state').mkdir()
        (root / 'run').mkdir()
        save(root / 'peers.json', {'nodeId': 'p1-consumers', 'peers': {}})
        # Existing parent helper performs unchanged installed Bun canonical setup only.
        self.command('canonical-seed-' + label,
                     [self.bun, HERE.parent / 'oracle.ts', self.release, root / 'state', 'seed'], root)
        return root

    def fork(self, root, label):
        dest = self.root / self.current / label
        dest.mkdir()
        (dest / 'state').mkdir()
        (dest / 'run').mkdir()
        backup(root / 'state/state.sqlite', dest / 'state/state.sqlite')
        return dest

    def observe(self, name, path, sql, values=()):
        result = rows(path, sql, values)
        save(self.caseout / (name + '.json'), {'dbPath': str(path), 'sql': sql, 'values': values, 'rows': result})
        return result

    def check(self, name, fn):
        try:
            fn()
            result = {'id': name, 'status': 'PASS'}
        except Gap as e:
            result = {'id': name, 'status': 'GAP', 'reason': str(e)}
        except (InfraError, FileNotFoundError) as e:
            result = {'id': name, 'status': 'INFRA_ERROR', 'reason': str(e)}
        except Exception as e:
            result = {'id': name, 'status': 'FAIL', 'reason': str(e), 'traceback': traceback.format_exc()}
        self.checks.append(result)
        save(self.caseout / 'checks.json', self.checks)
        return result

    def run_case(self, id, fn):
        self.current = id
        self.caseout = self.out / id
        self.caseout.mkdir()
        self.checks = []
        self.check('case-execution', lambda: fn(self))
        present = {x['id'] for x in self.checks}
        for missing in sorted(set(REQUIRED[id]) - present):
            self.checks.append({'id': missing, 'status': 'GAP', 'reason': 'mandatory assertion not executed'})
        statuses = [c['status'] for c in self.checks]
        state = next((s for s in ('FAIL', 'INFRA_ERROR', 'GAP') if s in statuses), 'PASS')
        result = {'id': id, 'status': state, 'requiredAssertions': REQUIRED[id], 'assertions': self.checks}
        self.summary['cases'].append(result)
        save(self.caseout / 'result.json', result)
        # Keep coherent state, even on failed controls; do not tear-copy WAL files.
        for db in (self.root / id).rglob('*.sqlite') if (self.root / id).exists() else []:
            relative = db.relative_to(self.root / id)
            target = self.caseout / 'databases' / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            backup(db, target)
        save(self.out / 'summary.json', self.summary)

    def finish(self):
        self.summary['nativeHashStable'] = digest(self.native) == self.native_hash
        self.summary['sourceFilesStable'] = all(p and digest(p) == expected for p, expected in self.source_hashes.items())
        if not self.cleanup_failed:
            shutil.rmtree(self.root)
        self.summary['scratchRemoved'] = not self.root.exists()
        states = [c['status'] for c in self.summary['cases']]
        if self.cleanup_failed:
            states.append('INFRA_ERROR')
        if not self.summary['nativeHashStable'] or not self.summary['sourceFilesStable']:
            states.append('FAIL')
        self.summary.update(complete=True, status=next((s for s in ('FAIL', 'INFRA_ERROR', 'GAP') if s in states), 'PASS'))
        self.summary['exitCode'] = 0 if self.summary['status'] == 'PASS' else 1
        self.summary['selectedSubset'] = self.args.cases != 'C01,C02,C03,C04,C05,C06,C07'
        # A subset never certifies full C01-C07 coverage.
        self.summary['allConsumersQualified'] = not self.summary['selectedSubset'] and self.summary['status'] == 'PASS'
        self.summary['coverage'] = {x['id']: {a: next((r['status'] for r in x['assertions'] if r['id'] == a), 'GAP') for a in REQUIRED[x['id']]} for x in self.summary['cases']}
        save(self.out / 'summary.json', self.summary)
        files = sorted(p for p in self.out.rglob('*') if p.is_file() and p.name != 'SHA256SUMS')
        (self.out / 'SHA256SUMS').write_text(''.join(digest(p) + '  ' + str(p.relative_to(self.out)) + '\n' for p in files))
        print(json.dumps(self.summary))
        return self.summary['exitCode']


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for field in ('native', 'release', 'scratch-root', 'out'):
        parser.add_argument('--' + field, required=True)
    parser.add_argument('--bun', default='/Users/lherron/.bun/bin/bun')
    parser.add_argument('--native-sha256')
    parser.add_argument('--native-origin', required=True, help='parent checkpoint/build description; artifact copy allowed')
    parser.add_argument('--cases', default='C01,C02,C03,C04,C05,C06,C07')
    parser.add_argument('--asp-socket', default='/Users/lherron/praesidium/var/aspd/run/aspd.sock')
    parser.add_argument('--monitor-profile', help='reviewed real isolated P0 infrastructure profile (never a status fixture)')
    args = parser.parse_args()
    from cases import CASES
    selected = args.cases.split(',')
    require(bool(selected) and len(set(selected)) == len(selected) and all(x in CASES for x in selected), 'unknown/duplicate/empty cases')
    ctx = Context(args)
    ctx.admit()
    from control_checks import run
    save(ctx.out / 'checker-controls.json', {'claim': 'checker-controls-only', 'rejected': run()})
    try:
        for id in selected:
            ctx.run_case(id, CASES[id])
    finally:
        # A crash/interrupt keeps complete=false plus scratch for forensic cleanup.
        save(ctx.out / 'summary.json', ctx.summary)
    return ctx.finish()


if __name__ == '__main__':
    sys.exit(main())
