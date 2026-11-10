#!/usr/bin/env python3
"""Native usage writer against frozen Bun literals: exact schema, stdout/exit, isolation, opt-out,
retention and 4096-byte record bounds. All metric files belong to this run.
"""
import argparse
import datetime
import json
import math
import os
from pathlib import Path
import subprocess
import tempfile
import time

from metrics_isolation import isolated_suite
from frozen_cases import load, compare, observation

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
    for name in ('binary', 'artifacts'):
        p.add_argument('--' + name, type=Path, required=True)
    p.add_argument('--runtime-root', type=Path)
    p.add_argument('--fixtures', type=Path, default=Path(__file__).with_name('fixtures') / 'metrics.json')
    args = p.parse_args()
    args.artifacts.mkdir(parents=True, exist_ok=True)
    results = []
    with tempfile.TemporaryDirectory(prefix='n5-metrics-', dir='/tmp') as temp:
        root = Path(temp)
        cases = [('help', ['runtime', 'list', '--help']), ('failure', ['runtime', 'list', 'extra'])]
        if args.runtime_root:
            assert (args.runtime_root / 'hrc.sock').exists()
            assert not str(args.runtime_root.resolve()).startswith(str(Path.home() / 'praesidium/var'))
            cases.append(('rpc', ['runtime', 'list', '--json', '--status', 'terminated']))
        frozen, literals = load(args.fixtures, cases)
        for name, argv in cases:
            state = root / name
            state.mkdir(parents=True)
            env = dict(os.environ, HRC_STATE_DIR=str(state), HRC_RUNTIME_DIR=str(args.runtime_root or root / 'run'), HRC_METRICS='1', ASP_AGENT_ID=' metric-agent ', ASP_PROJECT=' metric-project ', NO_COLOR='1', FORCE_COLOR='0')
            c = subprocess.run([str(args.binary.resolve()), *argv], env=env, cwd=ROOT, capture_output=True, text=True, timeout=20)
            usage = records(state)
            subject = observation(c)
            expected = literals[name]
            good, diff = compare(expected['expected'], subject)
            record_good, record_diff = compare(expected['record'], normalized(usage[0]) if len(usage) == 1 else usage)
            good = good and record_good
            if len(usage) == 1:
                row = usage[0]
                good = good and row['bin'] == 'rusthrc'
                good = good and row['stdoutBytes'] == len(c.stdout.encode()) and row['exitCode'] == c.returncode
                good = good and all(math.isfinite(r['ms']) and r['ms'] >= 0 for r in row['rpc'])
            results.append(dict(case=name, expected=expected, subject=subject, records=usage,
                                diff=diff + record_diff, **{'pass': good}))
        # Search has no Bun registration after T-13053. Its usage record is native.
        state = root / 'native-search'
        env = dict(os.environ, HRC_STATE_DIR=str(state), HRC_RUNTIME_DIR=str(root / 'run'), HRC_METRICS='1')
        c = subprocess.run([str(args.binary.resolve()), 'monitor', 'search', '--help'], env=env, cwd=ROOT, capture_output=True)
        usage = records(state)
        def contract(case, actual):
            expected = frozen['contracts'][case]
            good, diff = compare(expected, actual)
            results.append(dict(case=case, expected=expected, subject=actual, diff=diff, **{'pass': good}))

        row = usage[0] if len(usage) == 1 else {}
        contract('native search usage record', dict(exit=c.returncode, stderr=c.stderr.decode(), count=len(usage),
                 **{k: row.get(k) for k in ('bin', 'cmd', 'flags', 'exitCode', 'rpc')},
                 stdoutMatches=row.get('stdoutBytes') == len(c.stdout)))
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
        contract('prune old CLI files only by mtime', dict(exit=c.returncode, oldExists=old.exists(), recentExists=recent.exists(), unrelatedExists=unrelated.exists()))
        before = {str(p): p.read_bytes() for p in metrics.iterdir()}
        env['HRC_METRICS'] = '0'
        c = subprocess.run([str(args.binary.resolve()), 'runtime', 'list', '--help'], env=env, cwd=ROOT, capture_output=True)
        contract('metrics opt-out writes and prunes nothing', dict(exit=c.returncode, unchanged=before == {str(p): p.read_bytes() for p in metrics.iterdir()}))
        bounded = root / 'bounded'
        env = dict(os.environ, HRC_STATE_DIR=str(bounded), HRC_RUNTIME_DIR=str(root / 'run'), HRC_METRICS='1', ASP_AGENT_ID='a' * 6000, ASP_PROJECT='p' * 6000)
        c = subprocess.run([str(args.binary.resolve()), 'runtime', 'list', '--help'], env=env, cwd=ROOT, capture_output=True)
        lines = [line for path in (bounded / 'metrics').glob('cli-*.ndjson') for line in path.read_bytes().splitlines()]
        record = json.loads(lines[0]) if len(lines) == 1 else {}
        contract('bounded record removes oversized context', dict(exit=c.returncode, count=len(lines),
                 below4096=len(lines) == 1 and len(lines[0]) < 4096,
                 agentAbsent='agent' not in record, projectAbsent='project' not in record))
        failed = root / 'storage-is-file'
        failed.write_text('conflicting file')
        env['HRC_STATE_DIR'] = str(failed)
        c = subprocess.run([str(args.binary.resolve()), 'runtime', 'list', '--help'], env=env, cwd=ROOT, capture_output=True)
        contract('observational storage failure preserves command success', dict(exit=c.returncode, contents=failed.read_text(), stderr=c.stderr.decode()))
    assert list(frozen['contracts']) == [r['case'] for r in results[len(cases):]], 'native contract manifest differs'
    report = dict(normalization=['bin', 'pid', 'ts', 'durMs', 'rpc[].id', 'rpc[].ms (elapsed RPC duration; semantic RPC fields compared)'], cases=results, **{'pass': sum(r['pass'] for r in results), 'fail': sum(not r['pass'] for r in results)})
    (args.artifacts / 'results.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({k: report[k] for k in ('pass', 'fail')}))
    for row in results:
        if not row['pass']:
            print('FAIL', row['case'], row.get('diff', json.dumps(row)))
    return int(bool(report['fail']))


if __name__ == '__main__':
    raise SystemExit(main())
