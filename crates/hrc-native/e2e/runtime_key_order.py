#!/usr/bin/env python3
"""Focused regression cases for N1 runtime response order, from real captures.

Failure modes: inspect's identity/header fields move; its nested context or
broker fields move; sweep inserts droppedContinuation before status; native
allocation persists tmux keys after window identity. Values keep their existing
suite comparators. An absent/empty population is a failure, never a green test.
"""
import argparse
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'conformance/hrc-parity'))
from key_order import differences


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--finding', choices=['inspect', 'sweep', 'tmux', 'stream'], required=True)
    p.add_argument('--baseline', type=Path, required=True)
    p.add_argument('--candidate', type=Path, required=True)
    p.add_argument('--out', type=Path, required=True)
    a = p.parse_args()
    def load(path):
        d = json.loads(path.read_text())
        return d['observations'] if isinstance(d, dict) else d
    bun, native = load(a.baseline), load(a.candidate)
    if a.finding == 'stream':
        cases = []
        for owner, rows in [('bun', bun), ('native', native)]:
            found = [r for r in rows if 'bounded-stream' in str(r.get('route', r.get('path', r.get('case', ''))))]
            if not found:
                cases.append(dict(owner=owner, **{'pass': False}, reason='missing follow case'))
            for r in found:
                raw = r.get('raw', r.get('body'))
                value = json.loads(raw.splitlines()[0]) if isinstance(raw, str) else raw
                cases.append(dict(owner=owner, status=r.get('status'), body=value,
                                  **{'pass': r.get('status') == 200 and isinstance(value, dict) and value.get('type') == 'ready'}))
        report = dict(finding='stream', compared=len(cases), failed=sum(not c['pass'] for c in cases), cases=cases)
        a.out.parent.mkdir(parents=True, exist_ok=True)
        a.out.write_text(json.dumps(report, indent=2) + '\n')
        print(json.dumps({k: v for k, v in report.items() if k != 'cases'}))
        return int(bool(report['failed']))
    left, right = ({r['case']: r for r in rows} for rows in (bun, native))
    results = []
    for name, b in left.items():
        n = right.get(name)
        if n is None:
            results.append(dict(case=name, **{'pass': False}, reason='missing case'))
            continue
        bv, nv = (r.get('response', r).get('body') for r in (b, n))
        probes = []
        if a.finding == 'inspect' and name in ('inspect', 'inspect-trimmed', 'inspect-inactive', 'inspect-owner-null', 'inspect-owner-empty'):
            if isinstance(bv, dict) and isinstance(nv, dict):
                probes = [('$', dict.fromkeys(bv), dict.fromkeys(nv))]
                for key in ('contextReading', 'broker'):
                    if key in bv or key in nv:
                        probes.append(('$.' + key, bv.get(key), nv.get(key)))
        elif a.finding == 'sweep' and name.startswith('sweep') and isinstance(bv, dict) and isinstance(nv, dict):
            probes = [('$.results', bv.get('results'), nv.get('results'))]
        elif a.finding == 'tmux' and name.startswith('runtimes') and isinstance(bv, list) and isinstance(nv, list):
            for i, (br, nr) in enumerate(zip(bv, nv, strict=True)):
                for path, obj in [('tmuxJson', br), ('runtimeStateJson.tmux', br.get('runtimeStateJson', {}))]:
                    key = 'tmuxJson' if path == 'tmuxJson' else 'tmux'
                    other = nr if key == 'tmuxJson' else nr.get('runtimeStateJson', {})
                    if isinstance(obj.get(key), dict) and isinstance(other.get(key), dict):
                        probes.append((f'$[{i}].{path}', obj[key], other[key]))
        for path, before, after in probes:
            delta = differences(before, after, path)
            results.append(dict(case=name, path=path, differences=delta, **{'pass': not delta}))
    report = dict(finding=a.finding, compared=len(results), failed=sum(not r['pass'] for r in results), cases=results)
    if not results:
        report['failed'] = 1
        report['error'] = 'empty finding population'
    a.out.parent.mkdir(parents=True, exist_ok=True)
    a.out.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({k: v for k, v in report.items() if k != 'cases'}))
    return int(bool(report['failed']))


if __name__ == '__main__':
    raise SystemExit(main())
