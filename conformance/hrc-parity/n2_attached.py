"""N2 attached-run door: the unchanged Bun `hrc run` on a real pty against each owner.

Per HTTP case the status and identity-normalized body must equal Bun's. Per
run, the CLI exit, the lifecycle kinds the run caused (probe-timed kinds
aside), the runtime and run rows, and the prepare/resume statuses must equal
Bun's, and the prompted second run must land on the first run's seat.
"""
import json
from pathlib import Path

from n2_turns import Norm, TIMED, born_after_fix, fallback_duplicates


def compare(args, checks):
    def check(name, passed, reason, code=1):
        checks.append({'id': name, 'pass': bool(passed), 'reason': reason, 'failureCode': code})

    sides = {}
    for owner, directory in (('bun', args.baseline), ('native', args.candidate)):
        d = json.loads((Path(directory) / f'{owner}.json').read_text())
        norm, scope = Norm(d['scratchRoot']), d['scope']
        sides[owner] = ({o['case']: o for o in d['observations']},
                        lambda v, n=norm, sc=scope: n(json.loads(json.dumps(v, default=str).replace(sc, '<scope>'))))
        rows = json.loads((Path(directory) / f'{owner}-rows.json').read_text())
        if born_after_fix(rows):
            dups = fallback_duplicates(rows)
            check(f'{owner}:no-fallback-duplicates', not dups, f'T-11837 fallback finals on a post-fix seat: {dups}')
    cases = []
    (bun, nb), (native, nn) = sides['bun'], sides['native']
    for name, a in bun.items():
        b = native.get(name)
        if b is None:
            check('compare:' + name, False, 'case missing on native')
            cases.append({'id': name, 'pass': False})
            continue
        if name.startswith('run:'):
            def view(o, norm):
                runtime = dict(o['runtime'])
                runtime['presentation_json'] = json.loads(runtime['presentation_json'] or 'null')
                return {'exit': o['exit'], 'events': [k for k in o['eventKinds'] if k not in TIMED],
                        'runtime': norm(runtime), 'runs': o['runs']}
            left, right = view(a, nb), view(b, nn)
        elif 'value' in a:
            left, right = a['value'], b['value']
        else:
            left = {'status': a['status'], 'body': nb(a['body'])}
            right = {'status': b['status'], 'body': nn(b['body'])}
        passed = left == right
        check('compare:' + name, passed, json.dumps({'bun': left, 'native': right}, default=str)[:4000])
        cases.append({'id': name, 'pass': passed})
    check('native:same-runtime', native.get('same-runtime', {}).get('value') is True,
          'the prompted run must land on the promptless run\'s seat')
    check('native:gate-order', native.get('gate-order', {}).get('value') is True,
          'the parked birth must start its invocation only after resume-attached began')
    return {'suite': 'n2-attached', 'cases': cases, 'behaviorQualified': all(c['pass'] for c in checks)}
