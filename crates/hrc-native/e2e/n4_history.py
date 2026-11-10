#!/usr/bin/env python3
"""N4 collective history on two scratch nodes: origin n4a and authority svc, both native.

A's store is seeded with ~100 messages by the native message insert and
execution update (n3_messages: hrc_store::messages statements), across
dm/literal/system kinds, request/response/oneway phases, threads and replies,
empty and multi-byte bodies, with and without metadata. A's first native boot
replicates every row to S; the delivered replications are the baseline.

A then restarts on that store and must leave every delivered replication
exactly as it was, while meeting four planted changes, so "unchanged" cannot
pass by doing nothing: a row whose stored fingerprint was tampered with (it
must be re-enqueued and redelivered with the original fingerprint), a message
whose metadata changed (redelivered, reaching S with the new record), a
message inserted while A was down (backfilled and delivered), and one inserted
while A runs (tailed). Then the read surfaces: A's collective query through S,
the local fallback with S down, A's peer listener refusing history verbs as a
non-authority, and S's own peer verbs (re-replication rewrites nothing,
validation, checkpoints, topological paging). Expectations are read off
federation/history.rs, peer_listener.rs and hrc-store collective_history.rs.
"""
import argparse
import hashlib
import json
from pathlib import Path
import secrets
import shutil
import sqlite3
import time
import urllib.error
import urllib.request

from n4_federation import TAILNET, Node, free_port
from n3_messages import EXEC, EXEC_COLUMNS

SEEDED = 100
# hrc_store::messages insert columns, as n3_messages.seed_messages writes them.
RECORD_FIELDS = ('messageId', 'kind', 'phase', 'from', 'to', 'rootMessageId', 'body', 'bodyFormat', 'metadataJson', 'execution')
COLUMNS = ['message_id', 'created_at', 'kind', 'phase', 'from_kind', 'from_ref', 'to_kind', 'to_ref',
           'reply_to_message_id', 'root_message_id', 'body', 'body_format', *EXEC_COLUMNS, 'metadata_json']


def cols(db, table, schema='main'):
    return [r[1] for r in db.execute(f'PRAGMA {schema}.table_info({table})')]


def seed(a_db, count=SEEDED):
    """COUNT messages by the native insert (n3_messages columns), ten threads, every fifth with execution facts."""
    seats = [f'agent:tabularasa:project:n4-history:task:seat-{k}/lane:main' for k in range(4)]
    with sqlite3.connect(a_db, timeout=30) as db:
        for i in range(count):
            seat = seats[i % 4]
            sender = {'kind': 'entity', 'entity': ('human', 'system')[i % 2]} if i % 3 == 0 else {'kind': 'session', 'sessionRef': seat}
            recipient = {'kind': 'session', 'sessionRef': seats[(i + 1) % 4]} if sender['kind'] == 'entity' else {'kind': 'entity', 'entity': 'human'}
            root = f'msg-n4h-{(i // 10) * 10:03d}'  # threads of ten: the first message roots each
            ref = lambda a: a['entity'] if a['kind'] == 'entity' else a['sessionRef']
            execution = {'state': 'completed', 'mode': 'headless', 'sessionRef': seat, 'hostSessionId': f'hs-n4h-{i % 4}',
                         'generation': 1, 'runtimeId': f'rt-n4h-{i % 4}', 'runId': f'run-n4h-{i}', 'transport': 'hrcpty'} if i % 5 == 0 else {'state': 'not_applicable'}
            metadata = json.dumps({'fixture': 'n4 history', 'i': i, 'tags': ['a', 'b'][: i % 3]}, separators=(',', ':')) if i % 4 else None
            values = [f'msg-n4h-{i:03d}', f'2026-11-10T01:{i // 60:02d}:{i % 60:02d}.000Z', ('dm', 'literal', 'system')[i % 3],
                      ('request', 'response', 'oneway')[i % 3], sender['kind'], ref(sender), recipient['kind'], ref(recipient),
                      f'msg-n4h-{i - 1:03d}' if i % 10 else None, root, '' if i % 17 == 0 else f'history body {i} \u6f22\u5b57\nline two',
                      'text/plain', *[execution.get(k) for k in EXEC], metadata]
            db.execute(f'INSERT INTO messages ({",".join(COLUMNS)}) VALUES ({",".join("?" * len(values))})', values)
    return count


def rows(a_db):
    db = sqlite3.connect(f'file:{a_db}?mode=ro', uri=True)
    out = {r[0]: {'fingerprint': r[1], 'state': r[2], 'totalAttempts': r[3], 'deliveredAt': r[4],
                  'recordJson': r[5], 'lastErrorCode': r[6]}
           for r in db.execute('SELECT message_id, record_fingerprint, state, total_attempts, delivered_at, '
                               'record_json, last_error_code FROM collective_history_replications')}
    db.close()
    return out


def wait_for(what, predicate, timeout=300):
    deadline = time.time() + timeout
    while time.time() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(.25)
    raise AssertionError('timed out waiting for ' + what)


def plant_message(a_db, template_id, new_id, seq_offset):
    """Copy one existing row under a new id and the next message_seq."""
    db = sqlite3.connect(a_db)
    names = cols(db, 'messages')
    row = dict(zip(names, db.execute('SELECT * FROM messages WHERE message_id = ?', (template_id,)).fetchone()))
    seq = db.execute('SELECT MAX(message_seq) FROM messages').fetchone()[0] + seq_offset
    # Far-future createdAt: plants sort after every quiet row in the collective order.
    row.update(message_seq=seq, message_id=new_id, root_message_id=new_id, reply_to_message_id=None,
               created_at=f'2099-01-01T00:00:{seq % 60:02d}.000Z')
    db.execute(f"INSERT INTO messages ({', '.join(names)}) VALUES ({', '.join('?' for _ in names)})",
               [row[n] for n in names])
    db.commit()
    db.close()


def peer_call(endpoint, token, method, path, body=None):
    headers = {'content-type': 'application/json', 'authorization': f'Bearer {token}'}
    data = None if body is None else (body if isinstance(body, bytes) else json.dumps(body).encode())
    req = urllib.request.Request(endpoint + path, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=10) as res:
            status, raw = res.status, res.read()
    except urllib.error.HTTPError as error:
        status, raw = error.code, error.read()
    return {'status': status, 'body': json.loads(raw) if raw else None}


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--binary', type=Path, required=True)
    p.add_argument('--scratch-root', type=Path, required=True)
    p.add_argument('--artifacts', type=Path, required=True)
    p.add_argument('--aspd-socket', type=Path, help='never dialed; defaults to a path under the scratch root')
    p.add_argument('--installed-release', type=Path, help='accepted and ignored')
    args = p.parse_args()
    if args.scratch_root.exists():
        raise SystemExit('scratch root must be fresh')
    args.artifacts.mkdir(parents=True, exist_ok=True)
    aspd = args.aspd_socket or args.scratch_root / 'aspd.sock'
    real = Path.home() / 'praesidium/var/state/hrc/federation.json'
    a = Node(args.scratch_root / 'a', None, aspd, args.artifacts, 'a', args.binary)
    s = Node(args.scratch_root / 's', None, aspd, args.artifacts, 's', args.binary)
    ports = {k: free_port() for k in ('s_peer', 'a_peer')}
    token = secrets.token_hex(24)
    s_endpoint, a_endpoint = f'http://{TAILNET}:{ports["s_peer"]}', f'http://{TAILNET}:{ports["a_peer"]}'
    s.write_config({'nodeId': 'svc', 'peers': {'n4a': {'endpoint': a_endpoint, 'token': token}},
                    'peerListener': {'bind': s_endpoint}, 'gate': {'mode': 'off'}})
    a.write_config({'nodeId': 'n4a', 'peers': {'svc': {'endpoint': s_endpoint, 'token': token}},
                    'peerListener': {'bind': a_endpoint}, 'gate': {'mode': 'off'}})
    seeded = seed(a.db)
    evidence = {'seeded': seeded}
    cases = {}
    failures = []
    try:
        s_proc = s.up('native', args.binary, 'authority')
        proc = a.up('native', args.binary, 'baseline')
        baseline = wait_for('baseline replication', lambda: (
            r if len(r := rows(a.db)) == seeded and all(v['state'] == 'delivered' for v in r.values()) else None))
        a.down(proc)
        # Owner readback of the seed: S's authority query holds every seeded message.
        status, value, _ = s.http('POST', '/v1/messages/query', {'limit': 500})
        assert status == 200 and sorted(m['messageId'] for m in value['messages']) == sorted(baseline), (status, value)
        ids = sorted(baseline, key=lambda i: json.loads(baseline[i]['recordJson'])['messageSeq'])
        quiet = ids[:len(ids) // 2]  # query cases read only this half; plants live in the other
        before = rows(a.db)
        tampered, changed, inserted, live = ids[-1], ids[-2], 'msg-n4-history-down', 'msg-n4-history-live'
        db = sqlite3.connect(a.db)
        db.execute("UPDATE collective_history_replications SET record_fingerprint = 'tampered' WHERE message_id = ?", (tampered,))
        meta = json.loads(db.execute('SELECT metadata_json FROM messages WHERE message_id = ?', (changed,)).fetchone()[0] or '{}')
        meta['n4HistoryProbe'] = 'restart'
        db.execute('UPDATE messages SET metadata_json = ? WHERE message_id = ?', (json.dumps(meta), changed))
        db.commit()
        db.close()
        plant_message(a.db, quiet[0], inserted, 1)
        proc = a.up('native', args.binary, 'restart')
        planted = {tampered, changed, inserted}
        settled = lambda: all((r := rows(a.db)).get(i, {}).get('state') == 'delivered' and r[i]['fingerprint'] != 'tampered'
                              and r[i] != before.get(i) for i in planted)
        wait_for('planted rows delivered', settled, timeout=60)
        plant_message(a.db, quiet[0], live, 1)
        # The tail runs on ledger-commit wakes (history.rs), so a raw insert waits for the next owner
        # write: a session create commits one. Without it the checkpoint renewal is 300 s away.
        woke = a.http('POST', '/v1/sessions/resolve', {'sessionRef': 'agent:tabularasa:project:n4-history:task:wake/lane:main',
                                                       'create': True, 'summonIntent': 'explicit_local'})
        assert woke[0] == 200, woke
        wait_for('live tail', lambda: rows(a.db).get(live, {}).get('state') == 'delivered', 30)
        time.sleep(3)  # three more polls: nothing else may move
        after = rows(a.db)
        moved = sorted(i for i in before if i not in planted and after.get(i) != before[i])
        checks = {
            'untouched': len(moved) == 0,
            'tamperedRestored': after[tampered]['fingerprint'] == baseline[tampered]['fingerprint']
                                and after[tampered]['recordJson'] == baseline[tampered]['recordJson'],
            'changedFingerprint': after[changed]['fingerprint'] == hashlib.sha256(
                after[changed]['recordJson'].encode()).hexdigest() != before[changed]['fingerprint'],
            'changedCarriesProbe': json.loads(after[changed]['recordJson'])['metadataJson'].get('n4HistoryProbe') == 'restart',
            'insertedDelivered': after[inserted]['state'] == 'delivered',
            'liveTailed': after[live]['state'] == 'delivered',
        }
        # S holds the changed record and both inserts, as A delivered them.
        for i in (changed, inserted, live):
            status, value, _ = s.http('POST', '/v1/messages/query', {'messageId': i})
            held_record = value['messages'][0] if status == 200 and len(value.get('messages', [])) == 1 else {}
            sent = json.loads(after[i]['recordJson'])
            evidence.setdefault('authorityDiff', {})[i] = {k: [sent.get(k), held_record.get(k)] for k in set(sent) | set(held_record) if sent.get(k) != held_record.get(k)}
            checks['authorityHolds:' + i] = bool(held_record) and all(held_record.get(k) == sent.get(k) for k in RECORD_FIELDS)
        evidence.update(moved=moved[:20], movedCount=len(moved), checks=checks, planted=sorted(planted | {live}))

        def query(name, body):
            status, value, _ = a.http('POST', '/v1/messages/query', body)
            cases['query:' + name] = {'request': body, 'status': status, 'body': value}

        first = json.loads(baseline[quiet[0]]['recordJson'])
        query('limit', {'limit': 5})
        query('after-seq', {'afterSeq': first['messageSeq'], 'limit': 3})
        query('message', {'messageId': quiet[1]})
        query('thread', {'thread': {'rootMessageId': first['rootMessageId']}, 'limit': 10})
        query('thread-asc', {'thread': {'rootMessageId': first['rootMessageId']}, 'limit': 2})
        query('thread-desc', {'thread': {'rootMessageId': first['rootMessageId']}, 'limit': 2, 'order': 'desc'})
        query('participant', {'participant': first['from'], 'limit': 4, 'kinds': [first['kind']]})
        query('bad-body', [])
        query('bad-filter', {'limit': 'x'})
        for verb, body in (('replicate', {'record': first}), ('checkpoint', {'checkpoint': {
                'maxMessageSeq': 1, 'pendingReplicationCount': 0}}), ('query', {'filter': {}})):
            cases['a-peer:' + verb] = peer_call(a_endpoint, token, 'POST', '/v1/federation/history/' + verb, body)
        cases['a-peer:bad-body'] = peer_call(a_endpoint, token, 'POST', '/v1/federation/history/query', {'x': 1})
        # S down: the collective read falls back to A's local rows.
        s.down(s_proc)
        query('unreachable', {'limit': 3})
        s_proc = s.up('native', args.binary, 'authority-after')
        a.down(proc)
        sample = json.loads(baseline[quiet[2]]['recordJson'])
        # A reply stamped before its parent: the topological pass must move it
        # after the parent, so a one-row page has to widen its window.
        parent = {k: v for k, v in sample.items() if k != 'replyToMessageId'}
        parent.update(messageId='msg-n4-skew-parent', rootMessageId='msg-n4-skew-parent',
                      createdAt='2099-02-01T00:00:02.000Z', messageSeq=900001)
        child = {**parent, 'messageId': 'msg-n4-skew-child', 'replyToMessageId': 'msg-n4-skew-parent',
                 'createdAt': '2099-02-01T00:00:01.000Z', 'messageSeq': 900002}
        skew = {'thread': {'rootMessageId': 'msg-n4-skew-parent'}}
        held = snapshot_authority(s.db)
        verbs = [
            ('replicate-again', 'replicate', {'record': sample}),
            ('replicate-extra-key', 'replicate', {'record': sample, 'x': 1}),
            ('replicate-not-object', 'replicate', {'record': []}),
            ('replicate-bad-seq', 'replicate', {'record': {**sample, 'messageSeq': 0}}),
            ('replicate-bad-address', 'replicate', {'record': {**sample, 'from': {'kind': 'entity', 'entity': 'x'}}}),
            ('replicate-bad-meta', 'replicate', {'record': {**sample, 'metadataJson': 'x'}}),
            ('checkpoint-pending', 'checkpoint', {'checkpoint': {'maxMessageSeq': 5, 'pendingReplicationCount': 2}}),
            ('query-lagging', 'query', {'filter': {'messageId': quiet[2]}}),
            ('checkpoint-bad', 'checkpoint', {'checkpoint': {'maxMessageSeq': -1, 'pendingReplicationCount': 0}}),
            ('checkpoint-clear', 'checkpoint', {'checkpoint': {'maxMessageSeq': 5, 'pendingReplicationCount': 0}}),
            ('replicate-skew-child', 'replicate', {'record': child}),
            ('replicate-skew-parent', 'replicate', {'record': parent}),
            ('query-skew', 'query', {'filter': skew}),
            ('query-skew-asc-1', 'query', {'filter': {**skew, 'limit': 1}}),
            ('query-skew-desc-1', 'query', {'filter': {**skew, 'limit': 1, 'order': 'desc'}}),
            ('query-complete', 'query', {'filter': {'messageId': quiet[2]}}),
            ('query-desc', 'query', {'filter': {'limit': 3, 'order': 'desc', 'afterSeq': 0,
                                                'thread': {'rootMessageId': sample['rootMessageId']}}}),
            ('query-bad-filter', 'query', {'filter': {'limit': 'x'}}),
        ]
        for name, verb, body in verbs:
            cases['s-peer:' + name] = peer_call(s_endpoint, token, 'POST', '/v1/federation/history/' + verb, body)
            if name == 'replicate-again':
                evidence['reReplicateRewrote'] = diff_authority(held, snapshot_authority(s.db))
                evidence['reReplicateRows'] = changed_rows(held, snapshot_authority(s.db))
        status, value, _ = s.http('POST', '/v1/messages/query', {'messageId': quiet[2]})
        cases['s-local:message'] = {'status': status, 'body': value}
        failures = [k for k, v in checks.items() if not v] + judge(cases, after, quiet, sample, evidence)
        print(json.dumps({'seeded': seeded, 'checks': checks, 'cases': len(cases), 'failures': failures}))
    finally:
        (args.artifacts / 'history.json').write_text(json.dumps(cases, indent=1) + '\n')
        (args.artifacts / 'evidence.json').write_text(json.dumps(evidence, indent=1) + '\n')
        (args.artifacts / 'steps.json').write_text(json.dumps({'a': a.steps, 's': s.steps}, indent=1) + '\n')
        a.cleanup()
        s.cleanup()
        assert str(real) not in json.dumps(a.env) + json.dumps(s.env)
        shutil.rmtree(args.scratch_root)
    if failures:
        raise SystemExit('FAIL ' + json.dumps(failures))


# Every collective column but the updated_at clocks, which an accepted re-replication refreshes.
AUTHORITY_COLUMNS = {
    'collective_history_messages': 'message_id, collective_seq, canonical_record_json, canonical_source_node_id, '
                                   'canonical_source_role, canonical_created_at, created_at',
    'collective_history_observations': 'message_id, source_node_id, source_message_seq, source_role, origin_node_id, '
                                       'accepted_destination_node_id, record_json, observed_at',
}


def snapshot_authority(db_path):
    """S's held collective rows, keyed, without the refresh clocks."""
    with sqlite3.connect(f'file:{db_path}?mode=ro', uri=True) as db:
        return {t: sorted(map(tuple, db.execute(f'SELECT {c} FROM {t}'))) for t, c in AUTHORITY_COLUMNS.items()}


def diff_authority(before, after):
    return {t: len(set(before[t]) ^ set(after[t])) for t in before}


def changed_rows(before, after):
    return {t: [list(r) for r in sorted(set(before[t]) ^ set(after[t]))] for t in before}


def judge(cases, baseline, quiet, sample, evidence):
    """Each read case's own literal, from federation/history.rs, peer_listener.rs and collective_history.rs."""
    failures = []
    ids = [f'msg-n4h-{i:03d}' for i in range(SEEDED)]
    collective = lambda queried, complete=True: {'source': 'collective', 'complete': complete, 'authorityNodeId': 'svc',
                                                  'queriedNodeId': queried, 'cursorKind': 'collective', 'pendingReplicationCount': 0}
    peer_refusal = lambda status, code, retryable=None: (status, {'ok': False, 'error': {'code': code, **({'retryable': True} if retryable else {})}})
    A, S = 'n4a', 'svc'
    expect = {
        'query:limit': (ids[:5], collective(A)), 'query:after-seq': (ids[1:4], collective(A)),
        'query:message': ([quiet[1]], collective(A)), 'query:thread': (ids[:10], collective(A)),
        'query:thread-asc': (ids[:2], collective(A)), 'query:thread-desc': ([ids[9], ids[8]], collective(A)),
        # every sixth seed is a human dm to the same seat: kind and participant both select it
        'query:participant': ([ids[i] for i in (0, 6, 12, 18)], collective(A)),
        # a non-object body reads as no filter: everything, the 2099 plants last
        'query:bad-body': (ids + ['msg-n4-history-down', 'msg-n4-history-live'], collective(A)),
        's-peer:query-lagging': ([quiet[2]], 'LAGGING'), 's-peer:query-complete': ([quiet[2]], collective(S)),
        # the reply stamped first still follows its parent; a one-row page keyed by stored order is the parent either way
        's-peer:query-skew': (['msg-n4-skew-parent', 'msg-n4-skew-child'], collective(S)),
        's-peer:query-skew-asc-1': (['msg-n4-skew-parent'], collective(S)), 's-peer:query-skew-desc-1': (['msg-n4-skew-parent'], collective(S)),
        's-peer:query-desc': ([ids[9], ids[8], ids[7]], collective(S)), 's-local:message': ([quiet[2]], collective(S)),
        'query:unreachable': (ids[:3], 'LOCAL'),
    }
    for name, (want, history) in expect.items():
        case = cases.get(name, {})
        body = case.get('body') or {}
        got = body.get('messages')
        got_ids = [m['messageId'] for m in got] if isinstance(got, list) else None
        h = body.get('history') or {}
        if history == 'LAGGING':
            ok = h.get('complete') is False and h.get('unconfirmedNodeIds') == [A] and h.get('degraded', {}).get('code')
        elif history == 'LOCAL':
            ok = (h.get('source'), h.get('complete'), h.get('cursorKind'), h.get('degraded', {}).get('code')) == ('local', False, 'node-local', 'collective_unreachable')
        else:
            ok = h == history
        if case.get('status') != 200 or got_ids != want or not ok:
            failures.append((name, case.get('status'), got_ids, h))
            continue
        for m in got:
            if m['messageId'] in baseline and name != 'query:unreachable':
                sent = json.loads(baseline[m['messageId']]['recordJson'])
                if any(m.get(k) != sent.get(k) for k in RECORD_FIELDS):
                    failures.append((name, 'record differs from what A delivered', m['messageId']))
    refusals = {
        'query:bad-filter': (400, {'error': {'code': 'malformed_request', 'message': 'limit must be a positive integer', 'detail': {'field': 'limit'}}}),
        # A is not the authority: every history verb is refused, retryable; a malformed body fails first.
        **{f'a-peer:{v}': peer_refusal(404, 'collective_history_not_authoritative', True) for v in ('replicate', 'checkpoint', 'query')},
        'a-peer:bad-body': peer_refusal(400, 'invalid_request'),
        's-peer:replicate-extra-key': peer_refusal(400, 'invalid_request'), 's-peer:replicate-not-object': peer_refusal(400, 'invalid_request'),
        # A record or filter the store rejects is the generic retryable 500 (peer_listener.rs).
        **{f's-peer:{v}': peer_refusal(500, 'internal_error', True) for v in ('replicate-bad-seq', 'replicate-bad-address', 'replicate-bad-meta', 'checkpoint-bad', 'query-bad-filter')},
        's-peer:replicate-again': (200, {'ok': True, 'ack': {'outcome': 'accepted', 'messageId': sample['messageId']}}),
        's-peer:replicate-skew-child': (200, {'ok': True, 'ack': {'outcome': 'accepted', 'messageId': 'msg-n4-skew-child'}}),
        's-peer:replicate-skew-parent': (200, {'ok': True, 'ack': {'outcome': 'accepted', 'messageId': 'msg-n4-skew-parent'}}),
        's-peer:checkpoint-pending': (200, {'ok': True, 'ack': {'outcome': 'accepted', 'nodeId': A}}),
        's-peer:checkpoint-clear': (200, {'ok': True, 'ack': {'outcome': 'accepted', 'nodeId': A}}),
    }
    for name, (status, body) in refusals.items():
        case = cases.get(name, {})
        if (case.get('status'), case.get('body')) != (status, body):
            failures.append((name, case.get('status'), case.get('body')))
    if set(cases) != set(expect) | set(refusals):
        failures.append(('matrix', sorted(set(cases) ^ (set(expect) | set(refusals)))))
    # Re-replicating a record the authority already holds rewrites nothing.
    if evidence.get('reReplicateRewrote') != {'collective_history_messages': 0, 'collective_history_observations': 0}:
        failures.append(('replicate-again rewrote', evidence.get('reReplicateRewrote')))
    return failures

if __name__ == '__main__':
    main()
