#!/usr/bin/env python3
"""Compare native CLI bytes/exits to Bun. Only IDs and clocks are normalized.

Failure modes: native silently delegates; unsupported commands disappear from
coverage; errors have wrong streams/exits; pagination drops rows; help drift.
No production writes: daemon cases require an explicit isolated runtime root.
"""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[3]
# Declared normalization: created IDs and timestamps can change between calls.
NORMALIZATION = {'timestamps': r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z'}


def nodes(node):
    yield node
    for child in node['children']:
        yield from nodes(child)


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--binary', type=Path, required=True)
    p.add_argument('--oracle', type=Path, default=ROOT / 'packages/hrc-cli/bin/hrc.js')
    p.add_argument('--runtime-root', type=Path)
    p.add_argument('--inventory', type=Path)
    p.add_argument('--artifacts', type=Path, required=True)
    args = p.parse_args()
    args.artifacts.mkdir(parents=True, exist_ok=True)
    env = dict(os.environ, NO_COLOR='1', FORCE_COLOR='0')
    if args.runtime_root:
        assert not str(args.runtime_root.resolve()).startswith(str(Path.home() / 'praesidium/var'))
        assert (args.runtime_root / 'hrc.sock').exists()
        env['HRC_RUNTIME_DIR'] = str(args.runtime_root.resolve())
    surface = json.loads((ROOT / 'crates/hrc-cli/surface.json').read_text())
    cases = []
    for node in nodes(surface):
        for view in ('agent', 'human'):
            cases.append((f"help:{' '.join(node['path'])}:{view}", [f'--{view}', *node['path'], '--help']))
        if any(a['required'] for a in node['arguments']):
            cases.append((f"missing:{' '.join(node['path'])}", node['path']))
    for argv in ([], ['runtime'], ['wat'], ['runtime', 'nonsense'], ['runtime', 'list', 'extra'], ['runtime', 'list', '--output', 'xml'], ['--output', 'json', 'wat']):
        cases.append(('grammar:' + ' '.join(argv), argv))
    supported = {'runtime list', 'session list', 'session resolve'}
    if args.runtime_root:
        for command in (['runtime', 'list'], ['runtime', 'list', '--all'], ['runtime', 'list', '--status', 'busy'], ['runtime', 'list', '--session', 'missing'], ['session', 'list'], ['ls', 'runtimes'], ['ls', 'sessions'], ['list', 'runtimes']):
            for json_flag in ([], ['--json']):
                cases.append(('daemon:' + ' '.join(command + json_flag), command + json_flag))
        cases.append(('conflicting-session', ['runtime', 'list', '--session', 'a', '--host-session-id', 'b']))
        cases.append(('resolve-missing-scope', ['session', 'resolve']))
    results = []
    for name, argv in cases:
        observed = []
        for command in (['bun', str(args.oracle)], [str(args.binary.resolve())]):
            child = subprocess.run(command + argv, cwd=ROOT, env=env, text=True, capture_output=True, timeout=20)
            item = {'exit': child.returncode, 'stdout': child.stdout, 'stderr': child.stderr}
            observed.append(item)
        def normalize(item):
            return {k: re.sub(NORMALIZATION['timestamps'], '<timestamp>', v) if isinstance(v, str) else v for k, v in item.items()}
        results.append({'case': name, 'argv': argv, 'pass': normalize(observed[0]) == normalize(observed[1]), 'oracle': observed[0], 'subject': observed[1]})
    if args.inventory:
        coverage = json.loads(args.inventory.read_text())
    else:
        inventory_dir = args.artifacts / 'inventory'
        subprocess.run(['python3', str(ROOT / 'conformance/hrc-parity/run.py'), 'inventory', '--source-ref', 'HEAD', '--out', str(inventory_dir)], cwd=ROOT, check=True, stdout=subprocess.DEVNULL)
        coverage = json.loads((inventory_dir / 'coverage-report.json').read_text())
    unsupported = []
    for item in coverage['items']:
        if item['target'] != 'GAP:N5':
            continue
        command = item['id'].removeprefix('cli:hrc').strip()
        unsupported.append({'line': item['id'], 'reason':
            'partial execution cases; full flags/PTY/failure qualification pending N5' if command in supported
            else 'help/error cases only; execution implementation pending N5' if item['kind'] == 'cli-command'
            else 'implementation/qualification pending N5'})
    report = {'normalization': NORMALIZATION, 'pass': sum(r['pass'] for r in results), 'fail': sum(not r['pass'] for r in results), 'cases': results, 'unsupported': unsupported}
    (args.artifacts / 'results.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({k: report[k] for k in ('pass', 'fail')}))
    for r in results:
        if not r['pass']: print('FAIL', r['case'])
    return int(bool(report['fail']))


if __name__ == '__main__':
    raise SystemExit(main())
