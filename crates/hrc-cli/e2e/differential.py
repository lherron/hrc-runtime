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
import tempfile

from metrics_isolation import isolated_suite

ROOT = Path(__file__).resolve().parents[3]
# Declared normalization: created IDs and timestamps can change between calls.
NORMALIZATION = {'timestamps': r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z'}


def nodes(node):
    yield node
    for child in node['children']:
        yield from nodes(child)


@isolated_suite
def main():
    p = argparse.ArgumentParser()
    p.add_argument('--binary', type=Path, required=True)
    p.add_argument('--oracle', type=Path, default=ROOT / 'packages/hrc-cli/bin/hrc.js')
    p.add_argument('--runtime-root', type=Path)
    p.add_argument('--state-root', type=Path)
    p.add_argument('--inventory', type=Path)
    p.add_argument('--artifacts', type=Path, required=True)
    args = p.parse_args()
    args.artifacts.mkdir(parents=True, exist_ok=True)
    # Grammar/help oracles write metrics too. Never inherit either live root.
    scratch = tempfile.TemporaryDirectory(prefix='n5-cli-e2e-', dir='/tmp')
    env = dict(os.environ, NO_COLOR='1', FORCE_COLOR='0',
               HRC_RUNTIME_DIR=str(Path(scratch.name) / 'run'),
               HRC_STATE_DIR=str(Path(scratch.name) / 'state'))
    if args.runtime_root:
        assert not str(args.runtime_root.resolve()).startswith(str(Path.home() / 'praesidium/var'))
        assert (args.runtime_root / 'hrc.sock').exists()
        assert args.state_root, '--state-root is required with --runtime-root'
        env['HRC_RUNTIME_DIR'] = str(args.runtime_root.resolve())
        env['HRC_STATE_DIR'] = str(args.state_root.resolve())
    surface = json.loads((ROOT / 'crates/hrc-cli/surface.json').read_text())
    cases = []
    for node in nodes(surface):
        for view in ('agent', 'human'):
            cases.append((f"help:{' '.join(node['path'])}:{view}", [f'--{view}', *node['path'], '--help']))
        if any(a['required'] for a in node['arguments']):
            cases.append((f"missing:{' '.join(node['path'])}", node['path']))
    for argv in ([], ['runtime'], ['wat'], ['runtime', 'nonsense'], ['runtime', 'list', 'extra'], ['runtime', 'status', 'a', 'b'], ['server', 'status', 'extra', '--json'], ['runtime', 'list', '--output', 'xml'], ['--output', 'json', 'wat']):
        cases.append(('grammar:' + ' '.join(argv), argv))
    if args.runtime_root:
        for command in (['runtime', 'list'], ['runtime', 'list', '--all'], ['runtime', 'list', '--status', 'busy'], ['runtime', 'list', '--session', 'missing'], ['session', 'list'], ['ls', 'runtimes'], ['ls', 'sessions'], ['list', 'runtimes']):
            for json_flag in ([], ['--json']):
                cases.append(('daemon:' + ' '.join(command + json_flag), command + json_flag))
        cases.append(('conflicting-session', ['runtime', 'list', '--session', 'a', '--host-session-id', 'b']))
        cases.append(('resolve-missing-scope', ['session', 'resolve']))
    results = []
    rust_server_help = (ROOT / 'crates/hrc-cli/server-help.txt').read_text()
    for name, argv in cases:
        observed = []
        for command in (['bun', str(args.oracle)], [str(args.binary.resolve())]):
            child = subprocess.run(command + argv, cwd=ROOT, env=env, text=True, capture_output=True, timeout=20)
            item = {'exit': child.returncode, 'stdout': child.stdout, 'stderr': child.stderr}
            observed.append(item)
        def normalize(item):
            return {k: re.sub(NORMALIZATION['timestamps'], '<timestamp>', v) if isinstance(v, str) else v for k, v in item.items()}
        expected = dict(observed[0])
        if name in {f'help:{path}:{view}' for path in ('server', 'server serve') for view in ('agent', 'human')}:
            expected['stdout'] += rust_server_help
        results.append({'case': name, 'argv': argv, 'pass': normalize(expected) == normalize(observed[1]), 'oracle': observed[0], 'subject': observed[1]})
    if args.inventory:
        coverage = json.loads(args.inventory.read_text())
    else:
        inventory_dir = args.artifacts / 'inventory'
        subprocess.run(['python3', str(ROOT / 'conformance/hrc-parity/run.py'), 'inventory', '--source-ref', 'HEAD', '--out', str(inventory_dir)], cwd=ROOT, check=True, stdout=subprocess.DEVNULL)
        coverage = json.loads((inventory_dir / 'coverage-report.json').read_text())
    scope = json.loads((ROOT / 'crates/hrc-cli/command-scope.json').read_text())
    # This bounded run proves grammar; execution belongs to the named suites.
    # Report the approved 55/39 split instead of obsolete implementation gaps.
    families = {
        'runtime.py': 'runtime list|runtime inspect|runtime status|show|ls|session list|session get|session meta get|session resolve|admin status',
        'targets.py': 'target locate|target bindings|peek',
        'launch.py': 'start|run|attach',
        'restart.py': 'restart', 'restartme.py': 'restartme',
        'resume.py': 'resume', 'send.py': 'send', 'summon.py': 'summon',
        'controls.py': 'runtime capture|runtime interrupt|runtime terminate|capture status|session drop-continuation|session rotate|admin surface bind',
        'server_lifecycle.py': 'server stop|server restart',
        'server_start.py': 'server start', 'daemon_entrypoints.py': 'server serve',
        'status.py': 'server status', 'turn_protocol.py': 'turn',
        'n5b_monitor_reads.py': 'monitor events|monitor transcript|monitor stats|monitor show|monitor session-report',
        'n5b_monitor_wait.py': 'monitor wait', 'n5b_monitor_watch.py': 'monitor watch',
        'n5b_local.py': 'info|doctor|runtime diagnostics|runtime prune|runtime sweep|server subscribers|server tmux status',
        'n5b_admin.py': 'admin broker-verify candidates|admin events drain|admin metrics report|admin metrics routes|admin runs reconcile-active|admin runs sweep-zombies|admin worktrees audit',
    }
    suites = {command: suite for suite, commands in families.items() for command in commands.split('|')}
    decisions = {item['command']: item for item in scope['commands']}
    assert set(suites) == {key for key, value in decisions.items() if value['disposition'] == 'IMPLEMENT'}
    qualification, unsupported = [], []
    for item in coverage['items']:
        if item['target'] != 'GAP:N5' and item['kind'] != 'cli-command':
            continue
        row = {'line': item['id']}
        if item['kind'] == 'cli-command':
            command = item['id'].removeprefix('cli:hrc').strip()
            decision = decisions[command]
            if command == 'server':
                row.update(suite='daemon_entrypoints.py', reason='Bare server is the native daemon entrypoint; its help is native too.')
            elif decision['disposition'] == 'IMPLEMENT':
                row.update(suite=suites[command], reason='Native execution qualification is in this separate suite; help alone does not qualify it.')
            else:
                row.update(suite='passthrough.py', reason='POSTPONED by T-11820 observed-use audit; exact argv/streams/PID/exit exec the same-release Bun CLI.')
        elif item['kind'] == 'cli-alias':
            row.update(suite='runtime.py', reason='list aliases ls; human/JSON alias grammar also runs in this bounded suite.')
        elif item['kind'] == 'package-bin':
            row.update(suite='passthrough.py', reason='Release resolution and exec identity; installed PATH provenance is a separate Gate 4 drive.')
        else:
            path, symbol = item['source']['path'], item['source']['symbol']
            if path.endswith('/schema-guard.ts'):
                row.update(suite='status.py', reason='Readonly non-refusing schema diagnostics, including WAL admission and coordination-file effects.')
            elif item['kind'] == 'store-operation' and path.endswith(('/event-repositories.ts', '/shared.ts')):
                row.update(suite='n5b_monitor_wait.py', reason='Native filtered lifecycle reads, high-water cursors, task predicates and row projection.')
            elif '/monitor/' in path or path.endswith('/monitor-show.ts'):
                row.update(suite='n5b_monitor_wait.py' if '/wait-' in path else 'n5b_monitor_watch.py' if '/watch-' in path else 'n5b_monitor_reads.py', reason='Native direct-store monitor projection through hrc-store.')
            elif path.endswith('/worktree-prune.ts'):
                row.update(suite='n5b_admin.py', reason='Native worktrees audit reads occupancy; apply/prune stays postponed.')
            elif '/hrc-capture-verifier/' in path and (item['kind'] == 'direct-store-open' or symbol == 'listCandidates.rows'):
                row.update(suite='n5b_admin.py', reason='Native broker-verify candidates uses the readonly store; full verification stays postponed.')
            else:
                row.update(reason='Outside the approved native command set: standalone maintenance scripts, full capture verification, or run export/annotate remain Bun-owned under T-11820.')
                unsupported.append(row)
        qualification.append(row)
    report = {'commandScope': scope, 'normalization': NORMALIZATION, 'rustHelpAddition': {'paths': ['server', 'server serve'], 'text': rust_server_help}, 'pass': sum(r['pass'] for r in results), 'fail': sum(not r['pass'] for r in results), 'cases': results, 'qualification': qualification, 'qualificationNote': 'Suite names are coverage obligations, not behavioral PASS results. Aggregate qualification supplies their actual results.', 'unsupported': unsupported}
    (args.artifacts / 'results.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({k: report[k] for k in ('pass', 'fail')}))
    for r in results:
        if not r['pass']: print('FAIL', r['case'])
    status_args = ['python3', str(ROOT / 'crates/hrc-cli/e2e/status.py'), '--binary', str(args.binary.resolve()), '--oracle', str(args.oracle.resolve()), '--artifacts', str(args.artifacts / 'status')]
    if args.runtime_root:
        status_args += ['--runtime-root', str(args.runtime_root.resolve()), '--state-root', str(args.state_root.resolve())]
    status = subprocess.run(status_args, cwd=ROOT)
    passthrough = subprocess.run(['python3', str(ROOT / 'crates/hrc-cli/e2e/passthrough.py'), '--binary', str(args.binary.resolve()), '--oracle', str(args.oracle.resolve()), '--artifacts', str(args.artifacts / 'passthrough')], cwd=ROOT)
    metric_args = ['python3', str(ROOT / 'crates/hrc-cli/e2e/metrics.py'), '--binary', str(args.binary.resolve()), '--oracle', str(args.oracle.resolve()), '--artifacts', str(args.artifacts / 'metrics')]
    if args.runtime_root:
        metric_args += ['--runtime-root', str(args.runtime_root.resolve())]
    metrics = subprocess.run(metric_args, cwd=ROOT)
    daemon = subprocess.run(['python3', str(ROOT / 'crates/hrc-cli/e2e/daemon_entrypoints.py'), '--binary', str(args.binary.resolve()), '--artifacts', str(args.artifacts / 'daemon-entrypoints')], cwd=ROOT)
    transport = subprocess.run(['python3', str(ROOT / 'crates/hrc-cli/e2e/client_errors.py'), '--binary', str(args.binary.resolve()), '--oracle', str(args.oracle.resolve()), '--artifacts', str(args.artifacts / 'client-errors')], cwd=ROOT)
    return int(bool(report['fail']) or any(p.returncode != 0 for p in (status, passthrough, metrics, daemon, transport)))


if __name__ == '__main__':
    raise SystemExit(main())
