#!/usr/bin/env python3
"""Mutate real ready captures; the named owner-relative gate must discriminate."""
import argparse
import copy
import json
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'conformance/hrc-parity'))
from owner_relative import bounded_ready


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--baseline', type=Path, required=True)
    p.add_argument('--candidate', type=Path, required=True)
    p.add_argument('--out', type=Path, required=True)
    a = p.parse_args()
    baseline = json.loads((a.baseline / 'observations.json').read_text())
    candidate = json.loads((a.candidate / 'observations.json').read_text())
    bun = next(row for row in baseline if 'bounded-stream?' in row['path'])
    results = []
    for control in ('identical', 'wrong-native-head', 'bun-incarnation', 'missing-field', 'unlisted-field'):
        directory = a.out / control
        directory.mkdir(parents=True, exist_ok=True)
        shutil.copytree(a.candidate, directory / 'native', dirs_exist_ok=True)
        rows = copy.deepcopy(candidate)
        row = next(row for row in rows if 'bounded-stream?' in row['path'])
        ready = json.loads(row['wireBody'])
        if control == 'wrong-native-head':
            ready['replayHeadHrcSeq'] += 1
        elif control == 'bun-incarnation':
            ready['ledgerIncarnationId'] = bun['ownerPage']['ledgerIncarnationId']
        elif control == 'missing-field':
            del ready['acceptedAfterHrcSeq']
        elif control == 'unlisted-field':
            ready['type'] = 'not-ready'
        row['wireBody'] = json.dumps(ready, separators=(',', ':')) + '\n'
        projected, rule = bounded_ready(row)
        invalid_stays_raw = control == 'identical' or (not rule['pass'] and projected['body'] == row['wireBody'])
        (directory / 'native/observations.json').write_text(json.dumps(rows, indent=2) + '\n')
        run = subprocess.run([sys.executable, str(ROOT / 'conformance/hrc-parity/run.py'),
                              'compare', '--suite', 'n1-passthrough', '--baseline', str(a.baseline),
                              '--candidate', str(directory / 'native'), '--out', str(directory / 'compare')],
                             capture_output=True, text=True)
        (directory / 'stdout').write_text(run.stdout + run.stderr)
        passed = run.returncode == (0 if control == 'identical' else 1) and invalid_stays_raw
        results.append(dict(control=control, exit=run.returncode, invalidStaysRaw=invalid_stays_raw, **{'pass': passed}))
    report = dict(controls=results, **{'pass': all(r['pass'] for r in results)})
    (a.out / 'control-results.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report))
    return int(not report['pass'])


if __name__ == '__main__':
    raise SystemExit(main())
