"""Comparison of the finite N1 session/metadata workflow's HTTP observations.

The workflow drives both owners from a Bun-created scratch snapshot. Shared
rows retain exact identities and times. Only newly written metadata timestamps
vary: validate their request bounds and preserve their equality across reads.
"""
import datetime
import json
from pathlib import Path

SESSION_CASES = (
    'sessions-list', 'sessions-scope', 'sessions-invalid-status',
    'sessions-invalid-limit', 'sessions-invalid-latest', 'session-by-host',
    'session-missing-host', 'session-continuity', 'session-continuity-missing',
    'metadata-empty', 'metadata-write', 'session-after-metadata-write', 'sessions-title', 'metadata-read', 'metadata-repeat',
    'metadata-clear', 'metadata-invalid', 'runtimes-empty',
    'runtimes-live-refs-empty', 'wrong-method',
)


def compare(args, checks):
    def check(name, passed, reason):
        checks.append({'id': name, 'pass': bool(passed), 'reason': reason, 'failureCode': 1})
    subjects = {}
    for kind, path in [('bun', args.baseline), ('native', args.candidate)]:
        rows = json.loads((Path(path) / 'observations.json').read_text())
        check(kind + ':case-names', len({r['case'] for r in rows}) == len(rows), 'duplicate case names')
        by_name = {r['case']: r for r in rows}
        check(kind + ':required', all(name in by_name for name in SESSION_CASES), 'every required N1 observation must exist')
        timestamp_map = {}
        for name in SESSION_CASES:
            if name not in by_name:
                continue
            observed = by_name[name]
            response = observed['response']
            body = response['body']
            if isinstance(body, dict) and isinstance(body.get('metadataSources'), dict):
                for key, source in body['metadataSources'].items():
                    stamp = source['updatedAt']
                    if stamp not in timestamp_map:
                        parsed = datetime.datetime.fromisoformat(stamp.replace('Z', '+00:00')).timestamp()
                        check(kind + ':' + name + ':timestamp:' + key,
                              observed['before'] - .01 <= parsed <= observed['after'] + .01,
                              'a new metadata timestamp must lie in the request interval')
                        timestamp_map[stamp] = 'write:' + name
                    source['updatedAt'] = timestamp_map[stamp]
        subjects[kind] = by_name
    results = []
    for name in SESSION_CASES:
        baseline, candidate = subjects['bun'].get(name), subjects['native'].get(name)
        if baseline is None or candidate is None:
            continue
        passed = (baseline['method'] == candidate['method'] and baseline['path'] == candidate['path']
                  and baseline['request'] == candidate['request']
                  and baseline['response'] == candidate['response']
                  and baseline['metadataEvents'] == candidate['metadataEvents'])
        check('compare:' + name, passed, 'HTTP status, full body, session headers and metadata event effects must agree')
        results.append({'id': name, 'pass': passed})
    for kind in ('bun', 'native'):
        rows = subjects[kind]
        check(kind + ':metadata-effects',
              all(rows.get(k, {}).get('metadataEvents') == n for k, n in
                  [('metadata-write', 2), ('metadata-repeat', 0), ('metadata-clear', 1), ('metadata-invalid', 0)]),
              'set changes two keys, repeat changes none, clear one, invalid write none')
    return {'suite': 'n1-routes', 'cases': results,
            'behaviorQualified': len(results) == len(SESSION_CASES) and all(c['pass'] for c in checks)}


def compare_passthrough(args, checks):
    baseline = json.loads((Path(args.baseline) / 'observations.json').read_text())
    candidate = json.loads((Path(args.candidate) / 'observations.json').read_text())
    checks.append({'id': 'proxy:nonempty-identical-cases', 'pass': len(baseline) >= 11 and len(baseline) == len(candidate),
                   'reason': 'every forwarding request must have both observations', 'failureCode': 1})
    required = {('POST', '/v1/surfaces/unbind'), ('POST', '/v1/runtimes/sweep'),
                ('POST', '/v1/runtimes/prune'), ('POST', '/v1/runtimes/ensure'),
                ('POST', '/v1/runtimes/attach'), ('GET', '/v1/targets'),
                ('GET', '/v1/surfaces'), ('GET', '/v1/placement/bindings'),
                ('GET', '/v1/events/bounded-stream')}
    for kind, rows in [('bun', baseline), ('native', candidate)]:
        observed = {(r['method'], r['path'].split('?')[0]) for r in rows}
        positive = any(r['method'] == 'GET' and r['path'].startswith('/v1/targets?') and r['status'] == 200 and bool(json.loads(r['body'])) for r in rows)
        live = any(r['path'].startswith('/v1/events/bounded-stream?') and r['status'] == 200 and json.loads(r['body']).get('type') == 'ready' for r in rows)
        checks.append({'id': 'proxy:' + kind + ':routes-and-positive-controls',
                       'pass': required <= observed and positive and live,
                       'reason': 'every postponed N1 route, nonempty target read and live stream must be observed', 'failureCode': 1})
    cases = []
    for index, (direct, forwarded) in enumerate(zip(baseline, candidate, strict=True)):
        passed = all(direct[key] == forwarded[key] for key in ('method', 'path', 'status', 'body'))
        for key, value in direct['headers'].items():
            if key not in ('date', 'connection', 'keep-alive', 'transfer-encoding', 'content-length'):
                passed = passed and forwarded['headers'].get(key) == value
        name = str(index) + ':' + direct['method'] + ':' + direct['path']
        checks.append({'id': 'proxy:' + name, 'pass': passed,
                       'reason': 'forwarded status, body and end-to-end headers must match Bun', 'failureCode': 1})
        cases.append({'id': name, 'pass': passed})
    return {'suite': 'n1-passthrough', 'cases': cases,
            'behaviorQualified': bool(checks) and all(c['pass'] for c in checks)}
