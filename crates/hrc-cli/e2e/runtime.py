#!/usr/bin/env python3
"""Read-only differential commands against an explicitly provisioned real seat.

Failure modes: selectors select a different seat, raw IDs lose their fast path,
unknown/type-mismatched selectors produce wrong errors, inspection hides broker
provenance, show changes record fields, pagination silently drops candidates.
"""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import shutil

from metrics_isolation import isolated_suite

ROOT = Path(__file__).resolve().parents[3]
NORMALIZATION = {
    'federation_latency_json': (r'("latencyMs": )[\d.]+', r'\1<latency>'),
    'federation_latency_human': (r', [\d.]+ms,', ', <latency>ms,'),
    'timestamp': (r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z', '<timestamp>'),
    'age_json': (r'("(?:createdAgeSec|lastActivityAgeSec)": )[\d.]+', r'\1<age>'),
    'age_human': (r'\(age: [^)]+\)', '(age: <age>)'),
}


def normalize(item):
    item = dict(item)
    for stream in ('stdout', 'stderr'):
        for pattern, replacement in NORMALIZATION.values():
            item[stream] = re.sub(pattern, replacement, item[stream])
    return item


@isolated_suite
def main():
    p = argparse.ArgumentParser()
    for flag in ('binary', 'oracle', 'runtime-root', 'state-root', 'seat', 'artifacts'):
        p.add_argument('--' + flag, type=Path, required=True)
    args = p.parse_args()
    assert not str(args.runtime_root.resolve()).startswith(str(Path.home() / 'praesidium/var'))
    seat = json.loads(args.seat.read_text())
    rid, host = seat['start']['runtimeId'], seat['start']['hostSessionId']
    scope, ref = seat['scope'], seat['sessionRef']
    rows = json.loads(subprocess.check_output(['curl', '--silent', '--show-error', '--unix-socket', str(args.runtime_root / 'hrc.sock'), 'http://localhost/v1/runtimes']))
    assert any(r['runtimeId'] == rid and r['scopeRef'] == scope for r in rows), 'real owned scratch seat must exist'
    args.artifacts.mkdir(parents=True, exist_ok=True)
    env = {k: v for k, v in os.environ.items() if not k.startswith(('ASP_', 'HRC_', 'WRKQ'))}
    env.update(HRC_RUNTIME_DIR=str(args.runtime_root), HRC_STATE_DIR=str(args.state_root), NO_COLOR='1', FORCE_COLOR='0')
    cases = []
    for command in (['runtime', 'status'], ['runtime', 'inspect']):
        for selector in (rid, 'runtime:' + rid, scope, 'scope:' + scope, 'session:' + ref, 'tabularasa@hrc-runtime:n5-11819-acceptance', 'runtime:rt-missing', 'host:' + host, 'msg:missing', 'seq:1', 'runtime:', 'wat:foo'):
            for flags in ([], ['--json']):
                cases.append(command + [selector] + flags)
    for selector in (rid, 'runtime:' + rid, host, 'host:' + host, 'scope:' + scope, 'msg:missing', 'seq:1'):
        for flags in ([], ['--json']):
            cases.append(['show', selector] + flags)
    for command in (['session', 'list', '--porcelain'], ['session', 'list', '--all'], ['runtime', 'list', '--scope', 'scope:' + scope], ['runtime', 'list', '--all-nodes'], ['runtime', 'list', '--all-nodes', '--json'], ['ls', 'messages'], ['runtime', 'inspect', rid, '--probe', '--json']):
        cases.append(command)
    for command in (['session', 'get'], ['session', 'meta', 'get']):
        for selector in (host, 'host:' + host, scope, 'scope:' + scope, 'session:' + ref, ref, 'tabularasa@hrc-runtime:n5-11819-acceptance', 'hsid-missing', 'host:hsid-missing', rid, 'runtime:' + rid, 'msg:missing', 'seq:1', 'wat:foo'):
            cases.append(command + [selector])
    for selector in (host, 'host:' + host, 'scope:' + scope, 'session:' + ref, 'runtime:' + rid, 'hsid-missing'):
        cases.append(['session', 'get', selector, '--live'])
    cases.extend([['admin', 'status'], ['admin', 'status', '--json'], ['--agent', 'runtime', 'list', '--json'], ['--agent', 'runtime', 'list', '--agent', 'tabularasa', '--json']])
    for flags in (['--since', '1d'], ['--since', '0s'], ['--since', 'bad'], ['--all', '--since', 'bad']):
        cases.append(['session', 'list', '--porcelain'] + flags)
    results = []
    bun = shutil.which("bun")
    for argv in cases:
        observed = []
        for oracle, command in ((True, [bun, str(args.oracle.resolve())]), (False, [str(args.binary.resolve())])):
            child_env = env if oracle else dict(env, PATH=str(args.artifacts / 'no-bun'))
            c = subprocess.run(command + argv, cwd=ROOT, env=child_env, text=True, capture_output=True, timeout=20)
            observed.append(dict(exit=c.returncode, stdout=c.stdout, stderr=c.stderr))
        results.append(dict(argv=argv, oracle=observed[0], subject=observed[1], **{'pass': normalize(observed[0]) == normalize(observed[1])}))
    report = dict(execution='native-required; Bun absent from subject PATH', normalization=NORMALIZATION, cases=results, **{'pass': sum(r['pass'] for r in results), 'fail': sum(not r['pass'] for r in results)})
    (args.artifacts / 'results.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({k: report[k] for k in ('pass', 'fail')}))
    for r in results:
        if not r['pass']:
            print('FAIL', ' '.join(r['argv']))
    return int(bool(report['fail']))


if __name__ == '__main__':
    raise SystemExit(main())
