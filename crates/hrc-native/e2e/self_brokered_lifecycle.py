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
import subprocess
import sys
import time

from self_brokered import Aspd, LAUNCHER, HERE, Run, LEAK, daemon_env, claim_body, session_invariants
from hrcpty_substrate import FakeAspd, alive, ops, descendants_of, canonical, start_hash
from n4_federation import local_tailnet_address, free_port


class LifecycleAspd(Aspd):
    def handle(self, method, params):
        if method == 'aspc.compileHarnessInvocation':
            assert params['compileRequest']['agent']['id']=='ordinary', 'self-brokered birth must not compile'
            result=FakeAspd.handle(self, method, params)
            request=params['compileRequest']
            start=result['plan']['execution']['dispatchRequest']['startRequest']
            if request.get('continuation'):
                start['spec']['continuation']=request['continuation']['broker']
                result['plan']['execution']['profile']['startRequestHash']=start_hash(start)
                result['plan']['planHash']=hashlib.sha256(canonical(result['plan']).encode()).hexdigest()
            return result
        return super().handle(method, params)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    for name in ('binary', 'scratch-root', 'artifacts', 'broker-module'):
        p.add_argument('--'+name, type=Path, required=True)
    p.add_argument('--archive-only', action='store_true', help='run repeated terminate and continuation gates only')
    p.add_argument('--baseline', action='store_true', help='reproduce termination graph leak only')
    p.add_argument('--reproduce-claims', action='store_true', help='record T-13451 defects without requiring fixes')
    p.add_argument('--doors-only', action='store_true', help='request-shape sweep only')
    p.add_argument('--claims-only', action='store_true', help='summon and first-allocation gates only')
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
                for agent in ('subject','control','interrupted','foundry','archive','summoned','doors','acktimeout')}
    for agent in [*commands,'ordinary']:
        directory=root/'agents'/agent
        directory.mkdir(parents=True)
        (directory/'agent-profile.toml').write_text('# fake aspd declaration\n')
    fake=LifecycleAspd(root, commands, a.artifacts/'aspd.jsonl')
    fake.node_id='sb42'
    release_root=root/'release'
    (release_root/'bin').mkdir(parents=True)
    stub=release_root/'bin/stub-broker'
    shutil.copy(HERE/'hrcpty_stub_broker.py',stub)
    # The ordinary Claude control emits a real continuation event and completes
    # CONT turns without the substrate fixture's question/answer interaction.
    stub.write_text(stub.read_text()
        .replace("if state['driver'] == 'codex-app-server' and 'CONT' in prompt:",
                 "if state['driver'] in ('codex-app-server','claude-code-hrcpty') and 'CONT' in prompt:")
        .replace("{'provider': 'openai', 'kind': 'thread',",
                 "{'provider': 'anthropic' if state['driver'] == 'claude-code-hrcpty' else 'openai', 'kind': 'thread',")
        .replace("(state['driver'] == 'codex-app-server' or ARGS.get('ops-only') == '1'):",
                 "(state['driver'] in ('codex-app-server','claude-code-hrcpty') or ARGS.get('ops-only') == '1'):")
        .replace("or state['driver'] == 'codex-app-server':",
                 "or state['driver'] in ('codex-app-server','claude-code-hrcpty'):"))
    stub.chmod(0o755)
    fake.release={'releaseId':'sb42-claude-control','sourceCommit':'1'*40,'builtAt':'2026-11-12T00:00:00Z',
        'releaseRoot':str(release_root),'worker':{'protocol':'harness-broker/0.2','executable':str(stub),
        'argvPrefix':[],'hostedDrivers':['claude-code-hrcpty']}}
    (release_root/'release.json').write_text(json.dumps({**fake.release,'protocol':'harness-broker/0.2',
        'hostedDrivers':['claude-code-hrcpty']}))
    host=local_tailnet_address()
    (root/'federation.json').write_text(json.dumps({'nodeId':'sb42','peers':{},
        'registry':{'bind':f'http://{host}:{free_port(host)}'},
        'gate':{'mode':'enforce','registryHost':'sb42'}}))
    r=Run(root,a.artifacts,a.binary.resolve())
    r.env=daemon_env(dict({k:v for k,v in os.environ.items() if not k.startswith(LEAK)},
        HRC_RUNTIME_DIR=str(root/'run'),HRC_STATE_DIR=str(root/'state'),
        HRC_PEER_CONFIG_FILE=str(root/'federation.json'),HRC_ASPD_SOCKET=str(root/'aspd.sock'),
        ASP_PROJECT_ROOT_OVERRIDE=str(project),HRC_PROJECT_SEARCH_ROOTS=str(project),
        HRC_WRKQ_DB=str(root/'wrkq.db'),WRKQ_DB=str(root/'wrkq.db'),HRC_ACP_WEBHOOK_URL=''))
    report={'binary':str(r.binary),'binarySha256':hashlib.sha256(r.binary.read_bytes()).hexdigest()}
    def call(path,body):
        result=r.http('POST',path,body,timeout=100)
        if not a.reproduce_claims:
            report.setdefault('sessionInvariants',[]).append({'door':path,'rows':session_invariants(r)})
        return result
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
    def turn(s,prompt='complete lifecycle turn'):
        answer=call('/v1/turns',{'hostSessionId':s['host'],'prompt':prompt,
            'runtimeIntent':{'harness':{'id':'claude-code','interactive':False}}})
        assert answer[0] in (200,202),answer
        run=answer[1]['runId']
        events=r.wait(lambda:r.rows("SELECT * FROM hrc_events WHERE run_id=? AND event_kind='turn.completed'",(run,)),30,'turn.completed ledger')
        row=r.rows('SELECT * FROM runs WHERE run_id=?',(run,))[0]
        assert row['status']=='completed',row
        return {'response':answer,'run':row,'completed':events}
    def ordinary(enqueue=False):
        intent={'placement':{'agentRoot':str(project),'projectRoot':str(project),'cwd':str(project),
            'runMode':'task','bundle':{'kind':'compose','compose':[]},'dryRun':False},
            'harness':{'provider':'anthropic','interactive':True}}
        target=call('/v1/targets/ensure',{'sessionRef':scope('ordinary')+'/lane:main',
            'runtimeIntent':intent})
        assert target[0]==200,target
        answer=(call('/v1/submissions/enqueue',{'target':scope('ordinary')+'/lane:main',
            'body':'CONT ordinary virgin enqueue','origin':{'principalRef':'agent:clod'},'runtimeIntent':intent,'wait':True})
            if enqueue else call('/v1/runtimes/start',{'hostSessionId':target[1]['activeHostSessionId'], 'intent':intent}))
        assert answer[0]==200,answer
        rid=answer[1]['runtimeId']
        row=r.runtime(rid)
        socket=Path(row['state']['broker']['substrate']['socketPath'])
        status=ops(socket,socket.parent/'attach.token','status')['status']
        assert status['child']['state']=='running' and status['broker']['state']=='running',status
        return {'id':rid,'host':row['host_session_id'],'child':status['child']['pid'],'socket':socket}
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
    def claim_gates():
        # Virgin ensure + enqueue: inspect every session, including ones the
        # continuity projection cannot expose. A disconnected active row fails.
        sc=scope('summoned')
        ensured=call('/v1/targets/ensure',{'sessionRef':sc+'/lane:main','runtimeIntent':{}})
        first=call('/v1/submissions/enqueue',{'target':sc+'/lane:main','body':'CONT first mail',
            'origin':{'principalRef':'agent:clod','envelopeId':'EN-T13451'},'wait':True})
        assert first[0]==200,first
        rid=first[1]['runtimeId']; row=r.runtime(rid)
        directory=Path(row['state']['broker']['substrate']['socketPath']).parent
        subject={'id':rid,'host':row['host_session_id'],'generation':row['generation'],
            'child':int((directory/'child.pid').read_text()),'supervisor':int((directory/'hrcpty.pid').read_text()),'directory':directory}
        r.wait(lambda:r.rows("SELECT 1 FROM hrc_events WHERE run_id=? AND event_kind='turn.completed'",(first[1]['runId'],)),30)
        sessions=r.rows('SELECT * FROM sessions WHERE scope_ref=? AND lane_ref=?',(sc,'main'))
        continuity=r.rows('SELECT * FROM continuities WHERE scope_ref=? AND lane_ref=?',(sc,'main'))[0]
        active=[x for x in sessions if x['status']=='active']
        report['B']={'ensure':ensured,'enqueue':first,'sessions':sessions,'continuity':continuity,
                     'pass':len(active)==1 and active[0]['host_session_id']==continuity['active_host_session_id']}
        terminate(subject)
        request=claim_body(r,sc,'T13451-retired')
        runs=r.rows('SELECT run_id FROM runs WHERE scope_ref=?',(sc,))
        answer=call('/v1/runtimes/start',request)
        report['A']={'request':request,'response':answer}
        if a.reproduce_claims:
            report['A']['reproduced']=answer[0]==409 and answer[1]['error']['code']=='session_scope_occupied'
            assert report['A']['reproduced'] and not report['B']['pass'],report
            return
        assert answer[0]==200,answer
        born=r.runtime(answer[1]['runtimeId'])
        newdir=Path(born['state']['broker']['substrate']['socketPath']).parent
        reg=json.loads((newdir/'registration.json').read_text())
        assert born['transport']=='hrcpty' and born['generation']==subject['generation']+1,born
        assert reg['continuation']['carried'],reg
        assert r.rows('SELECT run_id FROM runs WHERE scope_ref=?',(sc,))==runs,'summon must deliver nothing'
        assert answer[1]['claim']['hostSessionId']==born['host_session_id'],answer
        replay=call('/v1/runtimes/start',request)
        assert replay[0]==200 and replay[1]['runtimeId']==born['runtime_id'] and replay[1]['claim']['replayed'],replay
        attempt_count=len(r.rows('SELECT * FROM participant_registration_attempts'))
        live=call('/v1/runtimes/start',claim_body(r,sc,'T13451-live'))
        assert live[0]==409 and live[1]['error']['code']=='session_scope_occupied',live
        suffix=call('/v1/runtimes/start',claim_body(r,sc,'T13451-suffix','suffix'))
        assert suffix[0]==409,suffix
        assert len(r.rows('SELECT * FROM participant_registration_attempts'))==attempt_count
        assert len(r.rows('SELECT * FROM participant_registration_attempts WHERE runtime_id=?',(born['runtime_id'],)))==1
        assert len(r.rows('SELECT * FROM sessions WHERE scope_ref LIKE ?',(sc+'-%',)))==0
        report['A'].update(pass_=True,registration=reg,replay=replay,live=live,suffix=suffix)
        assert report['B']['pass'],report['B']
        initial=json.loads((directory/'registration.json').read_text())
        assert initial['hostSessionId']==ensured[1]['activeHostSessionId'] and initial['generation']==1,initial
        assert not initial['continuation']['carried'],initial
        report['B']['initialRegistration']=initial
        assert born['generation']==2,born
        call('/v1/terminate',{'runtimeId':born['runtime_id']})

        # Ordinary Claude discriminator: one session on virgin ensure + turn;
        # retired exact claims rotate and discard its reusable conversation.
        old=ordinary(enqueue=True); turn(old,'CONT ordinary discriminator')
        rows=r.rows('SELECT * FROM sessions WHERE scope_ref=?',(scope('ordinary'),))
        assert len(rows)==1 and rows[0]['status']=='active',rows
        live=call('/v1/runtimes/start',claim_body(r,scope('ordinary'),'T13451-ordinary-live'))
        assert live[0]==409 and live[1]['error']['code']=='session_scope_occupied',live
        assert call('/v1/terminate',{'runtimeId':old['id']})[0]==200
        r.wait(lambda:not alive(old['child']),20)
        fresh=call('/v1/runtimes/start',claim_body(r,scope('ordinary'),'T13451-ordinary-retired'))
        assert fresh[0]==200,fresh
        new=r.runtime(fresh[1]['runtimeId'])
        assert new['generation']>rows[0]['generation'] and new['host_session_id']!=old['host'],new
        frames=[json.loads(l) for l in (a.artifacts/'aspd.jsonl').read_text().splitlines()]
        req=next(x['request']['params']['compileRequest'] for x in frames if x.get('request',{}).get('method')=='aspc.compileHarnessInvocation' and x['request']['params']['compileRequest']['identity']['runtimeId']==new['runtime_id'])
        assert not req.get('continuation'),req
        report['ordinaryClaimControl']={'virginSessions':rows,'live':live,'fresh':fresh,'compileRequest':req}
        call('/v1/terminate',{'runtimeId':new['runtime_id']})
        print('PASS summon retired/live/replay/suffix and virgin session ownership; ordinary controls',flush=True)
    def door_gates():
        sc=scope('doors'); ref=sc+'/lane:main'; checks=report.setdefault('doors',{})
        def stop(rid):
            row=r.runtime(rid); directory=Path(row['state']['broker']['substrate']['socketPath']).parent
            child=int((directory/'child.pid').read_text()); supervisor=int((directory/'hrcpty.pid').read_text())
            assert call('/v1/terminate',{'runtimeId':rid})[0]==200
            r.wait(lambda:not alive(child) and not alive(supervisor),20)
        # Exact claim with no session at all (the normal new-scope summon).
        request=claim_body(r,sc,'T13451-virgin-exact')
        answer=call('/v1/runtimes/start',request); checks['virginExact']={'request':request,'response':answer}
        assert answer[0]==200 and answer[1]['generation']==1,answer
        host=answer[1]['hostSessionId']; rid=answer[1]['runtimeId']
        turn({'host':host},'CONT door sweep')
        stop(rid)
        # targets/ensure with a complete runtime intent still only ensures a
        # session; it must not start a child on a retired scope.
        intent=request['runtimeIntent']
        before=r.rows('SELECT attempt_id FROM participant_registration_attempts')
        ensured=call('/v1/targets/ensure',{'sessionRef':ref,'runtimeIntent':intent})
        assert ensured[0]==200 and r.rows('SELECT attempt_id FROM participant_registration_attempts')==before,ensured
        checks['ensureWithIntent']=ensured
        # The no-input resume chain used by prae summon --continuation resume.
        resumed=call('/v1/sessions/resume-continuation',{'sessionRef':ref,'intent':intent})
        assert resumed[0]==200,resumed
        answer=call('/v1/runtimes/start',{'hostSessionId':resumed[1]['hostSessionId'],'intent':intent,
            'restartStyle':'reuse_pty','allowStaleGeneration':True})
        assert answer[0]==200,answer
        assert r.runtime(answer[1]['runtimeId'])['generation']==2,answer
        rid=answer[1]['runtimeId']
        reg=json.loads((Path(r.runtime(rid)['state']['broker']['substrate']['socketPath']).parent/'registration.json').read_text())
        assert reg['continuation']['carried'],reg
        checks['resume']={'resumed':resumed,'started':answer,'registration':reg,
            'activeSessions':r.rows("SELECT host_session_id,generation FROM sessions WHERE scope_ref=? AND status='active'",(sc,))}
        assert len(checks['resume']['activeSessions'])==1,checks['resume']
        assert resumed[1]['hostSessionId']==answer[1]['hostSessionId'],checks['resume']
        before=r.rows('SELECT host_session_id FROM sessions WHERE scope_ref=?',(sc,))
        live=call('/v1/sessions/resume-continuation',{'sessionRef':ref,'intent':intent})
        assert live[0]==409 and live[1]['error']['code']=='resume_runtime_live',live
        stop(rid)
        historical=call('/v1/sessions/resume-continuation',{'sessionRef':ref,'intent':intent,'priorHostSessionId':host})
        assert historical[0]==409 and historical[1]['error']['code']=='self_brokered_resume_current_only',historical
        assert r.rows('SELECT host_session_id FROM sessions WHERE scope_ref=?',(sc,))==before
        checks['resume'].update(live=live,historical=historical)
        # Both reusable-runtime submission doors can cause a cold birth.
        for door in ('steer','invoke'):
            body={'target':ref,'body':'CONT '+door,'origin':{'principalRef':'agent:clod'},'runtimeIntent':intent,'wait':True}
            if door=='steer': body.pop('runtimeIntent')
            if door=='invoke': body['coldBirth']={'promptMode':'replace-priming'}
            answer=call('/v1/submissions/'+door,body)
            assert answer[0]==200,answer
            checks[door]=answer
            if answer[1].get('runId'):
                run=answer[1]['runId']
                r.wait(lambda:r.rows("SELECT 1 FROM hrc_events WHERE run_id=? AND event_kind='turn.completed'",(run,)),30)
                rid=answer[1]['runtimeId']
            else:
                # The fixture has queue/exclusive but no steer implementation.
                # Its refusal is after the cold birth, whose invariant is still
                # exercised here; this case makes no turn-completion claim.
                assert door=='steer' and answer[1]['reason']=='unsupported:steer',answer
                rid=r.rows('SELECT a.runtime_id FROM participant_registration_attempts a JOIN participant_registrations p USING(registration_id) WHERE p.scope_ref=? ORDER BY attach_epoch DESC LIMIT 1',(sc,))[0]['runtime_id']
                assert r.runtime(rid)['status']=='ready'
            checks[door]=answer; stop(rid)
        # hrc run's prepare/resume chain, without a priming input.
        host=r.rows('SELECT active_host_session_id FROM continuities WHERE scope_ref=?',(sc,))[0]['active_host_session_id']
        attempts_before=len(r.rows('SELECT * FROM participant_registration_attempts'))
        runs_before=r.rows('SELECT run_id FROM runs WHERE scope_ref=?',(sc,))
        answer=call('/v1/runs/prepare-attached',{'hostSessionId':host,'intent':intent,'restartStyle':'reuse_pty'})
        assert answer[0]==200 and answer[1]['status']=='prepared',answer
        unpark=call('/v1/runs/resume-attached',{'pendingStartId':answer[1]['pendingStartId']})
        assert unpark[0]==200 and unpark[1]['status']=='started',unpark
        missing=call('/v1/runs/resume-attached',{'pendingStartId':'attached-never-prepared'})
        assert missing[0]==503 and missing[1]['error']['code']=='runtime_unavailable' and missing[1]['error']['message']=='attached run is not pending',missing
        assert len(r.rows('SELECT * FROM participant_registration_attempts'))==attempts_before+1
        assert r.rows('SELECT run_id FROM runs WHERE scope_ref=?',(sc,))==runs_before
        rt=r.runtime(answer[1]['runtimeId']); directory=Path(rt['state']['broker']['substrate']['socketPath']).parent
        child=int((directory/'child.pid').read_text()); assert alive(child)
        checks['attached']={'prepared':answer,'resumed':unpark,'noPending':missing,'child':child,'attemptsAdded':1,'runsAdded':0}; stop(answer[1]['runtimeId'])
        host=r.rows('SELECT active_host_session_id FROM continuities WHERE scope_ref=?',(sc,))[0]['active_host_session_id']
        with_prompt=call('/v1/runs/prepare-attached',{'hostSessionId':host,'intent':intent,'prompt':'CONT attached prompt'})
        assert with_prompt[0]==200 and with_prompt[1]['status']=='prepared',with_prompt
        resumed_prompt=call('/v1/runs/resume-attached',{'pendingStartId':with_prompt[1]['pendingStartId']})
        assert resumed_prompt[0]==200,resumed_prompt
        run=resumed_prompt[1]['result']['runId']
        r.wait(lambda:r.rows("SELECT 1 FROM hrc_events WHERE run_id=? AND event_kind='turn.completed'",(run,)),30)
        checks['attachedPrompt']={'prepared':with_prompt,'resumed':resumed_prompt}
        stop(with_prompt[1]['runtimeId'])
        # Real attached-start timeout, no shortened daemon setting. A launcher
        # has no priming turn: missing acknowledgement cannot own its lease.
        timeout_scope=scope('acktimeout'); timeout_intent=claim_body(r,timeout_scope,'unused')['runtimeIntent']
        ensured=call('/v1/targets/ensure',{'sessionRef':timeout_scope+'/lane:main','runtimeIntent':timeout_intent})
        waiting=call('/v1/runs/prepare-attached',{'hostSessionId':ensured[1]['activeHostSessionId'],'intent':timeout_intent})
        assert waiting[0]==200 and waiting[1]['status']=='prepared',waiting
        timeout_start=time.monotonic()
        # A second product caller for the exact claim shape.
        argv=[str(r.binary),'start',sc,'--on-conflict','reject','--no-viewer','--json']
        result=subprocess.run(argv,env=r.env,cwd=project,text=True,capture_output=True,timeout=90)
        checks['hrcStart']={'argv':argv,'code':result.returncode,'stdout':result.stdout,'stderr':result.stderr}
        assert result.returncode==0,checks['hrcStart']
        started=json.loads(result.stdout)['runtime']
        checks['hrcStart']['sessionInvariant']=session_invariants(r)
        stop(started['runtimeId'])
        # Explicit and implicit suffix claims refuse without creating a slot.
        for implicit in (False,True):
            request=claim_body(r,sc,'T13451-suffix-'+str(implicit),'suffix')
            if implicit: request['summonIntent']='implicit'
            answer=call('/v1/runtimes/start',request)
            assert answer[0]==409 and answer[1]['error']['code']=='self_brokered_roster_unsupported',answer
            checks['suffix-'+str(implicit)]=answer
        ordinary_before=ordinary(); turn(ordinary_before,'CONT ordinary resume')
        assert call('/v1/terminate',{'runtimeId':ordinary_before['id']})[0]==200
        r.wait(lambda:not alive(ordinary_before['child']),20)
        count=len(r.rows('SELECT * FROM runtimes'))
        req=claim_body(r,scope('ordinary'),'ordinary-resume')
        resumed=call('/v1/sessions/resume-continuation',{'sessionRef':scope('ordinary')+'/lane:main','intent':req['runtimeIntent']})
        assert resumed[0]==200 and len(r.rows('SELECT * FROM runtimes'))==count,resumed
        started=call('/v1/runtimes/start',{'hostSessionId':resumed[1]['hostSessionId'],'intent':req['runtimeIntent']})
        assert started[0]==200 and started[1]['hostSessionId']==resumed[1]['hostSessionId'],started
        live=call('/v1/sessions/resume-continuation',{'sessionRef':scope('ordinary')+'/lane:main','intent':req['runtimeIntent']})
        assert live[0]==409 and live[1]['error']['code']=='resume_runtime_live',live
        checks['ordinaryResume']={'resumed':resumed,'started':started,'live':live,'runtimeCountBeforeStart':count}
        call('/v1/terminate',{'runtimeId':started[1]['runtimeId']})
        r.wait(lambda:time.monotonic()-timeout_start>=122,130,'ordinary attached-start deadline')
        timeout_runtime=r.runtime(waiting[1]['runtimeId'])
        directory=Path(timeout_runtime['state']['broker']['substrate']['socketPath']).parent
        assert timeout_runtime['status']=='ready' and alive(int((directory/'child.pid').read_text())),timeout_runtime
        expired=call('/v1/runs/resume-attached',{'pendingStartId':waiting[1]['pendingStartId']})
        assert expired[0]==503 and expired[1]['error']['message']=='attached run is not pending',expired
        checks['attachedUnacknowledged']={'prepared':waiting,'afterDeadline':timeout_runtime,'resume':expired}
        stop(waiting[1]['runtimeId'])
        print('PASS request-shape sweep: virgin exact, ensure, resume, steer, invoke, attached, hrc start, suffix',flush=True)
    def archive_gates():
        results={}
        def session(s):
            return r.rows('SELECT continuation_json,continuation_reuse_disabled FROM sessions WHERE host_session_id=?',(s['host'],))[0]
        def stop(s):
            answer=call('/v1/terminate',{'runtimeId':s['id'],'dropContinuation':False})
            assert answer[0]==200,answer
            r.wait(lambda:not alive(s['child']) and r.runtime(s['id'])['status']=='terminated',20,'archive predecessor ended')
        def repeat(s,drop,owner=False):
            body={'runtimeId':s['id']}
            if owner: body['ownerRunId']='archive-gate-owner'
            if drop is not None: body['dropContinuation']=drop
            answer=call('/v1/terminate',body)
            assert answer[0]==200 and answer[1]['droppedContinuation']==(drop is True),answer
            assert r.runtime(s['id'])['status']=='terminated',r.runtime(s['id'])
            return answer
        def offer(s,kind,carried):
            if kind=='self-brokered':
                answer=json.loads((s['directory']/'registration.json').read_text())['continuation']
                assert answer['carried'] is carried,answer
            else:
                frames=[json.loads(line) for line in (a.artifacts/'aspd.jsonl').read_text().splitlines()]
                requests=[v['request']['params']['compileRequest'] for v in frames
                    if v.get('request',{}).get('method')=='aspc.compileHarnessInvocation']
                request=next(q for q in requests if q['identity']['runtimeId']==s['id'])
                answer=request.get('continuation')
                assert bool(answer) is carried,request
            return answer
        for kind,spawn in [('ordinary',ordinary),('self-brokered',lambda:birth('archive'))]:
            first=spawn(); first_turn=turn(first,'CONT archive conversation')
            kept=session(first)
            assert kept['continuation_json'] and not kept['continuation_reuse_disabled'],kept
            stop(first)
            # A terminal row can still have protected work during reconciliation.
            # The owner check must win before an archive can disable reuse.
            run_id=first_turn['run']['run_id']
            with sqlite3.connect(r.db_path) as db: db.execute("UPDATE runs SET status='running' WHERE run_id=?",(run_id,))
            protected=call('/v1/terminate',{'runtimeId':first['id'],'ownerRunId':'other-owner','dropContinuation':True})
            assert protected[0]==200 and not protected[1]['droppedContinuation'] and 'protected work' in protected[1]['warning'],protected
            assert session(first)==kept and r.runtime(first['id'])['status']=='terminated',protected
            with sqlite3.connect(r.db_path) as db: db.execute("UPDATE runs SET status='completed' WHERE run_id=?",(run_id,))
            keep=repeat(first,False); omitted=repeat(first,None,owner=True)
            assert session(first)==kept,(session(first),kept)
            continued=spawn(); offered_keep=offer(continued,kind,True)
            turn(continued,'CONT continued conversation')
            stop(continued)
            audit_before=r.rows("SELECT COUNT(*) AS count FROM hrc_events WHERE runtime_id=? AND event_kind='runtime.terminated'",(continued['id'],))
            assert audit_before[0]['count']>=1,audit_before
            drop=repeat(continued,True); second_drop=repeat(continued,True,owner=True); after_omit=repeat(continued,None)
            assert session(continued)['continuation_reuse_disabled']==1,session(continued)
            audit_after=r.rows("SELECT COUNT(*) AS count FROM hrc_events WHERE runtime_id=? AND event_kind='runtime.terminated'",(continued['id'],))
            assert audit_before==audit_after,(audit_before,audit_after)
            literal=call('/v1/literal-input/by-selector',{'selector':{'sessionRef':r.runtime(continued['id'])['scope_ref']+'/lane:main'},'text':'must refuse'})
            assert literal[0]==503 and literal[1]['error']['code']=='runtime_unavailable',literal
            interrupt=call('/v1/interrupt',{'runtimeId':continued['id']})
            assert interrupt[0]==503 and interrupt[1]['error']['message']==f'runtime "{continued["id"]}" is terminated',interrupt
            fresh=spawn(); offered_drop=offer(fresh,kind,False)
            results[kind]={'protectedOwner':protected,'keep':keep,'omitted':omitted,'offeredKeep':offered_keep,
                'drop':drop,'secondDrop':second_drop,'omittedAfterDrop':after_omit,
                'offeredDrop':offered_drop,'inputRefusal':literal,'interruptRefusal':interrupt,
                'auditBefore':audit_before,'auditAfter':audit_after}
            stop(fresh)
        report['archiveTerminated']={'pass':True,'cases':results}
        print('PASS repeated terminate keep/drop, fresh/continued birth, input and interrupt refusals (ordinary + self-brokered)',flush=True)
    try:
        owner=r.up('1')
        if a.doors_only:
            door_gates(); report['pass']=True; return
        if not a.baseline:
            claim_gates()
            if a.reproduce_claims: return
            if a.claims_only: report['pass']=True; return
            door_gates()
            archive_gates()
            if a.archive_only:
                report['pass']=True
                return
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
