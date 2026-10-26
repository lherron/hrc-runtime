"""N2 broker death mid-turn, then broker inspect with recoverFinalSummary.

Each owner must settle the crashed runtime (terminal status, no active run, the
in-flight run failed), and both owners must answer inspect with the same
status, recovery state and retained-evidence view, leave the same runtime and
run state, and record the same retained outcomes and runtime events.
"""
import json
from pathlib import Path

TERMINAL = ('terminated', 'failed', 'crashed', 'dead', 'stale')


def compare(args, checks):
    def check(name, passed, reason, code=1):
        checks.append({'id': name, 'pass': bool(passed), 'reason': reason, 'failureCode': code})

    sides = {o: json.loads((Path(d) / f'{o}.json').read_text()) for o, d in (('bun', args.baseline), ('native', args.candidate))}
    for owner, d in sides.items():
        rt = d['runtime']
        check(f'{owner}:runtime-settled', rt['status'] in TERMINAL and not rt['activeRun'], json.dumps(rt))
        check(f'{owner}:run-failed', (d['run'] or {}).get('status') == 'failed', json.dumps(d['run']))
        check(f'{owner}:inspect-answers', d['inspect']['status'] == 200 and d['inspect']['finalSummaryRecovery'] is not None,
              json.dumps(d['inspect']))
    b, n = sides['bun'], sides['native']
    for key in ('inspect', 'runtime', 'run', 'outcomes', 'events'):
        check(f'compare:{key}', b[key] == n[key], json.dumps({'bun': b[key], 'native': n[key]})[:3000])
    return {'suite': 'n2-inspect-crash', 'cases': [{'id': c['id'], 'pass': c['pass']} for c in checks],
            'behaviorQualified': all(c['pass'] for c in checks)}
