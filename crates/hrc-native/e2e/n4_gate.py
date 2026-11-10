#!/usr/bin/env python3
"""N4 summon gate on the native owner, each case checked against its expected verdict.

One scratch node n4a hosts its own binding registry, knows a peer n4b, and
runs the gate in enforce and then advisory mode. Every case is a fresh
POST /v1/targets/ensure (the ensure-target door), so each reaches the gate's
whole precedence: retirement fence, local ledger authority, registry-first
binding, then declared policy from real agent profiles (animan's placement
homes, arris participant-only, tabularasa's provisioning.node, hunter with
none), node= directives, birth designations and capability observation.

The scratch node has no launchable harness, so every case whose authority
resolves here (ledger-local, registry-local, designated-here, undeclared,
node=n4a) ends at the capability stage with homeNodeId n4a: that reason is
the proof the earlier stages allowed it. Seeds are the native writers'
statements (n4_federation LEDGER_*/REGISTRY_*), into schemas the owner made.

Failure modes: a refusal with another reason, status, code or home; a stage
skipped or reordered (a retired scope reaching the ledger home, a registry
binding losing to policy, a directive overriding a profile pin silently);
enforce minting a session or writing a registry or ledger row; advisory
refusing anything, or not logging the same would-be refusal it enforces.
"""
import argparse
from collections import Counter
import json
from pathlib import Path
import secrets
import socket

import sqlite3

from n3_scratch import Scratch
from n4_federation import LEDGER_ACTIVE, LEDGER_RETIRE, REGISTRY_DESIGNATE, REGISTRY_ESTABLISH

TAILNET = '100.73.60.81'
PROJECT = 'n4-t11872g'
HERE = 'capability-harness-missing'
# Cases whose scope is not hunter:<case>; all but animan's carry a '<phase>-' task prefix.
CASE_SCOPES = {'local-default': ('hunter', 'fresh'), 'repeat-local-default': ('hunter', 'fresh'),
               'task-default': ('animan', 'primary'), 'roster-home': ('animan', 'minisvc-nova'), 'directive-conflict': ('animan', 'primary'),
               'participant-only': ('arris', 'p1'), 'configured-default': ('tabularasa', 'c1'),
               **{f'directive-{k}': ('tabularasa', f'd{i}') for i, k in enumerate(('here', 'peer', 'unknown', 'local', 'bad'), 1)}}


def case_scope(phase, name):
    agent, task = CASE_SCOPES.get(name, ('hunter', name))
    return scope(agent, task if agent == 'animan' or name not in CASE_SCOPES else f'{phase}-{task}')


# case -> (status, error code, reason, homeNodeId), read from the case's construction.
EXPECT = {
    'retired': (409, 'stale_context', 'scope-retired', None),
    'ledger-foreign': (409, 'stale_context', 'bound-elsewhere', 'n4b'),
    'ledger-local': (409, 'stale_context', HERE, 'n4a'),
    'registry-foreign': (409, 'stale_context', 'bound-elsewhere', 'n4b'),
    'registry-local': (409, 'stale_context', HERE, 'n4a'),
    'designated-here': (409, 'stale_context', HERE, 'n4a'),
    'designated-there': (409, 'stale_context', 'birth-designated-elsewhere', 'n4b'),
    'local-default': (409, 'stale_context', HERE, 'n4a'),
    'task-default': (409, 'stale_context', 'pin-mismatch', 'max3'),  # animan [placement.homes] primary = max3
    'roster-home': (409, 'stale_context', 'pin-mismatch', 'svc'),  # animan roster minisvc-nova on svc
    'participant-only': (409, 'stale_context', 'participant-only', None),
    'configured-default': (409, 'stale_context', 'routed-elsewhere', 'max3'),  # tabularasa provisioning.node
    'directive-here': (409, 'stale_context', HERE, 'n4a'),
    'directive-peer': (409, 'stale_context', 'routed-elsewhere', 'n4b'),
    'directive-unknown': (422, 'unknown_node', 'unknown-node', None),
    'directive-local': (422, 'invalid_provision_value', 'invalid-provision-value', None),
    'directive-bad': (422, 'invalid_provision_value', 'invalid-provision-value', None),
    'directive-conflict': (409, 'placement_directive_conflict', 'placement-directive-conflict', 'max3'),
    'repeat-local-default': (409, 'stale_context', HERE, 'n4a'),
}


def free_port():
    with socket.socket() as s:
        s.bind((TAILNET, 0))
        return s.getsockname()[1]


def scope(agent, task):
    return f'agent:{agent}:project:{PROJECT}:task:{task}'


def check(obs, artifacts, now):
    failures = []
    for name, (status, code, reason, home) in EXPECT.items():
        got = obs[f'enforce:{name}']
        error = (got['body'] or {}).get('error', {}) if isinstance(got['body'], dict) else {}
        detail = error.get('detail') or {}
        seen = (got['status'], error.get('code'), detail.get('reason'), detail.get('homeNodeId'))
        if seen != (status, code, reason, home):
            failures.append(('enforce', name, seen, (status, code, reason, home)))
        advisory = obs[f'advisory:{name}']
        if advisory['status'] != 200:
            failures.append(('advisory refused', name, advisory['status'], advisory['body']))
    designation = obs['enforce:designated-there']['body']['error']['detail'].get('birthDesignation') or {}
    if (designation.get('homeNodeId'), designation.get('state')) != ('n4b', 'live'):
        failures.append(('designation detail', designation))
    seeded_registry = [{'scope_ref': scope('hunter', t), 'home_node_id': h} for t, h in (('registry-foreign', 'n4b'), ('registry-local', 'n4a'))]
    seeded_ledger = [(scope('hunter', 'ledger-foreign'), 'n4b', 'active'), (scope('hunter', 'ledger-local'), 'n4a', 'active'),
                     (scope('hunter', 'retired'), 'n4a', 'retired')]
    for phase in ('enforce', 'advisory'):
        rows = obs[f'{phase}:rows']['body']
        if rows['registry'] != seeded_registry or [(r['scope_ref'], r['home_node_id'], r['state']) for r in rows['ledger']] != seeded_ledger:
            failures.append((phase, 'a gate decision wrote a registry or ledger row', rows['registry'], rows['ledger']))
        if [d['state'] for d in rows['designations']] != ['live', 'live']:
            failures.append((phase, 'designations changed', rows['designations']))
    if obs['enforce:rows']['body']['sessions']:
        failures.append(('enforce minted a session', obs['enforce:rows']['body']['sessions']))
    advisory_scopes = {r['scope_ref'] for r in obs['advisory:rows']['body']['sessions']}
    if scope('hunter', 'advisory-fresh') not in advisory_scopes:
        failures.append(('advisory did not admit the fresh scope', sorted(advisory_scopes)))
    # Refusals are logged in advisory and enforce alike (gate.rs evaluate); only enforce acts.
    for phase, enforced in (('enforce', True), ('advisory', False)):
        lines = [json.loads(l) for l in (artifacts / f'native-gate-{phase}.log').read_text().splitlines() if l.startswith('{')]
        refusals = [l['data'] for l in lines if l.get('event') == 'federation.summon_gate.refusal']
        want = Counter()
        for name, (_, _, reason, home) in EXPECT.items():
            if phase == 'advisory' and name in ('repeat-local-default', 'directive-conflict'):
                # Advisory already admitted these scopes (local-default, task-default): the ensure resolves the session.
                continue
            want[(case_scope(phase, name), reason, home)] += 1
        got = Counter((r['scopeRef'], r['reason'], r.get('homeNodeId')) for r in refusals
                      if (r['enforced'], r['mode']) == (enforced, phase))
        if got != want:
            failures.append((phase, 'logged would-be refusals', sorted(got - want), sorted(want - got)))
    assert not failures, failures


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--owner', choices=['native'], default='native')
    p.add_argument('--binary', type=Path, required=True)
    p.add_argument('--installed-release', type=Path, help='accepted and ignored')
    p.add_argument('--aspd-socket', type=Path, required=True)
    p.add_argument('--scratch-root', type=Path, required=True)
    p.add_argument('--artifacts', type=Path, required=True)
    args = p.parse_args()
    s = Scratch(args.scratch_root, args.installed_release, args.aspd_socket, args.binary, args.artifacts,
                project_id=PROJECT)
    observations = {}
    now = '2026-10-26T10:00:00.000Z'
    registry_path = s.root / 'federation/binding-registry.sqlite'

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

        # Fixtures by the native writers' statements, into schemas the owner created.
        configure('enforce')
        s.down(s.up('native', 'schema'))
        assert registry_path.is_file(), 'owner did not create the binding registry'
        ledger = [(LEDGER_ACTIVE, (scope('hunter', 'retired'), 'n4a', now, now)),
                  (LEDGER_RETIRE, (now, 'n4 fixture', now, scope('hunter', 'retired'), 'n4a')),
                  (LEDGER_ACTIVE, (scope('hunter', 'ledger-foreign'), 'n4b', now, now)),
                  (LEDGER_ACTIVE, (scope('hunter', 'ledger-local'), 'n4a', now, now))]
        registry = [(REGISTRY_ESTABLISH, (scope('hunter', 'registry-foreign'), 'n4b', now, now)),
                    (REGISTRY_ESTABLISH, (scope('hunter', 'registry-local'), 'n4a', now, now)),
                    (REGISTRY_DESIGNATE, (scope('hunter', 'designated-here'), 'n4a', 'default_home_node(sender)', 'EN-g1', scope('hunter', 'sender'), now)),
                    (REGISTRY_DESIGNATE, (scope('hunter', 'designated-there'), 'n4b', 'default_home_node(sender)', 'EN-g2', scope('hunter', 'sender'), now))]
        for path, statements in ((s.db_path, ledger), (registry_path, registry)):
            with sqlite3.connect(path, timeout=30) as db:
                for sql, values in statements:
                    db.execute(sql, values)

        def ensure(phase, name, ref, intent=None):
            status, value = s.http('POST', '/v1/targets/ensure', {
                'sessionRef': ref + '/lane:main', 'runtimeIntent': intent or {}})
            observations[f'{phase}:{name}'] = {'status': status, 'body': value}

        def rows(phase):
            registry = []
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
        check(observations, args.artifacts, now)
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
