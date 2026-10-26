"""N2 broker-turn comparison: two real workflow dumps (Bun copy, rusthrc).

The harness answers in prose, so the two runs' broker ledgers differ in
content and sometimes in count. Each side is therefore checked against its
OWN broker ledger with Bun's projection rules, and the sides are compared on
everything the rules fix: raw-row bytes and key order per event type, run and
runtime rows, lifecycle kinds/payload shapes per turn, the Skill tool rows
foundry's skill-lifecycle counts, and the human-typed turn that has no run.
"""
import collections
import json
from pathlib import Path
import re

ID = re.compile(r'(?:rt|run|inv|hsid|op|req|trace|input)-[0-9a-f]{8}-[0-9a-f-]{27}')
LEASE = re.compile(r'btmux/[a-z-]+--rt-[0-9a-f-]+\.sock')
TS = re.compile(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z')
# Rows whose presence and order follow broker/probe timing, not projection rules.
TIMED = {'broker.seat.transition', 'runtime.context.updated', 'server.started'}
# Recorded when the admitting route returns; on a cold birth that races the
# harness's first turn. Compared as their own ordered list, not by position.
UNPOSITIONED = {'submission.admission'}


# agent-spaces T-11837 (the claude-code-tmux Stop-hook fallback final beside the
# transcript's message) is fixed in the aspd live from this instant; a seat born
# after it must carry no fallback duplicate. Older seats keep the old broker.
T11837_FIXED_AT = '2026-10-26T08:39:00Z'
FALLBACK = re.compile(r'^turn_.+_final$')


def born_after_fix(d):
    return bool(d.get('runtimes')) and all(r['created_at'] > T11837_FIXED_AT for r in d['runtimes'])


def fallback_duplicates(d):
    """(run, messageId) of each broker fallback final in a run that also has a transcript message."""
    by_run = collections.defaultdict(list)
    for r in d['broker_invocation_events']:
        if r['type'] == 'assistant.message.completed':
            by_run[r['run_id']].append(json.loads(r['broker_event_json']).get('messageId') or '')
    return [(run, m) for run, ids in by_run.items() if any(not FALLBACK.match(i) for i in ids)
            for m in ids if FALLBACK.match(m)]


def load(directory, name):
    return json.loads((Path(directory) / f'{name}.json').read_text())


class Norm:
    """First-appearance bijection for identities; timestamps and scratch roots erased."""
    def __init__(self, root):
        self.ids, self.root = {}, root

    def __call__(self, value):
        if isinstance(value, dict):
            return {k: self(v) for k, v in value.items()}
        if isinstance(value, list):
            return [self(v) for v in value]
        if isinstance(value, str):
            value = LEASE.sub('btmux/<lease>.sock', value.replace(self.root, '<root>'))
            value = ID.sub(lambda m: self.ids.setdefault(m.group(0), f'<{m.group(0).split("-")[0]}{len(self.ids)}>'), value)
            return TS.sub('<ts>', value)
        return value


def keys(raw):
    try:
        value = json.loads(raw)
    except (TypeError, ValueError):
        return None
    return list(value) if isinstance(value, dict) else type(value).__name__


def ledger_checks(side, d, check):
    ledger = {e['seq']: e for e in d['brokerLedger']}
    rows = d['broker_invocation_events']
    semantic = [r for r in rows if not r['type'].endswith('.delta')]
    check(side + ':raw:nonempty', len(semantic) > 10, 'workflow must project a real broker ledger')
    bad = []
    for r in rows:
        e = ledger.get(r['seq'])
        envelope = dict(e or {})
        payload = envelope.pop('payload', None)
        stored = json.loads(r['broker_event_json'])
        if isinstance(stored, dict) and isinstance(stored.get('result'), dict) and 'spill' in stored['result'].get('details', {}):
            stored = payload  # spilled rows are checked through tool_result_blobs elsewhere
        if e is None or stored != payload or json.loads(r['broker_envelope_json']) != envelope or r['type'] != e['type']:
            bad.append(r['seq'])
    check(side + ':raw:ledger-equal', not bad, f'stored payload/envelope must equal the broker ledger (bad seqs {bad[:8]})')
    check(side + ':raw:no-deltas', not [r for r in rows if r['type'].endswith('.delta')], 'raw *.delta fragments stay in the broker ledger')
    check(side + ':raw:applied', all(r['projection_status'] == 'applied' for r in rows), 'every mirrored row projects as applied')
    dispositions = {(x['invocation_id'], x['seq']) for x in d['broker_projection_dispositions']}
    check(side + ':raw:dispositions', dispositions == {(r['invocation_id'], r['seq']) for r in rows}, 'one hash disposition per projected seq')
    inv = d['broker_invocations'][0]
    top = max(ledger)
    check(side + ':raw:cursor', inv['last_projected_seq'] == top, f'durable cursor {inv["last_projected_seq"]} must reach ledger head {top}')
    check(side + ':raw:last-event-seq', inv['last_event_seq'] == max(r['seq'] for r in rows), 'lastEventSeq follows the last mirrored seq')


def turns(d):
    """Lifecycle kinds per broker turn id, in hrc_seq order, timing rows removed."""
    by_turn, current = collections.OrderedDict(), 'birth'
    for e in d['hrc_events']:
        payload = json.loads(e['payload_json'] or '{}')
        if e['event_kind'] in ('broker.turn.origin',) and payload.get('turnId'):
            current = payload['turnId'].rsplit('_', 1)[-1]
        if e['event_kind'] in TIMED or e['event_kind'] in UNPOSITIONED:
            continue
        by_turn.setdefault(current, []).append(e)
    return by_turn


def compare(args, checks):
    def check(name, passed, reason):
        checks.append({'id': name, 'pass': bool(passed), 'reason': reason, 'failureCode': 1})

    bun, native = load(args.baseline, 'bun'), load(args.candidate, 'native')
    nb, nn = Norm(bun['scratchRoot']), Norm(native['scratchRoot'])
    cases = []

    def case(name, passed, reason):
        check('compare:' + name, passed, reason)
        cases.append({'id': name, 'pass': bool(passed)})

    for side, d in (('bun', bun), ('native', native)):
        ledger_checks(side, d, check)
        # One reply row per broker message on each side.
        messages = len([r for r in d['broker_invocation_events'] if r['type'] == 'assistant.message.completed'])
        replies = len([e for e in d['hrc_events'] if e['event_kind'] == 'turn.message'])
        check(side + ':reply-rows', messages == replies, f'{replies} turn.message rows for {messages} broker messages')
        if born_after_fix(d):
            dups = fallback_duplicates(d)
            check(side + ':no-fallback-duplicates', not dups, f'T-11837 fallback finals on a post-fix seat: {dups}')

    # Raw bytes: for every (type, key set) both sides stored, Bun's key order.
    def orders(d):
        out = {}
        for r in d['broker_invocation_events']:
            for column in ('broker_event_json', 'broker_envelope_json'):
                k = keys(r[column])
                if isinstance(k, list):
                    out.setdefault((r['type'], column, tuple(sorted(k))), k)
        return out
    ob, on = orders(bun), orders(native)
    shared_orders = sorted(set(ob) & set(on))
    case('raw-key-order', shared_orders and all(ob[k] == on[k] for k in shared_orders),
         'stored JSON key order per (type, key set): ' + str([k[:2] for k in shared_orders if ob[k] != on[k]]))
    kb = {r['type'] for r in bun['broker_invocation_events']}
    shared = sorted(kb & {r['type'] for r in native['broker_invocation_events']})
    case('raw-run-attribution', all(
        [r['run_id'] is None for r in bun['broker_invocation_events'] if r['type'] == t][:1] ==
        [r['run_id'] is None for r in native['broker_invocation_events'] if r['type'] == t][:1] for t in shared),
         'first row of each type attributes a run iff Bun does')

    # Skill tool rows (foundry skill-lifecycle reads these directly).
    def skill(d, norm):
        rows = [r for r in d['broker_invocation_events'] if r['type'].startswith('tool.call.')
                and json.loads(r['broker_event_json']).get('name') == 'Skill']
        out = []
        for r in rows:
            p = json.loads(r['broker_event_json'])
            out.append((r['type'], keys(r['broker_event_json']), p.get('input'), p.get('isError'), r['run_id'] is not None,
                        r['projection_status']))
        events = [(e['event_kind'], norm(json.loads(e['payload_json'])).get('toolName'), e['run_id'] is not None)
                  for e in d['hrc_events'] if e['event_kind'] in ('turn.tool_call', 'turn.tool_result')
                  and json.loads(e['payload_json']).get('toolName') == 'Skill']
        return out, events
    sb, sn = skill(bun, nb), skill(native, nn)
    if not sb[0]:
        checks.append({'id': 'compare:skill-rows', 'pass': False, 'failureCode': 2,
                       'reason': 'workflow ran no Skill tool turn; skill-lifecycle rows not exercised'})
        cases.append({'id': 'skill-rows', 'pass': False, 'gap': True})
    else:
        case('skill-rows', sb == sn, f'Skill broker rows and lifecycle rows must match Bun: {sb} vs {sn}')

    # Durable run/runtime/invocation/session rows, identity-normalized.
    run_cols = ('status', 'transport', 'error_code', 'execution_format', 'correlation_json', 'origin_kind')
    def runs(d, norm):
        return [{**{c: r[c] for c in run_cols}, 'dispatched': r['dispatched_input_id'] is not None,
                 'submission': r['broker_submission_id'] is not None, 'started': r['started_at'] is not None,
                 'completed': r['completed_at'] is not None} for r in sorted(d['runs'], key=lambda r: r['accepted_at'])]
    case('run-rows', runs(bun, nb) == runs(native, nn), f'{runs(bun, nb)} vs {runs(native, nn)}')
    def runtime(d):
        r = d['runtimes'][0]
        state = json.loads(r['runtime_state_json'])
        return {'status': r['status'], 'activeRun': r['active_run_id'], 'transport': r['transport'],
                'stateKeys': sorted(state), 'stateStatus': state.get('status'),
                'invocationState': d['broker_invocations'][0]['invocation_state'],
                'continuation': json.loads(d['sessions'][0]['continuation_json'] or 'null') is not None,
                'reuseDisabled': d['sessions'][0]['continuation_reuse_disabled'],
                'surfaces': [(s['surface_kind'], s['unbound_at']) for s in d['surface_bindings']]}
    rb, rn = runtime(bun), runtime(native)
    case('runtime-row', rb == rn, f'{rb} vs {rn}')

    # Lifecycle rows per turn: kinds, categories, transports, run attribution and
    # payload shapes. Assistant prose differs; the shape and identity do not.
    tb, tn = turns(bun), turns(native)
    case('turn-set', list(tb) == list(tn), f'turns {list(tb)} vs {list(tn)}')
    for turn in tb:
        def shape(events, norm, fixed):
            out, replied, terminal = [], set(), False
            for e in events:
                if e['event_kind'] == 'turn.completed':
                    terminal = True
                if e['event_kind'] == 'turn.message' and not fixed:
                    # Pre-fix seat: a T-11837 fallback duplicate, or its
                    # transcript twin landing after the terminal.
                    if e['run_id'] in replied or terminal:
                        continue
                    replied.add(e['run_id'])
                p = norm(json.loads(e['payload_json'] or '{}'))
                stable = e['event_kind'] in ('turn.started', 'turn.completed', 'turn.accepted', 'broker.turn.origin',
                                             'broker.submission.milestone', 'turn.user_prompt', 'runtime.presentation')
                out.append((e['event_kind'], e['category'], e['transport'], e['run_id'] is not None, e['error_code'],
                            p if stable else sorted(p)))
            return out
        a, b = shape(tb[turn], nb, born_after_fix(bun)), shape(tn.get(turn, []), nn, born_after_fix(native))
        case(f'lifecycle-turn-{turn}', a == b, json.dumps({'bun': a, 'native': b}, default=str)[:3000])
    def admissions(d, norm):
        return [(e['run_id'] is not None, norm(json.loads(e['payload_json']))) for e in d['hrc_events']
                if e['event_kind'] in UNPOSITIONED]
    ab, an = admissions(bun, nb), admissions(native, nn)
    case('submission-admission', ab == an, json.dumps({'bun': ab, 'native': an})[:3000])
    human = [e for e in native['hrc_events'] if e['event_kind'] == 'broker.turn.origin'
             and json.loads(e['payload_json']).get('origin') == 'local-interactive']
    case('human-turn-origin', len(human) == 1 and human[0]['run_id'] is None,
         'the pane-typed turn is recorded with no run, origin local-interactive')
    return {'suite': 'n2-turns', 'cases': cases, 'behaviorQualified': all(c['pass'] for c in checks)}
