#!/usr/bin/env python3
"""N4 federation reads on two scratch nodes, recorded for a per-case compare.

Node B is a scratch Bun registry host with a peer listener. Node A runs one
owner (bun, then native, on the same store) under four federation configs:
none (no file), peerless, peered (B is the sole peer and registry host) and
peer-down (B's ports point nowhere). Each config is a fresh daemon start.

Failure modes this guards: a home decision that differs from Bun's for a
ledger, registry or unconfigured scope; a refusal (session_home_unknown,
_pending, _unreachable) with another status, code or detail; a forwarded read
that loses the home's status, body or x-hrc-home-node header; a bounded-stream
relay that rewrites records; locate/designations views with different keys,
order or values; and a scratch node reaching the real federation.json,
registry or peers (every config, token and port here is private).
"""
import argparse
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

from n2_scratch import LEAK_PREFIXES, UnixHTTP, copy_release, preflight_unmanaged

TAILNET = '100.73.60.81'
PROJECT = 'n4-t11872'
AGENT = 'tabularasa'
DYNAMIC = {'checkedAt', 'answeredAt', 'latencyMs'}


def free_port():
    with socket.socket() as s:
        s.bind((TAILNET, 0))
        return s.getsockname()[1]


class Node:
    def __init__(self, root, installed, aspd, artifacts, name):
        self.root = Path(root).absolute()
        self.root.mkdir(parents=True)
        self.name = name
        self.artifacts = artifacts
        self.release = copy_release(installed, self.root / 'bun-release')
        self.project = self.root / PROJECT
        self.project.mkdir()
        for d in ('run', 'state'):
            (self.root / d).mkdir()
        self.config = self.root / 'federation.json'
        bin_dir = self.root / 'bin'
        bin_dir.mkdir()
        (bin_dir / 'hrc').symlink_to(self.release / 'packages/hrc-cli/bin/hrc.js')
        env = {k: v for k, v in os.environ.items() if not k.startswith(LEAK_PREFIXES)}
        env['PATH'] = str(bin_dir) + os.pathsep + os.environ.get('PATH', '')
        env.update(HRC_RUNTIME_DIR=str(self.root / 'run'), HRC_STATE_DIR=str(self.root / 'state'),
                   ASP_PROJECT_ROOT_OVERRIDE=str(self.project), HRC_PROJECT_SEARCH_ROOTS=str(self.project),
                   HRC_WRKQ_DB=str(self.root / 'wrkq.db'), WRKQ_DB=str(self.root / 'wrkq.db'),
                   WRKQ_PRINCIPAL_REF='agent:clod', HRC_WRKQD_TOKEN_FILE='', WRKQD_TOKEN_FILE='', WRKQD_TOKEN='',
                   HRC_PEER_CONFIG_FILE=str(self.config), HRC_EVENT_INGEST_SOCKET=str(self.root / 'run/ingest.sock'),
                   HRC_ACP_WEBHOOK_URL='', HRC_ASPD_SOCKET=str(Path(aspd).resolve()))
        self.env = env
        self.provenance = preflight_unmanaged(self.release, env)
        self.socket = self.root / 'run/hrc.sock'
        self.db = self.root / 'state/state.sqlite'
        self.steps, self.procs, self.logs = [], [], []
        self.run('git-init', ['git', 'init', '-q'])
        self.run('wrkq-migrate', ['wrkqadm', 'migrate'])
        self.bun_store('schema', 'openHrcDatabase(a[0]).close()', self.db)

    def run(self, name, argv, stdin=None):
        r = subprocess.run([str(a) for a in argv], env=self.env, cwd=self.project, input=stdin,
                           capture_output=True, text=True, timeout=300)
        self.steps.append({'name': name, 'argv': [str(a) for a in argv], 'exit': r.returncode,
                           'stdout': r.stdout[-4000:], 'stderr': r.stderr[-4000:]})
        assert r.returncode == 0, (name, r.stdout, r.stderr)
        return r.stdout

    def bun_store(self, name, body, *args):
        """Fixture writes go through the copied release's own store code."""
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

    def up(self, owner, binary, tag):
        log = (self.artifacts / f'{self.name}-{owner}-{tag}.log').open('w')
        self.logs.append(log)
        argv = [binary, 'server'] if owner == 'native' else [
            'bun', self.release / 'packages/hrc-cli/src/cli.ts', 'server', 'serve']
        proc = subprocess.Popen([str(a) for a in argv], env=self.env, cwd=self.project, stdout=log, stderr=log)
        self.procs.append(proc)
        for _ in range(300):
            assert proc.poll() is None, (owner, tag, 'owner exited', proc.returncode)
            try:
                status, value, _ = self.http('GET', '/v1/status')
                if status == 200:
                    if owner == 'native':
                        assert Path(value['binaryPath']).resolve() == Path(binary).resolve()
                    else:
                        assert Path(value['packagePath']).resolve().is_relative_to(self.release)
                        assert value['release']['mode'] == 'unmanaged', value['release']
                    self.steps.append({'name': f'{owner}-{tag}-up', 'pid': proc.pid})
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


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--binary', type=Path, required=True)
    p.add_argument('--installed-release', type=Path, required=True)
    p.add_argument('--aspd-socket', type=Path, required=True)
    p.add_argument('--scratch-root', type=Path, required=True)
    p.add_argument('--artifacts', type=Path, required=True)
    p.add_argument('--owners', default='bun,native')
    # B as native exercises the native registry listener from a Bun origin.
    p.add_argument('--b-owner', choices=['bun', 'native'], default='bun')
    args = p.parse_args()
    if args.scratch_root.exists():
        raise SystemExit('scratch root must be fresh')
    args.artifacts.mkdir(parents=True, exist_ok=True)
    real = Path.home() / 'praesidium/var/state/hrc/federation.json'
    a = Node(args.scratch_root / 'a', args.installed_release, args.aspd_socket, args.artifacts, 'a')
    b = Node(args.scratch_root / 'b', args.installed_release, args.aspd_socket, args.artifacts, 'b')
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
