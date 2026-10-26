#!/usr/bin/env python3
"""Bun/native origins forward a verified primary's grant to the owned Bun peer.

Failure modes: origin acts instead of target; peer attestation loses identity;
restart proof accepts an unchanged process; missing proof fields pass; target
credentials leak into evidence; cleanup touches production. Native peer receive
is explicitly outside this drive. Every target actuation uses the one approved
/tmp/n5-server-owned-11819 owner. The origin is disposable and only receives
plain SIGTERM during fixture handoff/cleanup.
"""
import argparse
import json
import os
from pathlib import Path
import secrets
import shutil
import signal
import socket
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import uuid

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT/'crates/hrc-cli/e2e'))
from copied_release import copied_bun_cli, preflight_unmanaged
from foundation import UnixHTTP
from metrics_isolation import MetricsIsolation


def main(isolation):
    parser = argparse.ArgumentParser()
    for name in ('binary', 'oracle', 'environment', 'seat', 'artifacts'):
        parser.add_argument('--'+name, type=Path, required=True)
    parser.add_argument('--federation-host', default='100.73.60.81')
    args = parser.parse_args()
    args.artifacts.mkdir(parents=True, exist_ok=True)
    target = Path('/tmp/n5-server-owned-11819')
    assert args.environment.resolve() == (target/'environment.json').resolve()
    assert not (target/'run/hrc.sock').exists() and not (target/'run/server.lock').exists()
    source = json.loads(args.environment.read_text())
    assert source['HRC_RUNTIME_DIR'] == str(target/'run') and source['HRC_STATE_DIR'] == str(target/'state')
    assert source['HRC_WRKQ_DB'].startswith('rpc://127.0.0.1:')
    env = {k:v for k,v in os.environ.items() if not k.startswith(('ASP_', 'HRC_', 'WRKQ', 'HARNESS_BROKER_'))}
    env.update(source)
    env.pop('XPC_SERVICE_NAME', None)
    env.pop('HRC_LAUNCHD_LABEL', None)
    production = Path.home()/'praesidium/var/run/hrc'
    def production_owner():
        return {n:dict(inode=(production/n).stat().st_ino, **({'pid':(production/n).read_text()} if n=='server.pid' else {})) for n in ('server.pid','hrc.sock')}
    production_before = production_owner()
    oracle = copied_bun_cli(args.oracle, target/'lifecycle-copy')
    bun = shutil.which('bun')
    processes = []
    cases = []
    runtime = None
    with tempfile.TemporaryDirectory(prefix='p-', dir=target) as temporary:
        origin = Path(temporary)
        origins = dict(env, HRC_RUNTIME_DIR=str(origin/'run'), HRC_STATE_DIR=str(origin/'state'))
        target_env = dict(env, HRC_PEER_CONFIG_FILE=str(origin/'target.json'))
        def raw(root, path, body=None, headers=None):
            http = UnixHTTP(root/'run/hrc.sock')
            http.request('POST' if body is not None else 'GET', path,
                         json.dumps(body) if body is not None else None,
                         dict(headers or {}, **{'content-type':'application/json'}))
            response = http.getresponse()
            value = json.loads(response.read())
            http.close()
            return response.status, value
        def call(root, path, body=None):
            code, value = raw(root, path, body)
            assert 200 <= code < 300, (code, value)
            return value
        def ready(root, previous=None):
            for _ in range(300):
                try:
                    status = call(root, '/v1/status')
                    pid = int((root/'run/server.pid').read_text())
                    if previous is None or previous != pid:
                        assert status['runtimeRoot'] == str(root/'run') and status['stateRoot'] == str(root/'state')
                        assert status['release']['mode'] != 'atomic'
                        isolation.pids.add(pid)
                        return pid, status
                except (OSError, ValueError):
                    pass
                time.sleep(.05)
            raise AssertionError('owned peer did not become healthy')
        def boot(root, owner, child_env):
            preflight_unmanaged(oracle, child_env, args.artifacts/'release-preflight.json')
            log = (args.artifacts/(('target' if root==target else 'origin')+'-'+owner+'.log')).open('a')
            command = [bun, str(oracle)] if owner=='bun' else [str(args.binary.resolve())]
            proc = subprocess.Popen(command+['server','serve'], cwd=root, env=child_env,
                                    stdin=subprocess.DEVNULL, stdout=log, stderr=log)
            processes.append(proc)
            threading.Thread(target=proc.wait, daemon=True).start()
            log.close()
            return ready(root)
        def down(root):
            if not (root/'run/server.pid').exists():
                return
            pid, _ = ready(root)
            os.kill(pid, signal.SIGTERM)
            for _ in range(400):
                if not (root/'run/hrc.sock').exists() and not (root/'run/server.lock').exists():
                    return
                time.sleep(.05)
            raise AssertionError('owned daemon did not release ownership')
        def rows(root):
            with sqlite3.connect('file:'+str(root/'state/state.sqlite')+'?mode=ro', uri=True) as db:
                return list(db.execute("SELECT hrc_seq,event_kind,payload_json FROM hrc_events WHERE scope_ref='server:hrc' AND source_ref IS NULL AND evidence_origin IS NULL ORDER BY hrc_seq"))
        try:
            boot(origin, 'bun', origins)
            profile = origin/'agents/mable'
            profile.mkdir(parents=True)
            (profile/'agent-profile.toml').write_text('version = 4\n[identity]\ndisplay = "N5 peer fixture"\n[provisioning]\nharness = "claude"\nyolo = true\n[spaces]\nbase = []\n')
            intent = json.loads(json.dumps(json.loads(args.seat.read_text())['intent']))
            intent.pop('initialPrompt', None)
            intent['placement']['agentRoot'] = str(profile)
            intent['placement']['bundle']['agentName'] = 'mable'
            intent['harness']['interactive'] = False
            ref = 'agent:mable:project:n5-t11819:task:primary/lane:peer-'+uuid.uuid4().hex[:8]
            host = call(origin, '/v1/sessions/resolve', dict(sessionRef=ref,create=True,summonIntent='explicit_local',runtimeIntent=intent))['hostSessionId']
            runtime = call(origin, '/v1/runtimes/start', dict(hostSessionId=host,intent=intent))['runtimeId']
            down(origin)
            ports = []
            for _ in range(2):
                with socket.socket() as probe:
                    probe.bind((args.federation_host, 0))
                    ports.append(probe.getsockname()[1])
            token = secrets.token_hex(24)
            for name, node, peer, port in [('origin','n5origin','n5target',ports[0]), ('target','n5target','n5origin',ports[1])]:
                config = dict(nodeId=node, peers={peer:dict(endpoint=f'http://{args.federation_host}:{port}',token=token)},gate=dict(mode='off'))
                if name=='target':config['peerListener'] = dict(bind=f'http://{args.federation_host}:{ports[0]}')
                path = origin/(name+'.json')
                path.write_text(json.dumps(config))
                path.chmod(0o600)
            origins['HRC_PEER_CONFIG_FILE'] = str(origin/'origin.json')
            baseline = {}
            for owner in ('bun','native'):
                boot(origin, owner, origins)
                for action in ('restart','stop'):
                    if not (target/'run/server.pid').exists():boot(target,'bun',target_env)
                    old, before = ready(target)
                    initial = rows(target)
                    origin_rows = rows(origin)
                    credential = (origin/'run/lifecycle'/(runtime+'.credential')).read_text().strip()
                    headers = {'x-hrc-lifecycle-runtime-id':runtime,'x-hrc-lifecycle-credential':credential,'x-hrc-lifecycle-session-ref':ref}
                    body = dict(action=action,targetNode='n5target',reason='Owned peer lifecycle qualification',proofTimeoutMs=5000)
                    code, response = raw(origin, '/v1/server/lifecycle', body, headers)
                    assert code==200 and response['accepted'] is True and response['targetNode']=='n5target',(code,response)
                    if action=='restart':
                        new, after = ready(target, old)
                        assert response['remote']['proven'] is True
                        assert response['remote']['beforeStartedAt']==before['startedAt']
                        assert response['remote']['afterStartedAt']==after['startedAt'] and before['startedAt']!=after['startedAt']
                    else:
                        new = None
                        for _ in range(400):
                            if not (target/'run/hrc.sock').exists() and not (target/'run/server.lock').exists():break
                            time.sleep(.05)
                        else:raise AssertionError('remote granted stop did not release owned target')
                    delta = [r for r in rows(target) if r[0] > initial[-1][0]]
                    assert [r[1] for r in delta]==(['server.shutting_down','server.stopped','server.started'] if action=='restart' else ['server.shutting_down','server.stopped'])
                    grant = response['grant']
                    assert grant['originNode']=='n5origin' and grant['requestedBy']==ref.split('/')[0] and grant['callerKind']=='mable-primary'
                    for row in delta[:2]:assert json.loads(row[2])['grant']==grant
                    assert rows(origin)==origin_rows, 'origin acted on itself'
                    assert production_owner()==production_before
                    (args.artifacts/f'{owner}-{action}.json').write_text(json.dumps(dict(response=response,beforePid=old,afterPid=new,rows=delta,originRowsUnchanged=True),indent=2)+'\n')
                    normalized = json.loads(json.dumps(response))
                    normalized['grant']['requestId'] = '<request id>'
                    if 'remote' in normalized:
                        normalized['remote']['beforeStartedAt'] = '<old boot>'
                        normalized['remote']['afterStartedAt'] = '<new boot>'
                    if owner=='bun':baseline[action] = normalized
                    else:assert normalized==baseline[action], (baseline[action],normalized)
                    cases.append(dict(owner=owner,action=action,**{'pass':True}))
                down(origin)
        finally:
            down(target)
            down(origin)
            if runtime is not None:
                boot(origin,'bun',origins)
                call(origin,'/v1/terminate',dict(runtimeId=runtime,reason='owned peer lifecycle cleanup'))
                assert call(origin,'/v1/runtimes/inspect',dict(runtimeId=runtime))['status']=='terminated'
                down(origin)
            assert production_owner()==production_before
            assert not list((origin/'run/lifecycle').glob('*.credential'))
            result = dict(cases=cases,**{'pass':len(cases)==4},productionUnchanged=True,
                          cleanup=dict(originSocketAbsent=not(origin/'run/hrc.sock').exists(),targetSocketAbsent=not(target/'run/hrc.sock').exists(),runtimeTerminated=runtime))
            (args.artifacts/'results.json').write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps(result))
    return int(not result['pass'])


if __name__=='__main__':
    with MetricsIsolation() as isolation:
        raise SystemExit(main(isolation))
