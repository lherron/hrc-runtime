#!/usr/bin/env python3
"""Native lifecycle refusal parity on an owned daemon.
Failure modes: actuation bypasses daemon authorization; wrong caller credential;
wrong defaults/duplicate-option precedence; bad timeout parsing; lost failure
code or message; JSON support drift. No granted lifecycle request is made here.
"""
import argparse, json, os, shutil, subprocess, sys
from pathlib import Path
from metrics_isolation import isolated_suite


@isolated_suite
def main():
    p = argparse.ArgumentParser()
    for name in ('binary', 'oracle', 'runtime-root', 'state-root', 'seat', 'artifacts'):
        p.add_argument('--' + name, type=Path, required=True)
    p.add_argument('--include-start', action='store_true')
    a = p.parse_args()
    assert all(root.resolve().is_relative_to(Path('/tmp').resolve()) for root in (a.runtime_root, a.state_root))
    seat = json.loads(a.seat.read_text())
    assert ':project:n5-t11819:task:n5-restartme-' in seat['sessionRef']
    a.artifacts.mkdir(parents=True, exist_ok=True)
    e = {k:v for k,v in os.environ.items() if not k.startswith(('ASP_', 'HRC_', 'WRKQ'))}
    e.update(HRC_RUNTIME_DIR=str(a.runtime_root), HRC_STATE_DIR=str(a.state_root), HRC_SESSION_REF=seat['sessionRef'], HRC_RUNTIME_ID=seat['runtimeId'], NO_COLOR='1', FORCE_COLOR='0')
    cmds = [('oracle', [shutil.which('bun'), str(a.oracle.resolve())]), ('subject', [str(a.binary.resolve())])]
    cases=[]
    for action in (('start', 'stop', 'restart') if a.include_start else ('stop', 'restart')):
     flags=[[],['extra'],['--output','json']]
     if action=='start':flags += [['--daemon'],['--foreground'],['--daemon','--foreground'],['--background','--foreground']]+[['--timeout-ms',v] for v in ('0','-1','x','1.5','1e2',' 2 ','2x')]
     else:flags += [['--wait','--drain'],['--reason','owned refusal'],['--force'],['--node','absent-n5-node']]+[[f,v] for f in ('--proof-timeout-ms','--wait-timeout-ms','--drain-timeout-ms') for v in ('0','-1','x','1.5','1e2')]+[['--proof-timeout-ms','0','--proof-timeout-ms','2'],['--proof-timeout-ms','2','--proof-timeout-ms','0']]
     cases += [['server',action]+flags for flags in flags]

    results = []
    for argv in cases:
        observed = []
        for label, cmd in cmds:
            env = dict(e)
            if label == 'subject':
                env['PATH'] = str(a.artifacts / 'no-bun')
            child = subprocess.run(cmd + argv, env=env, capture_output=True, text=True, timeout=40)
            observed.append(dict(exit=child.returncode, stdout=child.stdout, stderr=child.stderr))
        assert observed[0]['exit'] != 0, (argv, observed[0])
        results.append(dict(argv=argv, oracle=observed[0], subject=observed[1], **{'pass': observed[0] == observed[1]}))
    report = dict(cases=results, **{'pass': sum(x['pass'] for x in results), 'fail': sum(not x['pass'] for x in results)})
    (a.artifacts / 'results.json').write_text(json.dumps(report, indent=2))
    print(json.dumps({k:report[k] for k in ('pass', 'fail')}))
    assert report['fail'] == 0


if __name__ == '__main__':
    main()
