#!/usr/bin/env python3
"""N4 operations reads on one frozen store, answered by a native owner and judged here.

A scratch node births one real seat (so broker_invocation_events are genuine),
terminates it, and freezes the store. The ledger fixtures are n4_federation's
native install/retire statements. Then the owner answers:
GET /v1/federation/bindings over ledger fixtures (a placement-home skew, a
default-home note, a retired row that must be skipped), GET
/v1/runtime-diagnostics over first_turn_missing trip rows (bundle present,
bundle missing, untripped), and GET /v1/broker-forensics by source ref,
invocation, runtime and refusals, and GET /v1/federation/runtimes with that
terminated seat.

Failure modes: a skew judged differently, a retired binding scanned, a trip
or bundle projected with other keys, parseInt edge cases, forensics events
decoded or ordered differently, and refusal text/status drift.

POST /v1/previews/run compiles real intents against the real aspd: with and without a first turn, interactive, a
lane-qualified ref, two selections ASP refuses (compile-not-ok), and the body
refusals. Dry-run ids, hashes, profile ids, session names, compile ids and
phase timings are masked by role. The startup retained-evidence pass is
settled first: it lands the terminated broker's disposal, which would
otherwise race the reads.
"""
import argparse
import json
from pathlib import Path
import re
import sqlite3
from urllib.parse import quote

from n3_scratch import Scratch
from n4_federation import LEDGER_ACTIVE, LEDGER_RETIRE

PROJECT = 'n4-t11872o'
PROMPT = 'Reply with exactly the word OK and nothing else. No tools.'


def scope(agent, task):
    return f'agent:{agent}:project:{PROJECT}:task:{task}'


DRY = re.compile(r'dry-(req|op|rt|inv|input|run|trace)-[0-9a-f-]{36}')
HASH = re.compile(r'\b(sha256:)?[0-9a-f]{64}\b')
PROFILE = re.compile(r'\bprofile_[0-9a-f]{32}\b')
UUID = re.compile(r'\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b')
SESSION = re.compile(rf'\b(\w+-{PROJECT})-[a-z0-9]{{4}}\b')
VOLATILE = {'compileId', 'planHash', 'createdAt', 'ms'}


def mask(value):
    """Mask per-compile values by role; keys and their order are kept."""
    if isinstance(value, dict):
        return {k: '<' + k + '>' if k in VOLATILE and value[k] is not None else mask(x) for k, x in value.items()}
    if isinstance(value, list):
        return [mask(x) for x in value]
    if isinstance(value, str):
        value = DRY.sub(lambda m: f'dry-{m.group(1)}-<id>', value)
        value = SESSION.sub(lambda m: m.group(1) + '-<name>', PROFILE.sub('profile_<id>', value))
        return UUID.sub('<uuid>', HASH.sub('<hash>', value))
    return value


def preview_cases(s):
    """Preview bodies from intents the owner resolves for real scopes."""
    def resolve(name, **extra):
        status, value = s.http('POST', '/v1/declarations/resolve', {'scopeRef': name, **extra})
        assert status == 200, (status, value)
        return value['intent']
    seat = scope('tabularasa', 'preview')
    prompted = resolve(seat, initialPrompt=PROMPT)
    bare = resolve(seat)
    interactive = resolve(seat, interactive=True, preferredMode='interactive')
    def selecting(**selection):
        intent = json.loads(json.dumps(bare))
        intent['selection'] = selection
        return intent
    return [
        ('preview:prompted', {'intent': prompted, 'sessionRef': seat}),
        ('preview:bare', {'intent': bare, 'sessionRef': seat}),
        ('preview:interactive', {'intent': interactive, 'sessionRef': seat}),
        ('preview:lane-ref', {'intent': prompted, 'sessionRef': seat + '/lane:main'}),
        ('preview:refused-model', {'intent': selecting(model='n4-no-such-model'), 'sessionRef': seat}),
        ('preview:refused-pairing', {'intent': selecting(harness='codex', modelProvider='anthropic'),
                                     'sessionRef': seat}),
        ('preview:not-object', []),
        ('preview:no-intent', {'sessionRef': seat}),
        ('preview:no-harness', {'intent': {'placement': prompted['placement']}, 'sessionRef': seat}),
        ('preview:no-ref', {'intent': prompted}),
        ('preview:blank-ref', {'intent': prompted, 'sessionRef': '  '}),
    ]


FAILED = []


def judge(o, ids, artifacts):
    """Each read's own literals: the fixture rows above and the born seat's ids."""
    checks = []
    def check(name, passed, reason):
        checks.append({'id': name, 'pass': bool(passed), 'reason': reason,
                       'got': {k: o.get(k, {}).get('status') for k in [name.split('/')[0]] if k in o}})
    def ok(name, status=200):
        return o[name]['status'] == status
    def err(name, status, code):
        return o[name]['status'] == status and o[name]['body'].get('error', {}).get('code') == code
    b = o['bindings']['body']
    check('bindings', ok('bindings') and b['localNodeId'] == 'n4o' and b['scan']['scanned'] == 2 and b['scan']['unreadable'] == []
          and [x['scopeRef'] for x in b['scan']['skewed']] == [scope('animan', 'primary')]
          and b['scan']['skewed'][0]['skew'] | {'detail': None} == {'kind': 'task-default-vs-binding', 'taskKey': 'primary',
                                                                     'taskDefaultNodeId': 'max3', 'boundNodeId': 'n4o', 'detail': None},
          'two active bindings scanned (the retired one skipped); only the animan primary default (max3) skews from n4o')
    trips = lambda name: [t['tripEventSeq'] for t in o[name]['body']['trips']]
    # The overdue rt-armed row trips on the first boot (first_turn.rs armed_due) as hrc_seq 2.
    armed = o['diagnostics:list']['body']['trips'][0]
    check('diagnostics:list', ok('diagnostics:list') and trips('diagnostics:list') == [armed['tripEventSeq'], 104, 103, 101]
          and armed['runtimeId'] == 'rt-armed' and armed['bundleAvailable'] is True,
          'every trip, newest trippedAt first; the overdue armed row was tripped by the owner itself')
    check('diagnostics:runtime', ok('diagnostics:runtime') and trips('diagnostics:runtime') == [104, 101], 'one runtime\'s trips across generations')
    for name in ('diagnostics:runtime-empty', 'diagnostics:runtime-unknown'):
        check(name, ok(name) and o[name]['body'] == {'ok': True, 'trips': []}, 'an empty or unknown runtime filter matches nothing')
    t101 = o['diagnostics:trip-bundle']['body']
    check('diagnostics:trip-bundle', ok('diagnostics:trip-bundle') and t101['trip']['tripEventSeq'] == 101 and t101['trip']['runId'] == 'run-a'
          and t101['bundle'] == {'schemaVersion': 'n4-fixture', 'files': ['a.log']}, 'a recorded bundle is read back verbatim')
    nb = o['diagnostics:trip-no-bundle']['body']
    check('diagnostics:trip-no-bundle', ok('diagnostics:trip-no-bundle') and nb['trip']['bundleAvailable'] is False and nb['bundleError'] == 'no_bundle_recorded'
          and 'bundleDir' not in nb['trip'] and 'runId' not in nb['trip'], 'no bundle recorded is named, absent fields are absent')
    mb = o['diagnostics:trip-missing-bundle']['body']
    check('diagnostics:trip-missing-bundle', ok('diagnostics:trip-missing-bundle') and mb['bundleError'].startswith('ENOENT')
          and mb['bundleError'].endswith("'<root>/bundles/missing/manifest.json'") and 'bundle' not in mb, 'a recorded but missing bundle names the read error')
    check('diagnostics:trip-prefix', o['diagnostics:trip-prefix'] == o['diagnostics:trip-bundle'], 'trip=101abc parses as 101 (parseInt)')
    for name, trip in (('diagnostics:trip-word', 'abc'), ('diagnostics:trip-unknown', '999')):
        check(name, err(name, 404, 'unknown_runtime') and o[name]['body']['error']['detail'] == {'trip': trip}, 'an unknown trip is 404 unknown_runtime')
    check('diagnostics:trip-blank', o['diagnostics:trip-blank'] == o['diagnostics:list'], 'a blank trip is the unfiltered list')
    for name in ('forensics:none', 'forensics:both'):
        check(name, err(name, 400, 'malformed_request'), 'exactly one of targetId or sourceRef')
    check('forensics:unknown', err('forensics:unknown', 400, 'invalid_selector'), 'an unknown target is invalid_selector')
    for name, kind, target in (('forensics:invocation', 'invocation', ids['invocation']), ('forensics:runtime', 'runtime', ids['runtime'])):
        v = o[name]['body']
        seqs = [e['seq'] for e in v['events']]
        check(name, ok(name) and v['targetKind'] == kind and v['targetId'] == target and v['runtimeIds'] == [ids['runtime']]
              and v['invocationIds'] == [ids['invocation']] and seqs and seqs == list(range(1, len(seqs) + 1))
              and all(e['invocationId'] == ids['invocation'] for e in v['events']) and v['events'][0]['type'] == 'lifecycle.policy.accepted'
              and isinstance(v['events'][0]['payload'], dict), 'the born seat\'s broker ledger, decoded, in seq order from 1')
    check('forensics:trimmed', o['forensics:trimmed'] == o['forensics:runtime'], 'a padded targetId is trimmed')
    v = o['forensics:source']['body']
    check('forensics:source', ok('forensics:source') and v['targetKind'] == 'source_ref' and v['targetId'] == ids['source']
          and (ids['source'] != 'none' or v['events'] == []), 'a sourceRef selects its own events (none recorded here)')
    nodes = o['fedruntimes:local']['body']['nodes']
    check('fedruntimes:local', ok('fedruntimes:local') and [n['nodeId'] for n in nodes] == ['n4o'] and nodes[0]['state'] == 'answered'
          and [(r['runtimeId'], r['status'], r['transport']) for r in nodes[0]['runtimes']] == [(ids['runtime'], 'terminated', 'hrcpty')],
          'the local projection includes the terminated seat by default')
    check('fedruntimes:not-all', ok('fedruntimes:not-all') and o['fedruntimes:not-all']['body']['nodes'][0]['runtimes'] == [], 'all=false drops terminal runtimes')
    for name in ('preview:prompted', 'preview:bare', 'preview:interactive', 'preview:lane-ref'):
        v = o[name]['body']
        check(name, ok(name) and v['controllerKind'] == 'harness-broker' and v['execution']['driver'] == 'claude-code-hrcpty'
              and v['selection']['harness'] == 'claude-hrcpty' and v['compileId'] == '<compileId>'
              and (v.get('primingPrompt') == PROMPT) == (name in ('preview:prompted', 'preview:lane-ref')),
              'a real compile; the prompt appears only when the intent carries one')
    check('preview:lane-ref:same', o['preview:lane-ref'] == o['preview:prompted'], 'a lane-qualified sessionRef compiles the same plan')
    for name in ('preview:refused-model', 'preview:refused-pairing'):
        d = o[name]['body'].get('error', {}).get('detail', {})
        check(name, err(name, 503, 'runtime_unavailable') and d.get('code') == 'compile-not-ok' and d.get('failingPhase') == 'admission'
              and d.get('rejectedBy') == 'producer', 'ASP\'s refusal is surfaced as compile-not-ok at admission')
    for name, field in (('preview:not-object', 'intent'), ('preview:no-intent', 'intent'), ('preview:no-harness', 'intent'),
                        ('preview:no-ref', 'sessionRef'), ('preview:blank-ref', 'sessionRef')):
        check(name, err(name, 400, 'malformed_request') and o[name]['body']['error']['detail'] == {'field': field}, 'body refusals name their field')
    (artifacts / 'checks.json').write_text(json.dumps(checks, indent=1) + '\n')
    FAILED.extend(c for c in checks if not c['pass'])
    return FAILED


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--binary', type=Path, required=True)
    p.add_argument('--installed-release', type=Path)
    p.add_argument('--aspd-socket', type=Path, required=True)
    p.add_argument('--scratch-root', type=Path, required=True)
    p.add_argument('--artifacts', type=Path, required=True)
    args = p.parse_args()
    s = Scratch(args.scratch_root, args.installed_release, args.aspd_socket, args.binary, args.artifacts,
                project_id=PROJECT)
    out = {'native': {}}
    try:
        s.init_substrate()
        s.root.joinpath('federation.json').write_text(json.dumps({'nodeId': 'n4o', 'peers': {}}))
        now = '2026-10-26T10:00:00.000Z'
        with sqlite3.connect(s.db_path) as db:
            for x in (scope('animan', 'primary'), scope('tabularasa', 'skewless'), scope('animan', 'retired')):
                db.execute(LEDGER_ACTIVE, (x, 'n4o', now, now))
            db.execute(LEDGER_RETIRE, (now, 'n4 fixture', now, scope('animan', 'retired'), 'n4o'))
        bundle = s.root / 'bundles/trip-1'
        bundle.mkdir(parents=True)
        bundle.joinpath('manifest.json').write_text(json.dumps({'schemaVersion': 'n4-fixture', 'files': ['a.log']}))
        with sqlite3.connect(s.db_path) as db:
            cols = ('runtime_id, generation, host_session_id, scope_ref, lane_ref, run_id, invocation_id, transport, '
                    'priming_dispatched_at, first_turn_deadline_at, first_turn_at, first_turn_missing_tripped_at, '
                    'disarmed_at, disarm_reason, trip_event_seq, diagnostics_event_seq, bundle_dir, created_at, updated_at')
            rows = [
                ('rt-trip-a', 1, 'hsid-a', scope('hunter', 'a'), 'main', 'run-a', 'inv-a', 'tmux', now, now, None, '2026-10-26T10:05:00.000Z', None, None, 101, 102, str(bundle), now, now),
                ('rt-trip-b', 2, 'hsid-b', scope('hunter', 'b'), 'main', None, None, 'tmux', None, None, None, '2026-10-26T10:06:00.000Z', None, None, 103, None, None, now, now),
                ('rt-trip-a', 3, 'hsid-a', scope('hunter', 'a'), 'main', None, None, 'tmux', now, now, None, '2026-10-26T10:07:00.000Z', None, None, 104, None, str(s.root / 'bundles/missing'), now, now),
                ('rt-armed', 1, 'hsid-c', scope('hunter', 'c'), 'main', None, None, 'tmux', now, now, None, None, None, None, None, None, None, now, now),
            ]
            db.executemany(f'INSERT INTO runtime_first_turn_watch ({cols}) VALUES ({",".join("?" * 19)})', rows)
        proc = s.up('native', 'birth')
        born = s.command('cold-start', ['hrc', 'start', scope('tabularasa', 'forensics'), '--json', '-p', PROMPT])
        runtime, run = born['runtime']['runtimeId'], born['runtime']['runId']
        s.wait_completed(run)
        s.http('POST', '/v1/terminate', {'runtimeId': runtime, 'reason': 'freeze the store for n4 ops reads'})
        invocation = s.rows('SELECT invocation_id FROM broker_invocations WHERE runtime_id=? LIMIT 1', (runtime,))[0]['invocation_id']
        source_rows = s.rows('SELECT source_ref FROM broker_invocation_events WHERE runtime_id=? AND source_ref IS NOT NULL LIMIT 1', (runtime,))
        source = source_rows[0]['source_ref'] if source_rows else 'none'
        s.down(proc)
        # The terminated broker's disposal arrives as retained evidence that
        # the next owner's startup pass projects; settle it before reading.
        proc = s.up('native', 'settle')
        settle_log = next(args.artifacts.glob('*settle*.log'))
        s.wait(lambda: 'retained_evidence.pass_complete' in settle_log.read_text(), timeout=60,
               what='startup retained-evidence pass')
        s.down(proc)
        cases = [
            ('bindings', '/v1/federation/bindings'),
            ('diagnostics:list', '/v1/runtime-diagnostics'),
            ('diagnostics:runtime', '/v1/runtime-diagnostics?runtimeId=rt-trip-a'),
            ('diagnostics:runtime-empty', '/v1/runtime-diagnostics?runtimeId='),
            ('diagnostics:runtime-unknown', '/v1/runtime-diagnostics?runtimeId=rt-nope'),
            ('diagnostics:trip-bundle', '/v1/runtime-diagnostics?trip=101'),
            ('diagnostics:trip-no-bundle', '/v1/runtime-diagnostics?trip=103'),
            ('diagnostics:trip-missing-bundle', '/v1/runtime-diagnostics?trip=104'),
            ('diagnostics:trip-prefix', '/v1/runtime-diagnostics?trip=101abc'),
            ('diagnostics:trip-word', '/v1/runtime-diagnostics?trip=abc'),
            ('diagnostics:trip-unknown', '/v1/runtime-diagnostics?trip=999'),
            ('diagnostics:trip-blank', '/v1/runtime-diagnostics?trip=%20'),
            ('forensics:none', '/v1/broker-forensics'),
            ('forensics:both', f'/v1/broker-forensics?targetId={runtime}&sourceRef=x'),
            ('forensics:source', '/v1/broker-forensics?sourceRef=' + quote(source, safe='')),
            ('forensics:invocation', f'/v1/broker-forensics?targetId={invocation}'),
            ('forensics:runtime', f'/v1/broker-forensics?targetId={runtime}'),
            ('forensics:trimmed', f'/v1/broker-forensics?targetId=%20{runtime}%20'),
            ('forensics:unknown', '/v1/broker-forensics?targetId=rt-nope'),
            # The frozen seat is terminated: the projection includes terminal
            # runtimes by default and honors an explicit all=false.
            ('fedruntimes:local', '/v1/federation/runtimes'),
            ('fedruntimes:not-all', '/v1/federation/runtimes?all=false'),
        ]
        previews = None
        for owner in ('native',):
            proc = s.up(owner, 'reads')
            for name, path in cases:
                status, value = s.http('GET', path)
                out[owner][name] = {'status': status, 'body': value}
            if previews is None:
                previews = preview_cases(s)
            for name, body in previews:
                status, value = s.http('POST', '/v1/previews/run', body)
                out[owner][name] = {'status': status, 'body': mask(value)}
            s.down(proc)
        for owner, observations in out.items():
            (args.artifacts / owner).mkdir(exist_ok=True)
            (args.artifacts / owner / 'ops.json').write_text(
                json.dumps(json.loads(json.dumps(observations).replace(str(s.root), '<root>')), indent=1) + '\n')
        failed = judge(json.loads(json.dumps(out['native']).replace(str(s.root), '<root>')),
                       {'runtime': runtime, 'invocation': invocation, 'source': source}, args.artifacts)
        print(json.dumps({'suite': 'n4_ops', 'cases': len(out['native']), 'failed': failed[:20]}, indent=1))
    finally:
        (args.artifacts / 'steps.json').write_text(json.dumps(s.steps, indent=1) + '\n')
        s.cleanup('agent:')


if __name__ == '__main__':
    main()
    if FAILED:
        raise SystemExit(1)
