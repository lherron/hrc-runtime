#!/usr/bin/env python3
"""N4 collective history on two scratch nodes: origin n4a and authority svc.

A's store is seeded with real message rows (a sample of a VACUUM INTO copy of
a live store, so record shapes, metadata and bodies are production ones).
A Bun owner on A replicates them to S. Then each A owner (bun, then native)
boots on that same store and must leave every delivered replication exactly
as it was: same fingerprint, state, attempt count and delivery time. A
fingerprint that differed from Bun's would re-enqueue every row on the first
native boot, which is the failure this gate exists for.

So that "unchanged" cannot pass by doing nothing, each owner's boot also meets
three planted changes: a row whose stored fingerprint was tampered with (it
must be re-enqueued and redelivered with the original fingerprint), a message
whose metadata changed (it must be redelivered and reach S with the new
record), and a message inserted while the owner was down (it must be
backfilled and delivered). Native alone also tails a message inserted while
it runs.

Recorded per A owner for the compare: A's /v1/messages/query (collective,
through S, and the unreachable fallback with S down), A's peer listener
refusing history verbs as a non-authority, and S's own peer verbs and
authority query. Run once per S owner (--s-owner bun|native).
"""
import argparse
import hashlib
import json
from pathlib import Path
import secrets
import sqlite3
import time
import urllib.error
import urllib.request

from n4_federation import TAILNET, Node, free_port

SAMPLE_EVERY = 25


def cols(db, table, schema='main'):
    return [r[1] for r in db.execute(f'PRAGMA {schema}.table_info({table})')]


def seed(a_db, source):
    """Every metadata-bearing row plus every SAMPLE_EVERY-th other row."""
    db = sqlite3.connect(a_db)
    db.execute('ATTACH ? AS src', (str(source),))
    names = [c for c in cols(db, 'messages') if c in cols(db, 'messages', 'src')]
    columns = ', '.join(names)
    db.execute(f"INSERT INTO messages ({columns}) SELECT {columns} FROM src.messages "
               f"WHERE (metadata_json IS NOT NULL AND metadata_json != '') OR message_seq % {SAMPLE_EVERY} = 0 "
               "ORDER BY message_seq")
    db.commit()
    count = db.execute('SELECT COUNT(*) FROM messages').fetchone()[0]
    db.close()
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
    p.add_argument('--installed-release', type=Path, required=True)
    p.add_argument('--aspd-socket', type=Path, required=True)
    p.add_argument('--source-db', type=Path, required=True, help='messages to seed A with (a store copy)')
    p.add_argument('--scratch-root', type=Path, required=True)
    p.add_argument('--artifacts', type=Path, required=True)
    p.add_argument('--s-owner', choices=['bun', 'native'], default='bun')
    p.add_argument('--owners', default='bun,native')
    args = p.parse_args()
    if args.scratch_root.exists():
        raise SystemExit('scratch root must be fresh')
    args.artifacts.mkdir(parents=True, exist_ok=True)
    real = Path.home() / 'praesidium/var/state/hrc/federation.json'
    a = Node(args.scratch_root / 'a', args.installed_release, args.aspd_socket, args.artifacts, 'a')
    s = Node(args.scratch_root / 's', args.installed_release, args.aspd_socket, args.artifacts, 's')
    ports = {k: free_port() for k in ('s_peer', 'a_peer')}
    token = secrets.token_hex(24)
    s_endpoint, a_endpoint = f'http://{TAILNET}:{ports["s_peer"]}', f'http://{TAILNET}:{ports["a_peer"]}'
    s.write_config({'nodeId': 'svc', 'peers': {'n4a': {'endpoint': a_endpoint, 'token': token}},
                    'peerListener': {'bind': s_endpoint}, 'gate': {'mode': 'off'}})
    a.write_config({'nodeId': 'n4a', 'peers': {'svc': {'endpoint': s_endpoint, 'token': token}},
                    'peerListener': {'bind': a_endpoint}, 'gate': {'mode': 'off'}})
    seeded = seed(a.db, args.source_db)
    evidence = {'seeded': seeded, 'sOwner': args.s_owner, 'owners': {}}
    observations = {}
    try:
        s_proc = s.up(args.s_owner, args.binary, 'authority')
        # Baseline: Bun is the owner whose replications must survive.
        proc = a.up('bun', args.binary, 'baseline')
        baseline = wait_for('baseline replication', lambda: (
            r if len(r := rows(a.db)) == seeded and all(v['state'] == 'delivered' for v in r.values()) else None))
        a.down(proc)
        evidence['baseline'] = {'rows': len(baseline), 'states': sorted({v['state'] for v in baseline.values()})}
        ids = sorted(baseline, key=lambda i: json.loads(baseline[i]['recordJson'])['messageSeq'])
        quiet = ids[:len(ids) // 2]  # query cases read only this half; plants live in the other
        roots = {}
        for i in quiet:
            roots.setdefault(json.loads(baseline[i]['recordJson'])['rootMessageId'], []).append(i)
        busiest = max(sorted(roots), key=lambda r: len(roots[r]))
        evidence['busiestThread'] = {'root': busiest, 'messages': len(roots[busiest])}
        for index, owner in enumerate(args.owners.split(',')):
            before = rows(a.db)
            tampered, changed = ids[-1 - 4 * index], ids[-2 - 4 * index]
            inserted = f'msg-n4-history-{owner}-down'
            db = sqlite3.connect(a.db)
            db.execute("UPDATE collective_history_replications SET record_fingerprint = 'tampered' WHERE message_id = ?",
                       (tampered,))
            meta = json.loads(db.execute('SELECT metadata_json FROM messages WHERE message_id = ?',
                                         (changed,)).fetchone()[0] or '{}')
            meta['n4HistoryProbe'] = owner
            db.execute('UPDATE messages SET metadata_json = ? WHERE message_id = ?', (json.dumps(meta), changed))
            db.commit()
            db.close()
            plant_message(a.db, quiet[0], inserted, 1)
            proc = a.up(owner, args.binary, 'restart')
            planted = {tampered, changed, inserted}
            def settled():
                r = rows(a.db)
                return all(r.get(i, {}).get('state') == 'delivered' and r[i]['fingerprint'] != 'tampered'
                           and r[i] != before.get(i) for i in planted)

            wait_for(owner + ' planted rows delivered', settled, timeout=60)
            live = None
            if owner == 'native':
                live = f'msg-n4-history-{owner}-live'
                plant_message(a.db, quiet[0], live, 1)
                wait_for('native live tail', lambda: rows(a.db).get(live, {}).get('state') == 'delivered', 30)
            time.sleep(3)  # three more polls: nothing else may move
            after = rows(a.db)
            moved = sorted(i for i in before if i not in planted and after.get(i) != before[i])
            checks = {
                'untouched': len(moved) == 0,
                'tamperedRestored': after[tampered]['fingerprint'] == baseline[tampered]['fingerprint']
                                    and after[tampered]['totalAttempts'] == 1,
                'changedFingerprint': after[changed]['fingerprint'] == hashlib.sha256(
                    after[changed]['recordJson'].encode()).hexdigest() != before[changed]['fingerprint'],
                'changedCarriesProbe': json.loads(after[changed]['recordJson'])['metadataJson'].get(
                    'n4HistoryProbe') == owner,
                'insertedDelivered': after[inserted]['state'] == 'delivered',
                'liveTailed': live is None or after[live]['state'] == 'delivered',
            }
            evidence['owners'][owner] = {'moved': moved[:20], 'movedCount': len(moved), 'checks': checks,
                                         'planted': sorted(planted | ({live} if live else set()))}
            cases = observations.setdefault(owner, {})

            def query(name, body, head=None):
                status, value, _ = a.http('POST', '/v1/messages/query', body)
                if head is not None and isinstance(value, dict) and 'messages' in value:
                    # Unbounded: keep the quiet head; each owner's plants sort last.
                    value = {**value, 'messages': value['messages'][:head]}
                cases['query:' + name] = {'status': status, 'body': value}

            first = json.loads(baseline[quiet[0]]['recordJson'])
            query('limit', {'limit': 5})
            query('after-seq', {'afterSeq': first['messageSeq'], 'limit': 3})
            query('message', {'messageId': quiet[1]})
            query('thread', {'thread': {'rootMessageId': first['rootMessageId']}, 'limit': 10})
            query('busy-thread', {'thread': {'rootMessageId': busiest}})
            query('busy-thread-asc', {'thread': {'rootMessageId': busiest}, 'limit': 2})
            query('busy-thread-desc', {'thread': {'rootMessageId': busiest}, 'limit': 2, 'order': 'desc'})
            query('participant', {'participant': first['from'], 'limit': 4, 'kinds': [first['kind']]})
            query('bad-body', [], head=5)
            query('bad-filter', {'limit': 'x'})
            for verb, body in (('replicate', {'record': first}), ('checkpoint', {'checkpoint': {
                    'maxMessageSeq': 1, 'pendingReplicationCount': 0}}), ('query', {'filter': {}})):
                cases['a-peer:' + verb] = peer_call(a_endpoint, token, 'POST', '/v1/federation/history/' + verb, body)
            cases['a-peer:bad-body'] = peer_call(a_endpoint, token, 'POST', '/v1/federation/history/query', {'x': 1})
            # S down: the collective read falls back to A's local rows.
            s.down(s_proc)
            query('unreachable', {'limit': 3})
            s_proc = s.up(args.s_owner, args.binary, f'authority-after-{owner}')
            a.down(proc)
        # S's own verbs, from A's token, after both owners.
        cases = observations.setdefault('authority', {})
        sample = json.loads(baseline[quiet[2]]['recordJson'])
        # A reply stamped before its parent: the topological pass must move it
        # after the parent, so a one-row page has to widen its window.
        parent = {k: v for k, v in sample.items() if k != 'replyToMessageId'}
        parent.update(messageId='msg-n4-skew-parent', rootMessageId='msg-n4-skew-parent',
                      createdAt='2099-02-01T00:00:02.000Z', messageSeq=900001)
        child = {**parent, 'messageId': 'msg-n4-skew-child', 'replyToMessageId': 'msg-n4-skew-parent',
                 'createdAt': '2099-02-01T00:00:01.000Z', 'messageSeq': 900002}
        skew = {'thread': {'rootMessageId': 'msg-n4-skew-parent'}}
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
            ('query-busy-desc', 'query', {'filter': {'thread': {'rootMessageId': busiest}, 'limit': 3, 'order': 'desc'}}),
            ('query-complete', 'query', {'filter': {'messageId': quiet[2]}}),
            ('query-desc', 'query', {'filter': {'limit': 3, 'order': 'desc', 'afterSeq': 0,
                                                'thread': {'rootMessageId': sample['rootMessageId']}}}),
            ('query-bad-filter', 'query', {'filter': {'limit': 'x'}}),
        ]
        for name, verb, body in verbs:
            cases['s-peer:' + name] = peer_call(s_endpoint, token, 'POST', '/v1/federation/history/' + verb, body)
        status, value, _ = s.http('POST', '/v1/messages/query', {'messageId': quiet[2]})
        cases['s-local:message'] = {'status': status, 'body': value}
        print(json.dumps({'seeded': seeded, **{o: e['checks'] for o, e in evidence['owners'].items()}}))
    finally:
        for owner, c in observations.items():
            (args.artifacts / owner).mkdir(exist_ok=True)
            (args.artifacts / owner / 'history.json').write_text(json.dumps(c, indent=1) + '\n')
        (args.artifacts / 'evidence.json').write_text(json.dumps(evidence, indent=1) + '\n')
        (args.artifacts / 'steps.json').write_text(json.dumps({'a': a.steps, 's': s.steps}, indent=1) + '\n')
        a.cleanup()
        s.cleanup()
        assert str(real) not in json.dumps(a.env) + json.dumps(s.env)
    failed = {o: [k for k, v in e['checks'].items() if not v] for o, e in evidence['owners'].items()}
    if any(failed.values()):
        raise SystemExit('FAIL ' + json.dumps(failed))


if __name__ == '__main__':
    main()
