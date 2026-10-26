"""N5 cases: the native CLI and the server lifecycle, qualified by N5's e2e drivers.

Each N5 driver (crates/hrc-cli/e2e, crates/hrc-native/e2e) runs Bun and rusthrc
on the same fixture and compares them itself, writing results.json with every
raw observation. --candidate is one aggregate root holding one directory per
driver run. This checker re-reads those results: every case must pass, an
UNSUPPORTED case only with a ruled reason, the summary counts must agree with
the cases, and the suite's production-metrics isolation record must be clean.
An absent, empty or summary-only result never qualifies.
"""
import json
from pathlib import Path

# Driver directories each case requires under --candidate.
SUITES = {
    'n5-status': ('status',),
    'n5-monitor': ('n5b_monitor_reads', 'n5b_monitor_wait', 'n5b_monitor_watch', 'n5b_monitor_pty'),
    'n5-lifecycle': ('lifecycle_credentials', 'lifecycle_actions', 'lifecycle_peer', 'lifecycle_rows', 'server_lifecycle'),
    'n5-shutdown': ('lifecycle_shutdown_unix', 'lifecycle_shutdown_peer', 'lifecycle_shutdown_registry'),
    'n5-server-owner': ('server_owner', 'server_start'),
}

# Bun behavior N5 deliberately does not reproduce, by exact reason and ruling.
APPROVED_UNSUPPORTED = {
    # mable EN-35430
    'Bun server status reports schema unreadable on a checkpointed WAL-header store with no -wal/-shm sidecars; '
    'Rust reads the schema and creates the SQLite coordination files.',
    # mable EN-35430
    'Bun truncates server status --json above 64 KiB; Rust emits complete JSON',
    # mable EN-35470
    'Bun creates and migrates a new HRC store at a nonexistent drain path and reports 0 drained; '
    'rusthrc refuses and never creates a store.',
}


def case_outcome(case):
    """'pass', 'unsupported' (ruled) or 'fail' for one driver case."""
    if case.get('pass') is True or case.get('pass_') is True:
        return 'pass'
    reason = case.get('reason') if case.get('status') == 'UNSUPPORTED' else case.get('unsupported')
    return 'unsupported' if reason in APPROVED_UNSUPPORTED else 'fail'


def check_driver(root, name, checks):
    """Validate one driver directory; returns its outcome counts."""
    path = root / name / 'results.json'
    if not path.is_file():
        checks.append({'id': name + ':results', 'pass': False, 'reason': 'driver results.json is missing', 'failureCode': 2})
        return {}
    result = json.loads(path.read_text())
    cases = result.get('cases')
    outcomes = [case_outcome(c) for c in cases] if isinstance(cases, list) else []
    counts = {k: outcomes.count(k) for k in ('pass', 'unsupported', 'fail')}
    checks.append({'id': name + ':nonvacuous', 'pass': counts['pass'] > 0,
                   'reason': 'a driver with no passing case qualifies nothing', 'failureCode': 2})
    checks.append({'id': name + ':cases', 'pass': counts['fail'] == 0,
                   'reason': 'every case passes or is a ruled UNSUPPORTED', 'failureCode': 1})
    # A numeric summary must agree with its cases; a boolean one must be true.
    summary = result.get('pass', result.get('pass_'))
    agrees = summary == counts['pass'] if type(summary) is int else summary is True
    if type(result.get('fail')) is int:
        agrees = agrees and result['fail'] == 0
    checks.append({'id': name + ':summary', 'pass': agrees,
                   'reason': 'results.json totals must match its cases', 'failureCode': 1})
    isolation = root / name / 'production-metrics-isolation.json'
    record = json.loads(isolation.read_text()) if isolation.is_file() else {}
    checks.append({'id': name + ':isolation', 'pass': record.get('pass') is True and record.get('ownedRecords') == [],
                   'reason': 'the suite wrote no production CLI metrics', 'failureCode': 1})
    return counts


def compare_cli(args, checks):
    """Every inventory line differential.py qualifies names a driver that passed."""
    root = Path(args.candidate)
    differential = check_driver(root, 'differential', checks)
    result = json.loads((root / 'differential/results.json').read_text()) if differential else {}
    drivers = {}
    for row in result.get('qualification', []):
        if not row.get('suite'):
            continue
        stem = row['suite'].removesuffix('.py')
        matched = sorted(p.name for p in root.iterdir() if p.is_dir() and (p.name == stem or p.name.startswith(stem + '_')))
        checks.append({'id': 'line:' + row['line'], 'pass': bool(matched),
                       'reason': 'qualification line ' + row['line'] + ' needs a run of ' + row['suite'], 'failureCode': 2})
        for name in matched:
            drivers.setdefault(name, []).append(row['line'])
    checks.append({'id': 'qualification:nonempty', 'pass': bool(drivers),
                   'reason': 'an empty qualification list cannot pass', 'failureCode': 2})
    counts = {name: check_driver(root, name, checks) for name in sorted(drivers)}
    return {'suite': args.suite, 'drivers': counts, 'lines': len({line for v in drivers.values() for line in v}),
            'behaviorQualified': all(c['pass'] for c in checks)}


def compare(args, checks):
    if args.suite == 'n5-cli':
        return compare_cli(args, checks)
    root = Path(args.candidate)
    counts = {name: check_driver(root, name, checks) for name in SUITES[args.suite]}
    return {'suite': args.suite, 'drivers': counts, 'behaviorQualified': all(c['pass'] for c in checks)}
