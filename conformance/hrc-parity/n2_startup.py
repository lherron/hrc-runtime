"""N2 startup reconciliation and broker lease GC: two real seats, one killed
while the owner was down, planted orphans and legacy rows, owner restarted.

Per facet the identity-normalized result must equal Bun's: each runtime's
status, stale reason, control state and the lifecycle rows the boot wrote; the
terminal run's settlement; which planted files survive; the warmup summary and
its per-runtime categories; the renderer sweep summary; the orphan servers
killed; the warm turn on the surviving seat; and the first recurring GC tick.
"""
import json
from pathlib import Path

from n2_turns import Norm

FACETS = ('runtimes', 'terminalRun', 'files', 'warmup', 'warmupRuntimes', 'renderer', 'orphanSwept',
          'deadRemoved', 'terminalReconciled', 'warmTurn', 'gcTick')


def compare(args, checks):
    def check(name, passed, reason, code=1):
        checks.append({'id': name, 'pass': bool(passed), 'reason': reason, 'failureCode': code})

    sides = {}
    for owner, directory in (('bun', args.baseline), ('native', args.candidate)):
        d = json.loads((Path(directory) / f'{owner}.json').read_text())
        rows = json.loads((Path(directory) / f'{owner}-rows.json').read_text())
        norm = Norm(rows['scratchRoot'])
        # Each owner's seats carry its own name in the scope.
        sides[owner] = norm(json.loads(json.dumps(d).replace('-' + owner, '-<owner>')))
        check(f'{owner}:seat-attached', d['warmup'] and d['warmup'][-1]['attached'] >= 1, json.dumps(d['warmup']))
        check(f'{owner}:warm-turn', d['warmTurn']['status'] == 200, json.dumps(d['warmTurn']))
    for facet in FACETS:
        b, n = sides['bun'].get(facet), sides['native'].get(facet)
        check('compare:' + facet, b == n, json.dumps({'bun': b, 'native': n}, default=str)[:4000])
    return {'suite': 'n2-startup', 'cases': [{'id': c['id'], 'pass': c['pass']} for c in checks],
            'behaviorQualified': all(c['pass'] for c in checks)}
