#!/usr/bin/env python3
"""Every hand-owned help node and grammar refusal works without a Bun runtime.

Failure cases: missing native dispatch, wrong help stream, altered server
appendix, a hidden Bun exec, or turn JSON errors losing their intended format.
"""
import argparse
import json
import os
from pathlib import Path
import subprocess
import tempfile

from metrics_isolation import isolated_suite

ROOT = Path(__file__).resolve().parents[3]


def nodes(node):
    yield node
    for child in node['children']:
        yield from nodes(child)


@isolated_suite
def main():
    p = argparse.ArgumentParser()
    p.add_argument('--binary', type=Path, required=True)
    p.add_argument('--artifacts', type=Path, required=True)
    args = p.parse_args()
    args.artifacts.mkdir(parents=True, exist_ok=True)
    surface = json.loads((ROOT / 'crates/hrc-cli/surface.json').read_text())
    appendix = (ROOT / 'crates/hrc-cli/server-help.txt').read_text()
    results = []
    with tempfile.TemporaryDirectory(prefix='hrc-native-surface-', dir='/tmp') as temp:
        root = Path(temp)
        env = dict(os.environ, HRC_RUNTIME_DIR=str(root / 'run'),
                   HRC_STATE_DIR=str(root / 'state'), PATH=str(root / 'no-bun'),
                   NO_COLOR='1', FORCE_COLOR='0')
        for node in nodes(surface):
            for view, field in (('agent', 'help'), ('human', 'humanHelp')):
                argv = ['--' + view, *node['path'], '--help']
                c = subprocess.run([str(args.binary.resolve()), *argv], env=env,
                                   capture_output=True, text=True, timeout=20)
                expected = node[field] + (appendix if ' '.join(node['path']) in ('server', 'server serve') else '')
                results.append(dict(argv=argv, exit=c.returncode, stdout=c.stdout,
                                    stderr=c.stderr, **{'pass': c.returncode == 0 and c.stdout == expected and not c.stderr}))
            argv = [*node['path'], '--native-surface-invalid']
            c = subprocess.run([str(args.binary.resolve()), *argv], env=env,
                               capture_output=True, text=True, timeout=20)
            results.append(dict(argv=argv, exit=c.returncode, stdout=c.stdout,
                                stderr=c.stderr, **{'pass': c.returncode == 2 and not c.stdout and 'unknown option:' in c.stderr}))
    report = dict(cases=results, **{'pass': sum(r['pass'] for r in results),
                                  'fail': sum(not r['pass'] for r in results)})
    (args.artifacts / 'results.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({k: report[k] for k in ('pass', 'fail')}))
    return int(bool(report['fail']))


if __name__ == '__main__':
    raise SystemExit(main())
