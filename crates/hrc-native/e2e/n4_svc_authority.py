#!/usr/bin/env python3
"""svc as registry host and collective-history authority, on svc's own data (T-11931).

n4_federation and n4_history prove these verbs on scratch fixtures. This run
boots one scratch node named svc, once per owner (bun, then native), each on a
fresh copy of an extract of the real svc stores: the binding registry
(`VACUUM INTO`) and the messages plus collective_history_* rows of
state.sqlite. It then replays, as peers max3 and hrcdev, the registry and
peer-history verbs max3/hrcdev call into svc, with scopes, threads and
records sampled from that data.

Failure modes this guards, on real rows rather than fixtures: a registry
answer (consult/designation/unborn/designate-birth/establish) with another
status, outcome, field or key order; an unborn-designations page that orders
or bounds 2k real designations differently; a history query over ~24k real
collective rows that pages, orders or reports completeness differently; a
replicate of an already-held record that rewrites it; the authority's startup
backfill of svc's own messages rewriting any canonical or observed record
(native re-observes every local message at boot, Bun does not); and any row
the cases did not address moving. Per-case latency is recorded for both.

Extract the seed on svc (read-only against the live stores):
  sqlite3 -readonly <state>/federation/binding-registry.sqlite "VACUUM INTO 'registry.sqlite'"
  sqlite3 history.sqlite "ATTACH 'file:<state>/hrc/state.sqlite?mode=ro' AS s;
    CREATE TABLE messages AS SELECT * FROM s.messages; (same for
    collective_history_messages, _observations, _replications)"
"""
import argparse
import json
from pathlib import Path
import secrets
import shutil
import sqlite3
import time
from urllib.parse import quote

from n4_federation import TAILNET, Node, free_port
from n4_history import peer_call

PEERS = ('max3', 'hrcdev')
HISTORY_TABLES = ('collective_history_messages', 'collective_history_observations',
                  'collective_history_replications')


def cols(db, table, schema='main'):
    return [r[1] for r in db.execute(f'PRAGMA {schema}.table_info({table})')]


def seed(node, history, registry):
    target = node.root / 'federation'
    target.mkdir()
    shutil.copyfile(registry, target / 'binding-registry.sqlite')
    db = sqlite3.connect(node.db)
    db.execute('ATTACH ? AS src', (str(history),))
    for table in ('messages', *HISTORY_TABLES):
        names = ', '.join(c for c in cols(db, table) if c in cols(db, table, 'src'))
        db.execute(f'INSERT INTO {table} ({names}) SELECT {names} FROM src.{table}')
    db.commit()
    db.close()


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


def plan(history, registry):
    """The ordered case list, from the seed alone so both owners replay it identically."""
    reg = sqlite3.connect(f'file:{registry}?mode=ro', uri=True)
    bound = [r for r in reg.execute('SELECT scope_ref, home_node_id FROM binding_registry ORDER BY scope_ref')]
    live = [r for r in reg.execute(
        "SELECT d.scope_ref, d.home_node_id, EXISTS (SELECT 1 FROM binding_registry b WHERE b.scope_ref = d.scope_ref) "
        "FROM birth_designation d WHERE state = 'live' ORDER BY scope_ref")]
    superseded = [r[0] for r in reg.execute(
        "SELECT DISTINCT scope_ref FROM birth_designation WHERE state = 'superseded' ORDER BY scope_ref")]
    reg.close()
    db = sqlite3.connect(f'file:{history}?mode=ro', uri=True)
    roots = db.execute('SELECT root_message_id, COUNT(*) n FROM collective_history_messages '
                       'WHERE root_message_id IS NOT NULL GROUP BY 1 ORDER BY n DESC, 1 LIMIT 1').fetchone()
    held = {node: db.execute(
        "SELECT record_json FROM collective_history_observations WHERE source_node_id = ? AND source_role = 'origin' "
        'ORDER BY source_message_seq DESC LIMIT 1', (node,)).fetchone()[0] for node in PEERS}
    sample = json.loads(db.execute('SELECT canonical_record_json FROM collective_history_messages '
                                   'ORDER BY collective_seq DESC LIMIT 1 OFFSET 50').fetchone()[0])
    max_seq = {node: db.execute('SELECT MAX(source_message_seq) FROM collective_history_observations '
                                'WHERE source_node_id = ?', (node,)).fetchone()[0] for node in PEERS}
    db.close()

    def every(rows, n):
        return rows[::max(1, len(rows) // n)][:n]

    cases, touched = [], set()

    def reg_case(name, method, path, body=None, peer='max3', mutates=False):
        cases.append({'name': 'registry:' + name, 'listener': 'registry', 'method': method, 'path': path,
                      'body': body, 'peer': peer, 'mutates': mutates})

    def hist(name, verb, body, peer='max3', mutates=False):
        cases.append({'name': 'history:' + name, 'listener': 'peer', 'method': 'POST',
                      'path': '/v1/federation/history/' + verb, 'body': body, 'peer': peer, 'mutates': mutates})

    for scope, home in every(bound, 15):
        reg_case(f'consult:{home}:{scope}', 'GET', '/v1/federation/registry/consult?scopeRef=' + quote(scope))
    reg_case('consult-unbound', 'GET', '/v1/federation/registry/consult?scopeRef='
             + quote('agent:nobody:project:t11931:task:unbound'))
    reg_case('consult-as-hrcdev', 'GET', '/v1/federation/registry/consult?scopeRef=' + quote(bound[0][0]),
             peer='hrcdev')
    for scope, _, _ in every(live, 6):
        reg_case('designation-live:' + scope, 'GET', '/v1/federation/registry/designation?scopeRef=' + quote(scope))
    for scope in every(superseded, 6):
        reg_case('designation-superseded:' + scope, 'GET',
                 '/v1/federation/registry/designation?scopeRef=' + quote(scope))
    reg_case('designation-none', 'GET', '/v1/federation/registry/designation?scopeRef='
             + quote('agent:nobody:project:t11931:task:unbound'))
    for peer in PEERS:
        reg_case('unborn:' + peer, 'GET', '/v1/federation/registry/unborn-designations?homeNodeId=' + peer, peer=peer)
    reg_case('unborn-mismatch', 'GET', '/v1/federation/registry/unborn-designations?homeNodeId=hrcdev')
    for scope, _, _ in every(live, 3):
        reg_case('designate-existing:' + scope, 'POST', '/v1/federation/registry/designate-birth', {'scopeRef': scope})
    for scope, home in [b for b in bound if b[1] in PEERS][:2]:
        reg_case(f'establish-existing:{scope}', 'POST', '/v1/federation/registry/establish',
                 {'scopeRef': scope, 'homeNodeId': home}, peer=home)
    unborn = [r for r in live if not r[2] and r[1] in PEERS]
    if unborn:
        scope, home, _ = unborn[0]
        touched.add(scope)
        reg_case('establish-unborn-enforce:' + scope, 'POST', '/v1/federation/registry/establish',
                 {'scopeRef': scope, 'homeNodeId': home, 'birthDesignation': {'action': 'enforce-designated-home'}},
                 peer=home, mutates=True)
        reg_case('designation-after-establish:' + scope, 'GET',
                 '/v1/federation/registry/designation?scopeRef=' + quote(scope), peer=home, mutates=True)
    reg_case('establish-mismatch', 'POST', '/v1/federation/registry/establish',
             {'scopeRef': bound[0][0], 'homeNodeId': 'hrcdev'})

    hist('checkpoint-max3-clear', 'checkpoint',
         {'checkpoint': {'maxMessageSeq': max_seq['max3'], 'pendingReplicationCount': 0}})
    hist('checkpoint-hrcdev-pending', 'checkpoint',
         {'checkpoint': {'maxMessageSeq': max_seq['hrcdev'], 'pendingReplicationCount': 2}}, peer='hrcdev')
    hist('query-limit', 'query', {'filter': {'limit': 5}})
    hist('query-desc', 'query', {'filter': {'limit': 5, 'order': 'desc'}})
    hist('query-message', 'query', {'filter': {'messageId': sample['messageId']}})
    hist('query-thread', 'query', {'filter': {'thread': {'rootMessageId': roots[0]}, 'limit': 10}})
    hist('query-thread-desc', 'query', {'filter': {'thread': {'rootMessageId': roots[0]}, 'limit': 10,
                                                   'order': 'desc'}})
    hist('query-participant', 'query', {'filter': {'participant': sample['from'], 'limit': 6,
                                                   'kinds': [sample['kind']]}})
    hist('query-after-seq', 'query', {'filter': {'afterSeq': 20000, 'limit': 5}})
    for peer in PEERS:
        record = json.loads(held[peer])
        touched.add(record['messageId'])
        hist('replicate-held:' + peer, 'replicate', {'record': record}, peer=peer, mutates=True)
    hist('checkpoint-hrcdev-clear', 'checkpoint',
         {'checkpoint': {'maxMessageSeq': max_seq['hrcdev'], 'pendingReplicationCount': 0}}, peer='hrcdev')
    hist('query-confirmed', 'query', {'filter': {'limit': 3, 'order': 'desc'}})
    cases.append({'name': 'peer:health', 'listener': 'peer', 'method': 'GET', 'path': '/v1/federation/health',
                  'body': None, 'peer': 'max3', 'mutates': False})
    cases.append({'name': 'local:messages-query', 'listener': 'local', 'method': 'POST',
                  'path': '/v1/messages/query', 'body': {'limit': 3, 'order': 'desc'}, 'mutates': False})
    cases.append({'name': 'local:messages-query-thread', 'listener': 'local', 'method': 'POST',
                  'path': '/v1/messages/query', 'body': {'thread': {'rootMessageId': roots[0]}, 'limit': 5},
                  'mutates': False})
    # Inbound server-lifecycle, as an origin's Mable primary attests it
    # (lifecycle/peer.rs forward). The accepted stop is last: it ends the owner.
    primary = 'agent:mable:project:hrc-runtime:task:primary'

    def grant(**changes):
        body = {'requestId': 'lifecycle-t11931-svc', 'originNode': 'max3', 'requestedBy': primary,
                'callerKind': 'mable-primary', 'reason': 'T-11931 svc authority e2e', 'action': 'stop',
                'flags': {'wait': False, 'drain': False, 'force': False}, 'waitTimeoutMs': 5000,
                'drainTimeoutMs': 5000}
        body.update(changes)
        return {k: v for k, v in body.items() if v is not None}

    def life(name, body, peer='max3'):
        cases.append({'name': 'lifecycle:' + name, 'listener': 'peer', 'method': 'POST',
                      'path': '/v1/federation/server-lifecycle', 'body': body, 'peer': peer, 'mutates': False})

    life('unknown-field', grant(extra=1))
    life('bad-action', grant(action='reboot'))
    life('bad-flags', grant(flags={'wait': 'yes'}))
    life('missing-requested-by', grant(requestedBy=None))
    life('drain-and-wait', grant(action='restart', flags={'wait': True, 'drain': True, 'force': False}))
    life('drain-stop', grant(flags={'wait': False, 'drain': True, 'force': False}))
    life('origin-not-authenticated', grant(originNode='hrcdev'))
    life('node-local-caller', grant(callerKind='mable-node-local'))
    life('not-mable-primary', grant(requestedBy='agent:clod:project:hrc-runtime:task:primary'))
    life('reason-missing', grant(reason=None))
    life('not-a-record', [])
    life('stop-accepted', grant())
    return cases, sorted(touched), {'bound': len(bound), 'liveDesignations': len(live),
                                    'supersededScopes': len(superseded), 'busiestRoot': list(roots)}


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--binary', type=Path, required=True)
    p.add_argument('--installed-release', type=Path, required=True)
    p.add_argument('--aspd-socket', type=Path, required=True)
    p.add_argument('--history-db', type=Path, required=True, help='svc messages + collective_history extract')
    p.add_argument('--registry-db', type=Path, required=True, help='svc binding-registry VACUUM INTO copy')
    p.add_argument('--scratch-root', type=Path, required=True)
    p.add_argument('--artifacts', type=Path, required=True)
    p.add_argument('--owners', default='bun,native')
    p.add_argument('--settle', type=float, default=8.0, help='seconds for the startup backfill')
    args = p.parse_args()
    if args.scratch_root.exists():
        raise SystemExit('scratch root must be fresh')
    args.artifacts.mkdir(parents=True, exist_ok=True)
    real = Path.home() / 'praesidium/var/state/hrc/federation.json'
    cases, touched, facts = plan(args.history_db, args.registry_db)
    evidence = {'facts': facts, 'cases': len(cases), 'touched': touched, 'owners': {}}
    nodes = []
    try:
        for owner in args.owners.split(','):
            node = Node(args.scratch_root / owner, args.installed_release, args.aspd_socket, args.artifacts, owner)
            nodes.append(node)
            seed(node, args.history_db, args.registry_db)
            ports = {k: free_port() for k in ('peer', 'registry', 'max3', 'hrcdev')}
            tokens = {peer: secrets.token_hex(24) for peer in PEERS}
            endpoints = {'peer': f'http://{TAILNET}:{ports["peer"]}', 'registry': f'http://{TAILNET}:{ports["registry"]}'}
            # The peers' own endpoints point at ports nothing listens on.
            node.write_config({'nodeId': 'svc',
                               'peers': {peer: {'endpoint': f'http://{TAILNET}:{ports[peer]}', 'token': tokens[peer]}
                                         for peer in PEERS},
                               'registry': {'bind': endpoints['registry']},
                               'gate': {'mode': 'enforce', 'registryHost': 'svc'},
                               'peerListener': {'bind': endpoints['peer']}})
            seeded = snapshot(node)
            started = time.monotonic()
            proc = node.up(owner, args.binary, 'svc')
            ready_s = time.monotonic() - started
            time.sleep(args.settle)
            booted = snapshot(node)
            observed = {}
            for case in cases:
                t0 = time.monotonic()
                if case['listener'] == 'local':
                    status, body, _ = node.http(case['method'], case['path'], case['body'])
                    result = {'status': status, 'body': body}
                else:
                    result = peer_call(endpoints[case['listener']], tokens[case['peer']], case['method'],
                                       case['path'], case['body'])
                result['ms'] = round((time.monotonic() - t0) * 1000, 1)
                result['mutates'] = case['mutates']
                observed[case['name']] = result
            try:
                proc.wait(timeout=30)
                stopped = proc.returncode
            except Exception:
                stopped = None
            after = snapshot(node)
            node.down(proc)
            (args.artifacts / owner).mkdir(exist_ok=True)
            (args.artifacts / owner / 'svc-authority.json').write_text(json.dumps(observed, indent=1) + '\n')
            evidence['owners'][owner] = {
                'readyS': round(ready_s, 2),
                'stoppedByPeerLifecycle': stopped is not None, 'exitCode': stopped,
                'bootMoved': moved(seeded, booted, set()),
                'casesMoved': moved(booted, after, set(touched)),
                'rows': {t: len(v) for t, v in after.items()},
                'msByCase': {k: v['ms'] for k, v in observed.items()},
            }
        print(json.dumps({o: {'readyS': e['readyS'], 'stopped': e['exitCode'],
                              'bootMoved': {t: d['count'] for t, d in e['bootMoved'].items()},
                              'casesMoved': {t: d['count'] for t, d in e['casesMoved'].items()}}
                          for o, e in evidence['owners'].items()}))
    finally:
        (args.artifacts / 'evidence.json').write_text(json.dumps(evidence, indent=1) + '\n')
        (args.artifacts / 'steps.json').write_text(json.dumps({n.name: n.steps for n in nodes}, indent=1) + '\n')
        for node in nodes:
            node.cleanup()
            assert str(real) not in json.dumps(node.env)
    failed = {o: [f'{phase}:{t}' for phase in ('bootMoved', 'casesMoved') for t, d in e[phase].items() if d['count']]
              + ([] if e['stoppedByPeerLifecycle'] else ['peer-lifecycle-stop-not-actuated'])
              for o, e in evidence['owners'].items()}
    if any(failed.values()):
        raise SystemExit('FAIL ' + json.dumps(failed))


if __name__ == '__main__':
    main()
