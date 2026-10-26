#!/usr/bin/env python3
"""N4 operations reads on one frozen store: Bun then native answer the same cases.

A scratch node births one real seat under Bun (so broker_invocation_events
are genuine), terminates it, and freezes the store. Then each owner answers:
GET /v1/federation/bindings over ledger fixtures (a placement-home skew, a
default-home note, a retired row that must be skipped), GET
/v1/runtime-diagnostics over first_turn_missing trip rows (bundle present,
bundle missing, untripped), and GET /v1/broker-forensics by source ref,
invocation, runtime and refusals, and GET /v1/federation/runtimes with that
terminated seat.

Failure modes: a skew judged differently, a retired binding scanned, a trip
or bundle projected with other keys, parseInt edge cases, forensics events
decoded or ordered differently, and refusal text/status drift.

POST /v1/previews/run compiles real intents (resolved once, under Bun) on both
owners against the same aspd: with and without a first turn, interactive, a
lane-qualified ref, two selections ASP refuses (compile-not-ok), and the body
refusals. Dry-run ids, hashes, profile ids, session names, compile ids and
phase timings are masked by role so the compare still sees every key in order.
The startup retained-evidence pass is settled first: it lands the terminated
broker's disposal, which would otherwise race the first owner's reads.
"""
import argparse
import json
from pathlib import Path
import re
import sqlite3
from urllib.parse import quote

from n3_scratch import Scratch

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
    """Preview bodies from intents the Bun owner resolves for real scopes."""
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


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--binary', type=Path, required=True)
    p.add_argument('--installed-release', type=Path, required=True)
    p.add_argument('--aspd-socket', type=Path, required=True)
    p.add_argument('--scratch-root', type=Path, required=True)
    p.add_argument('--artifacts', type=Path, required=True)
    args = p.parse_args()
    s = Scratch(args.scratch_root, args.installed_release, args.aspd_socket, args.binary, args.artifacts,
                project_id=PROJECT)
    out = {'bun': {}, 'native': {}}
    try:
        s.init_substrate()
        s.root.joinpath('federation.json').write_text(json.dumps({'nodeId': 'n4o', 'peers': {}}))
        now = '2026-10-26T10:00:00.000Z'
        store = s.release / 'packages/hrc-store-sqlite/src/index.ts'
        script = (f'const s=await import({json.dumps(str(store))});const a=process.argv.slice(1);'
                  'const db=s.openHrcDatabase(a[0]);const l=s.createPlacementLedgerRepository(db.sqlite);'
                  'for(const x of [a[1],a[2]])l.installActive({scopeRef:x,homeNodeId:"n4o",updatedAt:a[4]});'
                  'l.installActive({scopeRef:a[3],homeNodeId:"n4o",updatedAt:a[4]});'
                  'l.retire({scopeRef:a[3],expectedHomeNodeId:"n4o",reason:"n4 fixture",retiredAt:a[4]});db.close()')
        s.command('store:ledger', ['bun', '-e', script, s.db_path, scope('animan', 'primary'),
                                   scope('tabularasa', 'skewless'), scope('animan', 'retired'), now])
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
        proc = s.up('bun', 'birth')
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
        proc = s.up('bun', 'settle')
        settle_log = args.artifacts / 'bun-settle.log'
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
        for owner in ('bun', 'native'):
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
        print(json.dumps({o: len(c) for o, c in out.items()}))
    finally:
        (args.artifacts / 'steps.json').write_text(json.dumps(s.steps, indent=1) + '\n')
        s.cleanup('agent:')


if __name__ == '__main__':
    main()
