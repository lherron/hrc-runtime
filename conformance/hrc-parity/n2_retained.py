"""N2 retained-evidence recovery: a worker whose tail was never projected
(owner killed, human turn and /quit while down, lease gone), recovered at the
next boot under a zero revivable hold.

Per owner the retained mirror must equal that run's ledger tail, envelope for
envelope. Across owners the result must equal Bun's: the outcomes recorded, the
invocation's terminal state and cursors, the lifecycle rows written under
evidence_origin = 'retained' (and no live rows), the runtime's current state
left as the classifier set it, and the inspect view of retained evidence.
"""
import json
from pathlib import Path

from n2_turns import TIMED

# The ledger tail is written by the broker with no owner up, so it is each
# run's input (a driver.notice may or may not occur); fidelity to it is
# checked per owner, and only owner behavior is compared across owners.
FACETS = ('outcomes', 'outcomeDetailKeys', 'invocation', 'liveMirrorAfter', 'retainedLifecycle', 'runtime', 'inspectRetained')


def compare(args, checks):
    def check(name, passed, reason, code=1):
        checks.append({'id': name, 'pass': bool(passed), 'reason': reason, 'failureCode': code})

    sides = {}
    for owner, directory in (('bun', args.baseline), ('native', args.candidate)):
        d = json.loads((Path(directory) / f'{owner}.json').read_text())
        d['retainedLifecycle'] = [k for k in d['retainedLifecycle'] if k not in TIMED]
        sides[owner] = d
        check(f'{owner}:recovered', d['outcomes'] and d['outcomes'][-1]['outcome'] in ('recovered', 'recovered_torn_tail'), json.dumps(d['outcomes']))
        check(f'{owner}:retained-rows', len(d['retainedMirror']) > 0 and d['liveMirrorAfter'] == 0, json.dumps({'retained': len(d['retainedMirror']), 'live': d['liveMirrorAfter']}))
        check(f'{owner}:mirror-equals-ledger-tail', d.get('ledgerTail') == d['retainedMirror'], json.dumps({'ledger': d.get('ledgerTail'), 'mirror': d['retainedMirror']}))
    for facet in FACETS:
        b, n = sides['bun'].get(facet), sides['native'].get(facet)
        check('compare:' + facet, b == n, json.dumps({'bun': b, 'native': n}, default=str)[:4000])
    return {'suite': 'n2-retained', 'cases': [{'id': c['id'], 'pass': c['pass']} for c in checks],
            'behaviorQualified': all(c['pass'] for c in checks)}
