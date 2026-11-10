#!/usr/bin/env python3
"""Runtime prune/sweep on one native owner, beside a real live seat.

Failures: dry runs write, apply silently does nothing, the live seat is pruned
or aged, satellites survive deletion, continuation flags/events are wrong,
invalid filters admit writes, refusal precedence or detail drifts. The live
seat is runtime_reads' public deterministic birth (hrcpty, which maintenance
never selects); the orphan rows are the reservation seed below, three sdk
runtimes plus one completed run, buffer chunk and surface binding on the
prune target, written after startup and read back through the owner.
Expectations are read off broker/maintenance.rs (`parse`, `duration`,
`selected`, manifest/disposition paths) and broker/sweeps.rs.
"""
import json
import sqlite3
from runtime_reads import main, OLD, stamp
from metrics_isolation import isolated_suite

GC = (('prune', 'stale'), ('sweep', 'ready'), ('busy', 'busy'))


def cases(c):
    runtime, scope = c['runtime'], c['scope']
    common = {'scope': scope, 'transport': 'sdk', 'olderThan': '24h'}
    prune, sweep = '/v1/runtimes/prune', '/v1/runtimes/sweep'
    return [
        ('prune-dry', 'POST', prune, dict(common, dryRun=True)),
        ('prune-no-confirm', 'POST', prune, dict(common, dryRun=False)),
        ('prune-ready-refusal', 'POST', prune, dict(common, status=['ready'], dryRun=True)),
        ('prune-apply', 'POST', prune, dict(common, dryRun=False, yes=True)),
        ('prune-repeat', 'POST', prune, dict(common, dryRun=False, yes=True)),
        ('sweep-dry', 'POST', sweep, dict(common, dryRun=True)),
        ('sweep-busy-refusal', 'POST', sweep, dict(common, status=['busy'], dryRun=True)),
        ('sweep-live-refusal', 'POST', sweep, {'scope': scope, 'olderThan': '0ms', 'dryRun': True}),
        ('sweep-apply', 'POST', sweep, dict(common, dryRun=False, dropContinuation=True)),
        ('prune-swept', 'POST', prune, dict(common, dryRun=False, yes=True)),
        ('sweep-no-matches', 'POST', sweep, dict(common, scope=scope + '-absent', dryRun=False)),
        ('prune-duration-invalid', 'POST', prune, dict(common, olderThan='bad')),
        ('sweep-duration-invalid', 'POST', sweep, dict(common, olderThan='bad')),
        ('prune-status-invalid', 'POST', prune, dict(common, status='stale')),
        ('sweep-status-invalid', 'POST', sweep, dict(common, status=[''])),
        ('prune-transport-invalid', 'POST', prune, dict(common, transport='bad')),
        ('sweep-bool-invalid', 'POST', sweep, dict(common, dryRun='true')),
        ('prune-empty-manifest', 'POST', prune, {'runtimeIds': [], 'includeLedgers': True}),
        ('prune-unpaired-manifest', 'POST', prune, {'runtimeIds': [runtime]}),
        ('prune-live-safety', 'POST', prune, {'scope': scope, 'olderThan': '0ms', 'status': ['ready'], 'dryRun': False, 'yes': True}),
        ('prune-wrong-shape', 'POST', prune, []),
        ('sweep-wrong-shape', 'POST', sweep, []),
        ('prune-duplicate-manifest', 'POST', prune, {'runtimeIds': [runtime, runtime], 'includeLedgers': True}),
        ('prune-unallowlisted-manifest', 'POST', prune, {'runtimeIds': [runtime], 'includeLedgers': True, 'dryRun': True}),
        ('prune-filtered-manifest', 'POST', prune, {'runtimeIds': [runtime], 'includeLedgers': True, 'scope': scope}),
        ('prune-missing-disposition-reason', 'POST', prune, {'disposeRetainedEvidence': True, 'runtimeIds': [runtime]}),
        ('prune-no-held-evidence-disposition', 'POST', prune, {'disposeRetainedEvidence': True, 'runtimeIds': [runtime + '-gc-busy'], 'reason': 'scratch control', 'dryRun': True}),
    ]


def seed(c):
    """Orphan reservations on the live seat's session: three sdk runtimes, one with run/buffer/surface satellites."""
    f, runtime = c['fixture'], c['runtime']
    host = f.s.rows('SELECT * FROM sessions WHERE host_session_id=?', (c['host'],))[0]
    rt = runtime + '-gc-prune'
    with sqlite3.connect(f.s.db_path, timeout=30) as db:
        for suffix, status in GC:
            db.execute('INSERT INTO runtimes (runtime_id,host_session_id,scope_ref,lane_ref,generation,transport,status,'
                       'supports_inflight_input,created_at,updated_at) VALUES (?,?,?,?,?,?,?,0,?,?)',
                       (runtime + '-gc-' + suffix, host['host_session_id'], host['scope_ref'], host['lane_ref'], host['generation'], 'sdk', status, OLD, OLD))
        db.execute('INSERT INTO runs (run_id,host_session_id,runtime_id,scope_ref,lane_ref,generation,transport,status,accepted_at,completed_at,updated_at) '
                   'VALUES (?,?,?,?,?,?,?,?,?,?,?)', ('run-' + rt, host['host_session_id'], rt, host['scope_ref'], host['lane_ref'], host['generation'], 'sdk', 'completed', OLD, OLD, OLD))
        db.execute("INSERT INTO runtime_buffers(runtime_id,run_id,chunk_seq,text,created_at) VALUES (?,?,0,'prune satellite',?)", (rt, 'run-' + rt, OLD))
        db.execute("INSERT INTO surface_bindings(surface_kind,surface_id,host_session_id,runtime_id,generation,bound_at) VALUES ('scratch','n1-maintenance-prune',?,?,?,?)",
                   (host['host_session_id'], rt, host['generation'], OLD))


def observe(c):
    f = c['fixture']
    with sqlite3.connect('file:' + str(f.s.db_path) + '?mode=ro', uri=True, timeout=30) as db:
        db.row_factory = sqlite3.Row
        tables = {t: [dict(r) for r in db.execute('SELECT * FROM ' + t + ' ORDER BY rowid')]
                  for t in ('sessions', 'continuities', 'runs', 'runtime_buffers', 'surface_bindings')}
        tables['runtimes'] = [dict(r) for r in db.execute("SELECT * FROM runtimes WHERE transport='sdk' ORDER BY runtime_id")]
        tables['liveGuard'] = [dict(r) for r in db.execute('SELECT runtime_id,status,transport,active_run_id,active_operation_id,active_invocation_id,runtime_state_json FROM runtimes WHERE runtime_id=?', (c['runtime'],))]
        tables['events'] = [dict(r) for r in db.execute("SELECT * FROM hrc_events WHERE event_kind IN ('runtime.stale','runtime.sweep_completed') ORDER BY hrc_seq")]
    return tables


PRUNE = lambda pruned, skipped: {'type': 'summary', 'matched': pruned + skipped, 'pruned': pruned, 'skipped': skipped, 'errors': 0}
SWEEP = lambda stale, skipped: {'type': 'summary', 'matched': stale + skipped, 'stale': stale, 'terminated': 0, 'skipped': skipped, 'errors': 0}
BAD = 'malformed_request'
# case -> (200, [(runtime suffix, result status, reason)], summary) or (status, code, message, detail).
# Prune defaults to stale rows; sweep ages ready rows and skips busy ones. Arrays parse as an empty filter.
EXPECT = {
    'prune-dry': (200, [('-gc-prune', 'pruned', 'dry_run')], PRUNE(1, 0)),
    'prune-no-confirm': (200, [('-gc-prune', 'pruned', 'dry_run')], PRUNE(1, 0)),  # no yes: a dry run
    'prune-ready-refusal': (200, [('-gc-sweep', 'skipped', 'status_not_prunable:ready')], PRUNE(0, 1)),
    'prune-apply': (200, [('-gc-prune', 'pruned', None)], PRUNE(1, 0)),
    'prune-repeat': (200, [], PRUNE(0, 0)),
    'sweep-dry': (200, [('-gc-busy', 'skipped', 'busy'), ('-gc-sweep', 'stale', None)], SWEEP(1, 1)),
    'sweep-busy-refusal': (200, [('-gc-busy', 'skipped', 'busy')], SWEEP(0, 1)),
    # Zero age over every transport: the hrcpty live seat is never selected.
    'sweep-live-refusal': (200, [('-gc-busy', 'skipped', 'busy'), ('-gc-sweep', 'stale', None)], SWEEP(1, 1)),
    'sweep-apply': (200, [('-gc-busy', 'skipped', 'busy'), ('-gc-sweep', 'stale', None)], SWEEP(1, 1)),
    'prune-swept': (200, [('-gc-sweep', 'pruned', None)], PRUNE(1, 0)),
    'sweep-no-matches': (200, [], SWEEP(0, 0)),
    'prune-duration-invalid': (400, BAD, 'olderThan must be a duration', {'field': 'olderThan'}),
    'sweep-duration-invalid': (400, BAD, 'olderThan must be a duration', {'field': 'olderThan'}),
    'prune-status-invalid': (400, BAD, 'status must be an array', {'field': 'status'}),
    'sweep-status-invalid': (400, BAD, 'status[0] must be a non-empty string', {'field': 'status[0]'}),
    'prune-transport-invalid': (400, BAD, 'transport must be one of: tmux, headless, sdk', {'field': 'transport'}),
    'sweep-bool-invalid': (400, BAD, 'dryRun must be a boolean', {'field': 'dryRun'}),
    'prune-empty-manifest': (400, BAD, 'runtimeIds must not be empty', {'field': 'runtimeIds'}),
    'prune-unpaired-manifest': (400, BAD, 'runtimeIds and includeLedgers:true must be supplied together', {'fields': ['runtimeIds', 'includeLedgers']}),
    'prune-live-safety': (200, [], PRUNE(0, 0)),
    'prune-wrong-shape': (200, [], PRUNE(0, 0)),
    'sweep-wrong-shape': (200, [('-gc-busy', 'skipped', 'busy')], SWEEP(0, 1)),
    'prune-duplicate-manifest': (400, BAD, 'runtimeIds must not contain duplicates', {'field': 'runtimeIds'}),
    'prune-unallowlisted-manifest': (409, 'stale_context', 'ledger-inclusive runtime prune refused: 1 of 1 manifest runtimes failed the all-or-nothing safety gate', 'LIVE'),
    'prune-filtered-manifest': (400, BAD, 'runtimeIds manifest mode does not accept transport, olderThan, status, or scope filters', {'field': 'runtimeIds'}),
    'prune-missing-disposition-reason': (400, 'disposition_reason_required', 'retained-evidence disposition requires a reason', {}),
    'prune-no-held-evidence-disposition': (409, 'retained_evidence_not_held', 'runtime has no held retained evidence to dispose', 'BUSY'),
}
# Requests that may write, and what: everything else must leave every captured row and event unchanged.
WRITES = {'prune-apply', 'sweep-apply', 'prune-swept', 'sweep-no-matches', 'sweep-wrong-shape'}


def judge(rows, c):
    failures = []
    runtime = c['runtime']
    fail = lambda *what: failures.append(what)
    if [r['case'] for r in rows] != list(EXPECT):
        fail('matrix', [r['case'] for r in rows])
    seen = max((e['hrc_seq'] for e in rows[0]['initial']['events']), default=0) if rows else 0
    for r in rows:
        name, initial, durable = r['case'], r['initial'], r['durable']
        want = EXPECT.get(name)
        body = r['body'] if isinstance(r['body'], dict) else {}
        if want and want[0] == 200:
            got = [(x['runtimeId'][len(runtime):], x['status'], x.get('reason')) for x in body.get('results', [])]
            if r['status'] != 200 or body.get('ok') is not True or got != want[1] or body.get('summary') != want[2]:
                fail(name, 'results', r['status'], got, body.get('summary'))
        elif want:
            detail = {'LIVE': {'manifestCount': 1, 'failureCount': 1, 'failures': [{'runtimeId': runtime, 'scopeRef': c['scope'],
                      'reasons': ['scope_not_allowlisted', 'offline_evidence_held']}]}, 'BUSY': {'runtimeId': runtime + '-gc-busy'}}.get(want[3]) if isinstance(want[3], str) else want[3]
            error = body.get('error', {})
            if (r['status'], error.get('code'), error.get('message'), error.get('detail')) != (want[0], want[1], want[2], detail):
                fail(name, 'refusal', r['status'], error)
        # The live seat survives every request byte for byte.
        if not durable['liveGuard'] or durable['liveGuard'] != initial['liveGuard'] or durable['liveGuard'][0]['transport'] != 'hrcpty':
            fail(name, 'live seat changed')
        if name not in WRITES and initial != durable:
            fail(name, 'wrote', [t for t in durable if durable[t] != initial[t]])
        new = [e for e in durable['events'] if e not in initial['events']]
        for e in new:
            # A new lifecycle row advances both sequence cursors and carries this request's clock.
            if e['hrc_seq'] <= seen or e['stream_seq'] != e['hrc_seq'] or not (r['before'] - .01 <= stamp(e['ts']) <= r['after'] + .01):
                fail(name, 'event cursor/clock', e['hrc_seq'], e['ts'])
            seen = max(seen, e['hrc_seq'])
        ids = lambda table, rows_: {x['runtime_id'] for x in rows_[table]}
        if name == 'prune-apply':
            rt = runtime + '-gc-prune'
            if not all(rt in ids(t, initial) for t in ('runtimes', 'runs', 'runtime_buffers', 'surface_bindings')):
                fail(name, 'satellites present before')
            if any(rt in ids(t, durable) for t in ('runtimes', 'runs', 'runtime_buffers', 'surface_bindings')) or new:
                fail(name, 'cascade removes runtime/run/buffer/surface, appends nothing')
        if name == 'prune-swept':
            if runtime + '-gc-sweep' in ids('runtimes', durable) or new:
                fail(name, 'swept runtime pruned')
        if name == 'sweep-apply':
            target = next((x for x in durable['runtimes'] if x['runtime_id'] == runtime + '-gc-sweep'), None)
            state = json.loads(target['runtime_state_json'] or '{}') if target else {}
            if not target or target['status'] != 'stale' or state.get('updatedAt') != target['updated_at']:
                fail(name, 'aged', target)
            elif [(e['event_kind'], e['runtime_id'], e['host_session_id']) for e in new] != [('runtime.stale', target['runtime_id'], c['host']), ('runtime.sweep_completed', None, c['host'])] \
                    or new[0]['ts'] != target['updated_at']:
                fail(name, 'one stale fact on the mutation clock, then one summary', [(e['event_kind'], e['ts']) for e in new])
            if [s['continuation_reuse_disabled'] for s in durable['sessions'] if s['host_session_id'] == c['host']] != [1]:
                fail(name, 'dropContinuation disables reuse')
        if name in ('sweep-no-matches', 'sweep-wrong-shape'):
            if [(e['event_kind'], e['host_session_id']) for e in new] != [('runtime.sweep_completed', 'hrc-sweep-summary')]:
                fail(name, 'an apply with nothing aged still appends one summary under the system session', new)
            if [t for t in durable if t not in ('events', 'sessions') and durable[t] != initial[t]]:
                fail(name, 'only the summary and its system session change')
    return failures

if __name__ == '__main__':
    isolated_suite(main)(case_factory=cases, judge=judge, seed=seed, observe=observe, paginate=False)
