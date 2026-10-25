#!/usr/bin/env python3
"""Native usage writer vs real Bun: exact schema, stdout/exit, isolation, opt-out,
retention and 4096-byte record bounds. All metric files belong to this run.
"""
import argparse
import datetime
import json
import math
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time

from metrics_isolation import isolated_suite

ROOT = Path(__file__).resolve().parents[3]


def records(root):
    return [json.loads(line) for path in (root / 'metrics').glob('cli-*.ndjson') for line in path.read_text().splitlines()]


def normalized(value):
    value = dict(value)
    for key in ('bin', 'pid', 'ts', 'durMs'):
        value.pop(key, None)
    value['rpc'] = [{k: v for k, v in rpc.items() if k not in ('id', 'ms')} for rpc in value['rpc']]
    return value


@isolated_suite
def main():
    p = argparse.ArgumentParser()
    for name in ('binary', 'oracle', 'artifacts'):
        p.add_argument('--' + name, type=Path, required=True)
    p.add_argument('--runtime-root', type=Path)
    args = p.parse_args()
    args.artifacts.mkdir(parents=True, exist_ok=True)
    results = []
    bun = shutil.which('bun')
    with tempfile.TemporaryDirectory(prefix='n5-metrics-', dir='/tmp') as temp:
        root = Path(temp)
        cases = [('help', ['runtime', 'list', '--help']), ('failure', ['runtime', 'list', 'extra']), ('postponed', ['index', 'status', '--help'])]
        if args.runtime_root:
            assert (args.runtime_root / 'hrc.sock').exists()
            assert not str(args.runtime_root.resolve()).startswith(str(Path.home() / 'praesidium/var'))
            cases.append(('rpc', ['runtime', 'list', '--json', '--status', 'terminated']))
        for name, argv in cases:
            observed = []
            for label, command in [('oracle', [bun, str(args.oracle.resolve())]), ('subject', [str(args.binary.resolve())])]:
                state = root / name / label
                state.mkdir(parents=True)
                env = dict(os.environ, HRC_STATE_DIR=str(state), HRC_RUNTIME_DIR=str(args.runtime_root or root / 'run'), HRC_METRICS='1', ASP_AGENT_ID=' metric-agent ', ASP_PROJECT=' metric-project ', NO_COLOR='1', FORCE_COLOR='0')
                c = subprocess.run(command + argv, env=env, cwd=ROOT, capture_output=True, text=True, timeout=20)
                usage = records(state)
                observed.append(dict(exit=c.returncode, stdout=c.stdout, stderr=c.stderr, records=usage))
            good = len(observed[0]['records']) == len(observed[1]['records']) == 1
            if good:
                a, b = observed[0]['records'][0], observed[1]['records'][0]
                good = normalized(a) == normalized(b) and a['bin'] == 'hrc' and b['bin'] == ('hrc' if name == 'postponed' else 'rusthrc')
                good = good and b['stdoutBytes'] == len(observed[1]['stdout'].encode()) and b['exitCode'] == observed[1]['exit']
                good = good and all(math.isfinite(r['ms']) and r['ms'] >= 0 for r in b['rpc'])
            results.append(dict(case=name, oracle=observed[0], subject=observed[1], **{'pass': good}))
        state = root / 'retention'
        metrics = state / 'metrics'
        metrics.mkdir(parents=True)
        old = metrics / 'cli-2000-01-01.ndjson'
        recent = metrics / 'cli-2000-01-02.ndjson'
        unrelated = metrics / 'server-2000-01-01.ndjson'
        for path in (old, recent, unrelated):
            path.write_text('')
        old_time = time.time() - 15 * 86400
        for path in (old, unrelated):
            os.utime(path, (old_time, old_time))
        env = dict(os.environ, HRC_STATE_DIR=str(state), HRC_RUNTIME_DIR=str(root / 'run'), HRC_METRICS='1')
        c = subprocess.run([str(args.binary.resolve()), 'runtime', 'list', '--help'], env=env, cwd=ROOT, capture_output=True)
        results.append(dict(case='prune old CLI files only by mtime', **{'pass': c.returncode == 0 and not old.exists() and recent.exists() and unrelated.exists()}))
        before = {str(p): p.read_bytes() for p in metrics.iterdir()}
        env['HRC_METRICS'] = '0'
        c = subprocess.run([str(args.binary.resolve()), 'runtime', 'list', '--help'], env=env, cwd=ROOT, capture_output=True)
        results.append(dict(case='metrics opt-out writes and prunes nothing', **{'pass': c.returncode == 0 and before == {str(p): p.read_bytes() for p in metrics.iterdir()}}))
        bounded = root / 'bounded'
        env = dict(os.environ, HRC_STATE_DIR=str(bounded), HRC_RUNTIME_DIR=str(root / 'run'), HRC_METRICS='1', ASP_AGENT_ID='a' * 6000, ASP_PROJECT='p' * 6000)
        c = subprocess.run([str(args.binary.resolve()), 'runtime', 'list', '--help'], env=env, cwd=ROOT, capture_output=True)
        lines = [line for path in (bounded / 'metrics').glob('cli-*.ndjson') for line in path.read_bytes().splitlines()]
        good = len(lines) == 1 and len(lines[0]) < 4096
        if good:
            record = json.loads(lines[0])
            good = 'agent' not in record and 'project' not in record
        results.append(dict(case='bounded record removes oversized context', **{'pass': c.returncode == 0 and good}))
        failed = root / 'storage-is-file'
        failed.write_text('conflicting file')
        env['HRC_STATE_DIR'] = str(failed)
        c = subprocess.run([str(args.binary.resolve()), 'runtime', 'list', '--help'], env=env, cwd=ROOT, capture_output=True)
        results.append(dict(case='observational storage failure preserves command success', **{'pass': c.returncode == 0 and failed.read_text() == 'conflicting file' and c.stderr == b''}))
    report = dict(normalization=['bin', 'pid', 'ts', 'durMs', 'rpc[].id', 'rpc[].ms (elapsed RPC duration; semantic RPC fields compared)'], cases=results, **{'pass': sum(r['pass'] for r in results), 'fail': sum(not r['pass'] for r in results)})
    (args.artifacts / 'results.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({k: report[k] for k in ('pass', 'fail')}))
    return int(bool(report['fail']))


if __name__ == '__main__':
    raise SystemExit(main())
