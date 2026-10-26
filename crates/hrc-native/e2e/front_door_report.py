#!/usr/bin/env python3
"""F gate 4 report for one fronted node: measured, not gated.

Reads <stateRoot>/metrics/{rusthrc-server,server}-<day>.ndjson and prints, per
route and UTC hour after --enabled-at, Rust's weighted count of servedBy=bun
requests beside Bun's weighted count of the same route, plus Rust's native
count. Bun's error rate (status >= 500, weighted) is compared for the same
length of time before and after --enabled-at. The usage population is Rust's
file; Bun's is its forwarded subset and is never summed with it.
"""
import argparse
import collections
import datetime
import json
from pathlib import Path


def load(root, prefix, start, end):
    out = []
    day = start.date()
    while day <= end.date():
        f = root / 'metrics' / f'{prefix}-{day.isoformat()}.ndjson'
        if f.exists():
            for line in f.read_text().splitlines():
                try:
                    r = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if r.get('kind') != 'server' or r.get('listener', 'main') != 'main':
                    continue
                ts = datetime.datetime.fromisoformat(r['ts'].replace('Z', '+00:00'))
                if start <= ts < end:
                    r['_ts'] = ts
                    out.append(r)
        day += datetime.timedelta(days=1)
    return out


def weight(r):
    return r.get('sampleWeight', 1)


def errors(rows):
    total = sum(weight(r) for r in rows)
    bad = sum(weight(r) for r in rows if r.get('status', 0) >= 500)
    return {'requests': total, 'errors5xx': bad, 'rate': (bad / total) if total else None}


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--state-root', type=Path, required=True)
    p.add_argument('--enabled-at', required=True, help='ISO time the node was fronted')
    p.add_argument('--hours', type=float, default=24)
    p.add_argument('--json', action='store_true')
    args = p.parse_args()
    enabled = datetime.datetime.fromisoformat(args.enabled_at.replace('Z', '+00:00'))
    span = datetime.timedelta(hours=args.hours)
    rust = load(args.state_root, 'rusthrc-server', enabled, enabled + span)
    bun_after = load(args.state_root, 'server', enabled, enabled + span)
    bun_before = load(args.state_root, 'server', enabled - span, enabled)
    table = collections.defaultdict(lambda: {'rustNative': 0, 'rustForwarded': 0, 'bun': 0})
    for r in rust:
        key = (r['_ts'].strftime('%Y-%m-%dT%H'), r['method'], r['route'])
        table[key]['rustNative' if r.get('servedBy') == 'native' else 'rustForwarded'] += weight(r)
    for r in bun_after:
        table[(r['_ts'].strftime('%Y-%m-%dT%H'), r['method'], r['route'])]['bun'] += weight(r)
    rows = [{'hour': h, 'method': m, 'route': rt, **v} for (h, m, rt), v in sorted(table.items())]
    report = {
        'enabledAt': enabled.isoformat(), 'hours': args.hours,
        'bunErrorsBefore': errors(bun_before), 'bunErrorsAfter': errors(bun_after),
        'frontErrors': errors([r for r in rust if r.get('servedBy') == 'native']),
        'frontForwardFailures': sum(weight(r) for r in rust
                                    if r.get('servedBy') == 'native' and r.get('status') == 502),
        'rows': rows,
    }
    if args.json:
        print(json.dumps(report, indent=2))
        return
    for key in ('bunErrorsBefore', 'bunErrorsAfter', 'frontErrors', 'frontForwardFailures'):
        print(f'{key}: {report[key]}')
    print(f'{"hour":14} {"method":6} {"route":48} {"native":>8} {"fwd":>8} {"bun":>8} {"fwd-bun":>8}')
    for r in rows:
        print(f'{r["hour"]:14} {r["method"]:6} {r["route"][:48]:48} {r["rustNative"]:>8} '
              f'{r["rustForwarded"]:>8} {r["bun"]:>8} {r["rustForwarded"] - r["bun"]:>8}')


if __name__ == '__main__':
    main()
