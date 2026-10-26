"""N2 cold-boot input recovery: planted Bun-shaped accepted runs, owner restarted.

Both owners must settle the same three runs the same way: the owed prompt
delivered once into the live seat, the runs with no runtime or no durable
prompt failed with cold_input_continuation_lost and the same failure payload,
and no other run touched.
"""
import json
from pathlib import Path

from n2_turns import TIMED

OWED = 'Reply with exactly the word RECOVERED and nothing else. No tools.'


def compare(args, checks):
    def check(name, passed, reason, code=1):
        checks.append({'id': name, 'pass': bool(passed), 'reason': reason, 'failureCode': code})

    sides = {o: json.loads((Path(d) / f'{o}.json').read_text()) for o, d in (('bun', args.baseline), ('native', args.candidate))}
    for owner, d in sides.items():
        delivered = [p for p in d['userPrompts'] if OWED in json.dumps(p)]
        check(f'{owner}:owed-prompt-once', len(delivered) == 1, f'{len(delivered)} deliveries of the owed prompt')
        check(f'{owner}:others-untouched', d['otherRunsTouched'] == 0, f'{d["otherRunsTouched"]} other runs changed')
    b, n = sides['bun'], sides['native']
    check('compare:runs', b['runs'] == n['runs'], json.dumps({'bun': b['runs'], 'native': n['runs']}))
    def kinds(d):
        return {rid: [k for k in ks if k not in TIMED] for rid, ks in d['events'].items()}
    check('compare:events', kinds(b) == kinds(n), json.dumps({'bun': kinds(b), 'native': kinds(n)})[:3000])
    check('compare:failed-payloads', b['failedPayloads'] == n['failedPayloads'],
          json.dumps({'bun': b['failedPayloads'], 'native': n['failedPayloads']})[:3000])
    return {'suite': 'n2-recovery', 'cases': [{'id': c['id'], 'pass': c['pass']} for c in checks],
            'behaviorQualified': all(c['pass'] for c in checks)}
