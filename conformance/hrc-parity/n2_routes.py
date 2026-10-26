"""N2 route cases: one ordered request list on a real seat per owner.

Per case the status, the identity-normalized body and the lifecycle kinds the
request caused must equal Bun's. Ledger cursors (`fromSeq`, `afterSeq`) are
positions in each owner's own ledger, so each side is checked for validity
(the cursor precedes the run's first row) rather than equality.
"""
import json
from pathlib import Path

from n2_turns import Norm, TIMED, UNPOSITIONED, born_after_fix, fallback_duplicates

CURSORS = ('fromSeq', 'afterSeq')
# Bun answers a scope-filtered read through the federation home registry
# (forwardScopedGet); rusthrc reads no federation.json yet and answers locally,
# as Bun does with no federation config.
GAPS = {'runs:scope': 'GAP:N4 scope-home routing of scoped GET /v1/runs',
        'broker-inspect:terminated': 'GAP:N2 retained-evidence terminal outcome (N2 recovery landing)'}


def strip_cursors(value):
    if isinstance(value, dict):
        return {k: ('<seq>' if k in CURSORS and isinstance(v, int)
                    else '<continuation-key>' if k == 'previousContinuationKey' and isinstance(v, str)
                    else strip_cursors(v)) for k, v in value.items()}
    if isinstance(value, list):
        return [strip_cursors(v) for v in value]
    return value


def kinds(observation, fixed):
    out, replied, tail = [], False, []
    for kind in observation['eventKinds']:
        if kind in TIMED:
            continue
        # Recorded when the admitting route returns: compared, not positioned.
        if kind in UNPOSITIONED:
            tail.append(kind)
            continue
        # Bun's terminate races its own exit projection against finalize and
        # sometimes writes runtime.terminated twice; one terminal record is the
        # contract (a mechanism race, not a product path).
        if kind == 'runtime.terminated' and out and out[-1] == kind:
            continue
        # Pre-fix seat: a second turn.message is the broker's Stop-hook
        # fallback beside the transcript's (agent-spaces T-11837).
        if kind == 'turn.message' and not fixed:
            if replied:
                continue
            replied = True
        out.append(kind)
    return out + sorted(tail)


def compare(args, checks):
    def check(name, passed, reason, code=1):
        checks.append({'id': name, 'pass': bool(passed), 'reason': reason, 'failureCode': code})

    sides, fixed = {}, {}
    for owner, directory in (('bun', args.baseline), ('native', args.candidate)):
        d = json.loads((Path(directory) / f'{owner}.json').read_text())
        norm = Norm(d['scratchRoot'])
        scope = d['scope']
        sides[owner] = (d, {o['case']: o for o in d['observations']},
                        lambda v, n=norm, sc=scope: n(json.loads(json.dumps(v).replace(sc, '<scope>'))))
        # Terminate must leave nothing running: broker, harness and the lease server.
        for o in d['observations']:
            if o['case'] == 'terminate:final' and 'processes' in o:
                p = o['processes']
                check(f'{owner}:terminate:processes-gone',
                      p['owned'] > 0 and not p['survivors'] and not p['leaseServerAlive'],
                      f'{p["owned"]} owned pids; survivors {p["survivors"]}; lease server alive {p["leaseServerAlive"]}')
        rows = json.loads((Path(directory) / f'{owner}-rows.json').read_text())
        fixed[owner] = born_after_fix(rows)
        if fixed[owner]:
            dups = fallback_duplicates(rows)
            check(f'{owner}:no-fallback-duplicates', not dups, f'T-11837 fallback finals on a post-fix seat: {dups}')
        first = {}
        for e in rows['hrc_events']:
            first.setdefault(e['run_id'], e['hrc_seq'])
        for o in d['observations']:
            body = o['body'] if isinstance(o['body'], dict) else {}
            lifecycle = body.get('observation', {}).get('lifecycle', {})
            run = body.get('runId')
            if 'fromSeq' in lifecycle and run in first and not body.get('replayed'):
                check(f'{owner}:{o["case"]}:fromSeq', lifecycle['fromSeq'] <= first[run],
                      f'fromSeq {lifecycle["fromSeq"]} must precede the run\'s first row {first[run]}')
    cases = []
    bun, native = sides['bun'], sides['native']
    for name in bun[1]:
        a, b = bun[1][name], native[1].get(name)
        if b is None:
            check('compare:' + name, False, 'case missing on native')
            cases.append({'id': name, 'pass': False})
            continue
        left = {'status': a['status'], 'body': strip_cursors(bun[2](a['body'])), 'events': kinds(a, fixed['bun'])}
        right = {'status': b['status'], 'body': strip_cursors(native[2](b['body'])), 'events': kinds(b, fixed['native'])}
        for key in ('sessions', 'runtimes'):
            if key in a or key in b:
                left[key], right[key] = a.get(key), b.get(key)
        passed = left == right
        detail = json.dumps({'bun': left, 'native': right}, default=str)[:4000]
        if not passed and name in GAPS:
            check('compare:' + name, False, GAPS[name] + ': ' + detail, 2)
        else:
            check('compare:' + name, passed, detail)
        cases.append({'id': name, 'pass': passed})
    return {'suite': 'n2-routes', 'cases': cases, 'behaviorQualified': all(c['pass'] for c in checks)}
