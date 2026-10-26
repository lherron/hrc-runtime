"""N2 human /quit: a real TUI seat quit by its operator.

Per facet the identity-normalized result must equal Bun's: the runtime's end
state (status, termination and user-exit reasons, invocation state), the
lifecycle rows written after the quit, the lease tmux server reaped, and the
summary-aware reap scheduled.
"""
import json
from pathlib import Path

from n2_turns import Norm, TIMED

FACETS = ('runtime', 'events', 'leaseAlive', 'reapLogs')


def compare(args, checks):
    def check(name, passed, reason, code=1):
        checks.append({'id': name, 'pass': bool(passed), 'reason': reason, 'failureCode': code})

    sides = {}
    for owner, directory in (('bun', args.baseline), ('native', args.candidate)):
        d = json.loads((Path(directory) / f'{owner}.json').read_text())
        rows = json.loads((Path(directory) / f'{owner}-rows.json').read_text())
        d['events'] = [e for e in d['events'] if e['kind'] not in TIMED]
        sides[owner] = Norm(rows['scratchRoot'])(json.loads(json.dumps(d).replace('quit-' + owner, 'quit-<owner>')))
        check(f'{owner}:lease-reaped', not d['leaseAlive'], 'the lease tmux server must not outlive the quit')
    for facet in FACETS:
        b, n = sides['bun'].get(facet), sides['native'].get(facet)
        check('compare:' + facet, b == n, json.dumps({'bun': b, 'native': n}, default=str)[:4000])
    return {'suite': 'n2-quit', 'cases': [{'id': c['id'], 'pass': c['pass']} for c in checks],
            'behaviorQualified': all(c['pass'] for c in checks)}
