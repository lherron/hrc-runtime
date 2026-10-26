"""Additional wire-order gate; never replaces or normalizes value checks.

Sources are raw HTTP strings or named unsorted driver artifacts, never sorted
summaries. Arrays stay positional, and missing keys/shapes are failures.
"""
import json
from pathlib import Path


def differences(bun, native, path='$'):
    out = []
    if isinstance(bun, dict) or isinstance(native, dict):
        left = list(bun) if isinstance(bun, dict) else None
        right = list(native) if isinstance(native, dict) else None
        if left != right:
            out.append({'path': path, 'bun': left, 'native': right})
        if isinstance(bun, dict) and isinstance(native, dict):
            for key in bun:
                if key in native:
                    out.extend(differences(bun[key], native[key], path + '.' + key))
    elif isinstance(bun, list) or isinstance(native, list):
        if not isinstance(bun, list) or not isinstance(native, list) or len(bun) != len(native):
            out.append({'path': path, 'bun': f'array[{len(bun)}]' if isinstance(bun, list) else None,
                        'native': f'array[{len(native)}]' if isinstance(native, list) else None})
        if isinstance(bun, list) and isinstance(native, list):
            for i, (a, b) in enumerate(zip(bun, native)):
                out.extend(differences(a, b, f'{path}[{i}]'))
    return out


def response_body(response):
    # run.py historically sorted parsed bodies on disk, but raw survives.
    value = response['raw'] if 'raw' in response else response['body']
    if isinstance(value, str):
        try:
            return json.loads(value)
        except ValueError:
            return value
    return value


def load_source(path):
    path = Path(path)
    if path.name == 'summary.json':
        raise ValueError('sorted summaries cannot supply wire order')
    value = json.loads(path.read_text())
    def dicts(v):
        if isinstance(v, dict):
            yield v
            for child in v.values():
                yield from dicts(child)
        elif isinstance(v, list):
            for child in v:
                yield from dicts(child)
    objects = list(dicts(value))
    # Fail closed when an all-sorted artifact lacks raw authority. We cannot
    # recover the original order from values; require fresh wire evidence.
    if objects and not any('raw' in v for v in objects):
        keyed = [list(v) for v in objects if len(v) > 1]
        if keyed and all(keys == sorted(keys) for keys in keyed):
            raise ValueError(f'{path}: all-sorted observation has no raw order authority')
    return value


def owner_package(suite, route):
    if suite.startswith('n5'):
        return 'hrc-cli'
    if any(token in route for token in ('/sessions', '/runtimes', '/runs', '/events')) and suite.startswith('n1'):
        return 'hrc-store / hrc-native'
    return 'hrc-native'


def compare_records(suite, bun, native):
    def index(rows):
        result = {name: (route, value) for name, route, value in rows}
        if not result or len(result) != len(rows):
            raise ValueError(f'{suite}: missing/empty or duplicate ordered observations')
        return result
    a, b = index(bun), index(native)
    if set(a) != set(b):
        raise ValueError(f'{suite}: missing ordered cases; bun-only={set(a)-set(b)}, native-only={set(b)-set(a)}')
    mismatches, failed = [], 0
    for name, (route, value) in a.items():
        delta = differences(value, b[name][1])
        failed += bool(delta)
        for d in delta:
            mismatches.append({'suite': suite, 'case': name, 'route': route,
                'owner package': owner_package(suite, route), 'object path': d['path'],
                'Bun key order': d['bun'], 'native key order': d['native']})
    return {'comparedCases': len(a), 'failedCases': failed, 'mismatches': mismatches}


def records(suite, directory, owner):
    root = Path(directory)
    wire = root / 'wire-observations.json'
    if wire.exists() and suite in ('n1-accounting', 'n1-front-accounting', 'n2-lanes'):
        return [(r['case'], r['route'], response_body(r)) for r in load_source(wire)]
    if suite == 'n1-session-projection':
        data = load_source(root / 'projection.json')['observations']
    elif suite == 'n1-front-accounting':
        data = load_source(root / 'front-accounting.json')['requests']
    elif suite == 'n1-accounting':
        raise ValueError('n1-accounting requires wire-observations.json (driver retains only byte counts)')
    elif suite == 'n1-participant-live':
        d = load_source(root / f'{owner}.json')
        return [('joined', '/v1/participants/register', d['joined'])] + [
            (key, '/v1/participants/attach', d[key][1]) for key in ('attach', 'retry')]
    elif suite.startswith('n1-'):
        data = load_source(root / 'observations.json')
    else:
        d = load_source(root / f'{owner}.json')
        if suite == 'n2-turns':
            result = [(k, 'CLI start', v) for k, v in d['cases'].items() if k != 'reads']
            result += [(k, k, v[1]) for k, v in d['cases']['reads'].items()]
            return result
        if suite == 'n2-continuation':
            out = [(f'compile-{i}', 'aspc.compileHarnessInvocation', v) for i, v in enumerate(d['compiles'])]
            # Birth CLI stdout is raw in the driver's step ledger; compile
            # request ordering alone does not qualify these response paths.
            steps = load_source(root / f'{owner}-steps.json')
            for step in steps:
                if step['name'].startswith('birth-'):
                    out.append((step['name'], 'CLI start', json.loads(step['stdout'])))
            return out
        if suite == 'n2-recovery':
            return [(k, 'ledger/' + k, d[k]) for k in ('runs', 'failedPayloads')]
        if suite == 'n2-lanes':
            raise ValueError('n2-lanes requires wire-observations.json (driver projects away response fields)')
        data = d['observations']
    out = []
    for i, row in enumerate(data):
        response = row.get('response', row)
        if 'body' not in response and 'raw' not in response:
            continue
        name = row.get('case', f'{i}:{row.get("pair", "")}:{row.get("role", "")}')
        out.append((name, row.get('path', name), response_body(response)))
    return out


def compare_suite(args, checks):
    try:
        report = compare_records(args.suite, records(args.suite, args.baseline, 'bun'),
                                 records(args.suite, args.candidate, 'native'))
        checks.append({'id': 'wire-key-order', 'pass': not report['failedCases'],
            'reason': f'{report["comparedCases"]} cases; {report["failedCases"]} key-order failures', 'failureCode': 1})
    except (ValueError, KeyError, OSError, TypeError) as error:
        report = {'comparedCases': 0, 'failedCases': 0, 'mismatches': [], 'error': str(error)}
        checks.append({'id': 'wire-key-order:source', 'pass': False, 'reason': str(error), 'failureCode': 2})
    return report


def cli_orders(bun, native):
    """Original CLI JSON streams, independent of normalized value equality."""
    compared, delta = 0, []
    for stream in ('stdout', 'stderr'):
        values = []
        for record in (bun, native):
            try:
                values.append(json.loads(record[stream]))
            except (ValueError, KeyError):
                values.append(None)
        if values == [None, None]:
            continue  # raw text equality already gates non-JSON streams
        compared += 1
        delta.extend(differences(*values, path=stream))
    return {'pass': not delta, 'comparedStreams': compared, 'mismatches': delta}
