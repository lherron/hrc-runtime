#!/usr/bin/env python3
"""Self-brokered lifecycle on an isolated worktree daemon (T-13442).

Failure modes are in the task artifact's failure-modes.md. Imports the shared
launch fixture unchanged; delay is a launcher-local file switch, never daemon
configuration. Private DB backdating advances normal retirement/prune schedules.
"""
import argparse
import hashlib
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import shutil
import signal
import sqlite3
import sys
import time

from self_brokered import Aspd, LAUNCHER, HERE, Run, LEAK, daemon_env
from hrcpty_substrate import FakeAspd, alive, ops, descendants_of


class LifecycleAspd(Aspd):
    def handle(self, method, params):
        if method == 'aspc.compileHarnessInvocation':
            return FakeAspd.handle(self, method, params)
        return super().handle(method, params)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    for name in ('binary', 'scratch-root', 'artifacts', 'broker-module'):
        p.add_argument('--'+name, type=Path, required=True)
    p.add_argument('--baseline', action='store_true', help='reproduce termination graph leak only')
    a = p.parse_args()
    root = a.scratch_root.absolute()
    assert not root.exists()
    root.mkdir(parents=True)
    a.artifacts.mkdir(parents=True, exist_ok=True)
    project = root/'t12049'
    (project/'.praesidium').mkdir(parents=True)
    (project/'.praesidium/project.json').write_text(json.dumps({'id':'t12049'}))
    broker = root/'broker.mjs'
    broker.write_text(r'''const [mode, modulePath, ...args] = process.argv.slice(2);
const {runBrokerCli, createNoopDriver} = await import(modulePath);
process.argv = [process.argv[0], process.argv[1], mode, ...args];
await runBrokerCli({additionalDrivers:[() => {
  const d=createNoopDriver(); let ctx; let count=0;
  const start=d.start.bind(d); const caps=d.capabilities.bind(d);
  d.capabilities=() => ({...caps(), admission:{classes:['exclusive','queue']}, continuation:{supported:true}});
  d.start=async (spec,c) => {ctx=c; return start(spec,c);};
  d.applyInputNow=async input => {
    const turnId='lifecycle-'+(++count);
    setTimeout(() => {
      const extra={turnId,inputId:input.inputId};
      ctx.emit('turn.started',{turnId,source:'hook-observed'},extra);
      ctx.emit('continuation.updated',{provider:'external',kind:'thread',key:'sb42-thread'},extra);
      if (!JSON.stringify(input).includes('HOLD')) ctx.emit('turn.completed',{turnId,status:'completed',finalOutput:'LIFECYCLE-OK'},extra);
    },100);
    return {turnId,deliveryDisposition:'executed'};
  };
  return d;
}]});
''')
    launcher = root/'launcher.py'
    # Reuse the exact launcher, adding a filesystem-controlled pre-descriptor pause.
    source = LAUNCHER.replace("j=json.loads(Path(a['--registration']).read_text())",
        "while (Path(a['--project-root'])/'delay').exists(): time.sleep(.05)\n"
        "j=json.loads(Path(a['--registration']).read_text())")
    launcher.write_text('E2E='+repr(str(HERE))+'\nBROKER='+repr(str(broker))+'\n'+source)
    commands = {agent:[sys.executable, str(launcher), 'ok', str(a.broker_module)]
                for agent in ('subject','control','interrupted','foundry')}
    for agent in [*commands,'ordinary']:
        directory=root/'agents'/agent
        directory.mkdir(parents=True)
        (directory/'agent-profile.toml').write_text('# fake aspd declaration\n')
    fake=LifecycleAspd(root, commands, a.artifacts/'aspd.jsonl')
    release_root=root/'release'
    (release_root/'bin').mkdir(parents=True)
    stub=release_root/'bin/stub-broker'
    shutil.copy(HERE/'hrcpty_stub_broker.py',stub)
    stub.chmod(0o755)
    fake.release={'releaseId':'sb42-claude-control','sourceCommit':'1'*40,'builtAt':'2026-11-12T00:00:00Z',
        'releaseRoot':str(release_root),'worker':{'protocol':'harness-broker/0.2','executable':str(stub),
        'argvPrefix':[],'hostedDrivers':['claude-code-hrcpty']}}
    (release_root/'release.json').write_text(json.dumps({**fake.release,'protocol':'harness-broker/0.2',
        'hostedDrivers':['claude-code-hrcpty']}))
    (root/'federation.json').write_text(json.dumps({'nodeId':'sb42','peers':{}}))
    r=Run(root,a.artifacts,a.binary.resolve())
    r.env=daemon_env(dict({k:v for k,v in os.environ.items() if not k.startswith(LEAK)},
        HRC_RUNTIME_DIR=str(root/'run'),HRC_STATE_DIR=str(root/'state'),
        HRC_PEER_CONFIG_FILE=str(root/'federation.json'),HRC_ASPD_SOCKET=str(root/'aspd.sock'),
        ASP_PROJECT_ROOT_OVERRIDE=str(project),HRC_PROJECT_SEARCH_ROOTS=str(project),
        HRC_WRKQ_DB=str(root/'wrkq.db'),WRKQ_DB=str(root/'wrkq.db'),HRC_ACP_WEBHOOK_URL=''))
    report={'binary':str(r.binary),'binarySha256':hashlib.sha256(r.binary.read_bytes()).hexdigest()}
    def call(path,body): return r.http('POST',path,body,timeout=100)
    def scope(agent): return 'agent:'+agent+':project:t12049:task:'+('primary' if agent=='foundry' else 'lifecycle')
    def birth(agent):
        target=call('/v1/targets/ensure',{'sessionRef':scope(agent)+'/lane:main','runtimeIntent':{}})
        assert target[0]==200,target
        answer=call('/v1/runtimes/start',{'hostSessionId':target[1]['activeHostSessionId'],
            'intent':{'harness':{'id':'claude-code','interactive':False}}})
        assert answer[0]==200,answer
        row=r.runtime(answer[1]['runtimeId'])
        directory=Path(row['state']['broker']['substrate']['socketPath']).parent
        return {'id':row['runtime_id'],'host':row['host_session_id'],'generation':row['generation'],
                'child':int((directory/'child.pid').read_text()),'supervisor':int((directory/'hrcpty.pid').read_text()),'directory':directory}
    def turn(s):
        answer=call('/v1/turns',{'hostSessionId':s['host'],'prompt':'complete lifecycle turn',
            'runtimeIntent':{'harness':{'id':'claude-code','interactive':False}}})
        assert answer[0] in (200,202),answer
        run=answer[1]['runId']
        events=r.wait(lambda:r.rows("SELECT * FROM hrc_events WHERE run_id=? AND event_kind='turn.completed'",(run,)),30,'turn.completed ledger')
        row=r.rows('SELECT * FROM runs WHERE run_id=?',(run,))[0]
        assert row['status']=='completed',row
        return {'response':answer,'run':row,'completed':events}
    def ordinary():
        intent={'placement':{'agentRoot':str(project),'projectRoot':str(project),'cwd':str(project),
            'runMode':'task','bundle':{'kind':'compose','compose':[]},'dryRun':False},
            'harness':{'provider':'anthropic','interactive':True}}
        target=call('/v1/targets/ensure',{'sessionRef':scope('ordinary')+'/lane:main',
            'runtimeIntent':intent})
        assert target[0]==200,target
        answer=call('/v1/runtimes/start',{'hostSessionId':target[1]['activeHostSessionId'],
            'intent':intent})
        assert answer[0]==200,answer
        rid=answer[1]['runtimeId']
        row=r.runtime(rid)
        socket=Path(row['state']['broker']['substrate']['socketPath'])
        status=ops(socket,socket.parent/'attach.token','status')['status']
        assert status['child']['state']=='running' and status['broker']['state']=='running',status
        return {'id':rid,'child':status['child']['pid'],'socket':socket}
    def graph(s):
        return {'attempt':r.rows('SELECT state,disposition_reason,establishment_work_state FROM participant_registration_attempts WHERE runtime_id=?',(s['id'],)),
                'binding':r.rows('SELECT state FROM participant_host_bindings WHERE runtime_id=?',(s['id'],)),
                'reservation':r.rows('SELECT state FROM participant_address_reservations WHERE scope_ref=?',(r.runtime(s['id'])['scope_ref'],))}
    def ended(s):
        r.wait(lambda:not alive(s['child']) and not alive(s['supervisor']),20,'child and supervisor ended')
        g=graph(s)
        assert g['attempt'][0]['state']=='TERMINAL' and g['binding'][0]['state']=='RETIRED',g
        assert g['reservation'][0]['state']=='held',g
        return g
    def terminate(s,drop=False):
        body={'runtimeId':s['id']}
        if drop is not None: body['dropContinuation']=drop
        answer=call('/v1/terminate',body)
        assert answer[0]==200,answer
        return ended(s)
    try:
        owner=r.up('1')
        subject=birth('subject')
        if not a.baseline: report['firstTurn']=turn(subject)
        report['terminate']=terminate(subject)
        if a.baseline: return
        successor=birth('subject')
        assert successor['generation']==subject['generation']+1
        print('PASS terminate and generation successor',flush=True)
        report['terminate']['successor']=successor
        carried=json.loads((successor['directory']/'registration.json').read_text())
        assert carried['continuation']['carried'] is True,carried
        report['continuationKept']=carried['continuation']
        control=birth('control')
        claude=ordinary()
        report['claudeLive']=r.runtime(claude['id'])
        os.kill(successor['child'],signal.SIGKILL)
        r.wait(lambda:r.runtime(successor['id'])['status'] in ('stale','dead','crashed'),330,'G5 liveness pass')
        row=r.runtime(successor['id'])
        assert row['state'].get('staleReason')=='broker_hrcpty_child_exited',row
        probe=r.http('GET','/v1/attach?runtimeId='+control['id'])
        assert probe[0]==200,probe
        assert r.runtime(control['id'])['status']=='ready' and alive(control['child'])
        assert r.runtime(claude['id'])['status']=='ready' and alive(claude['child'])
        os.kill(claude['child'],signal.SIGKILL)
        time.sleep(.2)
        r.http('GET','/v1/attach?runtimeId='+claude['id'])
        r.wait(lambda:r.runtime(claude['id'])['status']=='stale',330,'ordinary Claude child exit')
        ordinary_row=r.runtime(claude['id'])
        assert ordinary_row['state']['staleReason']=='broker_hrcpty_child_exited',ordinary_row
        report['claudeExit']=ordinary_row
        print('PASS G5 self-brokered dead, live sibling, Claude unchanged',flush=True)
        report['G5']={'subject':row,'control':r.runtime(control['id']),'graph':ended(successor)}
        successor=birth('subject')
        assert successor['generation']==subject['generation']+2
        # Abrupt daemon loss while a second launch waits before descriptor.
        (project/'delay').touch()
        with ThreadPoolExecutor(1) as pool:
            future=pool.submit(birth,'interrupted')
            def pending():
                for path in (root/'run/bipc').glob('*/child.pid'):
                    reg=json.loads((path.parent/'registration.json').read_text())
                    if reg['scopeRef']==scope('interrupted'):
                        return path.parent,reg
            directory,reg=r.wait(pending,15,'interrupted child spawned')
            interrupted={'id':reg['identity']['runtimeId'],'child':int((directory/'child.pid').read_text()),
                         'supervisor':int((directory/'hrcpty.pid').read_text())}
            owner.kill();owner.wait(timeout=15)
            try: future.result(timeout=15)
            except Exception: pass  # daemon death cuts off the original HTTP request
        (project/'delay').unlink()
        owner=r.up('2')
        r.wait(lambda:not alive(interrupted['child']) and not alive(interrupted['supervisor']),20,'interrupted cleanup')
        attempt=r.rows('SELECT * FROM participant_registration_attempts WHERE runtime_id=?',(interrupted['id'],))[0]
        assert attempt['state']=='ABANDONED' and attempt['disposition_reason']=='launch_interrupted',attempt
        retry=birth('interrupted')
        assert retry['generation']==reg['generation']+1
        report['G7']={'interrupted':interrupted,'attempt':attempt,'successor':retry}
        r.wait(lambda:r.runtime(control['id'])['state']['control'].get('brokerAttached') is True,30,'participant reconnect')
        assert alive(control['child']) and int((control['directory']/'child.pid').read_text())==control['child']
        assert len(r.rows('SELECT * FROM participant_registration_attempts WHERE runtime_id=?',(control['id'],)))==1
        spawn_log=(a.artifacts/'supervisor-control.log')
        logs=[f for f in (root/'run/logs/hrcpty').glob('*.log') if str(control['directory']/'hrcpty.sock') in f.read_text()]
        assert len(logs)==1,logs
        text=logs[0].read_text()
        assert text.count('spawned child pid')==1,text
        spawn_log.write_text(text)
        report['G4']={'spawnCount':1,'sameChildPid':control['child'],'row':r.runtime(control['id']),'turn':turn(control)}
        print('PASS G4 same child and completed turn; G7 interrupted cleanup and successor',flush=True)
        # runtime.archive keep/drop maps to this exact terminate request.
        report['dropTurn']=turn(successor)
        report['drop']=terminate(successor,drop=True)
        dropped=birth('subject')
        registration=json.loads((dropped['directory']/'registration.json').read_text())
        assert registration['continuation']['carried'] is False,registration
        assert dropped['generation']==successor['generation']+1
        report['drop']['registration']=registration
        restart=call('/v1/sessions/restart',{'hostSessionId':dropped['host'],
            'expectedGeneration':dropped['generation'],'force':True})
        assert restart[0]==503 and restart[1]['error']['detail']['reason']=='participant_rotation_unsupported',restart
        report['selfRestartRefusal']=restart
        # Backdate Foundry's activity, then let the unmodified 300s pass retire it.
        foundry=birth('foundry')
        report['foundryTurn']=turn(foundry)
        with sqlite3.connect(r.db_path) as db:
            db.execute("UPDATE runtimes SET last_activity_at='2020-01-01T00:00:00Z' WHERE runtime_id=?",(foundry['id'],))
        r.wait(lambda:r.runtime(foundry['id'])['status']=='terminated',330,'Foundry idle retirement')
        report['retirement']=ended(foundry)
        retired_successor=birth('foundry')
        assert retired_successor['generation']==foundry['generation']+1
        selected=json.loads((retired_successor['directory']/'registration.json').read_text())
        assert selected['continuation']['carried'] is True,selected
        report['retirement']['successor']=selected
        # Ordinary startup IPC sweep, terminal TTL expired; no release holds it.
        held=call('/v1/turns',{'hostSessionId':control['host'],'prompt':'HOLD',
            'runtimeIntent':{'harness':{'id':'claude-code','interactive':False}}})
        assert held[0] in (200,202),held
        r.wait(lambda:r.rows("SELECT 1 FROM hrc_events WHERE run_id=? AND event_kind='turn.started'",(held[1]['runId'],)),15,'held turn starts')
        report['defaultKeep']=terminate(control,drop=None)
        kept=birth('control')
        kept_registration=json.loads((kept['directory']/'registration.json').read_text())
        assert kept_registration['continuation']['carried'] is True,kept_registration
        report['defaultKeep']['successor']=kept_registration
        with sqlite3.connect(r.db_path) as db:
            db.execute("UPDATE runtimes SET status_changed_at='2020-01-01T00:00:00Z',updated_at='2020-01-01T00:00:00Z' WHERE runtime_id=?",(control['id'],))
        os.utime(control['directory'],(946684800,946684800))
        owner.kill();owner.wait(timeout=15)
        owner=r.up('3')
        r.wait(lambda:not control['directory'].exists(),20,'terminal IPC prune')
        report['prune']={'removed':str(control['directory']),'terminalGraph':graph(control)}
        report['pass']=True
    finally:
        report['checks']=r.checks
        for token in (root/'run/bipc').glob('*/attach.token'):
            sock=token.parent/'hrcpty.sock'
            if sock.exists():
                try: ops(sock,token,'shutdown',{})
                except Exception: pass
        for owner in r.owners:
            if owner.poll() is None: r.down(owner)
        fake.close()
        for pid,_ in descendants_of([str(root)]):
            if pid!=os.getpid():
                try: os.kill(pid,signal.SIGKILL)
                except ProcessLookupError: pass
        for log in r.logs: log.close()
        time.sleep(.2)
        remaining=[(pid,cmd) for pid,cmd in descendants_of([str(root)]) if pid!=os.getpid()]
        report['cleanup']={'pass':not remaining,'remaining':remaining}
        if remaining: report['pass']=False
        (a.artifacts/'summary.json').write_text(json.dumps(report,indent=2,default=str)+'\n')
        assert not remaining,remaining
    print(json.dumps({'pass':True,'artifacts':str(a.artifacts)}))

if __name__=='__main__': main()
