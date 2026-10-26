#!/usr/bin/env python3
"""N4 summon gate on one owner (bun or native), recorded for a compare.

One scratch node n4a hosts its own binding registry, knows a peer n4b, and
runs the gate in enforce and then advisory mode. Every case is a fresh
POST /v1/targets/ensure (the ensure-target door), so each reaches the gate's
whole precedence: retirement fence, local ledger authority, registry-first
binding, then declared policy from real agent profiles (animan's placement
homes, arris participant-only, tabularasa's provisioning.node, hunter with
none), node= directives, birth designations and capability observation.

Failure modes: a refusal with another reason, status, code or detail; a
native gate that mints where Bun refuses (or the reverse); an establishment
that writes a different registry or ledger row; advisory refusing anything;
and a designation honored or ignored differently.
"""
import argparse
import json
from pathlib import Path
import secrets
import socket

from n3_scratch import Scratch

TAILNET = '100.73.60.81'
PROJECT = 'n4-t11872g'


def free_port():
    with socket.socket() as s:
        s.bind((TAILNET, 0))
        return s.getsockname()[1]


def scope(agent, task):
    return f'agent:{agent}:project:{PROJECT}:task:{task}'


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--owner', choices=['bun', 'native'], required=True)
    p.add_argument('--binary', type=Path, required=True)
    p.add_argument('--installed-release', type=Path, required=True)
    p.add_argument('--aspd-socket', type=Path, required=True)
    p.add_argument('--scratch-root', type=Path, required=True)
    p.add_argument('--artifacts', type=Path, required=True)
    args = p.parse_args()
    s = Scratch(args.scratch_root, args.installed_release, args.aspd_socket, args.binary, args.artifacts,
                project_id=PROJECT)
    observations = {}
    now = '2026-10-26T10:00:00.000Z'
    store = s.release / 'packages/hrc-store-sqlite/src/index.ts'
    registry_path = s.root / 'federation/binding-registry.sqlite'

    def bun_store(name, body, *argv):
        script = (f'const s=await import({json.dumps(str(store))});const a=process.argv.slice(1);'
                  f'const {{openHrcDatabase,createPlacementLedgerRepository,openBindingRegistry}}=s;{body}')
        s.command('store:' + name, ['bun', '-e', script, *map(str, argv)])

    try:
        s.init_substrate()
        token = secrets.token_hex(24)
        ports = {'registry': free_port(), 'peer': free_port()}

        def configure(mode):
            s.root.joinpath('federation.json').write_text(json.dumps({
                'nodeId': 'n4a',
                'peers': {'n4b': {'endpoint': f'http://{TAILNET}:{ports["peer"]}', 'token': token}},
                'registry': {'bind': f'http://{TAILNET}:{ports["registry"]}'},
                'gate': {'mode': mode, 'registryHost': 'n4a'}}))
            s.root.joinpath('federation.json').chmod(0o600)

        # Fixtures through the copied release's own store code.
        bun_store('ledger', 'const db=openHrcDatabase(a[0]);const l=createPlacementLedgerRepository(db.sqlite);'
                  'l.installActive({scopeRef:a[1],homeNodeId:"n4a",updatedAt:a[4]});'
                  'l.retire({scopeRef:a[1],expectedHomeNodeId:"n4a",reason:"n4 fixture",retiredAt:a[4]});'
                  'l.installActive({scopeRef:a[2],homeNodeId:"n4b",updatedAt:a[4]});'
                  'l.installActive({scopeRef:a[3],homeNodeId:"n4a",updatedAt:a[4]});db.close()',
                  s.db_path, scope('hunter', 'retired'), scope('hunter', 'ledger-foreign'),
                  scope('hunter', 'ledger-local'), now)
        bun_store('registry', 'const r=openBindingRegistry(a[0]);'
                  'r.establish({scopeRef:a[1],homeNodeId:"n4b",now:a[5]});'
                  'r.establish({scopeRef:a[2],homeNodeId:"n4a",now:a[5]});'
                  'r.recordDesignation({scopeRef:a[3],homeNodeId:"n4a",provenance:"default_home_node(sender)",birthEnvelopeId:"EN-g1",senderScopeRef:a[6],now:a[5]});'
                  'r.recordDesignation({scopeRef:a[4],homeNodeId:"n4b",provenance:"default_home_node(sender)",birthEnvelopeId:"EN-g2",senderScopeRef:a[6],now:a[5]});'
                  'r.close()',
                  registry_path, scope('hunter', 'registry-foreign'), scope('hunter', 'registry-local'),
                  scope('hunter', 'designated-here'), scope('hunter', 'designated-there'),
                  scope('hunter', 'sender'), now)

        def ensure(phase, name, ref, intent=None):
            status, value = s.http('POST', '/v1/targets/ensure', {
                'sessionRef': ref + '/lane:main', 'runtimeIntent': intent or {}})
            observations[f'{phase}:{name}'] = {'status': status, 'body': value}

        def rows(phase):
            registry = []
            import sqlite3
            with sqlite3.connect(f'file:{registry_path}?mode=ro', uri=True) as db:
                db.row_factory = sqlite3.Row
                registry = [dict(r) for r in db.execute('SELECT scope_ref, home_node_id FROM binding_registry ORDER BY scope_ref')]
                designations = [dict(r) for r in db.execute(
                    'SELECT scope_ref, designation_epoch, home_node_id, state, superseded_by FROM birth_designation ORDER BY scope_ref, designation_epoch')]
            ledger = s.rows('SELECT scope_ref, home_node_id, state FROM placement_ledger ORDER BY scope_ref')
            sessions = s.rows('SELECT scope_ref, lane_ref, status FROM sessions ORDER BY scope_ref')
            observations[f'{phase}:rows'] = {'status': 0, 'body': {
                'registry': registry, 'designations': designations, 'ledger': ledger, 'sessions': sessions}}

        for phase in ('enforce', 'advisory'):
            configure(phase)
            proc = s.up(args.owner, 'gate-' + phase)
            t = lambda name: f'{phase}-{name}'
            ensure(phase, 'retired', scope('hunter', 'retired'))
            ensure(phase, 'ledger-foreign', scope('hunter', 'ledger-foreign'))
            ensure(phase, 'ledger-local', scope('hunter', 'ledger-local'))
            ensure(phase, 'registry-foreign', scope('hunter', 'registry-foreign'))
            ensure(phase, 'registry-local', scope('hunter', 'registry-local'))
            ensure(phase, 'designated-here', scope('hunter', 'designated-here'))
            ensure(phase, 'designated-there', scope('hunter', 'designated-there'))
            ensure(phase, 'local-default', scope('hunter', t('fresh')))
            ensure(phase, 'task-default', scope('animan', 'primary'))
            ensure(phase, 'roster-home', scope('animan', 'minisvc-nova'))
            ensure(phase, 'participant-only', scope('arris', t('p1')))
            ensure(phase, 'configured-default', scope('tabularasa', t('c1')))
            ensure(phase, 'directive-here', scope('tabularasa', t('d1')), {'provision': {'node': 'n4a'}})
            ensure(phase, 'directive-peer', scope('tabularasa', t('d2')), {'provision': {'node': 'n4b'}})
            ensure(phase, 'directive-unknown', scope('tabularasa', t('d3')), {'provision': {'node': 'zzz'}})
            ensure(phase, 'directive-local', scope('tabularasa', t('d4')), {'provision': {'node': 'local'}})
            ensure(phase, 'directive-bad', scope('tabularasa', t('d5')), {'provision': {'node': 'bad node'}})
            # animan's [placement.homes] primary = max3; the directive disagrees.
            ensure(phase, 'directive-conflict', scope('animan', 'primary'), {'provision': {'node': 'n4a'}})
            ensure(phase, 'repeat-local-default', scope('hunter', t('fresh')))
            rows(phase)
            s.down(proc)
        normalized = json.loads(json.dumps(observations).replace(str(s.root.resolve()), '<root>')
                                .replace(str(s.root), '<root>'))
        (args.artifacts / args.owner).mkdir(exist_ok=True)
        (args.artifacts / args.owner / 'gate.json').write_text(json.dumps(normalized, indent=1) + '\n')
        print(json.dumps({'owner': args.owner, 'cases': len(observations)}))
    finally:
        (args.artifacts / f'{args.owner}-steps.json').write_text(json.dumps(s.steps, indent=1) + '\n')
        s.cleanup('agent:')


if __name__ == '__main__':
    main()
