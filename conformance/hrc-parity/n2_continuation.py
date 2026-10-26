"""aspc.compileHarnessInvocation requests, field for field, Bun vs rusthrc.

Both owners birth, lose the seat, and re-birth on the stored continuation
(crates/hrc-native/e2e/n2_continuation.py). Every compile request either owner
sent is compared with key order. Only identities, timestamps, the run's code
word, the provider continuation key and the owner-named scope may differ.
"""
import json
from pathlib import Path

from n2_turns import Norm


def normalized(d):
    norm = Norm(d['scratchRoot'])
    raw = json.dumps(d['compiles']).replace(d['scope'], '<scope>').replace(d['word'], '<word>')
    raw = raw.replace(d['sessionContinuation']['key'], '<continuation-key>')
    task = d['scope'].rsplit(':', 1)[-1]
    raw = raw.replace(task, '<task>')
    return norm(json.loads(raw))


def ordered(value):
    """Key order is part of the request: compare as nested key/value lists."""
    if isinstance(value, dict):
        return [[k, ordered(v)] for k, v in value.items()]
    if isinstance(value, list):
        return [ordered(v) for v in value]
    return value


def compare(args, checks):
    def check(name, passed, reason):
        checks.append({'id': name, 'pass': bool(passed), 'reason': reason, 'failureCode': 1})

    cases = []
    sides = {}
    for owner, directory in (('bun', args.baseline), ('native', args.candidate)):
        d = json.loads((Path(directory) / f'{owner}.json').read_text())
        sides[owner] = d
        check(owner + ':recalled', d['recalled'], f'the re-born harness must recall the code word: {d["reply"]}')
        check(owner + ':two-compiles', d['compileCount'] == 2, f'{d["compileCount"]} compiles')
        second = d['compiles'][-1]['compileRequest'] if d['compiles'] else {}
        check(owner + ':continuation-carried',
              second.get('continuation', {}).get('hrc', {}).get('key') == d['sessionContinuation']['key'],
              'the re-birth compile carries the stored session continuation')
    b, n = normalized(sides['bun']), normalized(sides['native'])
    for i, (left, right) in enumerate(zip(b, n)):
        name = f'compile-{i + 1}'
        passed = ordered(left) == ordered(right)
        check('compare:' + name, passed, json.dumps({'bun': left, 'native': right}))
        cases.append({'id': name, 'pass': passed})
    return {'suite': 'n2-continuation', 'cases': cases, 'behaviorQualified': all(c['pass'] for c in checks)}
