#!/usr/bin/env python3
"""Read-only placement and pane commands on a real owned seat. Verify scope
qualification, caller defaults, streamed bytes, errors, and native execution.
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess

from metrics_isolation import isolated_suite
from runtime import normalize, ROOT


@isolated_suite
def main():
    p = argparse.ArgumentParser()
    for flag in ('binary', 'oracle', 'runtime-root', 'state-root', 'seat', 'artifacts'):
        p.add_argument('--' + flag, type=Path, required=True)
    args = p.parse_args()
    assert not str(args.runtime_root.resolve()).startswith(str(Path.home() / 'praesidium/var'))
    seat = json.loads(args.seat.read_text())
    scope, ref = seat['scope'], seat['sessionRef']
    handle = 'tabularasa@hrc-runtime:n5-11819-acceptance'
    args.artifacts.mkdir(parents=True, exist_ok=True)
    env = {k: v for k, v in os.environ.items() if not k.startswith(('ASP_', 'HRC_', 'WRKQ'))}
    env.update(HRC_RUNTIME_DIR=str(args.runtime_root), HRC_STATE_DIR=str(args.state_root), NO_COLOR='1', FORCE_COLOR='0')
    cases = []
    for target in (scope, handle, handle + '~main', 'tabularasa', 'tabularasa:n5-11819-acceptance', 'scope:' + scope, ref, 'missing@hrc-runtime:missing', 'bad handle'):
        for flags in ([], ['--json'], ['--json', '--fail-on-skew']):
            cases.append((['target', 'locate', target] + flags, {}))
    cases.extend([(['target', 'bindings'], {}), (['target', 'bindings', '--json'], {})])
    for target in (scope, handle, handle + '~main', 'session:' + ref, seat['start']['hostSessionId'], 'bad handle'):
        for flags in ([], ['--json']): cases.append((['peek', target, '--lines', '5'] + flags, {}))
    for target in ('tabularasa', 'tabularasa:n5-11819-acceptance'):
        cases.append((['peek', target, '--lines', '5', '--json'], dict(ASP_PROJECT='hrc-runtime', HRC_SESSION_REF=ref)))
    for suffix in ('~alternate', '~', '+node=max3', '+yolo=true', '+remote=wat', '+node=a+node=b', '+unknown=yes', '+'):
        cases.append((['target', 'locate', handle + suffix, '--json'], {}))
        cases.append((['peek', handle + suffix, '--json'], {}))
    for lines in ('0', '-1', 'abc', '6suffix', '2.2', '999999999999999999999'):
        cases.append((['peek', handle, '--lines', lines, '--json'], {}))
    for extra in (dict(ASP_PROJECT='hrc-runtime'), dict(ASP_PROJECT='hrc-runtime', ASP_DEFAULT_TASK='n5-11819-acceptance')):
        cases.append((['target', 'locate', 'tabularasa', '--json'], extra))
    observed = []
    bun = shutil.which('bun')
    for argv, extra in cases:
        items = []
        for label, command in (('oracle', [bun, str(args.oracle.resolve())]), ('subject', [str(args.binary.resolve())])):
            child_env = dict(env, **extra)
            if label == 'subject': child_env['PATH'] = str(args.artifacts / 'no-bun')
            c = subprocess.run(command + argv, cwd=ROOT, env=child_env, text=True, capture_output=True, timeout=20)
            items.append(dict(exit=c.returncode, stdout=c.stdout, stderr=c.stderr))
        observed.append(dict(argv=argv, env=extra, oracle=items[0], subject=items[1], **{'pass': normalize(items[0]) == normalize(items[1])}))
    report = dict(cases=observed, **{'pass': sum(r['pass'] for r in observed), 'fail': sum(not r['pass'] for r in observed)})
    (args.artifacts / 'results.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({k: report[k] for k in ('pass', 'fail')}))
    for r in observed:
        if not r['pass']: print('FAIL', r['argv'])
    return int(bool(report['fail']))


if __name__ == '__main__':
    raise SystemExit(main())
