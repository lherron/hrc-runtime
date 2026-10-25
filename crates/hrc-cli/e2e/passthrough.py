#!/usr/bin/env python3
"""Pass-through release resolution, exact streams/exits, stdin and exec identity.

No shared data or daemons. The ordinary oracle cases use the real Bun CLI on
absent isolated roots; a process seam proves exec keeps the same PID and argv.
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

from metrics_isolation import isolated_suite

ROOT = Path(__file__).resolve().parents[3]


@isolated_suite
def main():
    p = argparse.ArgumentParser()
    p.add_argument('--binary', type=Path, required=True)
    p.add_argument('--oracle', type=Path, required=True)
    p.add_argument('--artifacts', type=Path, required=True)
    args = p.parse_args()
    args.artifacts.mkdir(parents=True, exist_ok=True)
    results = []
    with tempfile.TemporaryDirectory(prefix='n5-pass-') as temp:
        root = Path(temp)
        release = root / 'release'
        (release / 'bin').mkdir(parents=True)
        native = release / 'bin/rusthrc'
        shutil.copy2(args.binary, native)
        script = release / 'packages/hrc-cli/bin/hrc.js'
        script.parent.mkdir(parents=True)
        script.symlink_to(args.oracle.resolve())
        link = root / 'rusthrc'
        link.symlink_to(native)
        env = dict(os.environ, HRC_RUNTIME_DIR=str(root / 'run'), HRC_STATE_DIR=str(root / 'state'), NO_COLOR='1', FORCE_COLOR='0', HRC_METRICS='0')
        cases = [['session', 'list', '--json'], ['session', 'resolve'], ['runtime', 'status', 'rt-missing', '--json'], ['run', 'export', 'run-missing'], ['run', 'annotate', 'run-missing', '-'], ['admin', 'metrics', 'report', '--json'], ['index', 'status', '--json']]
        for argv in cases:
            observed = []
            for command in (['bun', str(args.oracle.resolve())], [str(link)]):
                child = subprocess.run(command + argv, cwd=ROOT, env=env, input='payload from stdin\n', text=True, capture_output=True, timeout=15)
                observed.append(dict(exit=child.returncode, stdout=child.stdout, stderr=child.stderr))
            results.append(dict(argv=argv, oracle=observed[0], subject=observed[1], **{'pass': observed[0] == observed[1]}))
        # Implemented command grammar must remain native when Bun is absent.
        bun = shutil.which('bun')
        no_bun = dict(env, PATH=str(root / 'no-bun'))
        for argv in (['runtime', 'list', 'extra'], ['runtime', 'inspect'], ['server', 'status', '--wat']):
            expected = subprocess.run([bun, str(args.oracle.resolve())] + argv, env=env, cwd=ROOT, text=True, capture_output=True)
            subject = subprocess.run([str(args.binary.resolve())] + argv, env=no_bun, cwd=ROOT, text=True, capture_output=True)
            oracle = dict(exit=expected.returncode, stdout=expected.stdout, stderr=expected.stderr)
            observed = dict(exit=subject.returncode, stdout=subject.stdout, stderr=subject.stderr)
            results.append(dict(case='native grammar without Bun', argv=argv, oracle=oracle, subject=observed, **{'pass': oracle == observed}))
        # The executable named bun is a process seam, not an oracle for CLI behavior.
        # Its PID must be the rusthrc PID: spawn-and-wait does not satisfy exec.
        shim = root / 'tools'
        shim.mkdir()
        (shim / 'bun').write_text('#!' + sys.executable + '\nimport os,sys,json\nprint(json.dumps(dict(pid=os.getpid(),argv=sys.argv[1:],stdin=sys.stdin.read())))\nprint("forwarded stderr",file=sys.stderr)\nsys.exit(37)\n')
        (shim / 'bun').chmod(0o755)
        env['PATH'] = str(shim)
        child = subprocess.Popen([str(link), 'run', 'annotate', 'literal $(not shell)', '-'], env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        out, err = child.communicate('exact stdin\n', timeout=10)
        try:
            value = json.loads(out)
        except json.JSONDecodeError:
            value = {}
        good = child.returncode == 37 and err == 'forwarded stderr\n' and value == dict(pid=child.pid, argv=[str(native.resolve().parents[1] / 'packages/hrc-cli/bin/hrc.js'), 'run', 'annotate', 'literal $(not shell)', '-'], stdin='exact stdin\n')
        results.append(dict(case='exec identity and literal argv/stdin/stderr/exit', subject=dict(exit=child.returncode, stdout=out, stderr=err), **{'pass': good}))
    report = dict(cases=results, **{'pass': sum(r['pass'] for r in results), 'fail': sum(not r['pass'] for r in results)})
    (args.artifacts / 'results.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({k: report[k] for k in ('pass', 'fail')}))
    return int(bool(report['fail']))


if __name__ == '__main__':
    raise SystemExit(main())
