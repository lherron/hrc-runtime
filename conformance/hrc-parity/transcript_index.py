"""Transcript index parity: identical wire values/key order and index effects.

Positive controls run on both owners so a Bun baseline that skipped the
follower, the repairs or the rebuild cannot qualify a matching native run.
"""
import json
from pathlib import Path

CASES = ('status', 'discovery', 'discovery-limit', 'discovery-candidates', 'within-runtime',
         'within-invocation', 'phrase', 'filters', 'blank-filters', 'resume-sentinel', 'late-prose',
         'inversion', 'truncated', 'no-match', 'missing-query', 'query-not-string', 'blank-query',
         'unmatched-quote', 'empty-phrase', 'adjacent-phrase', 'inner-quote', 'limit-zero',
         'limit-fraction', 'limit-string', 'candidates-zero', 'filter-not-string', 'body-array',
         'body-absent', 'status-post', 'rebuild', 'status-after-rebuild', 'sentinel-after-rebuild',
         'discovery-after-rebuild')
ERRORS = ('missing-query', 'query-not-string', 'blank-query', 'unmatched-quote', 'empty-phrase',
          'adjacent-phrase', 'inner-quote', 'limit-zero', 'limit-fraction', 'limit-string',
          'candidates-zero', 'filter-not-string', 'body-array', 'body-absent')


def key_order(value):
    if isinstance(value, dict):
        return [(k, key_order(v)) for k, v in value.items()]
    if isinstance(value, list):
        return [key_order(v) for v in value]
    return None


def controls(rows):
    """Each claim the fixture exists to exercise, observed on one owner."""
    by = {r['case']: r for r in rows}
    body = lambda name: by[name]['response']['body'] if isinstance(by[name]['response']['body'], dict) else {}
    hits = lambda name: body(name).get('hits', [])
    status = body('status')
    first = by['status']
    discovery = hits('discovery')
    per_runtime = {}
    for hit in discovery:
        per_runtime[hit['runtimeId']] = per_runtime.get(hit['runtimeId'], 0) + 1
    truncated = hits('truncated')
    return {
        'caught-up': first['cursor'] == first['ceiling'] and status.get('lastEventId') == first['ceiling'],
        'stats-shape': list(status) == ['turnsIndexed', 'lastEventId', 'ledgerMaxEventId', 'lagEvents', 'invocationsReindexed'],
        'repairs-counted': status.get('invocationsReindexed') == 2 and status.get('lagEvents') == 0,
        'resumed-not-reindexed': len(hits('resume-sentinel')) == 1,
        'late-prose': any(h['invocationId'] == 'inv-a1' for h in hits('late-prose')),
        'inversion-split': [(h['seqFrom'], h['seqTo']) for h in hits('inversion')] == [(10, 25), (30, 40)],
        'per-runtime-cap': body('discovery').get('mode') == 'discovery' and per_runtime.get('rt-b') == 5,
        'within-runtime': body('within-runtime').get('mode') == 'within_runtime' and len(hits('within-runtime')) == 7,
        'truncated': len(truncated) == 1 and truncated[0]['truncated'] is True,
        'filters': len(hits('filters')) > 0 and all(h.get('agent') == 'tabularasa' for h in hits('filters')),
        'errors': all(by[name]['response']['status'] == 400 for name in ERRORS),
        'rebuild-accepted': body('rebuild').get('accepted') is True,
        'rebuild-regenerated': len(hits('sentinel-after-rebuild')) == 0 and by['status-after-rebuild']['cursor'] == first['ceiling']
                               and body('status-after-rebuild').get('turnsIndexed') == status.get('turnsIndexed'),
    }


def compare(args, checks):
    subjects = {}
    for kind, directory in (('bun', args.baseline), ('native', args.candidate)):
        rows = json.loads((Path(directory) / 'observations.json').read_text())
        present = [r['case'] for r in rows] == list(CASES)
        checks.append({'id': kind+':cases', 'pass': present, 'reason': 'every transcript case exactly once, in order', 'failureCode': 1})
        if present:
            for name, passed in controls(rows).items():
                checks.append({'id': kind+':'+name, 'pass': bool(passed), 'reason': 'fixture claim must be exercised', 'failureCode': 1})
        subjects[kind] = {r['case']: {k: v for k, v in r.items() if k not in ('before', 'after')} for r in rows}
    cases = []
    for name in CASES:
        a, b = subjects['bun'].get(name), subjects['native'].get(name)
        passed = a is not None and a == b and key_order(a['response']['body']) == key_order(b['response']['body'])
        cases.append({'id': name, 'pass': passed})
        checks.append({'id': name, 'pass': passed, 'reason': 'wire values/key order and index rows, marks and cursor must agree', 'failureCode': 1})
    return {'suite': 'transcript-index', 'cases': cases, 'behaviorQualified': all(c['pass'] for c in checks)}
