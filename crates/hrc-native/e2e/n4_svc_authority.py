#!/usr/bin/env python3
"""svc as registry host and collective-history authority, on a generated svc-sized seed.

n4_federation and n4_history prove these verbs on small fixtures. This run
boots one native scratch node named svc whose stores are generated to svc's
shape (T-13073 recipe), never extracted from a live store:

- the binding registry: 2,000 birth designations by the registry listener's
  own statements (designate, establish, supersede), homed on max3 and hrcdev,
  some unborn, some bound, some superseded, plus 300 plain bindings;
- collective history: 200 of svc's own messages by the native message insert
  (n4_history.seed), backfilled by svc's first boot, then 12,000 records
  replicated through svc's own peer listener as max3 and hrcdev, with about
  1,700 also observed by hrcdev as the accepting destination: ~26k collective
  rows across messages and observations.

The seed is read back through svc's own routes before any case runs. svc then
reboots and serves, as peers max3 and hrcdev, the registry and peer-history
verbs they call into svc. Each case asserts its own literal, computed from
the generated model and the routes' code (registry_listener.rs,
federation/history.rs, hrc-store collective_history.rs, lifecycle/route.rs).

Invariants kept: a registry answer with another status, outcome or field; an
unborn-designations page that orders or bounds 250 designations differently
(LIMIT 200); a history query that pages, orders or reports completeness
differently; a replicate of an already-held record that rewrites it; the
startup backfill of svc's own messages rewriting any canonical or observed
record; any row the cases did not address moving; and the peer-lifecycle stop
ending the owner. Per-case latency is recorded.
"""
import argparse
from datetime import datetime, timedelta, timezone
import http.client
import json
from pathlib import Path
import secrets
import shutil
import sqlite3
import time
from urllib.parse import quote, urlsplit

from n4_federation import TAILNET, Node, REGISTRY_DESIGNATE, REGISTRY_ESTABLISH, free_port
from n4_history import peer_call, seed as seed_messages

PEERS = ('max3', 'hrcdev')
LOCAL = 200
GENERATED = 12000
DESIGNATIONS = 2000
PLAIN = 300
CLOCK = '2026-11-01T00:00:00.000Z'
# registry_listener.rs establish: supersede the live designation.
REGISTRY_SUPERSEDE = ("UPDATE birth_designation SET state = 'superseded', superseded_by = ?, superseded_at = ? "
                      'WHERE scope_ref = ? AND designation_epoch = ?')
SENDER = 'agent:svcauth:project:t13125:task:sender'


def scope(name):
    return f'agent:svcauth:project:t13125:task:{name}'


def stamp(base, seconds):
    return (base + timedelta(seconds=seconds)).strftime('%Y-%m-%dT%H:%M:%S.000Z')


def registry_seed(node):
    """2,000 designations in four classes, and 300 plain bindings; returns the model."""
    base = datetime(2026, 11, 1, tzinfo=timezone.utc)
    statements, bindings, designations = [], {}, {}
    for i in range(DESIGNATIONS):
        name, home = scope(f'd{i:04d}'), PEERS[i % 2]
        at = stamp(base, i)
        statements.append((REGISTRY_DESIGNATE, (name, home, 'default_home_node(sender)', f'EN-svc-{i}', SENDER, at)))
        d = {'scopeRef': name, 'homeNodeId': home, 'provenance': 'default_home_node(sender)', 'birthEnvelopeId': f'EN-svc-{i}',
             'senderScopeRef': SENDER, 'designationEpoch': 1, 'designatedAt': at, 'state': 'live'}
        cls = (i // 2) % 4  # 0 unborn, 1 and 3 live and bound home, 2 superseded and bound elsewhere
        if cls == 2:
            later = stamp(base, 10000 + i)
            statements.append((REGISTRY_SUPERSEDE, ('pin', later, name, 1)))
            d.update(state='superseded', supersededBy='pin', supersededAt=later)
            home = PEERS[(i + 1) % 2]
        if cls:
            statements.append((REGISTRY_ESTABLISH, (name, home, at, at)))
            bindings[name] = {'scopeRef': name, 'homeNodeId': home, 'createdAt': at, 'updatedAt': at}
        designations[name] = d
    for i in range(PLAIN):
        name, home, at = scope(f'b{i:03d}'), ('max3', 'hrcdev', 'svc')[i % 3], stamp(base, 20000 + i)
        statements.append((REGISTRY_ESTABLISH, (name, home, at, at)))
        bindings[name] = {'scopeRef': name, 'homeNodeId': home, 'createdAt': at, 'updatedAt': at}
    node.sql(node.root / 'federation/binding-registry.sqlite', statements)
    return bindings, designations


def generated(template):
    """12,000 records on one timeline: max3 originates five of six, hrcdev the sixth.

    One busy thread (every 200th record, 60 long); the rest in threads of four
    or five; replies always later than their parent. About one in five max3
    records is also held by hrcdev as the accepting destination.
    """
    base = datetime(2026, 11, 1, tzinfo=timezone.utc)
    seats = [f'agent:svcauth:project:t13125:task:seat-{k}/lane:main' for k in range(7)]
    seq = {p: 0 for p in PEERS}
    records, copies = [], []
    for t in range(GENERATED):
        origin = 'hrcdev' if t % 6 == 5 else 'max3'
        seq[origin] += 1
        if t % 200 == 0:
            root, reply = 0, (t - 200 if t else None)
        else:
            b = t - t % 5
            b += b % 200 == 0
            root, reply = b, (t - 1 if t > b else None)
        sender = {'kind': 'session', 'sessionRef': seats[t % 7]} if t % 4 else {'kind': 'entity', 'entity': ('human', 'system')[t % 8 == 0]}
        recipient = {'kind': 'entity', 'entity': 'human'} if sender['kind'] == 'session' else {'kind': 'session', 'sessionRef': seats[(t + 1) % 7]}
        r = dict(template)
        r.update(messageId=f'msg-svc-{t:05d}', messageSeq=seq[origin], createdAt=stamp(base, t),
                 kind=('dm', 'literal', 'system')[t % 3], phase=('request', 'response', 'oneway')[(t // 3) % 3],
                 **{'from': sender, 'to': recipient}, rootMessageId=f'msg-svc-{root:05d}',
                 body='' if t % 23 == 0 else f'svc history {t}',
                 execution={'state': 'completed', 'mode': 'headless', 'sessionRef': seats[t % 7], 'hostSessionId': f'hs-svc-{t % 7}',
                            'generation': 1, 'runtimeId': f'rt-svc-{t % 7}', 'runId': f'run-svc-{t}', 'transport': 'hrcpty'}
                 if t % 9 == 0 else {'state': 'not_applicable'})
        r['replyToMessageId'] = f'msg-svc-{reply:05d}' if reply is not None else None
        r['metadataJson'] = {'fixture': 'svc authority', 't': t} if t % 3 else None
        r = {k: v for k, v in r.items() if v is not None}
        records.append((origin, r))
        if origin == 'max3' and t % 5 == 1:
            seq['hrcdev'] += 1
            copy = {**r, 'messageSeq': seq['hrcdev'],
                    'metadataJson': {**r.get('metadataJson', {}), 'federationIngress': {'authenticatedNodeId': 'max3'}}}
            copies.append(('hrcdev', copy))
    return records, copies


class Peer:
    """One keep-alive connection to svc's peer listener as one peer."""

    def __init__(self, endpoint, token):
        u = urlsplit(endpoint)
        self.conn = http.client.HTTPConnection(u.hostname, u.port, timeout=30)
        self.headers = {'content-type': 'application/json', 'authorization': f'Bearer {token}'}

    def post(self, path, body):
        self.conn.request('POST', path, json.dumps(body), self.headers)
        res = self.conn.getresponse()
        return res.status, json.loads(res.read())


def history_seed(node, endpoint, tokens, evidence):
    """svc's own messages (backfilled at boot), then every generated record through the peer route."""
    seed_messages(node.db, LOCAL)
    proc = node.up('native', node.binary, 'seed')
    deadline = time.time() + 120
    while time.time() < deadline:
        with sqlite3.connect(f'file:{node.db}?mode=ro', uri=True) as db:
            if db.execute('SELECT COUNT(*) FROM collective_history_messages').fetchone()[0] == LOCAL:
                break
        time.sleep(.25)
    status, value, _ = node.http('POST', '/v1/messages/query', {'limit': 500})
    assert status == 200 and [m['messageId'] for m in value['messages']] == [f'msg-n4h-{i:03d}' for i in range(LOCAL)], (status, value)
    locals_ = value['messages']
    template = {k: v for k, v in locals_[1].items() if k not in ('collectiveSeq', 'collectiveHistory')}
    records, copies = generated(template)
    peers = {p: Peer(endpoint, tokens[p]) for p in PEERS}
    started = time.monotonic()
    refused = []
    # max3's originals, then hrcdev's, then hrcdev's destination copies: collective_seq follows this order.
    order = [x for x in records if x[0] == 'max3'] + [x for x in records if x[0] == 'hrcdev'] + copies
    for origin, record in order:
        status, body = peers[origin].post('/v1/federation/history/replicate', {'record': record})
        if (status, body) != (200, {'ok': True, 'ack': {'outcome': 'accepted', 'messageId': record['messageId']}}):
            refused.append((record['messageId'], status, body))
    evidence['replicateS'] = round(time.monotonic() - started, 1)
    assert not refused, refused[:5]
    model = []
    for m in locals_:
        model.append({**{k: v for k, v in m.items() if k != 'collectiveHistory'}})
    for n, (origin, record) in enumerate(order[:len(records)]):
        model.append({**record, 'collectiveSeq': LOCAL + 1 + n, '_origin': origin})
    # Owner readback: the last collective seq is the last record sent, and a sample carries both observations.
    last = model[-1]
    status, value = peers['max3'].post('/v1/federation/history/query', {'filter': {'afterSeq': len(model) - 1}})
    assert status == 200 and [(m['messageId'], m['collectiveSeq']) for m in value['messages']] == [(last['messageId'], len(model))], value
    status, value = peers['max3'].post('/v1/federation/history/query', {'filter': {'messageId': 'msg-svc-00001'}})
    seen = [(o['nodeId'], o['role']) for o in value['messages'][0]['collectiveHistory']['observations']]
    assert status == 200 and sorted(seen) == [('hrcdev', 'destination'), ('max3', 'origin')], value
    for p in peers.values():
        p.conn.close()
    node.down(proc)
    evidence['seed'] = {'local': LOCAL, 'generated': len(records), 'destinationCopies': len(copies)}
    return sorted(model, key=lambda m: (m['createdAt'], m['messageId'])), {r['messageId']: o for o, r in records}


def snapshot(node):
    """Every history and registry row, keyed, with only clock columns dropped."""
    out = {}
    db = sqlite3.connect(f'file:{node.db}?mode=ro', uri=True)
    out['messages'] = {r[0]: r[1:] for r in db.execute(
        'SELECT message_id, collective_seq, canonical_record_json, canonical_source_node_id, '
        'canonical_source_role, canonical_created_at, created_at FROM collective_history_messages')}
    out['observations'] = {f'{r[0]}@{r[1]}': r[2:] for r in db.execute(
        'SELECT message_id, source_node_id, source_message_seq, source_role, origin_node_id, '
        'accepted_destination_node_id, record_json FROM collective_history_observations')}
    db.close()
    reg = sqlite3.connect(f'file:{node.root}/federation/binding-registry.sqlite?mode=ro', uri=True)
    out['bindings'] = {r[0]: r[1:] for r in reg.execute('SELECT * FROM binding_registry')}
    out['designations'] = {f'{r[0]}#{r[1]}': r[2:] for r in reg.execute('SELECT * FROM birth_designation')}
    reg.close()
    return out


def moved(before, after, touched):
    """Keys whose row changed, ignoring keys a case addressed on purpose."""
    diff = {}
    for table in before:
        keys = set(before[table]) | set(after[table])
        changed = sorted(k for k in keys if before[table].get(k) != after[table].get(k)
                         and k.split('@')[0].split('#')[0] not in touched)
        diff[table] = {'count': len(changed), 'sample': changed[:10]}
    return diff


def every(rows, n):
    return rows[::max(1, len(rows) // n)][:n]


def plan(bindings, designations, model):
    """The ordered case list and each case's expected answer, from the generated model."""
    ok = lambda peer, **v: (200, {'ok': True, 'authenticatedNodeId': peer, **v})
    bound = sorted(bindings)
    live = sorted(s for s, d in designations.items() if d['state'] == 'live')
    superseded = sorted(s for s, d in designations.items() if d['state'] == 'superseded')
    unborn = {p: sorted(s for s in live if s not in bindings and designations[s]['homeNodeId'] == p) for p in PEERS}
    nobody = 'agent:nobody:project:t11931:task:unbound'
    cases, touched = [], set()

    def case(name, listener, method, path, body, want, peer='max3', mutates=False):
        cases.append({'name': name, 'listener': listener, 'method': method, 'path': path, 'body': body,
                      'peer': peer, 'mutates': mutates, 'want': want})

    def reg(name, method, path, body, want, peer='max3', mutates=False):
        case('registry:' + name, 'registry', method, '/v1/federation/registry/' + path, body, want, peer, mutates)

    for s in every(bound, 15):
        b = bindings[s]
        reg(f'consult:{b["homeNodeId"]}:{s}', 'GET', 'consult?scopeRef=' + quote(s), None, ok('max3', outcome='bound', binding=b))
    reg('consult-unbound', 'GET', 'consult?scopeRef=' + quote(nobody), None,
        (404, {'ok': False, 'error': 'unbound', 'authenticatedNodeId': 'max3'}))
    reg('consult-as-hrcdev', 'GET', 'consult?scopeRef=' + quote(bound[0]), None,
        ok('hrcdev', outcome='bound', binding=bindings[bound[0]]), peer='hrcdev')
    for s in every(live, 6):
        reg('designation-live:' + s, 'GET', 'designation?scopeRef=' + quote(s), None,
            ok('max3', outcome='designated', designation=designations[s]))
    for s in every(superseded, 6):
        reg('designation-superseded:' + s, 'GET', 'designation?scopeRef=' + quote(s), None,
            ok('max3', outcome='superseded', designation=designations[s]))
    reg('designation-none', 'GET', 'designation?scopeRef=' + quote(nobody), None, ok('max3', outcome='none'))
    for p in PEERS:
        # 250 unborn per home; the listener bounds the page at 200, in scope order.
        reg('unborn:' + p, 'GET', 'unborn-designations?homeNodeId=' + p, None,
            ok(p, designations=[designations[s] for s in unborn[p][:200]]), peer=p)
    mismatch = (403, {'ok': False, 'error': 'authenticated_node_mismatch'})
    reg('unborn-mismatch', 'GET', 'unborn-designations?homeNodeId=hrcdev', None, mismatch)
    for s in every(live, 3):
        reg('designate-existing:' + s, 'POST', 'designate-birth', {'scopeRef': s},
            ok('max3', kind='designated', designation=designations[s]))
    for s in [s for s in bound if bindings[s]['homeNodeId'] in PEERS][:2]:
        home = bindings[s]['homeNodeId']
        reg('establish-existing:' + s, 'POST', 'establish', {'scopeRef': s, 'homeNodeId': home},
            ok(home, outcome='existing', binding=bindings[s]), peer=home)
    s = unborn['hrcdev'][-1]  # past the 200-row page, so the unborn pages above are unaffected
    touched.add(s)
    reg('establish-unborn-enforce:' + s, 'POST', 'establish',
        {'scopeRef': s, 'homeNodeId': 'hrcdev', 'birthDesignation': {'action': 'enforce-designated-home'}},
        ('CREATED', s, 'hrcdev'), peer='hrcdev', mutates=True)
    reg('designation-after-establish:' + s, 'GET', 'designation?scopeRef=' + quote(s), None,
        ok('hrcdev', outcome='designated', designation=designations[s]), peer='hrcdev', mutates=True)
    reg('establish-mismatch', 'POST', 'establish', {'scopeRef': bound[0], 'homeNodeId': 'hrcdev'}, mismatch)

    # History: the collective order is (createdAt, messageId); every reply here is later than its parent.
    ids = lambda rows: [m['messageId'] for m in rows]
    lagging = {'source': 'collective', 'complete': False, 'authorityNodeId': 'svc', 'queriedNodeId': 'svc',
               'cursorKind': 'collective', 'pendingReplicationCount': 0, 'unconfirmedNodeIds': ['hrcdev'],
               'degraded': {'code': 'collective_lagging', 'message': 'awaiting catch-up checkpoint from hrcdev'}}
    complete = {k: v for k, v in lagging.items() if k not in ('unconfirmedNodeIds', 'degraded')} | {'complete': True}

    def hist(name, verb, body, want, peer='max3', mutates=False):
        case('history:' + name, 'peer', 'POST', '/v1/federation/history/' + verb, body, want, peer, mutates)

    def q(name, flt, want, history=lagging, listener='peer'):
        if listener == 'peer':
            hist(name, 'query', {'filter': flt}, ('QUERY', want, history))
        else:
            case(name, 'local', 'POST', '/v1/messages/query', flt, ('QUERY', want, history))

    ack = lambda peer: (200, {'ok': True, 'ack': {'outcome': 'accepted', 'nodeId': peer}})
    max_seq = {p: max(m['messageSeq'] for m in model if m.get('_origin') == p) for p in PEERS}
    by_seq = sorted(model, key=lambda m: m['collectiveSeq'])
    sample = by_seq[-51]
    busy = [m for m in model if m['rootMessageId'] == 'msg-svc-00000']
    assert len(busy) == 60
    after = len(model) - 10
    hist('checkpoint-max3-clear', 'checkpoint', {'checkpoint': {'maxMessageSeq': max_seq['max3'], 'pendingReplicationCount': 0}}, ack('max3'))
    hist('checkpoint-hrcdev-pending', 'checkpoint', {'checkpoint': {'maxMessageSeq': max_seq['hrcdev'], 'pendingReplicationCount': 2}},
         ack('hrcdev'), peer='hrcdev')
    q('query-limit', {'limit': 5}, ids(model[:5]))
    q('query-desc', {'limit': 5, 'order': 'desc'}, ids(model[-5:][::-1]))
    q('query-message', {'messageId': sample['messageId']}, [sample['messageId']])
    q('query-thread', {'thread': {'rootMessageId': 'msg-svc-00000'}, 'limit': 10}, ids(busy[:10]))
    q('query-thread-desc', {'thread': {'rootMessageId': 'msg-svc-00000'}, 'limit': 10, 'order': 'desc'}, ids(busy[-10:][::-1]))
    party = [m for m in model if sample['from'] in (m['from'], m['to']) and m['kind'] == sample['kind']]
    q('query-participant', {'participant': sample['from'], 'limit': 6, 'kinds': [sample['kind']]}, ids(party[:6]))
    q('query-after-seq', {'afterSeq': after, 'limit': 5}, ids([m for m in model if m['collectiveSeq'] > after][:5]))
    held = {p: max((m for m in model if m.get('_origin') == p), key=lambda m: m['messageSeq']) for p in PEERS}
    for p in PEERS:
        record = {k: v for k, v in held[p].items() if not k.startswith('_') and k != 'collectiveSeq'}
        # Not touched: re-replicating a held record must leave every snapshotted column as it was.
        hist('replicate-held:' + p, 'replicate', {'record': record},
             (200, {'ok': True, 'ack': {'outcome': 'accepted', 'messageId': record['messageId']}}), peer=p, mutates=True)
    hist('checkpoint-hrcdev-clear', 'checkpoint', {'checkpoint': {'maxMessageSeq': max_seq['hrcdev'], 'pendingReplicationCount': 0}},
         ack('hrcdev'), peer='hrcdev')
    q('query-confirmed', {'limit': 3, 'order': 'desc'}, ids(model[-3:][::-1]), complete)
    case('peer:health', 'peer', 'GET', '/v1/federation/health', None, ('HEALTH',))
    q('local:messages-query', {'limit': 3, 'order': 'desc'}, ids(model[-3:][::-1]), complete, 'local')
    q('local:messages-query-thread', {'thread': {'rootMessageId': 'msg-svc-00000'}, 'limit': 5}, ids(busy[:5]), complete, 'local')

    # Inbound server-lifecycle, as an origin's Mable primary attests it (lifecycle/route.rs peer).
    # The accepted stop is last: it ends the owner.
    primary = 'agent:mable:project:hrc-runtime:task:primary'

    def grant(**changes):
        body = {'requestId': 'lifecycle-t11931-svc', 'originNode': 'max3', 'requestedBy': primary,
                'callerKind': 'mable-primary', 'reason': 'T-11931 svc authority e2e', 'action': 'stop',
                'flags': {'wait': False, 'drain': False, 'force': False}, 'waitTimeoutMs': 5000,
                'drainTimeoutMs': 5000}
        body.update(changes)
        return {k: v for k, v in body.items() if v is not None}

    def life(name, body, want):
        case('lifecycle:' + name, 'peer', 'POST', '/v1/federation/server-lifecycle', body, want)

    invalid = lambda message: (400, {'ok': False, 'error': {'code': 'invalid_request', 'message': message}})
    refused = lambda refusal, *needles: ('REFUSED', refusal, needles)
    life('unknown-field', grant(extra=1), invalid('unknown field extra'))
    life('bad-action', grant(action='reboot'), invalid('action must be stop or restart'))
    life('bad-flags', grant(flags={'wait': 'yes'}), invalid('flags must be {wait, drain, force} booleans'))
    life('missing-requested-by', grant(requestedBy=None), invalid('requestId, originNode, requestedBy and callerKind are required'))
    life('drain-and-wait', grant(action='restart', flags={'wait': True, 'drain': True, 'force': False}),
         invalid('--drain and --wait are mutually exclusive; --drain owns the closed-admission wait'))
    life('drain-stop', grant(flags={'wait': False, 'drain': True, 'force': False}), invalid('--drain applies to restart only'))
    life('origin-not-authenticated', grant(originNode='hrcdev'),
         refused('attestation_refused', 'attested originNode hrcdev is not the authenticated peer max3'))
    life('node-local-caller', grant(callerKind='mable-node-local'),
         refused('attestation_refused', 'callerKind mable-node-local may not act across nodes'))
    life('not-mable-primary', grant(requestedBy='agent:clod:project:hrc-runtime:task:primary'),
         refused('attestation_refused', 'is not a Mable primary'))
    life('reason-missing', grant(reason=None), refused('reason_required', '--reason <text> is required'))
    life('not-a-record', [], (400, {'ok': False, 'error': {'code': 'invalid_request'}}))
    life('stop-accepted', grant(), (200, {'ok': True, 'accepted': True, 'targetNode': 'svc', 'grant': {
        'requestId': 'lifecycle-t11931-svc', 'requestedBy': primary, 'callerKind': 'mable-primary', 'originNode': 'max3',
        'reason': 'T-11931 svc authority e2e', 'action': 'stop', 'flags': {'wait': False, 'drain': False, 'force': False}}}))
    facts = {'bound': len(bound), 'liveDesignations': len(live), 'supersededScopes': len(superseded),
             'unborn': {p: len(v) for p, v in unborn.items()}, 'collectiveMessages': len(model), 'busiestRoot': ['msg-svc-00000', len(busy)]}
    return cases, sorted(touched), facts


def judge(case, result, model):
    """None when the observed answer is the case's own literal, else why not."""
    want, status, body = case['want'], result['status'], result['body']
    if want[0] == 'CREATED':
        _, s, home = want
        b = (body or {}).get('binding') or {}
        good = status == 200 and body.get('outcome') == 'created' and body.get('authenticatedNodeId') == home \
            and (b.get('scopeRef'), b.get('homeNodeId')) == (s, home) and b.get('createdAt') == b.get('updatedAt') > CLOCK
        return None if good else 'establish did not create the binding'
    if want[0] == 'QUERY':
        _, want_ids, history = want
        got = (body or {}).get('messages')
        if status != 200 or not isinstance(got, list):
            return f'status {status}'
        if [m['messageId'] for m in got] != want_ids:
            return {'ids': [m['messageId'] for m in got]}
        if body.get('history') != history:
            return {'history': body.get('history')}
        sent = {m['messageId']: m for m in model}
        for m in got:
            expect = {k: v for k, v in sent[m['messageId']].items() if not k.startswith('_')}
            if {k: v for k, v in m.items() if k != 'collectiveHistory'} != expect:
                return {'record differs': m['messageId']}
            roles = sorted((o['nodeId'], o['role']) for o in m['collectiveHistory']['observations'])
            origin = sent[m['messageId']].get('_origin', 'svc')
            if roles != sorted([(origin, 'origin')] + ([('hrcdev', 'destination')] if origin == 'max3' and int(m['messageId'][-5:]) % 5 == 1 else [])):
                return {'observations': roles}
        return None
    if want[0] == 'HEALTH':
        caps = (body or {}).get('capabilities')
        good = status == 200 and body.get('ok') is True and body.get('nodeId') == 'svc' and caps == {
            'locate': True, 'health': True, 'runtimeProjection': True, 'collectiveHistory': True,
            'serverLifecycle': True, 'federatedSessionRead': True}
        return None if good else 'health'
    if want[0] == 'REFUSED':
        _, refusal, needles = want
        err = (body or {}).get('error') or {}
        good = status == 403 and body.get('ok') is False and err.get('code') == 'server_lifecycle_refused' \
            and err.get('detail') == {'refusal': refusal} and all(n in err.get('message', '') for n in needles)
        return None if good else 'refusal'
    if (status, body) == want:
        return None
    if status == want[0] and isinstance(body, dict) and body.get('ok') and set(body) - set(want[1]) == {'notes'}:
        return None if {k: v for k, v in body.items() if k != 'notes'} == want[1] else 'body'
    return 'literal'


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--binary', type=Path, required=True)
    p.add_argument('--scratch-root', type=Path, required=True)
    p.add_argument('--artifacts', type=Path, required=True)
    p.add_argument('--aspd-socket', type=Path, help='never dialed; defaults to a path under the scratch root')
    p.add_argument('--installed-release', type=Path, help='accepted and ignored')
    p.add_argument('--settle', type=float, default=8.0, help='seconds for the startup backfill')
    args = p.parse_args()
    if args.scratch_root.exists():
        raise SystemExit('scratch root must be fresh')
    args.artifacts.mkdir(parents=True, exist_ok=True)
    real = Path.home() / 'praesidium/var/state/hrc/federation.json'
    node = Node(args.scratch_root / 'svc', None, args.aspd_socket or args.scratch_root / 'aspd.sock', args.artifacts, 'svc', args.binary)
    evidence, observed, failures = {}, {}, {}
    try:
        ports = {k: free_port() for k in ('peer', 'registry', 'max3', 'hrcdev')}
        tokens = {peer: secrets.token_hex(24) for peer in PEERS}
        endpoints = {'peer': f'http://{TAILNET}:{ports["peer"]}', 'registry': f'http://{TAILNET}:{ports["registry"]}'}
        # The peers' own endpoints point at ports nothing listens on.
        node.write_config({'nodeId': 'svc',
                           'peers': {peer: {'endpoint': f'http://{TAILNET}:{ports[peer]}', 'token': tokens[peer]} for peer in PEERS},
                           'registry': {'bind': endpoints['registry']},
                           'gate': {'mode': 'enforce', 'registryHost': 'svc'},
                           'peerListener': {'bind': endpoints['peer']}})
        node.down(node.up('native', args.binary, 'schema'))  # the owner creates the registry schema
        bindings, designations = registry_seed(node)
        model, _ = history_seed(node, endpoints['peer'], tokens, evidence)
        cases, touched, facts = plan(bindings, designations, model)
        evidence.update(facts=facts, cases=len(cases), touched=touched)
        seeded = snapshot(node)
        started = time.monotonic()
        proc = node.up('native', args.binary, 'svc')
        ready_s = time.monotonic() - started
        time.sleep(args.settle)
        booted = snapshot(node)
        for case in cases:
            t0 = time.monotonic()
            if case['listener'] == 'local':
                status, body, _ = node.http(case['method'], case['path'], case['body'])
                result = {'status': status, 'body': body}
            else:
                result = peer_call(endpoints[case['listener']], tokens[case['peer']], case['method'], case['path'], case['body'])
            result['ms'] = round((time.monotonic() - t0) * 1000, 1)
            observed[case['name']] = result
            why = judge(case, result, model)
            if why:
                failures[case['name']] = {'why': why, 'status': result['status'], 'body': result['body']}
        try:
            proc.wait(timeout=30)
            stopped = proc.returncode
        except Exception:
            stopped = None
        after = snapshot(node)
        if stopped is None:
            node.down(proc)
        evidence.update(readyS=round(ready_s, 2), stoppedByPeerLifecycle=stopped is not None, exitCode=stopped,
                        bootMoved=moved(seeded, booted, set()), casesMoved=moved(booted, after, set(touched)),
                        rows={t: len(v) for t, v in after.items()}, msByCase={k: v['ms'] for k, v in observed.items()})
        for phase in ('bootMoved', 'casesMoved'):
            for t, d in evidence[phase].items():
                if d['count']:
                    failures[f'{phase}:{t}'] = d
        if not evidence['stoppedByPeerLifecycle']:
            failures['peer-lifecycle-stop-not-actuated'] = True
        print(json.dumps({'cases': len(cases), 'failures': sorted(failures), 'readyS': evidence['readyS'],
                          'replicateS': evidence.get('replicateS'), 'rows': evidence['rows']}))
    finally:
        (args.artifacts / 'svc-authority.json').write_text(json.dumps(observed, indent=1) + '\n')
        (args.artifacts / 'evidence.json').write_text(json.dumps({**evidence, 'failures': failures}, indent=1, default=str) + '\n')
        (args.artifacts / 'steps.json').write_text(json.dumps({node.name: node.steps}, indent=1, default=str) + '\n')
        node.cleanup()
        assert str(real) not in json.dumps(node.env)
        shutil.rmtree(args.scratch_root)
    if failures:
        raise SystemExit('FAIL ' + json.dumps(sorted(failures)))


if __name__ == '__main__':
    main()
