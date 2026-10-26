"""Shared N5b differential runner: Bun oracle vs rusthrc with Bun absent.

Failure modes guarded here: the subject silently execs Bun (its PATH has no
bun), a run inherits production roots (every ASP_/HRC_/WRKQ variable is
dropped and both roots are explicit scratch), normalization hides a real
difference (only patterns a suite declares by name are applied), and a suite
reports success without evidence (results.json keeps both raw observations).
"""
import json
import os
from pathlib import Path
import re
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[3]
PRODUCTION = Path.home() / 'praesidium/var'


def scratch_env(runtime_root, state_root, **extra):
    for root in (runtime_root, state_root):
        assert not str(Path(root).resolve()).startswith(str(PRODUCTION)), f'production root {root}'
    env = {k: v for k, v in os.environ.items() if not k.startswith(('ASP_', 'HRC_', 'WRKQ', 'AGENT_ID'))}
    env.update(HRC_RUNTIME_DIR=str(runtime_root), HRC_STATE_DIR=str(state_root), NO_COLOR='1', FORCE_COLOR='0')
    env.update(extra)
    return env


def normalize(item, normalization):
    item = dict(item)
    for stream in ('stdout', 'stderr'):
        for pattern, replacement in normalization.values():
            item[stream] = re.sub(pattern, replacement, item[stream])
    return item


class Runner:
    def __init__(self, binary, oracle, artifacts, env, normalization, cwd=ROOT, timeout=30):
        self.binary, self.oracle = Path(binary).resolve(), Path(oracle).resolve()
        self.artifacts, self.env, self.normalization = Path(artifacts), env, normalization
        self.cwd, self.timeout = cwd, timeout
        self.artifacts.mkdir(parents=True, exist_ok=True)
        no_bun = self.artifacts / 'no-bun'
        no_bun.mkdir(exist_ok=True)
        self.subject_path = f'{no_bun}:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin'
        if shutil.which('bun', path=self.subject_path):
            self.subject_path = str(no_bun) + ':/usr/bin:/bin'
        self.bun = shutil.which('bun')
        self.results = []

    def observe(self, argv, subject, env=None, stdin=None):
        env = dict(env or self.env)
        command = [str(self.binary)] if subject else [self.bun, str(self.oracle)]
        if subject:
            env['PATH'] = self.subject_path
        c = subprocess.run(command + argv, cwd=self.cwd, env=env, text=True, capture_output=True,
                           timeout=self.timeout, input=stdin)
        return dict(exit=c.returncode, stdout=c.stdout, stderr=c.stderr)

    def case(self, argv, name=None, env=None, unsupported=None, stdin=None):
        oracle = self.observe(argv, False, env, stdin)
        subject = self.observe(argv, True, env, stdin)
        ok = normalize(oracle, self.normalization) == normalize(subject, self.normalization)
        row = dict(case=name or ' '.join(argv), argv=argv, oracle=oracle, subject=subject, **{'pass': ok})
        if unsupported:
            row['unsupported'] = unsupported
        self.results.append(row)
        return row

    def finish(self, **meta):
        failed = [r for r in self.results if not r['pass'] and not r.get('unsupported')]
        report = dict(meta, normalization={k: list(v) for k, v in self.normalization.items()},
                      cases=self.results, **{'pass': sum(r['pass'] for r in self.results),
                                             'fail': len(failed),
                                             'unsupported': sum(bool(r.get('unsupported')) for r in self.results)})
        (self.artifacts / 'results.json').write_text(json.dumps(report, indent=2) + '\n')
        print(json.dumps({k: report[k] for k in ('pass', 'fail', 'unsupported')}))
        for r in failed:
            print('FAIL', r['case'])
        return int(bool(failed))
