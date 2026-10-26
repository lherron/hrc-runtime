"""Comparison of the finite N1 session/metadata workflow's HTTP observations.

The workflow drives both owners from a Bun-created scratch snapshot. Shared
rows retain exact identities and times. Only newly written metadata timestamps
vary: validate their request bounds and preserve their equality across reads.
"""
import datetime
import json
from pathlib import Path
from owner_relative import bounded_ready, READY_RULE, READY_FIELDS

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
    control = json.loads((Path(args.candidate) / 'env-inert.json').read_text())
    checks.append({'id':'proxy:legacy-env-inert','pass':control.get('explicitArgument') is False and str(control.get('legacyEnvironment','')).startswith('/') and all(control.get('withoutEnvironment',{}).get(k)==control.get('withEnvironment',{}).get(k) for k in ('method','path','status','body')) and control.get('withEnvironment',{}).get('status')==404 and control.get('withEnvironment',{}).get('body')=='Not Found',
                   'reason':'a live backend in the retired environment variable must be inert without --bun-socket','failureCode':1})
    baseline = json.loads((Path(args.baseline) / 'observations.json').read_text())
    candidate = json.loads((Path(args.candidate) / 'observations.json').read_text())
    checks.append({'id': 'proxy:nonempty-identical-cases', 'pass': len(baseline) >= 11 and len(baseline) == len(candidate),
                   'reason': 'every forwarding request must have both observations', 'failureCode': 1})
    required = {('POST', '/v1/surfaces/unbind'), ('POST', '/v1/capture/recover'),
                ('POST', '/v1/in-flight-input'), ('POST', '/v1/runtimes/ensure'),
                ('POST', '/v1/transcript-search'), ('GET', '/v1/targets'),
                ('GET', '/v1/surfaces'), ('GET', '/v1/transcript-index/status'),
                ('GET', '/v1/events/bounded-stream')}
    for kind, rows in [('bun', baseline), ('native', candidate)]:
        observed = {(r['method'], r['path'].split('?')[0]) for r in rows}
        positive = any(r['method'] == 'GET' and r['path'].startswith('/v1/targets?') and r['status'] == 200 and bool(json.loads(r['body'])) for r in rows)
        live = any(r['path'].startswith('/v1/events/bounded-stream?') and r['status'] == 200 and json.loads(r['body']).get('type') == 'ready' for r in rows)
        checks.append({'id': 'proxy:' + kind + ':routes-and-positive-controls',
                       'pass': required <= observed and positive and live,
                       'reason': 'every postponed N1 route, nonempty target read and live stream must be observed', 'failureCode': 1})
    cases = []
    relative = dict(id=READY_RULE, fields=READY_FIELDS, owners={})
    for index, (direct, forwarded) in enumerate(zip(baseline, candidate, strict=True)):
        if direct['path'].startswith('/v1/events/bounded-stream?'):
            direct, bun_rule = bounded_ready(direct)
            forwarded, native_rule = bounded_ready(forwarded)
            relative['owners'] = dict(bun=bun_rule, native=native_rule)
            for owner, rule in relative['owners'].items():
                checks.append(dict(id=READY_RULE + ':' + owner, **{'pass': rule['pass']},
                                   reason='ready must exactly report its own sampled page head/incarnation', failureCode=1))
        passed = all(direct[key] == forwarded[key] for key in ('method', 'path', 'status', 'body'))
        for key, value in direct['headers'].items():
            if key not in ('date', 'connection', 'keep-alive', 'transfer-encoding', 'content-length'):
                passed = passed and forwarded['headers'].get(key) == value
        name = str(index) + ':' + direct['method'] + ':' + direct['path']
        checks.append({'id': 'proxy:' + name, 'pass': passed,
                       'reason': 'forwarded status, body and end-to-end headers must match Bun', 'failureCode': 1})
        cases.append({'id': name, 'pass': passed})
    checks.append(dict(id=READY_RULE + ':nonempty', **{'pass': set(relative['owners']) == {'bun', 'native'}},
                       reason='both owner-relative ready observations are required', failureCode=1))
    return {'suite': 'n1-passthrough', 'cases': cases, 'ownerRelative': [relative],
            'behaviorQualified': bool(checks) and all(c['pass'] for c in checks)}


def compare_accounting(args, checks):
    expected = {'GET /v1/health n1-accounting/health': 50,
                'GET /v1/targets n1-accounting/targets': 50,
                'GET /v1/sessions n1-accounting/sessions': 50,
                'GET /v1/health n1-accounting/request-id': 7,
                'GET /v1/sessions/by-host/:hostSessionId n1-accounting/error': 13,
                'GET /v1/events/bounded-stream n1-accounting/stream': 1}
    cases = []
    populations = {}
    relative = dict(id=READY_RULE, fields=READY_FIELDS, owners={}, metricBytes='actual HTTP bytes')
    for kind, directory in [('bun', args.baseline), ('native', args.candidate)]:
        report = json.loads((Path(directory) / 'accounting.json').read_text())
        records, logs, observations = report['metrics'], report['logs'], report['observations']
        probes = [o for o in observations if o.get('streamProbe')]
        valid = len(probes) == 1
        if valid:
            probe = probes[0]
            _, rule = bounded_ready(probe['streamProbe'])
            relative['owners'][kind] = rule
            valid = rule['pass'] and probe['bytes'] == len(probe['streamProbe']['wireBody'].encode())
        checks.append(dict(id=READY_RULE + ':' + kind, **{'pass': valid},
                           reason='ready reports own page; metric bytes remain actual wire bytes', failureCode=1))
        counts = {}
        shape = bool(records)
        for r in records:
            shape = shape and r.get('v') == 1 and r.get('kind') == 'server' and 'listener' not in r and 'peer' not in r
            shape = shape and isinstance(r.get('ts'), str) and isinstance(r.get('ms'), (float, int)) and r['ms'] >= 0
            shape = shape and isinstance(r.get('status'), int) and (('bytes' in r) != ('stream' in r))
            key = r['method'] + ' ' + r['route'] + ' ' + r['client'].replace('/' + kind + '/', '/')
            counts[key] = counts.get(key, 0) + r.get('sampleWeight', 1)
            if kind == 'native':
                expected_owner='bun' if r['route'] == '/v1/targets' else 'native'
                shape = shape and r.get('servedBy') == expected_owner
            if 'sampleWeight' in r:
                shape = shape and r['sampleWeight'] == 20 and r['status'] < 400 and r['ms'] < 25 and 'reqId' not in r
            if 'bytes' in r:
                # Every tested finite route has a stable representation within
                # one owner's mix; compare metric bytes to actual HTTP bytes.
                matching = [o for o in observations if o['client'] == r['client'] and o['status'] == r['status']]
                shape = shape and bool(matching) and all(o['bytes'] == r['bytes'] for o in matching)
        ids = sorted(r['reqId'] for r in records if 'reqId' in r)
        shape = shape and ids == ['id-' + str(i) for i in range(7)]
        polls = [r for r in logs if r['event'] == 'http.request' and r['data']['route'] == '/v1/sessions' and r['data']['status'] < 400]
        errors = [r for r in logs if r['event'] == 'http.request' and r['data']['client'].endswith('/error')]
        log_ok = not polls and len(errors) == 13 and all(r['level'] == 'warn' and r['component'] == 'http' and r['data'].get('code') == 'unknown_host_session' and r['data'].get('message') for r in errors)
        log_ok = log_ok and all('?' not in r['data']['path'] for r in logs)
        if kind == 'native':
            log_ok = log_ok and all(r.get('server') == 'rusthrc' and r['data'].get('servedBy') == ('bun' if r['data']['route'] == '/v1/targets' else 'native') for r in logs)
        log_ok = log_ok and any(r['event'] == 'http.stream.open' for r in logs) and any(r['event'] == 'http.stream.close' for r in logs)
        for name, passed in [('weighted-counts', counts == expected), ('schema-bytes-and-sampling', shape), ('L3', log_ok)]:
            case = {'id': kind + ':' + name, 'pass': bool(passed)}
            cases.append(case)
            checks.append({**case, 'reason': 'the real request mix must retain Bun accounting semantics', 'failureCode': 1})
        populations[kind] = counts
    checks.append({'id': 'accounting:weighted-count-parity', 'pass': populations['bun'] == populations['native'] == expected,
                   'reason': 'native and forwarded routes must have the same per-route weighted population as Bun', 'failureCode': 1})
    return {'suite': 'n1-accounting', 'cases': cases, 'ownerRelative': [relative],
            'behaviorQualified': bool(checks) and all(c['pass'] for c in checks)}
