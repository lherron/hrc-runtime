#!/usr/bin/env python3
"""Assert native CLI bytes/exits against the frozen Bun baseline.

Failure modes: native silently delegates; unsupported commands disappear from
coverage; errors have wrong streams/exits; pagination drops rows; help drift.
No production writes: daemon cases require an explicit isolated runtime root.
"""
import argparse
import difflib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile

from metrics_isolation import isolated_suite
import frozen_oracle

ROOT = Path(__file__).resolve().parents[3]
# Declared normalization: created IDs and timestamps can change between calls.
NORMALIZATION = {'timestamps': r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z'}

FIXTURES = Path(__file__).with_name('fixtures') / 'differential.json'


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
    p.add_argument('--fixtures', type=Path, default=FIXTURES)
    p.add_argument('--only-differential', action='store_true',
                   help='Run the frozen case set without the separately owned follow-on suites')
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
    frozen = json.loads(args.fixtures.read_text())
    manifest = [(r['case'], r['argv']) for r in frozen['cases']]
    assert len({r[0] for r in manifest}) == len(manifest), 'duplicate frozen case'
    assert manifest == cases, ('frozen case manifest differs from surface/grammar: '
                               f'missing={sorted(set(n for n, _ in cases) - set(n for n, _ in manifest))}; '
                               f'extra={sorted(set(n for n, _ in manifest) - set(n for n, _ in cases))}')
    literals = {r['case']: r.get('nativeContract', {k: r[k] for k in ('exit', 'stdout', 'stderr')})
                for r in frozen['cases']}
    results = []
    rust_server_help = (ROOT / 'crates/hrc-cli/server-help.txt').read_text()
    for name, argv in cases:
        # This status spelling ignores its excess argument in the frozen CLI.
        # Probe no ambient tools: tmux's presence/version is not CLI grammar.
        case_env = dict(env, PATH='/nonexistent') if name == 'grammar:server status extra --json' else env
        child = subprocess.run([str(args.binary.resolve()), *argv], cwd=ROOT,
                               env=case_env, text=True, capture_output=True, timeout=20)
        subject = {'exit': child.returncode, 'stdout': child.stdout, 'stderr': child.stderr}
        expected = dict(literals[name])
        if name in {f'help:{path}:{view}' for path in ('server', 'server serve') for view in ('agent', 'human')}:
            expected['stdout'] += rust_server_help
        def normalize(item):
            item = frozen_oracle.project(item)
            # Only the explicitly supplied private roots, never arbitrary paths.
            return {k: re.sub(NORMALIZATION['timestamps'], '<timestamp>', v)
                    .replace(env['HRC_RUNTIME_DIR'], '<runtime-root>')
                    .replace(env['HRC_STATE_DIR'], '<state-root>')
                    if isinstance(v, str) else v for k, v in item.items()}
        good = normalize(expected) == normalize(subject)
        diff = ''.join(difflib.unified_diff(
            json.dumps(normalize(expected), indent=2).splitlines(True),
            json.dumps(normalize(subject), indent=2).splitlines(True),
            fromfile='frozen', tofile='native')) if not good else ''
        results.append({'case': name, 'argv': argv, 'pass': good,
                        'oracle': expected, 'subject': subject, 'diff': diff})
    # This bounded run proves grammar; execution belongs to the named suites.
    # Every grammar node is native; the map names its execution qualification.
    families = {
        'runtime.py': 'runtime list|runtime inspect|runtime status|show|ls|session list|session get|session meta get|admin status',
        'continuity.py': 'session resolve',
        'targets.py': 'target locate|target bindings|peek',
        'launch.py': 'start|run|attach',
        'restart.py': 'restart', 'restartme.py': 'restartme',
        'resume.py': 'resume', 'send.py': 'send', 'summon.py': 'summon',
        '../../hrc-native/e2e/seat_handoffs.py': 'handoff|handoff create|handoff get|handoff acknowledge|handoff list',
        '../../hrc-native/e2e/ledger_prune.py': 'runtime prune-window',
        'seat_work.py': 'seat|seat work|seat work get|seat work set',
        'annotations.py': 'session annotation|session annotation list|session annotation put|session annotation delete|session annotation act',
        'controls.py': 'runtime capture|runtime interrupt|runtime terminate|capture status|session drop-continuation|session rotate|admin surface bind',
        'server_lifecycle.py': 'server stop|server restart',
        'server_start.py': 'server start', 'daemon_entrypoints.py': 'server|server serve',
        'differential.py': '|monitor|admin|admin broker-verify|admin events|admin runs|admin surface|capture|federation|runtime|server tmux|session|session meta|target',
        'status.py': 'server status', 'turn_protocol.py': 'turn',
        'n5b_monitor_reads.py': 'monitor events|monitor transcript|monitor stats|monitor show|monitor session-report',
        'n5b_monitor_wait.py': 'monitor wait', 'n5b_monitor_watch.py': 'monitor watch',
        'n5b_local.py': 'info|doctor|runtime diagnostics|runtime prune|runtime sweep|server subscribers|server tmux status',
        'n5b_admin.py': 'admin broker-verify candidates|admin events drain|admin runs reconcile-active|admin runs sweep-zombies|admin worktrees|admin worktrees audit|admin worktrees prune',
        'transcript_search.py': 'monitor search',
        'metrics_report.py': 'admin metrics|admin metrics report|admin metrics routes',
        'session_meta_retire.py': 'session meta set|session meta clear|session retitle|federation retire',
    }
    suites = {command: suite for suite, commands in families.items() for command in commands.split('|')}
    assert set(suites) == {' '.join(node['path']) for node in nodes(surface)}
    qualification = [dict(line='cli:hrc' + (' ' + command if command else ''),
                          suite=suite,
                          reason='Execution obligation; this grammar run does not qualify execution.',
                          **({'requiredArguments': ['--extended']} if command == 'session resolve' else {}))
                     for command, suite in sorted(suites.items())]
    report = {'nativeCommands': sorted(suites), 'normalization': NORMALIZATION,
              'fixtureSource': frozen['sourceCommit'],
              'pass': sum(r['pass'] for r in results),
              'fail': sum(not r['pass'] for r in results), 'cases': results,
              'qualification': qualification,
              'qualificationNote': 'Suite names are coverage obligations, not behavioral PASS results.'}
    (args.artifacts / 'results.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({k: report[k] for k in ('pass', 'fail')}))
    for r in results:
        if not r['pass']:
            print('FAIL', r['case'])
            print(r.get('diff', ''))
    if args.only_differential:
        return int(bool(report['fail']))
    status_args = ['python3', str(ROOT / 'crates/hrc-cli/e2e/status.py'), '--binary', str(args.binary.resolve()), '--oracle', str(args.oracle.resolve()), '--artifacts', str(args.artifacts / 'status')]
    if args.runtime_root:
        status_args += ['--runtime-root', str(args.runtime_root.resolve()), '--state-root', str(args.state_root.resolve())]
    status = subprocess.run(status_args, cwd=ROOT)
    native = subprocess.run(['python3', str(ROOT / 'crates/hrc-cli/e2e/native_surface.py'), '--binary', str(args.binary.resolve()), '--artifacts', str(args.artifacts / 'native-surface')], cwd=ROOT)
    metric_args = ['python3', str(ROOT / 'crates/hrc-cli/e2e/metrics.py'), '--binary', str(args.binary.resolve()), '--oracle', str(args.oracle.resolve()), '--artifacts', str(args.artifacts / 'metrics')]
    if args.runtime_root:
        metric_args += ['--runtime-root', str(args.runtime_root.resolve())]
    metrics = subprocess.run(metric_args, cwd=ROOT)
    daemon = subprocess.run(['python3', str(ROOT / 'crates/hrc-cli/e2e/daemon_entrypoints.py'), '--binary', str(args.binary.resolve()), '--artifacts', str(args.artifacts / 'daemon-entrypoints')], cwd=ROOT)
    transport = subprocess.run(['python3', str(ROOT / 'crates/hrc-cli/e2e/client_errors.py'), '--binary', str(args.binary.resolve()), '--oracle', str(args.oracle.resolve()), '--artifacts', str(args.artifacts / 'client-errors')], cwd=ROOT)
    caller = subprocess.run(['python3', str(ROOT / 'crates/hrc-cli/e2e/caller.py'), '--binary', str(args.binary.resolve()), '--artifacts', str(args.artifacts / 'caller')], cwd=ROOT)
    return int(bool(report['fail']) or any(p.returncode != 0 for p in (status, native, metrics, daemon, transport, caller)))


if __name__ == '__main__':
    raise SystemExit(main())
