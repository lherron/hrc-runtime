#!/usr/bin/env python3
"""N4 federation reads on two scratch nodes, recorded for a per-case compare.

Node B is a scratch registry host with a peer listener. Node A runs each
named owner (native by default; `--owners bun,native` and `--b-owner bun`
reach the Bun copy as before) on the same store under five federation
configs: none (no file), peerless, peered (B is the sole peer and registry
host), peer-refused and peer-down (B's ports point nowhere). Each config is a
fresh daemon start.

Node is native unless its caller asks for Bun (`up('bun')`, `.release`,
`bun_store`); the native seed writes the placement ledger and binding registry
by SQL into schemas the native owner created, then reads each seeded scope back
through the owner's own routes before any case runs.

Failure modes this guards: a home decision that differs from Bun's for a
ledger, registry or unconfigured scope; a refusal (session_home_unknown,
_pending, _unreachable) with another status, code or detail; a forwarded read
that loses the home's status, body or x-hrc-home-node header; a bounded-stream
relay that rewrites records; locate/designations views with different keys,
order or values; and a scratch node reaching the real federation.json,
registry or peers (every config, token and port here is private).
"""
from foundation import daemon_env
import argparse
import ipaddress
import json
import os
from pathlib import Path
import secrets
import shutil
import signal
import socket
import subprocess
import time
from http.client import HTTPException
from urllib.parse import quote

from n2_scratch import (LEAK_PREFIXES, UnixHTTP, check_native_status, copy_release, native_provenance,
                        opened_files, preflight_unmanaged, reap_root)
import sqlite3

TAILNET = '100.73.60.81'
PROJECT = 'n4-t11872'
AGENT = 'tabularasa'
DYNAMIC = {'checkedAt', 'answeredAt', 'latencyMs'}


def local_tailnet_address():
    """Use this node's assigned IPv4 address; registry binds require tailnet.

    Inspect interfaces, not a named peer or default route. Missing tailnet is
    a setup failure, never a reason to skip the registry-backed assertions.
    """
    interfaces = subprocess.run(['/sbin/ifconfig'], check=True, capture_output=True, text=True).stdout
    for line in interfaces.splitlines():
        parts = line.split()
        if len(parts) >= 2 and parts[0] == 'inet':
            address = ipaddress.IPv4Address(parts[1])
            if address in ipaddress.IPv4Network('100.64.0.0/10'):
                return str(address)
    raise RuntimeError('native federation E2E requires a node-local tailnet IPv4 interface')


def free_port(host=TAILNET):
    with socket.socket() as s:
        s.bind((host, 0))
        return s.getsockname()[1]


class Node:
    def __init__(self, root, installed, aspd, artifacts, name, binary):
        self.binary = Path(binary).resolve()
        self.root = Path(root).absolute()
        self.root.mkdir(parents=True)
        self.name = name
        self.artifacts = artifacts
        # Only Bun mode reads it; native callers may still pass one.
        self.installed = installed
        self.mode, self._release, self._bun_provenance = 'native', None, None
        self.native_provenance = native_provenance(self.binary)
        self.steps, self.procs, self.logs = [{'name': 'mode', 'mode': 'native', 'provenance': self.native_provenance}], [], []
        self.project = self.root / PROJECT
        self.project.mkdir()
        for d in ('run', 'state'):
            (self.root / d).mkdir()
        self.config = self.root / 'federation.json'
        bin_dir = self.root / 'bin'
        bin_dir.mkdir()
        (bin_dir / 'hrc').symlink_to(self.binary)
        env = {k: v for k, v in os.environ.items() if not k.startswith(LEAK_PREFIXES)}
        env['PATH'] = str(bin_dir) + os.pathsep + os.environ.get('PATH', '')
        env.update(ASP_HOME=str(self.root / 'asp-home'), HRC_RUNTIME_DIR=str(self.root / 'run'), HRC_STATE_DIR=str(self.root / 'state'),
                   ASP_PROJECT_ROOT_OVERRIDE=str(self.project), HRC_PROJECT_SEARCH_ROOTS=str(self.project),
                   HRC_WRKQ_DB=str(self.root / 'wrkq.db'), WRKQ_DB=str(self.root / 'wrkq.db'),
                   WRKQ_PRINCIPAL_REF='agent:clod', HRC_WRKQD_TOKEN_FILE='', WRKQD_TOKEN_FILE='', WRKQD_TOKEN='',
                   HRC_PEER_CONFIG_FILE=str(self.config), HRC_EVENT_INGEST_SOCKET=str(self.root / 'run/ingest.sock'),
                   HRC_ACP_WEBHOOK_URL='', HRC_ASPD_SOCKET=str(Path(aspd).resolve()))
        self.env = env
        self.aspd = Path(aspd).resolve()
        self.socket = self.root / 'run/hrc.sock'
        self.db = self.root / 'state/state.sqlite'
        self.run('git-init', ['git', 'init', '-q'])
        self.run('wrkq-migrate', [Path.home() / '.local/bin/wrkqadm', 'migrate'])
        self.run('schema', [self.binary, 'store', 'migrate', self.db])

    @property
    def cli(self):
        return self._release / 'packages/hrc-cli/bin/hrc.js' if self._release else self.binary

    @property
    def release(self):
        return self.enter_bun('release')

    @property
    def provenance(self):
        if self.mode == 'native':
            return self.native_provenance
        return self._bun_provenance

    def enter_bun(self, why):
        """Bun mode, on the caller's request only: copied release, preflight, Bun CLI as `hrc`."""
        if self._release is None:
            assert self.installed, 'Bun mode needs --installed-release'
            self._release = copy_release(self.installed, self.root / 'bun-release')
            link = self.root / 'bin/hrc'
            link.unlink()
            link.symlink_to(self.cli)
            self._bun_provenance = preflight_unmanaged(self._release, self.env)
            self.mode = 'bun'
            self.steps.append({'name': 'mode', 'mode': 'bun', 'enteredBy': why})
        return self._release

    def run(self, name, argv, stdin=None):
        argv = [self.cli if str(argv[0]) == 'hrc' else argv[0], *argv[1:]]
        r = subprocess.run([str(a) for a in argv], env=self.env, cwd=self.project, input=stdin,
                           capture_output=True, text=True, timeout=300)
        self.steps.append({'name': name, 'argv': [str(a) for a in argv], 'exit': r.returncode,
                           'stdout': r.stdout[-4000:], 'stderr': r.stderr[-4000:]})
        assert r.returncode == 0, (name, r.stdout, r.stderr)
        return r.stdout

    def bun_store(self, name, body, *args):
        """Fixture writes go through the copied release's own store code (Bun mode)."""
        store = self.release / 'packages/hrc-store-sqlite/src/index.ts'
        script = f'const s=await import({json.dumps(str(store))});const a=process.argv.slice(1);' \
                 f'const {{openHrcDatabase,createPlacementLedgerRepository,openBindingRegistry}}=s;{body}'
        return self.run('store:' + name, ['bun', '-e', script, *args])

    def write_config(self, value):
        if value is None:
            self.config.unlink(missing_ok=True)
            return
        self.config.write_text(json.dumps(value))
        self.config.chmod(0o600)

    def sql(self, path, statements):
        """Native fixture writes: plain SQL into a schema the native owner created."""
        assert Path(path).is_file(), ('seed target has no owner-created schema', path)
        with sqlite3.connect(path, timeout=30) as db:
            for sql, params in statements:
                db.execute(sql, params)
        self.steps.append({'name': 'sql:' + Path(path).name, 'statements': [[q, list(v)] for q, v in statements]})

    def up(self, owner, binary, tag):
        if owner == 'bun':
            self.enter_bun('up')
        log = (self.artifacts / f'{self.name}-{owner}-{tag}.log').open('w')
        self.logs.append(log)
        argv = [binary, 'server'] if owner == 'native' else [
            'bun', self.release / 'packages/hrc-cli/src/cli.ts', 'server', 'serve']
        proc = subprocess.Popen([str(a) for a in argv], env=daemon_env(self.env, bun=self.mode == 'bun'), cwd=self.project, stdout=log, stderr=log)
        self.procs.append(proc)
        for _ in range(300):
            assert proc.poll() is None, (owner, tag, 'owner exited', proc.returncode)
            try:
                status, value, _ = self.http('GET', '/v1/status')
                if status == 200:
                    step = {'name': f'{owner}-{tag}-up', 'pid': proc.pid}
                    if owner == 'native':
                        assert Path(value['binaryPath']).resolve() == Path(binary).resolve()
                        if Path(binary).resolve() == self.binary:
                            check_native_status(value, self.native_provenance)
                        opened = opened_files(proc.pid, self.root, (self.aspd,))
                        (self.artifacts / f'opened-{self.name}-{owner}-{tag}.json').write_text(json.dumps(opened, indent=1) + '\n')
                        step['stateStore'] = opened['stateStore']
                    else:
                        assert Path(value['packagePath']).resolve().is_relative_to(self.release)
                        assert value['release']['mode'] == 'unmanaged', value['release']
                    self.steps.append(step)
                    return proc
            except (OSError, HTTPException, ValueError):
                pass
            time.sleep(.1)
        raise AssertionError(owner + ' not ready')

    def down(self, proc):
        proc.send_signal(signal.SIGTERM)
        proc.wait(timeout=30)

    def http(self, method, path, body=None, timeout=60, stream_for=None):
        c = UnixHTTP(self.socket, timeout)
        c.request(method, path, json.dumps(body) if body is not None else None,
                  {'Content-Type': 'application/json'})
        res = c.getresponse()
        home = res.getheader('x-hrc-home-node')
        if stream_for is not None and res.status == 200:
            c.sock.settimeout(stream_for)
            raw = b''
            try:
                while True:
                    chunk = res.read1(65536)
                    if not chunk:
                        break
                    raw += chunk
            except (TimeoutError, socket.timeout):
                pass
            c.close()
            lines = [json.loads(l) for l in raw.decode().split('\n') if l.strip()]
            return res.status, {'records': lines, 'contentType': res.getheader('content-type')}, home
        raw = res.read().decode()
        c.close()
        try:
            value = json.loads(raw)
        except ValueError:
            value = raw
        return res.status, value, home

    def cleanup(self):
        for p in self.procs:
            if p.poll() is None:
                p.terminate()
                p.wait(timeout=30)
        for log in self.logs:
            log.close()
        reap_root(self.root, Path(self.artifacts) / f'reap-{self.name}')


def registry_cases(endpoint, token):
    """Every registry route and refusal against B's listener, in a fixed order."""
    import urllib.request, urllib.error
    out = {}

    def call(name, method, path, body=None, auth=token):
        headers = {'content-type': 'application/json'}
        if auth is not None:
            headers['authorization'] = auth if auth.startswith('Basic') else f'Bearer {auth}'
        req = urllib.request.Request(endpoint + path, data=None if body is None else json.dumps(body).encode(),
                                     method=method, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=10) as res:
                status, raw = res.status, res.read()
        except urllib.error.HTTPError as error:
            status, raw = error.code, error.read()
        out[name] = {'status': status, 'body': json.loads(raw) if raw else None}

    q = lambda s: quote(s, safe='')
    call('no-auth', 'GET', '/v1/federation/registry/consult?scopeRef=' + q(scope('registry-foreign')), auth=None)
    call('bad-token', 'GET', '/v1/federation/registry/consult?scopeRef=' + q(scope('registry-foreign')), auth='nope')
    call('basic-auth', 'GET', '/v1/federation/registry/consult?scopeRef=' + q(scope('registry-foreign')), auth='Basic x')
    call('consult-missing', 'GET', '/v1/federation/registry/consult')
    call('consult-bound', 'GET', '/v1/federation/registry/consult?scopeRef=' + q(scope('registry-foreign')))
    call('consult-unbound', 'GET', '/v1/federation/registry/consult?scopeRef=' + q(scope('nowhere')))
    call('consult-invalid', 'GET', '/v1/federation/registry/consult?scopeRef=bogus')
    call('designation-none', 'GET', '/v1/federation/registry/designation?scopeRef=' + q(scope('nowhere')))
    call('designation-live', 'GET', '/v1/federation/registry/designation?scopeRef=' + q(scope('unborn')))
    call('designation-missing', 'GET', '/v1/federation/registry/designation')
    call('unborn-self', 'GET', '/v1/federation/registry/unborn-designations?homeNodeId=n4a')
    call('unborn-other', 'GET', '/v1/federation/registry/unborn-designations?homeNodeId=n4b')
    call('unborn-missing', 'GET', '/v1/federation/registry/unborn-designations')
    call('designate-live', 'POST', '/v1/federation/registry/designate-birth', {'scopeRef': scope('unborn')})
    call('designate-no-envelope', 'POST', '/v1/federation/registry/designate-birth', {'scopeRef': scope('fresh')})
    call('designate-bad-body', 'POST', '/v1/federation/registry/designate-birth', ['x'])
    call('designate-missing', 'POST', '/v1/federation/registry/designate-birth', {})
    call('establish-mismatch', 'POST', '/v1/federation/registry/establish', {'scopeRef': scope('fresh'), 'homeNodeId': 'n4b'})
    call('establish-provenance', 'POST', '/v1/federation/registry/establish', {'scopeRef': scope('fresh'), 'homeNodeId': 'n4a', 'placementSource': 'x'})
    call('establish-bad-decision', 'POST', '/v1/federation/registry/establish', {'scopeRef': scope('fresh'), 'homeNodeId': 'n4a', 'birthDesignation': {'action': 'nope'}})
    call('establish-invalid-scope', 'POST', '/v1/federation/registry/establish', {'scopeRef': 'bogus', 'homeNodeId': 'n4a'})
    call('establish-created', 'POST', '/v1/federation/registry/establish', {'scopeRef': scope('fresh'), 'homeNodeId': 'n4a'})
    call('establish-existing', 'POST', '/v1/federation/registry/establish', {'scopeRef': scope('fresh'), 'homeNodeId': 'n4a'})
    call('establish-supersede', 'POST', '/v1/federation/registry/establish', {'scopeRef': scope('unborn'), 'homeNodeId': 'n4a', 'birthDesignation': {'action': 'supersede', 'supersededBy': 'pin'}})
    call('designation-superseded', 'GET', '/v1/federation/registry/designation?scopeRef=' + q(scope('unborn')))
    call('unborn-after', 'GET', '/v1/federation/registry/unborn-designations?homeNodeId=n4a')
    call('delete-mismatch', 'POST', '/v1/federation/registry/delete', {'scopeRef': scope('fresh'), 'expectedHomeNodeId': 'n4b', 'retiredAt': '2026-10-26T11:00:00.000Z'})
    call('delete-conflict', 'POST', '/v1/federation/registry/delete', {'scopeRef': scope('registry-foreign'), 'expectedHomeNodeId': 'n4a', 'retiredAt': '2026-10-26T11:00:00.000Z'})
    call('delete-missing-retired', 'POST', '/v1/federation/registry/delete', {'scopeRef': scope('fresh'), 'expectedHomeNodeId': 'n4a'})
    call('delete-deleted', 'POST', '/v1/federation/registry/delete', {'scopeRef': scope('fresh'), 'expectedHomeNodeId': 'n4a', 'retiredAt': '2026-10-26T11:00:00.000Z'})
    call('delete-idempotent', 'POST', '/v1/federation/registry/delete', {'scopeRef': scope('fresh'), 'expectedHomeNodeId': 'n4a', 'retiredAt': '2026-10-26T11:00:00.000Z'})
    call('consult-after-delete', 'GET', '/v1/federation/registry/consult?scopeRef=' + q(scope('fresh')))
    call('unknown-route', 'GET', '/v1/federation/registry/nope')
    call('wrong-method', 'POST', '/v1/federation/registry/consult')
    return out


def scope(task):
    return f'agent:{AGENT}:project:{PROJECT}:task:{task}'


def seed_native(a, b, now):
    """The Bun seed's rows, by SQL, into schemas the native owner created.

    Each statement is the native writer's own (placement-ledger install and
    retirement in federation/mod.rs and retirement.rs; registry establish and
    designate-birth in registry_listener.rs), with the fixture's fixed clock.
    B boots once natively so its owner creates the binding registry schema.
    """
    active = ("INSERT INTO placement_ledger (scope_ref, home_node_id, state, retired_at, retirement_reason, created_at, updated_at) "
              "VALUES (?, ?, 'active', NULL, NULL, ?, ?)")
    retire = ("UPDATE placement_ledger SET state='retired',retired_at=?,retirement_reason=?,updated_at=? "
              "WHERE scope_ref=? AND home_node_id=? AND state='active'")
    # A's placement ledger: local, retired and ledger-foreign scopes.
    a.sql(a.db, [(active, (scope('local'), 'n4a', now, now)), (active, (scope('retired'), 'n4a', now, now)),
                 (retire, (now, 'n4 fixture', now, scope('retired'), 'n4a')),
                 (active, (scope('ledger-foreign'), 'n4b', now, now))])
    b.down(b.up('native', b.binary, 'schema'))
    registry = b.root / 'federation/binding-registry.sqlite'
    establish = 'INSERT INTO binding_registry (scope_ref, home_node_id, created_at, updated_at) VALUES (?, ?, ?, ?)'
    designate = ('INSERT INTO birth_designation (scope_ref, designation_epoch, home_node_id, provenance, birth_envelope_id, '
                 "sender_scope_ref, designated_at, state, superseded_by, superseded_at) VALUES (?, 1, ?, ?, ?, ?, ?, 'live', NULL, NULL)")
    # B's registry: foreign (B), registry-local (A), and an unborn designation for A.
    b.sql(registry, [(establish, (scope('registry-foreign'), 'n4b', now, now)),
                     (establish, (scope('registry-local'), 'n4a', now, now)),
                     (establish, (scope('ledger-foreign'), 'n4b', now, now)),
                     (designate, (scope('unborn'), 'n4a', 'default_home_node(sender)', 'EN-n4', scope('sender'), now))])
    b.sql(b.db, [(active, (scope('registry-foreign'), 'n4b', now, now)), (active, (scope('ledger-foreign'), 'n4b', now, now))])


def check_seed(registry, cases):
    """The native seed reads back through the owners' own routes before it is trusted."""
    bound = lambda name: (registry[name]['status'], (registry[name]['body'] or {}).get('binding', {}).get('homeNodeId'))
    assert bound('consult-bound') == (200, 'n4b'), registry['consult-bound']
    live = registry['designation-live']['body'] or {}
    assert live.get('outcome') == 'designated' and live['designation']['state'] == 'live', live
    for task, state, home in (('local', 'active', 'n4a'), ('retired', 'retired', 'n4a'), ('ledger-foreign', 'active', 'n4b')):
        ledger = cases[f'none:locate:{task}']['body']['ledger']
        assert (ledger['state'], ledger['record']['homeNodeId']) == (state, home), (task, ledger)


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--binary', type=Path, required=True)
    p.add_argument('--installed-release', type=Path, help='Bun release; read only when an owner is bun')
    p.add_argument('--aspd-socket', type=Path, required=True)
    p.add_argument('--scratch-root', type=Path, required=True)
    p.add_argument('--artifacts', type=Path, required=True)
    p.add_argument('--owners', default='native', help='comma list; bun,native is the Bun comparison')
    # B as bun exercises the Bun registry listener from a native origin.
    p.add_argument('--b-owner', choices=['bun', 'native'], default='native')
    args = p.parse_args()
    if args.scratch_root.exists():
        raise SystemExit('scratch root must be fresh')
    args.artifacts.mkdir(parents=True, exist_ok=True)
    real = Path.home() / 'praesidium/var/state/hrc/federation.json'
    a = Node(args.scratch_root / 'a', args.installed_release, args.aspd_socket, args.artifacts, 'a', args.binary)
    b = Node(args.scratch_root / 'b', args.installed_release, args.aspd_socket, args.artifacts, 'b', args.binary)
    ports = {k: free_port() for k in ('b_registry', 'b_peer', 'a_peer', 'dead_registry', 'dead_peer')}
    # One bearer per node pair: the registry listener authenticates the
    # receiver's own `token` for that peer, the peer listener its accepted set.
    token, wrong = secrets.token_hex(24), secrets.token_hex(24)
    b.write_config({'nodeId': 'n4b',
                    'peers': {'n4a': {'endpoint': f'http://{TAILNET}:{ports["a_peer"]}', 'token': token}},
                    'registry': {'bind': f'http://{TAILNET}:{ports["b_registry"]}'},
                    'peerListener': {'bind': f'http://{TAILNET}:{ports["b_peer"]}'},
                    'gate': {'mode': 'off', 'registryHost': 'n4b'}})
    peer = lambda pp, rp, tok: {'nodeId': 'n4a', 'peers': {'n4b': {
        'endpoint': f'http://{TAILNET}:{pp}', 'registryEndpoint': f'http://{TAILNET}:{rp}',
        'token': tok}}, 'gate': {'mode': 'off'}}
    configs = [('none', None), ('peerless', {'nodeId': 'n4a', 'peers': {}}),
               ('peered', peer(ports['b_peer'], ports['b_registry'], token)),
               ('peer-refused', peer(ports['b_peer'], ports['b_registry'], wrong)),
               ('peer-down', peer(ports['dead_peer'], ports['dead_registry'], token))]
    now = '2026-10-26T10:00:00.000Z'
    bun = 'bun' in args.owners.split(',') + [args.b_owner]
    if bun:
        # The Bun comparison seeds through the copied release's repositories, as before.
        # A's placement ledger: local, retired and ledger-foreign scopes.
        a.bun_store('ledger', 'const db=openHrcDatabase(a[0]);const l=createPlacementLedgerRepository(db.sqlite);'
                    'l.installActive({scopeRef:a[1],homeNodeId:"n4a",updatedAt:a[4]});'
                    'l.installActive({scopeRef:a[2],homeNodeId:"n4a",updatedAt:a[4]});'
                    'l.retire({scopeRef:a[2],expectedHomeNodeId:"n4a",reason:"n4 fixture",retiredAt:a[4]});'
                    'l.installActive({scopeRef:a[3],homeNodeId:"n4b",updatedAt:a[4]});db.close()',
                    a.db, scope('local'), scope('retired'), scope('ledger-foreign'), now)
        # B's registry: foreign (B), registry-local (A), and an unborn designation for A.
        b.bun_store('registry', 'const r=openBindingRegistry(a[0]);'
                    'for(const [s,h] of [[a[1],"n4b"],[a[2],"n4a"],[a[3],"n4b"]])r.establish({scopeRef:s,homeNodeId:h,now:a[6]});'
                    'r.recordDesignation({scopeRef:a[4],homeNodeId:"n4a",provenance:"default_home_node(sender)",'
                    'birthEnvelopeId:"EN-n4",senderScopeRef:a[5],now:a[6]});r.close()',
                    b.root / 'federation/binding-registry.sqlite', scope('registry-foreign'), scope('registry-local'),
                    scope('ledger-foreign'), scope('unborn'), scope('sender'), now)
        b.bun_store('ledger', 'const db=openHrcDatabase(a[0]);const l=createPlacementLedgerRepository(db.sqlite);'
                    'for(const s of [a[1],a[2]])l.installActive({scopeRef:s,homeNodeId:"n4b",updatedAt:a[3]});db.close()',
                    b.db, scope('registry-foreign'), scope('ledger-foreign'), now)
    observations = {}
    try:
        if not bun:
            seed_native(a, b, now)
        b.up(args.b_owner, args.binary, 'home')
        registry = registry_cases(f'http://{TAILNET}:{ports["b_registry"]}', token)
        (args.artifacts / f'registry-{args.b_owner}.json').write_text(json.dumps(registry, indent=1) + '\n')
        # Real continuity at the home so forwarded reads return rows.
        for task in ('registry-foreign', 'ledger-foreign'):
            status, value, _ = b.http('POST', '/v1/sessions/resolve', {'sessionRef': scope(task) + '/lane:main', 'create': True})
            assert status == 200, (status, value)
        _, tail, _ = b.http('GET', '/v1/events/tail?limit=1')
        incarnation = tail['ledgerIncarnationId']
        for owner in args.owners.split(','):
            for tag, config in configs:
                a.write_config(config)
                proc = a.up(owner, args.binary, tag)
                cases = observations.setdefault(owner, {})

                def case(name, method, path, body=None, stream=False):
                    status, value, home = a.http(method, path, body, stream_for=3 if stream else None)
                    cases[f'{tag}:{name}'] = {'status': status, 'body': value, 'homeNode': home}

                _, st, _ = a.http('GET', '/v1/status')
                cases[f'{tag}:status-node'] = {'status': 200, 'body': st['node'], 'homeNode': None}
                case('locate:missing', 'GET', '/v1/federation/locate')
                case('locate:blank', 'GET', '/v1/federation/locate?scopeRef=%20')
                case('locate:invalid', 'GET', '/v1/federation/locate?scopeRef=bogus')
                case('locate:invalid-task', 'GET', '/v1/federation/locate?scopeRef=' + quote(f'agent:{AGENT}:project:x:task:'))
                case('locate:unknown-agent', 'GET', '/v1/federation/locate?scopeRef=' + quote('agent:nobody-n4:project:' + PROJECT))
                for task in ('unbound', 'local', 'retired', 'ledger-foreign', 'registry-foreign', 'registry-local', 'unborn'):
                    case('locate:' + task, 'GET', '/v1/federation/locate?scopeRef=' + quote(scope(task)))
                case('locate:trimmed', 'GET', '/v1/federation/locate?scopeRef=' + quote(' ' + scope('local') + ' '))
                case('designations:missing', 'GET', '/v1/federation/designations')
                case('designations:false', 'GET', '/v1/federation/designations?unborn=false')
                case('designations:true', 'GET', '/v1/federation/designations?unborn=true')
                case('fedruntimes:all', 'GET', '/v1/federation/runtimes')
                case('fedruntimes:status', 'GET', '/v1/federation/runtimes?status=ready,stale')
                case('fedruntimes:bad-filter', 'GET', '/v1/federation/runtimes?limit=abc')
                for task in ('unbound', 'local', 'retired', 'ledger-foreign', 'registry-foreign'):
                    s = quote(scope(task))
                    case('runs:' + task, 'GET', f'/v1/runs?scopeRef={s}')
                    case('events-tail:' + task, 'GET', f'/v1/events/tail?scopeRef={s}&limit=5')
                    case('bounded-bad:' + task, 'GET', f'/v1/events/bounded-stream?scopeRef={s}')
                    case('bounded:' + task, 'GET', f'/v1/events/bounded-stream?scopeRef={s}&ledgerIncarnationId={incarnation}&afterSeq=0&follow=true', stream=True)
                    case('sessions-get:' + task, 'GET', f'/v1/sessions/get?scopeRef={s}&laneRef=main')
                    case('metadata-get:' + task, 'GET', f'/v1/sessions/metadata?scopeRef={s}&laneRef=main')
                    case('resolve:' + task, 'POST', '/v1/sessions/resolve', {'sessionRef': scope(task) + '/lane:main'})
                    case('resolve-false:' + task, 'POST', '/v1/sessions/resolve', {'sessionRef': scope(task) + '/lane:main', 'create': False})
                case('runs:trimmed-scope', 'GET', '/v1/runs?scopeRef=' + quote(' ' + scope('registry-foreign') + ' '))
                case('runs:non-agent-scope', 'GET', '/v1/runs?scopeRef=server:hrc')
                case('resolve:bad-ref', 'POST', '/v1/sessions/resolve', {'sessionRef': scope('registry-foreign')})
                case('metadata-patch:not-object', 'PATCH', '/v1/sessions/metadata', [])
                case('metadata-patch:retired', 'PATCH', '/v1/sessions/metadata', {'scopeRef': scope('retired'), 'laneRef': 'main', 'set': {'n4': 'x'}})
                if not bun and tag == 'none':
                    check_seed(registry, cases)
                a.down(proc)
        print(json.dumps({owner: len(c) for owner, c in observations.items()}))
    finally:
        for owner, cases in observations.items():
            (args.artifacts / owner).mkdir(exist_ok=True)
            (args.artifacts / owner / 'federation.json').write_text(json.dumps(cases, indent=1) + '\n')
        (args.artifacts / 'steps.json').write_text(json.dumps({'a': a.steps, 'b': b.steps}, indent=1) + '\n')
        a.cleanup()
        b.cleanup()
        # The real federation.json was never a config path for either node.
        assert str(real) not in json.dumps(a.env) + json.dumps(b.env)


if __name__ == '__main__':
    main()
