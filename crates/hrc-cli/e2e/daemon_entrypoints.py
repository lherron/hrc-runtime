#!/usr/bin/env python3
"""Real isolated daemon entrypoints: neither may exec Bun; each invocation must
record its own command, graceful exit and zero stdout exactly once. Schema is
created by Bun, then backed up per case; all CLI state belongs to this suite.
"""
import argparse
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import tempfile
import time

from metrics_isolation import isolated_suite

ROOT = Path(__file__).resolve().parents[3]


@isolated_suite
def main():
    p = argparse.ArgumentParser()
    for flag in ('binary', 'artifacts'):
        p.add_argument('--' + flag, type=Path, required=True)
    args = p.parse_args()
    args.artifacts.mkdir(parents=True, exist_ok=True)
    results = []
    with tempfile.TemporaryDirectory(prefix='n5-daemon-', dir='/tmp') as temp:
        root = Path(temp)
        env = {k: v for k, v in os.environ.items() if not k.startswith(('ASP_', 'HRC_', 'WRKQ'))}
        env.update(HRC_STATE_DIR=str(root / 'source-state'), HRC_RUNTIME_DIR=str(root / 'source-run'))
        source = root / 'source.sqlite'
        subprocess.run(['bun', '-e', 'import {openHrcDatabase} from "./packages/hrc-store-sqlite/src/database.ts"; openHrcDatabase(process.argv[1]).close()', str(source)], cwd=ROOT, env=env, check=True, capture_output=True)
        for argv in (['server'], ['server', 'serve'], ['--agent', 'server', 'serve'], ['server', 'serve', '--human']):
            case = root / '-'.join(argv)
            state = case / 'state'
            state.mkdir(parents=True)
            with sqlite3.connect(source) as a, sqlite3.connect(state / 'state.sqlite') as b:
                a.backup(b)
            run = case / 'run'
            child_env = dict(env, HRC_STATE_DIR=str(state), HRC_RUNTIME_DIR=str(run), PATH=str(root / 'no-bun'), HRC_METRICS='1')
            log = args.artifacts / ('-'.join(argv) + '.log')
            with log.open('w') as output:
                proc = subprocess.Popen([str(args.binary.resolve())] + argv, env=child_env, cwd=ROOT, stdout=subprocess.PIPE, stderr=output)
                try:
                    for _ in range(100):
                        if proc.poll() is not None or (run / 'hrc.sock').exists():
                            break
                        time.sleep(.05)
                    listening = proc.poll() is None and (run / 'hrc.sock').exists()
                finally:
                    if proc.poll() is None:
                        proc.terminate()
                    stdout, _ = proc.communicate(timeout=10)
            records = [json.loads(line) for path in (state / 'metrics').glob('cli-*.ndjson') for line in path.read_text().splitlines()]
            good = listening and proc.returncode == 0 and not stdout and len(records) == 1
            if good:
                r = records[0]
                good = (r['bin'], r['cmd'], r['exitCode'], r['pid'], r['stdoutBytes'], r['rpc']) == ('rusthrc', ' '.join(a for a in argv if not a.startswith('--')), 0, proc.pid, 0, []) and r['durMs'] >= 0
            results.append(dict(argv=argv, listening=listening, exit=proc.returncode, stdout=stdout.decode(), records=records, **{'pass': good}))
    report = dict(cases=results, **{'pass': sum(r['pass'] for r in results), 'fail': sum(not r['pass'] for r in results)})
    (args.artifacts / 'results.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({k: report[k] for k in ('pass', 'fail')}))
    return int(bool(report['fail']))


if __name__ == '__main__':
    raise SystemExit(main())
