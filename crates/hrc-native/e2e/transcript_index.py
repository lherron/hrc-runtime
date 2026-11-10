#!/usr/bin/env python3
"""Transcript index on native owners: follower resume, repairs, and HTTP search.

A native owner boots on phase A of a broker ledger fixture and its follower
indexes it; then phase B lands after that cursor and a second boot must catch up
from it. The CLI golden (crates/hrc-cli/e2e/transcript_search.py) covers query
construction and rendering and hrc-store tests/transcript_search.rs the store
search; this driver keeps what neither does: HTTP body/query/limit validation
and the follower's resume, late-prose and terminal-inversion cursor behavior.

Failure modes: route 404; follower never runs (cursor frozen); catch-up
reindexes from zero (the sentinel planted in a phase-A row disappears); late
prose or a terminal inversion not reindexed; wrong segment bounds, final/mid
selection, block flattening, payload unwrapping or UTF-8 cap; per-runtime cap,
runtime-group limit or filters ignored; validation messages wrong; stats wrong.
Every hit is judged against SEGMENTS, written from projection/transcript.rs
(`document`, `process_invocation`, `cap`) and hrc-store transcript_index.rs.
"""
import argparse
import hashlib
import json
from pathlib import Path
import signal
import sqlite3
import subprocess
import time
from foundation import daemon_env
from routes import main

SENTINEL = 'resumesentinel'
T0 = 1793095200  # 2026-10-27T10:00:00Z


def stamp(offset):
    return time.strftime('%Y-%m-%dT%H:%M:%S', time.gmtime(T0 + offset)) + '.000Z'


def fixture(scope):
    """(phase, invocation, runtime, seq, type, broker_event_json)."""
    big = 'a ' * 131070 + 'b' + '\U0001F600' + ' albatross tail'
    j = json.dumps
    a = [
        ('inv-a1', 'rt-a', 10, 'turn.started', {}),
        ('inv-a1', 'rt-a', 20, 'user.message', {'content': 'deploy the kestrel pipeline today'}),
        ('inv-a1', 'rt-a', 30, 'assistant.message.completed', {'content': 'checking kestrel config first', 'final': False}),
        ('inv-a1', 'rt-a', 40, 'assistant.message.completed', {'content': [
            {'type': 'text', 'text': 'kestrel pipeline deployed'}, {'type': 'tool_use', 'id': 'x'},
            {'type': 'text', 'text': 'all green'}], 'final': True}),
        ('inv-a1', 'rt-a', 50, 'turn.completed', {}),
        ('inv-a1', 'rt-a', 60, 'input.accepted', {}),
        ('inv-a1', 'rt-a', 70, 'user.message', {'payload': {'content': 'second question about falcon migration'}}),
        ('inv-a1', 'rt-a', 80, 'assistant.message.completed', {'content': 'falcon done'}),
        ('inv-a1', 'rt-a', 90, 'assistant.message.completed', {'content': 'falcon migration finished cleanly'}),
        ('inv-a1', 'rt-a', 95, 'tool.call.started', {'toolCallId': 't1'}),
        ('inv-a1', 'rt-a', 100, 'turn.completed', {}),
        ('inv-a2', 'rt-a', 10, 'turn.started', {}),
        ('inv-a2', 'rt-a', 20, 'user.message', {'content': 'plover survey'}),
        ('inv-a2', 'rt-a', 30, 'assistant.message.completed', {'content': 'plover counted', 'final': True}),
        ('inv-a2', 'rt-a', 40, 'turn.completed', {}),
        ('inv-y', 'rt-c', 10, 'user.message', {'content': 'osprey nesting report'}),
        ('inv-y', 'rt-c', 20, 'assistant.message.completed', {'content': 'osprey nests: four', 'final': True}),
        ('inv-y', 'rt-c', 30, 'assistant.message.completed', {'content': 'trailing osprey aside', 'final': False}),
        ('inv-y', 'rt-c', 40, 'turn.completed', {}),
    ]
    b = [
        ('inv-a1', 'rt-a', 35, 'assistant.message.completed', {'content': 'late heron sighting near kestrel'}),
        ('inv-a2', 'rt-a', 25, 'turn.interrupted', {}),
        ('inv-b1', 'rt-b', 10, 'turn.started', {}),
        ('inv-b1', 'rt-b', 20, 'user.message', {'content': [{'type': 'text', 'text': 'kestrel rollback please'}]}),
        ('inv-b1', 'rt-b', 30, 'assistant.message.completed', {'content': 'rolled back kestrel', 'final': True}),
        ('inv-b1', 'rt-b', 40, 'turn.failed', {}),
        ('inv-b1', 'rt-b', 50, 'user.message', '{not json'),
        ('inv-b1', 'rt-b', 60, 'turn.interrupted', {}),
        ('inv-b1', 'rt-b', 70, 'turn.started', {}),
        ('inv-b1', 'rt-b', 80, 'turn.completed', {}),
        ('inv-b1', 'rt-b', 90, 'user.message', {'content': big}),
        ('inv-b1', 'rt-b', 100, 'assistant.message.completed', {'content': 'albatross acknowledged', 'final': True}),
        ('inv-b1', 'rt-b', 110, 'turn.completed', {}),
        ('inv-orphan', 'rt-gone', 10, 'user.message', {'content': 'kestrel orphan question'}),
        ('inv-orphan', 'rt-gone', 20, 'assistant.message.completed', {'content': 'orphan kestrel answer'}),
        ('inv-orphan', 'rt-gone', 30, 'turn.completed', {}),
        ('inv-open', 'rt-a', 10, 'user.message', {'content': 'unfinished swallow'}),
    ]
    # Six distinct-length kestrel turns in one runtime exercise the per-runtime cap.
    for i in range(6):
        b += [('inv-k', 'rt-b', 30*i+10, 'user.message', {'content': 'kestrel batch item' + ' filler'*i}),
              ('inv-k', 'rt-b', 30*i+20, 'assistant.message.completed', {'content': f'noted kestrel {i}', 'final': True}),
              ('inv-k', 'rt-b', 30*i+30, 'turn.completed', {})]
    b.append(('inv-k', 'rt-b', 999, 'tool.call.started', {'toolCallId': 'tail'}))
    rows = []
    for phase, events in (('a', a), ('b', b)):
        for inv, rt, seq, ty, payload in events:
            rows.append((phase, inv, rt, seq, ty, payload if isinstance(payload, str) else j(payload)))
    return rows


def index_phase_a(dbpath, env):
    """One native owner boots on the phase-A ledger and its follower indexes it; stop at the head."""
    binary = argparse.ArgumentParser(add_help=False)
    binary.add_argument('--binary', type=Path, required=True)
    binary = binary.parse_known_args()[0].binary.resolve()
    root = Path(env['HRC_STATE_DIR']).parent
    log = (root/'phase-a.log').open('w')
    # Third argument False: the daemon PATH gains no JS runtime directory.
    owner = subprocess.Popen([str(binary), 'server', 'serve'], env=daemon_env(env, (), False), cwd=root, stdout=log, stderr=log)
    try:
        deadline = time.time() + 30
        while time.time() < deadline:
            assert owner.poll() is None, 'phase-A owner exited'
            with sqlite3.connect(f'file:{dbpath}?mode=ro', uri=True) as db:
                cursor, ceiling = head(db)
            if cursor == ceiling:
                break
            time.sleep(.05)
        else:
            raise AssertionError(('phase-A follower never reached the head', cursor, ceiling))
    finally:
        owner.send_signal(signal.SIGTERM)
        owner.wait(timeout=20)
        log.close()


def prepare(release, dbpath, scope, host, env):
    with sqlite3.connect(dbpath) as db:
        lane = db.execute('SELECT lane_ref FROM sessions WHERE host_session_id=?', (host,)).fetchone()[0]
        for rt, scope_ref, generation in (('rt-a', scope, 1), ('rt-b', scope, 2),
                                          ('rt-c', 'agent:outsider:project:n1-elsewhere', 1)):
            db.execute("""INSERT INTO runtimes (runtime_id,host_session_id,scope_ref,lane_ref,generation,
                transport,harness,provider,status,supports_inflight_input,created_at,updated_at)
                VALUES (?,?,?,?,?,'tmux','claude-code','anthropic','terminated',0,?,?)""",
                       (rt, host, scope_ref, lane, generation, stamp(0), stamp(0)))
    rows = fixture(scope)

    def insert(phase):
        with sqlite3.connect(dbpath) as db:
            for index, (p, inv, rt, seq, ty, payload) in enumerate(rows):
                if p == phase:
                    db.execute("""INSERT INTO broker_invocation_events (invocation_id,seq,time,type,runtime_id,
                        broker_event_json,created_at) VALUES (?,?,?,?,?,?,?)""",
                               (inv, seq, stamp(index), ty, rt, payload, stamp(index)))
    insert('a')
    # The native follower authors the phase-A rows and the cursor the next boot resumes from.
    index_phase_a(dbpath, env)
    with sqlite3.connect(dbpath) as db:
        cursor, ceiling = head(db)
        assert cursor == ceiling == 19, (cursor, ceiling)
        assert db.execute('SELECT count(*) FROM transcript_turns').fetchone()[0] == 4  # inv-a1 x2, inv-a2, inv-y
        # A from-zero reindex would rewrite this phase-A row; a resume leaves it.
        db.execute("UPDATE transcript_turns SET final_text=final_text||' '||? WHERE invocation_id='inv-y'", (SENTINEL,))
    insert('b')


def cases(scope, host):
    task = scope.rsplit(':', 1)[1]
    search = lambda name, body: (name, 'POST', '/v1/transcript-search', body)
    return [
        search('discovery', {'query': 'kestrel'}),
        search('discovery-limit', {'query': 'kestrel', 'limit': 2}),
        search('discovery-candidates', {'query': 'kestrel', 'candidateLimit': 3}),
        search('within-runtime', {'query': 'kestrel', 'runtimeId': 'rt-b'}),
        search('within-invocation', {'query': 'kestrel', 'invocationId': 'inv-a1', 'limit': 1}),
        search('phrase', {'query': '"kestrel pipeline"'}),
        search('filters', {'query': 'kestrel', 'agent': 'tabularasa', 'project': 'n1-t11818', 'task': task,
                           'scopeRef': scope, 'since': stamp(0), 'until': '2026-10-28T00:00:00.000Z'}),
        search('blank-filters', {'query': 'osprey', 'agent': '', 'project': None}),
        search('resume-sentinel', {'query': SENTINEL}),
        search('late-prose', {'query': 'heron'}),
        search('inversion', {'query': 'plover', 'runtimeId': 'rt-a'}),
        search('truncated', {'query': 'albatross', 'runtimeId': 'rt-b'}),
        search('no-match', {'query': 'zzzqqq'}),
        search('missing-query', {}),
        search('query-not-string', {'query': 17}),
        search('blank-query', {'query': '   '}),
        search('unmatched-quote', {'query': '"kestrel'}),
        search('empty-phrase', {'query': '"" kestrel'}),
        search('adjacent-phrase', {'query': '"kestrel"x'}),
        search('inner-quote', {'query': 'kes"trel'}),
        search('limit-zero', {'query': 'kestrel', 'limit': 0}),
        search('limit-fraction', {'query': 'kestrel', 'limit': 1.5}),
        search('limit-string', {'query': 'kestrel', 'limit': '5'}),
        search('candidates-zero', {'query': 'kestrel', 'candidateLimit': 0}),
        search('filter-not-string', {'query': 'kestrel', 'agent': 5}),
        search('body-array', []),
        search('body-absent', None),
    ]


def head(db):
    cursor = db.execute('SELECT last_event_id FROM transcript_index_cursor').fetchone()
    return (cursor[0] if cursor else None), db.execute('SELECT max(id) FROM broker_invocation_events').fetchone()[0]


def settle(dbpath, name):
    if name is not None:
        return
    deadline = time.time() + 10
    while time.time() < deadline:
        with sqlite3.connect(f'file:{dbpath}?mode=ro', uri=True) as db:
            cursor, ceiling = head(db)
        if cursor == ceiling:
            return
        time.sleep(.05)
    # An owner that never indexes falls through; the comparison records it.


def digest(text):
    return {'bytes': len(text.encode()), 'md5': hashlib.md5(text.encode()).hexdigest()}


def observe(dbpath):
    with sqlite3.connect(f'file:{dbpath}?mode=ro', uri=True) as db:
        db.row_factory = sqlite3.Row
        turns = []
        for row in db.execute('SELECT * FROM transcript_turns ORDER BY turn_rowid'):
            row = dict(row)
            for key in ('user_text', 'final_text', 'mid_text'):
                row[key] = digest(row[key])
            turns.append(row)
        cursor, ceiling = head(db)
        return {'turns': turns, 'cursor': cursor, 'ceiling': ceiling,
                'marks': [dict(r) for r in db.execute(
                    'SELECT invocation_id,runtime_id,last_terminal_seq FROM transcript_index_invocations ORDER BY invocation_id')]}


# (invocation, seqFrom) -> (runtime, seqTo, terminalStatus, messageCount, truncated, userText, finalText, midText).
# Segments run from the previous terminal (exclusive) to the next; the final text
# is the last explicitly final assistant message, else the last; the rest is mid.
BIG = 'a ' * 131070 + 'b' + '\ufffd'  # 256 KiB cut inside the emoji: lossy, then fits
SEGMENTS = {
    ('inv-a1', 10): ('rt-a', 50, 'completed', 3, False, 'deploy the kestrel pipeline today', 'kestrel pipeline deployed\nall green',
                     'checking kestrel config first\n\nlate heron sighting near kestrel'),
    ('inv-a1', 60): ('rt-a', 100, 'completed', 2, False, 'second question about falcon migration', 'falcon migration finished cleanly', 'falcon done'),
    ('inv-a2', 10): ('rt-a', 25, 'interrupted', 0, False, 'plover survey', '', ''),
    ('inv-a2', 30): ('rt-a', 40, 'completed', 1, False, '', 'plover counted', ''),
    ('inv-y', 10): ('rt-c', 40, 'completed', 2, False, 'osprey nesting report', 'osprey nests: four ' + SENTINEL, 'trailing osprey aside'),
    ('inv-b1', 10): ('rt-b', 40, 'failed', 1, False, 'kestrel rollback please', 'rolled back kestrel', ''),
    ('inv-b1', 50): ('rt-b', 60, 'interrupted', 0, False, '', '', ''),
    ('inv-b1', 70): ('rt-b', 80, 'completed', 0, False, '', '', ''),
    ('inv-b1', 90): ('rt-b', 110, 'completed', 1, True, BIG, 'albatross acknowledged', ''),
    ('inv-orphan', 10): ('rt-gone', 30, 'completed', 1, False, 'kestrel orphan question', 'orphan kestrel answer', ''),
    **{('inv-k', 30*i+10): ('rt-b', 30*i+30, 'completed', 1, False, 'kestrel batch item' + ' filler'*i, f'noted kestrel {i}', '') for i in range(6)},
}
KESTREL = sorted(k for k, v in SEGMENTS.items() if 'kestrel' in ' '.join(v[5:]))
ERRORS = {
    'missing-query': 'query is required', 'query-not-string': 'query must be a string',
    'blank-query': 'unparseable query: unparseable query: query must not be empty',
    'unmatched-quote': 'unparseable query: unparseable query: unmatched double quote',
    'empty-phrase': 'unparseable query: unparseable query: empty phrase',
    'adjacent-phrase': 'unparseable query: unparseable query: quoted phrases must be whitespace-separated',
    'inner-quote': 'unparseable query: unparseable query: unmatched double quote',
    'limit-zero': 'limit must be a positive integer', 'limit-fraction': 'limit must be a positive integer',
    'limit-string': 'limit must be a positive integer', 'candidates-zero': 'candidateLimit must be a positive integer',
    'filter-not-string': 'agent must be a string', 'body-array': 'request body must be an object',
    'body-absent': 'request body must be an object',
}


def compare(results):
    rows = results['native']
    by = {r['case']: r for r in rows}
    scope = next(r['request']['scopeRef'] for r in rows if r['case'] == 'filters')
    task = scope.rsplit(':', 1)[1]
    times = {(inv, seq): stamp(i) for i, (_, inv, _, seq, _, _) in enumerate(fixture(scope))}
    failures = []
    fail = lambda *what: failures.append(what)
    names = [r['case'] for r in rows]
    if len(names) != 27 or len(set(names)) != 27:
        fail('matrix', names)
    # Two phase-A repairs and nothing else: the late prose (inv-a1) and the inversion (inv-a2).
    want_stats = {'turnsIndexed': len(SEGMENTS), 'lastEventId': 55, 'ledgerMaxEventId': 55, 'lagEvents': 0, 'invocationsReindexed': 2}
    marks = [{'invocation_id': i, 'runtime_id': r, 'last_terminal_seq': s} for i, r, s in
             [('inv-a1', 'rt-a', 100), ('inv-a2', 'rt-a', 40), ('inv-b1', 'rt-b', 110), ('inv-k', 'rt-b', 180), ('inv-orphan', 'rt-gone', 30), ('inv-y', 'rt-c', 40)]]
    for r in rows:
        if r['cursor'] != 55 or r['ceiling'] != 55 or len(r['turns']) != len(SEGMENTS) or r['marks'] != marks or r['metadataEvents']:
            fail(r['case'], 'index state', r['cursor'], r['ceiling'], len(r['turns']), r['marks'])

    def hits(name, mode):
        response = by[name]['response']
        body = response['body'] if isinstance(response['body'], dict) else {}
        if response['status'] != 200 or list(body) != ['mode', 'hits', 'index'] or body['mode'] != mode or body['index'] != want_stats:
            fail(name, 'envelope', response['status'], {k: v for k, v in body.items() if k != 'hits'})
            return []
        for h in body['hits']:
            key = (h['invocationId'], h['seqFrom'])
            if key not in SEGMENTS:
                fail(name, 'unknown segment', key); continue
            rt, to, status, count, cut, user, final, mid = SEGMENTS[key]
            facets = {'rt-a': (1, True), 'rt-b': (2, True), 'rt-c': (1, False), 'rt-gone': (None, False)}[rt]
            want = {'invocationId': key[0], 'runtimeId': rt, 'seqFrom': key[1], 'seqTo': to, 'startedAt': times[key], 'completedAt': times[(key[0], to)],
                    'terminalStatus': status, 'messageCount': count, 'truncated': cut, 'userText': user, 'finalText': final, 'midText': mid}
            if facets[1]:
                want.update(agent='tabularasa', project='n1-t11818', task=task, scopeRef=scope)
            elif rt == 'rt-c':
                want['scopeRef'] = 'agent:outsider:project:n1-elsewhere'
            if facets[0] is not None:
                want['generation'] = facets[0]
            # The scope's distinct generations among indexed turns: rt-a and rt-b give two.
            want['scopeGenerationCount'] = {'rt-a': 2, 'rt-b': 2, 'rt-c': 1, 'rt-gone': 0}[rt]
            got = {k: v for k, v in h.items() if k not in ('turnRowid', 'score', 'snippet')}
            if got != want:
                fail(name, 'hit', key, {k: (got.get(k), want.get(k)) for k in set(got) | set(want) if got.get(k) != want.get(k)})
            if not isinstance(h['score'], (int, float)) or h['score'] <= 0 or '[' not in h['snippet']:
                fail(name, 'score/snippet', key, h['score'], h['snippet'][:80])
        return body['hits']

    keys = lambda hs: sorted((h['invocationId'], h['seqFrom']) for h in hs)
    descending = lambda hs: all(a['score'] >= b['score'] for a, b in zip(hs, hs[1:]))
    # Discovery: at most five turns per runtime, runtimes ordered by their best score, hits by score inside each.
    found = hits('discovery', 'discovery')
    per = {}
    for h in found:
        per.setdefault(h['runtimeId'], []).append(h)
    if sorted(per) != ['rt-a', 'rt-b', 'rt-gone'] or len(per['rt-b']) != 5 or len(found) != 7 or not all(descending(v) for v in per.values()):
        fail('discovery', 'per-runtime cap', keys(found))
    groups = list(dict.fromkeys(h['runtimeId'] for h in found))
    if [h['runtimeId'] for h in found] != [g for g in groups for _ in per[g]] or not descending([per[g][0] for g in groups]):
        fail('discovery', 'runtime grouping', [h['runtimeId'] for h in found])
    if not set(keys(found)) <= set(KESTREL):
        fail('discovery', 'non-kestrel hit', keys(found))
    # limit counts runtime groups, not hits.
    limited = hits('discovery-limit', 'discovery')
    if [h['runtimeId'] for h in limited] != [h['runtimeId'] for h in found if h['runtimeId'] in groups[:2]]:
        fail('discovery-limit', 'two runtime groups', [h['runtimeId'] for h in limited])
    # candidateLimit bounds the scored rows before grouping.
    if len(hits('discovery-candidates', 'discovery')) != 3:
        fail('discovery-candidates', 'three candidates')
    # Within a runtime or invocation: no cap, seqFrom order.
    within = hits('within-runtime', 'within_runtime')
    if keys(within) != [k for k in KESTREL if SEGMENTS[k][0] == 'rt-b'] or [h['seqFrom'] for h in within] != sorted(h['seqFrom'] for h in within):
        fail('within-runtime', 'all seven rt-b turns by seqFrom', [(h['invocationId'], h['seqFrom']) for h in within])
    if keys(hits('within-invocation', 'within_runtime')) != [('inv-a1', 10)]:
        fail('within-invocation', 'one inv-a1 turn')
    if keys(hits('phrase', 'discovery')) != [('inv-a1', 10)]:
        fail('phrase', 'phrase only in inv-a1')
    filtered = hits('filters', 'discovery')
    if sorted(set(h['runtimeId'] for h in filtered)) != ['rt-a', 'rt-b'] or len(filtered) != 6:
        fail('filters', 'scope filters drop rt-gone', keys(filtered))
    if keys(hits('blank-filters', 'discovery')) != [('inv-y', 10)]:
        fail('blank-filters', 'blank filters are absent')
    if keys(hits('resume-sentinel', 'discovery')) != [('inv-y', 10)]:
        fail('resume-sentinel', 'phase-A row survived the resume')
    if keys(hits('late-prose', 'discovery')) != [('inv-a1', 10)]:
        fail('late-prose', 'late heron reindexed into inv-a1')
    if [(h['seqFrom'], h['seqTo']) for h in hits('inversion', 'within_runtime')] != [(10, 25), (30, 40)]:
        fail('inversion', 'inv-a2 split at the inverted terminal')
    if keys(hits('truncated', 'within_runtime')) != [('inv-b1', 90)]:
        fail('truncated', 'albatross turn')
    if hits('no-match', 'discovery') != []:
        fail('no-match', 'hits')
    for name, message in ERRORS.items():
        response = by[name]['response']
        error = response['body'].get('error', {}) if isinstance(response['body'], dict) else {}
        if response['status'] != 400 or error.get('message') != message or error.get('detail') != {}:
            fail(name, 'refusal', response)
    assert not failures, failures


if __name__ == '__main__':
    main(prepare=prepare, case_factory=cases, observe=observe, suite='transcript-index', settle=settle, compare=compare)
