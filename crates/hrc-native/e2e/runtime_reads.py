#!/usr/bin/env python3
"""Real-seat runtime reads against sequential owners on one scratch snapshot.

Failure modes: absent/empty seat, ignored filters or cursors, lost identity,
incorrect errors, stale owner diagnostics, fabricated live probes, token leaks,
and accidental event ACK/projection. Bun establishes the acknowledged baseline;
native only reads the actual worker. Historical rows come from Bun's public
repository and carry no broker endpoints. Cleanup is fenced to this scope/root.
"""
import argparse
from http.client import HTTPException
import json
import os
from pathlib import Path
import signal
import shutil
import socket
import sqlite3
import subprocess
import time
from urllib.parse import urlencode

from foundation import UnixHTTP


def main(case_factory=None, observe=None, paginate=True, before_subject=None, before_request=None):
    p = argparse.ArgumentParser()
    p.add_argument('--binary', type=Path, required=True)
    p.add_argument('--bun-release', type=Path, required=True)
    p.add_argument('--aspd-socket', type=Path, required=True)
    p.add_argument('--scratch-root', type=Path, required=True)
    p.add_argument('--artifacts', type=Path, required=True)
    args = p.parse_args()
    if any(os.environ.get(k) for k in ('CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CODEX_SANDBOX')):
        raise RuntimeError('run this workflow from a clean ghostmux terminal')
    root = args.scratch_root.absolute()
    if root.exists():
        raise RuntimeError('scratch root must be fresh: ' + str(root))
    root.mkdir(parents=True)
    args.artifacts.mkdir(parents=True, exist_ok=True)
    release = args.bun_release.resolve()
    assert release.parent.name != 'hrc-runtime-releases'
    bin_dir = root / 'bin'
    bin_dir.mkdir()
    cli = release / 'packages/hrc-cli/bin/hrc.js'
    assert cli.is_file()
    (bin_dir / 'hrc').symlink_to(cli)
    project = root / 'n1-t11818'
    project.mkdir()
    (root / 'run').mkdir()
    (root / 'state').mkdir()
    config = root / 'federation.json'
    config.write_text(json.dumps({'nodeId': 'n1-t11818', 'peers': {}}))
    config.chmod(0o600)
    env = dict(os.environ, PATH=str(bin_dir)+os.pathsep+os.environ.get('PATH',''))
    assert Path(shutil.which('hrc',path=env['PATH'])).resolve()==cli.resolve()
    for k in ('HRC_SESSION_REF', 'HRC_RUNTIME_ID', 'HRC_RUN_ID', 'HRC_HOST_SESSION_ID',
              'HRC_EVENT_FORWARD_URL', 'HRC_EVENT_INGEST_TCP_PORT', 'HRC_EVENT_FORWARD_SOURCE_REF',
              'WRKQ_DB_PATH', 'WRKQ_DB_PATH_FILE', 'WRKQD_NODE_TOKENS', 'WRKQD_NODE_TOKENS_FILE', 'WRKQD_UNIX'):
        env.pop(k, None)
    env.update(HRC_RUNTIME_DIR=str(root / 'run'), HRC_STATE_DIR=str(root / 'state'),
               ASP_PROJECT_ROOT_OVERRIDE=str(project), HRC_PROJECT_SEARCH_ROOTS=str(project),
               HRC_WRKQ_DB=str(root / 'wrkq.db'), WRKQ_DB=str(root / 'wrkq.db'),
               WRKQ_PRINCIPAL_REF='agent:cody',
               HRC_WRKQD_TOKEN_FILE='', WRKQD_TOKEN_FILE='', WRKQD_TOKEN='',
               HRC_PEER_CONFIG_FILE=str(config), HRC_EVENT_INGEST_SOCKET=str(root / 'run/ingest.sock'),
               HRC_ACP_WEBHOOK_URL='', HRC_ASPD_SOCKET=str(args.aspd_socket.resolve()),
               HRC_BROKER_DURABLE_IPC_ENABLED='1', HRC_HEADLESS_CODEX_BROKER_ENABLED='1',
               HRC_CLAUDE_CODE_TMUX_BROKER_ENABLED='1')
    db_path = root / 'state/state.sqlite'
    scope = 'agent:tabularasa:project:n1-t11818:task:native-' + str(time.time_ns())
    steps, gates, owners, logs = [{'name':'named-bun-cli','resolvedPath':str(cli.resolve()),'releasePath':str(release)}], {}, [], []
    def command(name, argv, timeout=120):
        run = subprocess.run([str(v) for v in argv], env=env, cwd=project,
                             capture_output=True, text=True, timeout=timeout)
        steps.append({'name': name, 'argv': [str(v) for v in argv], 'exit': run.returncode,
                      'stdout': run.stdout, 'stderr': run.stderr})
        assert run.returncode == 0, (name, run.returncode, run.stdout, run.stderr)
        return json.loads(run.stdout) if run.stdout.strip().startswith(('{', '[')) else run.stdout
    def rows(sql, params=()):
        with sqlite3.connect(f'file:{db_path}?mode=ro', uri=True) as db:
            db.row_factory = sqlite3.Row
            return [dict(row) for row in db.execute(sql, params)]
    def http(method, path, body=None):
        c = UnixHTTP(root / 'run/hrc.sock')
        c.request(method, path, json.dumps(body) if body is not None else None,
                  {'Content-Type': 'application/json'})
        res = c.getresponse()
        raw = res.read().decode()
        response_headers={k.lower():v for k,v in res.getheaders() if k.lower()=='x-hrc-next-cursor'}
        c.close()
        return res.status, raw, response_headers
    def up(kind, index):
        log = (args.artifacts / f'{kind}-{index}.log').open('w')
        logs.append(log)
        argv = [args.binary.resolve(), 'server'] if kind == 'native' else [
            'bun', release / 'packages/hrc-cli/src/cli.ts', 'server', 'serve']
        proc = subprocess.Popen([str(a) for a in argv], env=env, cwd=project, stdout=log, stderr=log)
        owners.append(proc)
        for _ in range(200):
            assert proc.poll() is None, (kind, 'owner exited', proc.returncode)
            try:
                status, raw, _ = http('GET', '/v1/status')
                value = json.loads(raw)
                if status == 200:
                    if kind == 'native':
                        assert Path(value['binaryPath']).resolve() == args.binary.resolve()
                    else:
                        assert Path(value['packagePath']).resolve().is_relative_to(release)
                        assert value['release']['mode'] == 'unmanaged'
                    return proc
            except (OSError, HTTPException):
                pass
            time.sleep(.1)
        raise AssertionError(kind + ' not ready')
    def down(proc):
        proc.send_signal(signal.SIGTERM)
        proc.wait(timeout=20)
        steps.append({'name': 'owner-shutdown', 'pid': proc.pid, 'exit': proc.returncode})
        assert proc.returncode == 0
    def wait_completed(run_id):
        for _ in range(900):
            matches = rows("SELECT * FROM hrc_events WHERE run_id=? AND event_kind='turn.completed'", (run_id,))
            if matches:
                return matches
            time.sleep(.1)
        raise AssertionError('turn did not complete: ' + run_id)
    try:
        command('project-init', ['git', 'init', '-q'])
        command('wrkq-migrate', ['wrkqadm', 'migrate'])
        command('wrkq-project', ['wrkq', 'mkdir', '/n1-t11818', '--kind', 'project', '--json'])
        command('wrkq-root', ['wrkq', 'set', '/n1-t11818', '--root', project, '--json'])
        command('schema-create', ['bun', '-e',
            f'import {{openHrcDatabase}} from {json.dumps(str(release / "packages/hrc-store-sqlite/src/database.ts"))};openHrcDatabase(process.argv[1]).close()', db_path])
        bun = up('bun', 0)
        start = command('bun-ordinary-start', ['hrc', 'start', scope, '--project-id', 'n1-t11818',
                        '--project-root', project, '--cwd', project, '-p',
                        'Reply with exactly the word OK and nothing else. No tools.', '--json'])
        runtime = start['runtime']['runtimeId']
        wait_completed(start['runtime']['runId'])
        host = start['session']['hostSessionId'] if 'session' in start else rows('SELECT host_session_id FROM runtimes WHERE runtime_id=?',(runtime,))[0]['host_session_id']
        down(bun)
        # Establish and persist a real Bun replay/ACK checkpoint before the
        # shared snapshot. N1 may report that known checkpoint but cannot ACK
        # any event itself. The daemon owner changes, the broker does not.
        primer=up('bun',2)
        for _ in range(300):
            state=json.loads(rows('SELECT runtime_state_json FROM runtimes WHERE runtime_id=?',(runtime,))[0]['runtime_state_json'])
            replay=state.get('brokerReplay',{})
            if replay.get('activeControllerInstanceId')==f'hrc-server:{primer.pid}' and replay.get('ackedThroughSeq',-1)==replay.get('currentSeq'):
                break
            time.sleep(.05)
        else:raise AssertionError('Bun did not establish a fully acknowledged baseline')
        down(primer)
        fixture='''import {openHrcDatabase} from PATH;
const db=openHrcDatabase(process.argv[1]), live=db.runtimes.getByRuntimeId(process.argv[2]);
for(const [suffix,status] of [['old-a','terminated'],['old-b','failed']]) db.runtimes.insert({runtimeId:live.runtimeId+'-'+suffix,hostSessionId:live.hostSessionId,scopeRef:live.scopeRef,laneRef:live.laneRef,generation:live.generation,transport:'sdk',status,supportsInflightInput:false,createdAt:'2026-01-01T00:00:00.000Z',updatedAt:'2026-01-01T00:00:00.000Z'});
db.close();'''.replace('PATH',json.dumps(str(release/'packages/hrc-store-sqlite/src/database.ts')))
        command('historical-runtime-fixture',['bun','-e',fixture,db_path,runtime])
        # Bun's N2 legacy-startup job classifies the historical controllerless
        # failed row as stale. Finish that setup once before the shared snapshot;
        # this workflow compares reads, not the deferred N2 startup job.
        history_owner=up('bun',3)
        for _ in range(300):
            if rows('SELECT status FROM runtimes WHERE runtime_id=?',(runtime+'-old-b',))[0]['status']=='stale':break
            time.sleep(.05)
        else:raise AssertionError('Bun historical setup did not settle')
        down(history_owner)
        with sqlite3.connect(db_path) as source,sqlite3.connect(root/'snapshot.sqlite') as target:source.backup(target)
        q=lambda **kw:'/v1/runtimes?'+urlencode(kw)
        cases=[('runtimes','GET','/v1/runtimes',None),
               ('runtimes-all','GET',q(all='true'),None),
               ('runtimes-page','GET',q(all='true',limit='1'),None),
               ('runtimes-terminal','GET',q(all='true',status='stale,terminated'),None),
               ('runtimes-terminal-hidden','GET',q(status='terminated'),None),
               ('runtimes-host','GET',q(hostSessionId=host),None),
               ('runtimes-scope','GET',q(scope=scope),None),
               ('runtimes-agent','GET',q(agent='tabularasa'),None),
               ('runtimes-task','GET',q(task=scope.rsplit(':',1)[1]),None),
               ('runtimes-other-agent','GET',q(agent='absent'),None),
               ('runtimes-other-host','GET',q(hostSessionId='absent'),None),
               ('runtimes-status','GET',q(status='ready,busy'),None),
               ('runtimes-unknown-status','GET',q(status='absent'),None),
               ('runtimes-transport','GET',q(transport='headless'),None),
               ('runtimes-stale','GET',q(stale='true',olderThan='24h'),None),
               ('runtimes-bool','GET',q(all='yes'),None),
               ('runtimes-transport-invalid','GET',q(transport='bad'),None),
               ('runtimes-limit-zero','GET',q(limit='0'),None),
               ('runtimes-limit-negative','GET',q(limit='-1'),None),
               ('runtimes-limit-fraction','GET',q(limit='1.2'),None),
               ('runtimes-limit-overflow','GET',q(limit='501'),None),
               ('runtimes-cursor','GET',q(cursor='bad'),None),
               ('runtimes-duration','GET',q(olderThan='24'),None),
               ('inspect','POST','/v1/runtimes/inspect',{'runtimeId':runtime}),
               ('inspect-array','POST','/v1/runtimes/inspect',[]),
               ('inspect-number','POST','/v1/runtimes/inspect',1),
               ('inspect-owner-null','POST','/v1/runtimes/inspect',{'runtimeId':runtime,'ownerRunId':None}),
               ('inspect-owner-empty','POST','/v1/runtimes/inspect',{'runtimeId':runtime,'ownerRunId':''}),
               ('inspect-trimmed','POST','/v1/runtimes/inspect',{'runtimeId':' '+runtime+' '}),
               ('inspect-missing','POST','/v1/runtimes/inspect',{}),
               ('inspect-unknown','POST','/v1/runtimes/inspect',{'runtimeId':'absent'}),
               ('seat','GET','/v1/runtimes/'+runtime+'/seat',None),
               ('seat-encoded','GET','/v1/runtimes/%72'+runtime[1:]+'/seat',None),
               ('seat-inactive','GET','/v1/runtimes/'+runtime+'-old-a/seat',None),
               ('inspect-inactive','POST','/v1/runtimes/inspect',{'runtimeId':runtime+'-old-a'}),
               ('seat-unknown','GET','/v1/runtimes/absent/seat',None),
               ('target','GET','/v1/targets/by-session-ref?'+urlencode({'sessionRef':scope+'/lane:main'}),None),
               ('target-default','GET','/v1/targets/by-session-ref?'+urlencode({'sessionRef':scope+'/lane:default'}),None),
               ('target-invalid','GET','/v1/targets/by-session-ref?sessionRef=bad',None),
               ('target-missing','GET','/v1/targets/by-session-ref',None),
               ('target-unknown','GET','/v1/targets/by-session-ref?'+urlencode({'sessionRef':scope+'-absent/lane:main'}),None)]
        if case_factory is not None:cases=case_factory(runtime,host,scope,root)
        observations={}
        for kind in ('bun','native'):
            with sqlite3.connect(root/'snapshot.sqlite') as source,sqlite3.connect(db_path) as target:source.backup(target)
            owner_before=time.time()
            owner=up(kind,1)
            if before_subject is not None: before_subject(kind, db_path, root)
            values=[]
            for name,method,path,body in cases:
                initial = before_request(kind, name, db_path) if before_request is not None else None
                before=time.time()
                status,raw,headers=http(method,path,body)
                try:response=json.loads(raw)
                except json.JSONDecodeError:response=raw
                persisted_probe=None
                if name.startswith('seat') and status==200:
                    persisted_state=rows('SELECT runtime_state_json FROM runtimes WHERE runtime_id=?',(response['runtimeId'],))[0]['runtime_state_json']
                    persisted_probe=json.loads(persisted_state or '{}').get('brokerDispatchDiagnostics',{}).get('liveSeatProbe')
                record={'persistedProbe':persisted_probe,'case':name,'method':method,'path':path,'request':body,'status':status,'body':response,'headers':headers,'before':before,'after':time.time(),'ownerPid':owner.pid,'ownerBefore':owner_before}
                if initial is not None: record["initial"] = initial
                if observe is not None:record.update(observe(kind,record,db_path))
                values.append(record)
            if paginate:
                page=next(r for r in values if r['case']=='runtimes-page')
                cursor=page['headers'].get('x-hrc-next-cursor','missing')
                before=time.time()
                path=q(all='true',limit='1',cursor=cursor)
                status,raw,headers=http('GET',path)
                values.append({'persistedProbe':None,'case':'runtimes-next','method':'GET','path':path,'request':None,'status':status,'body':json.loads(raw),'headers':headers,'before':before,'after':time.time(),'ownerPid':owner.pid,'ownerBefore':owner_before})
            observations[kind]=values
            down(owner)
        for kind,values in observations.items():
            directory=args.artifacts/kind
            directory.mkdir(exist_ok=True)
            (directory/'observations.json').write_text(json.dumps(values,indent=2)+'\n')
        (args.artifacts/'observations.json').write_text(json.dumps(observations,indent=2)+'\n')
        gates['workflow']={'pass':True,'runtimeId':runtime,'hostSessionId':host}
    finally:
        # Every candidate came from our own fresh database. Validate both scope
        # and destination before cleaning only this workflow's tmux servers.
        if db_path.exists():
            for record in rows('SELECT scope_ref,runtime_state_json FROM runtimes'):
                assert record['scope_ref'] == scope, record['scope_ref']
                state = json.loads(record['runtime_state_json'] or '{}')
                path = state.get('tmux', {}).get('socketPath')
                if path:
                    assert Path(path).resolve().is_relative_to((root / 'run').resolve())
                    subprocess.run(['tmux', '-S', path, 'kill-server'], capture_output=True, timeout=5)
        for owner in owners:
            if owner.poll() is None:
                owner.terminate()
                owner.wait(timeout=20)
        for log in logs:
            log.close()
        (args.artifacts / 'results.json').write_text(json.dumps({'gates': gates, 'steps': steps, 'scratchRoot': str(root)}, indent=2) + '\n')
    assert gates.get('workflow',{}).get('pass')
    print(json.dumps({'pass':['runtime-read-baseline'],'artifacts':str(args.artifacts)}))




if __name__ == '__main__':
    main()
