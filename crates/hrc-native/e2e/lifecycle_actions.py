#!/usr/bin/env python3
"""Granted lifecycle on the one authorized disposable owner, versus copied Bun.

Failure modes: env attribution grants authority; a refusal writes/acts; ACK is
lost before stop; restart loses its successor or starts two; grant attribution
is absent from durable stop rows; production ownership changes. Credentials
stay in memory and never appear in evidence. Both actors are real owned seats.
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import signal
import sqlite3
import subprocess
import sys
import threading
import time
import uuid

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0,str(ROOT/'crates/hrc-cli/e2e'))
from copied_release import copied_bun_cli,preflight_unmanaged
from metrics_isolation import isolated_suite
from foundation import UnixHTTP


@isolated_suite
def main():
    p=argparse.ArgumentParser()
    for name in ('binary','oracle','environment','seat','artifacts'):
        p.add_argument('--'+name,type=Path,required=True)
    a=p.parse_args()
    root=Path('/tmp/n5-server-owned-11819')
    assert a.environment.resolve()==(root/'environment.json').resolve()
    a.artifacts.mkdir(parents=True,exist_ok=True)
    env={k:v for k,v in os.environ.items() if not k.startswith(('ASP_','HRC_','WRKQ','HARNESS_BROKER_'))}
    env.update(json.loads(a.environment.read_text()))
    env.pop('XPC_SERVICE_NAME',None)
    env.pop('HRC_LAUNCHD_LABEL',None)
    assert Path(env['HRC_RUNTIME_DIR'])==root/'run' and Path(env['HRC_STATE_DIR'])==root/'state'
    assert env['HRC_WRKQ_DB'].startswith('rpc://127.0.0.1:')
    assert not(root/'run/hrc.sock').exists() and not(root/'run/server.lock').exists()
    oracle=copied_bun_cli(a.oracle,root/'lifecycle-copy')
    bun=shutil.which('bun')
    processes=[]
    owned=[]
    contexts={}
    cases=[]
    production=Path.home()/'praesidium/var/run/hrc'
    def production_owner():
        return {n:dict(inode=(production/n).stat().st_ino,**({'pid':(production/n).read_text()} if n=='server.pid' else {})) for n in ('server.pid','hrc.sock')}
    before_production=production_owner()
    def raw(path,body=None,headers=None):
        h=UnixHTTP(root/'run/hrc.sock')
        h.request('POST' if body is not None else 'GET',path,json.dumps(body) if body is not None else None,
                  dict(headers or {},**{'Content-Type':'application/json'}))
        r=h.getresponse()
        data=r.read().decode()
        h.close()
        return r.status,json.loads(data)
    def call(path,body=None):
        status,value=raw(path,body)
        assert 200<=status<300,(status,value)
        return value
    def pid():return int((root/'run/server.pid').read_text())
    def ready(previous=None):
        for _ in range(300):
            try:
                value=call('/v1/status')
                current=pid()
                if previous is None or current!=previous:
                    assert value['runtimeRoot']==str(root/'run') and value['stateRoot']==str(root/'state') and value['release']['mode']!='atomic'
                    return current,value
            except (OSError,ValueError):pass
            time.sleep(.05)
        raise AssertionError('owned successor did not become healthy')
    def boot(owner):
        preflight_unmanaged(oracle,env,a.artifacts/'release-preflight.json')
        log=(a.artifacts/(owner+'.log')).open('a')
        command=[bun,str(oracle)] if owner=='bun' else [str(a.binary.resolve())]
        proc=subprocess.Popen(command+['server','serve'],env=env,cwd=root,stdin=subprocess.DEVNULL,stdout=log,stderr=log)
        processes.append(proc)
        threading.Thread(target=proc.wait,daemon=True).start()
        log.close()
        return ready()
    def down():
        if (root/'run/server.pid').exists():
            current,status=ready()
            os.kill(current,signal.SIGTERM)
            for _ in range(400):
                if not(root/'run/hrc.sock').exists() and not(root/'run/server.lock').exists():break
                time.sleep(.05)
            else:raise AssertionError('owned owner did not release its files')
    def rows():
        with sqlite3.connect('file:'+str(root/'state/state.sqlite')+'?mode=ro',uri=True) as db:
            db.row_factory=sqlite3.Row
            return [dict(r) for r in db.execute("SELECT * FROM hrc_events WHERE scope_ref='server:hrc' AND source_ref IS NULL AND evidence_origin IS NULL ORDER BY hrc_seq")]
    def headers(agent):
        rid,ref=contexts[agent]
        path=root/'run/lifecycle'/(rid+'.credential')
        for _ in range(100):
            if path.exists():break
            time.sleep(.03)
        value=path.read_text().strip()
        assert len(value)==64
        return {'x-hrc-lifecycle-runtime-id':rid,'x-hrc-lifecycle-session-ref':ref,'x-hrc-lifecycle-credential':value}
    def provision(agent):
        directory=root/'agents'/agent
        directory.mkdir(parents=True,exist_ok=True)
        (directory/'agent-profile.toml').write_text('version = 4\n[identity]\ndisplay = "N5 lifecycle fixture"\n[provisioning]\nharness = "claude"\nyolo = true\n[spaces]\nbase = []\n')
        intent=json.loads(json.dumps(json.loads(a.seat.read_text())['intent']))
        intent.pop('initialPrompt',None)
        intent['placement']['agentRoot']=str(directory)
        intent['placement']['bundle']['agentName']=agent
        intent['harness']['interactive']=False
        ref=f'agent:{agent}:project:n5-t11819:task:primary/lane:action-'+uuid.uuid4().hex[:8]
        host=call('/v1/sessions/resolve',dict(sessionRef=ref,create=True,summonIntent='explicit_local',runtimeIntent=intent))['hostSessionId']
        runtime=call('/v1/runtimes/start',dict(hostSessionId=host,intent=intent))['runtimeId']
        owned.append(runtime)
        contexts[agent]=(runtime,ref)
    def normalized_response(value):
        value=json.loads(json.dumps(value))
        value['grant']['requestId']='<lifecycle request id>'
        if 'notes' in value:
            value['notes']=[n.replace(n[n.find('restart-drain-'):n.find(')')],'<drain operation>') if 'restart-drain-' in n else n for n in value['notes']]
        return value
    def normalized_rows(delta,old,new,grant):
        ids={r['hrc_seq']:i+1 for i,r in enumerate(delta)}
        out=[]
        for row in delta:
            row=dict(row)
            payload=json.loads(row.pop('payload_json'))
            if 'pid' in payload:
                assert payload['pid']==(new if row['event_kind']=='server.started' else old)
                payload['pid']='<new owner>' if row['event_kind']=='server.started' else '<old owner>'
            if 'previousPid' in payload:
                assert payload['previousPid']==old
                payload['previousPid']='<old owner>'
            if 'processStartedAt' in payload:payload['processStartedAt']='<new process startedAt>'
            if 'shuttingDownHrcSeq' in payload:payload['shuttingDownHrcSeq']=ids[payload['shuttingDownHrcSeq']]
            if 'grant' in payload:
                assert payload['grant']==grant
                payload['grant']=dict(payload['grant'],requestId='<lifecycle request id>')
            row.update(hrc_seq=ids[row['hrc_seq']],stream_seq=ids[row['hrc_seq']],ts='<fact timestamp>',payload=payload)
            out.append(row)
        return out
    try:
        boot('bun')
        provision('mable')
        provision('tabularasa')
        down()
        matrix=[('restart',{}),('stop',{}),('restart',{'wait':True}),('restart',{'force':True}),('restart',{'drain':True}),('stop',{'force':True})]
        baseline={}
        for owner in ('bun','native'):
            if (root/'run/server.pid').exists():down()
            for index,(action,flags) in enumerate(matrix):
                if not(root/'run/server.pid').exists():boot(owner)
                old,old_status=ready()
                initial=rows()
                body=dict(action=action,reason='Owned N5 execution-owner lifecycle',**flags)
                negative=raw('/v1/server/lifecycle',body,headers('tabularasa'))
                assert negative[0]==403 and negative[1]['error']['detail']['refusal']=='not_authorized',negative
                assert rows()==initial and pid()==old and production_owner()==before_production
                status,response=raw('/v1/server/lifecycle',body,headers('mable'))
                assert status==200 and response['ok'] is True and response['accepted'] is True,(status,response)
                (a.artifacts/f'{owner}-{index}-ack.json').write_text(json.dumps(dict(beforePid=old,response=response,negative=negative),indent=2)+'\n')
                if action=='restart':
                    new,new_status=ready(old)
                    (a.artifacts/f'{owner}-{index}-successor.json').write_text(json.dumps(dict(afterPid=new,status=new_status),indent=2)+'\n')
                    assert new_status['startedAt']!=old_status['startedAt']
                    assert new_status['lastRestart']['requestedBy']==response['grant']['requestedBy']
                    assert new_status['lastRestart']['reason']==body['reason']
                else:
                    new=None
                    for _ in range(400):
                        if not(root/'run/hrc.sock').exists() and not(root/'run/server.lock').exists():break
                        time.sleep(.05)
                    else:raise AssertionError('granted owned stop did not release owner')
                after=rows()
                delta=[row for row in after if not initial or row['hrc_seq']>initial[-1]['hrc_seq']]
                observation=dict(owner=owner,action=action,flags=flags,beforePid=old,afterPid=new,response=response,negative=negative,delta=delta)
                (a.artifacts/f'{owner}-{index}.json').write_text(json.dumps(observation,indent=2)+'\n')
                kinds=[r['event_kind'] for r in delta]
                assert kinds==(['server.shutting_down','server.stopped','server.started'] if action=='restart' else ['server.shutting_down','server.stopped']),kinds
                for row in delta[:2]:
                    payload=json.loads(row['payload_json'])
                    assert payload['reason']=='lifecycle:'+action and payload['grant']==response['grant'] and 'ungranted' not in payload
                current=dict(response=normalized_response(response),rows=normalized_rows(delta,old,new,response['grant']))
                if owner=='bun':baseline[index]=current
                else:assert current==baseline[index],(index,baseline[index],current)
                cases.append(dict(owner=owner,index=index,action=action,flags=flags,**{'pass':True}))
                assert production_owner()==before_production
    finally:
        # Always return these real seats through Bun's established teardown.
        down()
        boot('bun')
        for runtime in owned:
            row=call('/v1/runtimes/inspect',dict(runtimeId=runtime))
            if row['status']!='terminated':call('/v1/terminate',dict(runtimeId=runtime,reason='owned lifecycle action cleanup'))
            assert call('/v1/runtimes/inspect',dict(runtimeId=runtime))['status']=='terminated'
        down()
        assert production_owner()==before_production
        report=dict(cases=cases,**{'pass':len(cases)==12 and all(c['pass'] for c in cases)},productionBefore=before_production,productionAfter=production_owner(),cleanup=dict(runtimeIds=owned,socketAbsent=not(root/'run/hrc.sock').exists(),lockAbsent=not(root/'run/server.lock').exists(),credentialFiles=list(map(str,(root/'run/lifecycle').glob('*.credential')))))
        assert not report['cleanup']['credentialFiles']
        (a.artifacts/'results.json').write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps(dict(pass_=report['pass'],cases=len(cases))))
    return int(not report['pass'])


if __name__=='__main__':raise SystemExit(main())
