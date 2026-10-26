"""N2 non-main lane: a `~side` seat, a warm turn and a selector read on each owner.

The warm turn must succeed, the selector must echo `<scope>/lane:side`, and
every stored lane_ref must equal Bun's (the raw lane, never the API's
canonical `lane:side`).
"""
import json
from pathlib import Path


def compare(args, checks):
    def check(name, passed, reason):
        checks.append({'id': name, 'pass': bool(passed), 'reason': reason, 'failureCode': 1})

    sides = {o: json.loads((Path(d) / f'{o}.json').read_text()) for o, d in (('bun', args.baseline), ('native', args.candidate))}
    for owner, d in sides.items():
        check(f'{owner}:warm-turn', d['warm']['status'] == 200 and d['warm']['outcome'] == 'completed', json.dumps(d['warm']))
        check(f'{owner}:selector-echo', d['capture']['status'] == 200 and str(d['capture']['sessionRef']).endswith('/lane:side'), json.dumps(d['capture']))
    b, n = sides['bun'], sides['native']
    for key in ('stored', 'sessionView'):
        check('compare:' + key, b[key] == n[key], json.dumps({'bun': b[key], 'native': n[key]}))
    return {'suite': 'n2-lanes', 'cases': [{'id': c['id'], 'pass': c['pass']} for c in checks],
            'behaviorQualified': all(c['pass'] for c in checks)}
