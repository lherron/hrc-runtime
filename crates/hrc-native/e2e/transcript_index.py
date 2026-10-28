#!/usr/bin/env python3
"""Transcript index differential: follower resume, search, status and rebuild.

Bun indexes phase A of a broker ledger fixture, then phase B lands after its
cursor. Each owner starts from that snapshot and must catch up from the cursor.

Failure modes: route 404; follower never runs (cursor frozen); catch-up
reindexes from zero (the sentinel Bun's row carries disappears); late prose or a
terminal inversion not reindexed; wrong segment bounds, final/mid selection,
block flattening, payload unwrapping or UTF-8 cap; search hits, order, score,
snippet, per-runtime cap or filters differ; validation codes/messages differ;
rebuild does not truncate and regenerate; status shape or counters differ.
"""
import hashlib
import json
import sqlite3
import subprocess
import time
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
    # Bun's own indexer authors the phase-A rows and the cursor native resumes from.
    script = '''
import {openHrcDatabase} from DATABASE;
import {createTranscriptIndexer} from INDEXER;
const db=openHrcDatabase(process.argv[1]);
const indexer=createTranscriptIndexer({db,log(){}},{enabled:true,tickIntervalMs:1000,batchSize:1000});
await indexer.tickOnce();
db.close();
'''.replace('DATABASE', json.dumps(str(release/'packages/hrc-store-sqlite/src/database.ts'))).replace(
        'INDEXER', json.dumps(str(release/'packages/hrc-transcript-index/src/index.ts')))
    subprocess.run(['bun', '-e', script, str(dbpath)], env=env, check=True, capture_output=True)
    with sqlite3.connect(dbpath) as db:
        cursor = db.execute('SELECT last_event_id FROM transcript_index_cursor').fetchone()[0]
        assert cursor == db.execute('SELECT max(id) FROM broker_invocation_events').fetchone()[0], cursor
        # A from-zero reindex would rewrite this Bun-authored row; a resume leaves it.
        db.execute("UPDATE transcript_turns SET final_text=final_text||' '||? WHERE invocation_id='inv-y'", (SENTINEL,))
    insert('b')


def cases(scope, host):
    task = scope.rsplit(':', 1)[1]
    search = lambda name, body: (name, 'POST', '/v1/transcript-search', body)
    return [
        ('status', 'GET', '/v1/transcript-index/status', None),
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
        ('status-post', 'POST', '/v1/transcript-index/status', {}),
        ('rebuild', 'POST', '/v1/transcript-index/rebuild', {}),
        ('status-after-rebuild', 'GET', '/v1/transcript-index/status', None),
        search('sentinel-after-rebuild', {'query': SENTINEL}),
        search('discovery-after-rebuild', {'query': 'kestrel'}),
    ]


def head(db):
    cursor = db.execute('SELECT last_event_id FROM transcript_index_cursor').fetchone()
    return (cursor[0] if cursor else None), db.execute('SELECT max(id) FROM broker_invocation_events').fetchone()[0]


def settle(dbpath, name):
    if name not in (None, 'rebuild'):
        return
    deadline = time.time() + 10
    while time.time() < deadline:
        with sqlite3.connect(f'file:{dbpath}?mode=ro', uri=True) as db:
            cursor, ceiling = head(db)
            stale = name == 'rebuild' and db.execute(
                'SELECT count(*) FROM transcript_turns WHERE final_text LIKE ?', ('%'+SENTINEL+'%',)).fetchone()[0]
        if cursor == ceiling and not stale:
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


if __name__ == '__main__':
    main(prepare=prepare, case_factory=cases, observe=observe, suite='transcript-index', settle=settle)
