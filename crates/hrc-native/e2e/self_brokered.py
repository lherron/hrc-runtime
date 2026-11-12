#!/usr/bin/env python3
"""T-13440 no-input launch acceptance; isolated daemon, real hrc-pty.

Failures: declaration projection/empty command; duplicate child; identity on argv;
wrong file modes; absent descriptor/early exit leaks; external row drift; missing
attach or stream bytes. Reuses ASP's exported noop participant broker, not a new
broker implementation. --baseline records the external row before source edits.
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import signal
import sqlite3
import socket
import struct
import subprocess
import sys
import time
from urllib.parse import urlencode
from hrcpty_substrate import Run, FakeAspd, LEAK
from foundation import daemon_env
import participant_descriptor

HERE = Path(__file__).resolve().parent

class Aspd(FakeAspd):
    def __init__(self, root, commands, log):
        self.root, self.commands = root, commands
        super().__init__(root/'aspd.sock', {}, log)

    def handle(self, method, params):
        if method == 'aspc.hello':
            hello = super().handle(method, params)
            hello['capabilities']['resolveRuntimeDeclaration'] = True
            return hello
        if method == 'aspc.resolveRuntimeDeclaration':
            c = params['context']; agent = c['agentId']
            placement = {'pins': {}, 'homes': {}}
            if agent in self.commands:
                placement.update(launch='self-brokered', launchCommand=self.commands[agent])
            elif agent == 'held': placement['launch'] = 'participant-only'
            return {'schemaVersion':'aspc-resolve-runtime-declaration-response/v1','ok':True,
                    'source':{'agentProfile':{'state':'present'}},
                    'placement':{'agentRoot':str(self.root/'agents'/agent),'projectRoot':str(self.root/'t12049'),
                                 'cwd':str(self.root/'t12049'),'runMode':c['runMode']},
                    'policy':{'claimsTask':False,'placement':placement},
                    'identity':{'operator':False},'agentSources':{},'provisioning':{'scalars':{}},'diagnostics':[]}
        raise AssertionError('Self-brokered birth must never compile: '+method)

LAUNCHER = r'''
import json, os, sys, time
from pathlib import Path
sys.path.insert(0, E2E)
import participant_descriptor as d
mode, module, *flags = sys.argv[1:]
a = dict(zip(flags[::2],flags[1::2])); root=Path(a['--registration']).parent
(root/'argv.json').write_text(json.dumps(sys.argv[1:]))
(root/'child.pid').write_text(str(os.getpid()))
print('SELF-BROKERED-TERMINAL',flush=True)
if mode == 'exit': sys.exit(23)
if mode == 'stall':
    while True: time.sleep(1)
j=json.loads(Path(a['--registration']).read_text())
v=d.scratch(j, a['--project-root']); s=v['harnessInvocation']['startRequest']['spec']
s['driver']['kind']=s['harness']['driver']=v['brokerDriver']='noop-driver'
if mode == 'establish': s['driver']['kind']=s['harness']['driver']=v['brokerDriver']='unsupported-launch-driver'
v=d.seal(v)
if mode == 'bad': v['descriptorHash']='invalid'
dest=Path(a['--descriptor-out']); tmp=dest.with_suffix('.tmp')
tmp.write_text(json.dumps(v)); tmp.rename(dest)
os.environ['PARTICIPANT_EVICTION_EFFECTS']=str(root/'effects.jsonl')
os.execvp('bun',['bun',BROKER,'run',module,'--transport','unix','--socket',a['--broker-socket'],
                       '--event-ledger',str(root/'events.ndjson'),'--join','participant-served'])
'''

def main():
    p=argparse.ArgumentParser(description=__doc__)
    for name in ('binary','scratch-root','artifacts','broker-module'): p.add_argument('--'+name,type=Path,required=True)
    p.add_argument('--baseline',action='store_true')
    p.add_argument('--baseline-summary',type=Path)
    a=p.parse_args(); root=a.scratch_root.absolute(); assert not root.exists(); root.mkdir(parents=True)
    a.artifacts.mkdir(parents=True,exist_ok=True)
    (root/'t12049').mkdir(); (root/'t12049/.praesidium').mkdir()
    (root/'t12049/.praesidium/project.json').write_text(json.dumps({'id':'t12049'}))
    launcher=root/'launcher.py'
    launcher.write_text('E2E='+repr(str(HERE))+'\nBROKER='+repr(str(HERE/'participant_eviction_broker.mjs'))+'\n'+LAUNCHER)
    commands={agent:[sys.executable,str(launcher),mode,str(a.broker_module)] for agent,mode in
              [('self','ok'),('exit','exit'),('stall','stall'),('bad','bad'),('establish','establish')]}
    commands['invalid']=[]
    for agent in [*commands,'external','held','ordinary']:
        profile=root/'agents'/agent;profile.mkdir(parents=True)
        (profile/'agent-profile.toml').write_text('# Watched declaration fixture; values served by fake aspd.\n')
    fake=Aspd(root,commands,a.artifacts/'aspd.jsonl')
    (root/'federation.json').write_text(json.dumps({'nodeId':'selftest','peers':{}}))
    r=Run(root,a.artifacts,a.binary.resolve())
    r.env=daemon_env(dict({k:v for k,v in os.environ.items() if not k.startswith(LEAK)},HRC_RUNTIME_DIR=str(root/'run'),HRC_STATE_DIR=str(root/'state'),
                         HRC_PEER_CONFIG_FILE=str(root/'federation.json'),HRC_ASPD_SOCKET=str(root/'aspd.sock'),
                         ASP_PROJECT_ROOT_OVERRIDE=str(root/'t12049'),HRC_PROJECT_SEARCH_ROOTS=str(root/'t12049'),HRC_WRKQ_DB=str(root/'wrkq.db'),WRKQ_DB=str(root/'wrkq.db'),HRC_ACP_WEBHOOK_URL=''))
    report={}; brokers=[]
    def call(path,body): return r.http('POST',path,body,timeout=700)
    def scope(agent): return 'agent:'+agent+':project:t12049:task:launch'
    def target(agent):
        result=call('/v1/targets/ensure',{'sessionRef':scope(agent)+'/lane:main','runtimeIntent':{}})
        assert result[0]==200,result
        return result[1]['activeHostSessionId']
    def ensure(host): return call('/v1/runtimes/start',{'hostSessionId':host,'intent':{'harness':{'id':'claude-code','interactive':False}}})
    def external():
        j=call('/v1/participants/register',{'registrationMode':'direct','requestedSessionRef':scope('external'),'hostIncarnationId':'external-one','workspaceCwd':str(root/'t12049'),'socketPath':str(root/'external.sock')})
        assert j[0]==200,j
        j=j[1]; d=participant_descriptor.scratch(j,root/'t12049'); s=d['harnessInvocation']['startRequest']['spec']
        s['driver']['kind']=s['harness']['driver']=d['brokerDriver']='noop-driver'; d=participant_descriptor.seal(d)
        log=(a.artifacts/'external.log').open('w')
        b=subprocess.Popen(['bun',str(HERE/'participant_eviction_broker.mjs'),'run',str(a.broker_module),'--transport','unix','--socket',str(root/'external.sock'),'--event-ledger',str(root/'external.ndjson'),'--join','participant-served'],env=dict(r.env,PARTICIPANT_EVICTION_EFFECTS=str(root/'external.effects')),stdout=log,stderr=log)
        brokers.append(b); r.wait(lambda:(root/'external.sock').exists(),15)
        body={k:j['identity'][k] for k in ('registrationId','attemptId','attachEpoch')}; body['descriptor']=d
        attached=call('/v1/participants/attach',body); assert attached[0]==200,attached
        rid=j['identity']['runtimeId']; r.wait(lambda:r.rows("SELECT 1 FROM runtimes WHERE runtime_id=? AND status='ready'",(rid,)),30)
        row=r.runtime(rid)
        return {'transport':row['transport'],'substrate':row['state']['broker']['substrate'],'lifecycleOwner':row['state']['lifecycleOwner']}
    try:
        r.up('self-brokered')
        report['external']=external()
        if a.baseline:
            report['pass']=True; return
        assert a.baseline_summary
        before=json.loads(a.baseline_summary.read_text())['external']
        assert report['external']==before,(report['external'],before)
        report['S5']={'pass':True,'before':before,'after':report['external']}
        held=call('/v1/participants/register',{'registrationMode':'direct','requestedSessionRef':scope('held'),
            'hostIncarnationId':'absent-external','workspaceCwd':str(root/'t12049'),'socketPath':str(root/'absent.sock')})
        assert held[0]==200,held
        with sqlite3.connect(r.db_path) as db:
            db.execute("UPDATE participant_registration_attempts SET state='ABANDONED',establishment_work_state='completed' WHERE attempt_id=?",(held[1]['identity']['attemptId'],))
            db.execute("UPDATE participant_host_bindings SET state='RETIRED',disposition_reason='scratch_absent_host',retired_at='2026-11-12T00:00:00Z' WHERE runtime_id=?",(held[1]['identity']['runtimeId'],))
        refused=call('/v1/targets/ensure',{'sessionRef':scope('held')+'/lane:main','runtimeIntent':{}})
        assert refused[0]==409 and refused[1]['error']['detail']['reason']=='host_absent',refused
        # Knock attribution is deliberately host-neutral; its payload carries the address.
        knock=r.rows("SELECT payload_json FROM hrc_events WHERE event_kind='participant.host_requested'")
        assert len(knock)==1 and json.loads(knock[0]['payload_json'])['scopeRef']==scope('held'),knock
        report['participantOnly']={'reply':refused,'knock':knock}
        host=target('self'); answer=ensure(host); report['birth']=answer
        assert answer[0]==200,answer
        rid=answer[1]['runtimeId']; row=r.runtime(rid); state=row['state']; substrate=state['broker']['substrate']
        assert row['status']=='ready' and row['transport']=='hrcpty',row
        assert state['lifecycleOwner']=='hrc' and state['participant']['lifecycleOwner']=='hrc-launched',state
        attach=r.http('GET','/v1/attach?'+urlencode({'runtimeId':rid})); report['attach']=attach
        assert attach[0]==200 and 'hrcpty' in json.dumps(attach),attach
        # Same streamed PTY door as Loggia; handshake and raw output discriminated below.
        query={'scopeRef':scope('self'),'laneRef':'main','kind':'pty','mode':'take-control'}
        stream_path='/v1/streams/open?'+urlencode(query)
        report['streamPath']=stream_path
        wire=socket.socket(socket.AF_UNIX); wire.settimeout(10); wire.connect(str(r.socket))
        wire.sendall(('GET '+stream_path+' HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: hrc-stream/1\r\n\r\n').encode())
        f=wire.makefile('rb'); status=f.readline().decode(); assert ' 101 ' in status,status
        while f.readline().strip(): pass
        chunks=b''
        while b'SELF-BROKERED-TERMINAL' not in chunks:
            kind,length=struct.unpack('>BI',f.read(5)); payload=f.read(length)
            assert kind in (1,2),(kind,payload)
            if kind==1: chunks+=payload
        report['streamStatus']=101; report['streamBytes']=chunks.decode(errors='replace')
        f.close(); wire.close()
        report['S1']={'pass':True,'runtime':row,'streamBytes':report['streamBytes'],'participantOnly':report['participantOnly']}
        directory=Path(substrate['socketPath']).parent; registration=json.loads((directory/'registration.json').read_text())
        argv=json.loads((directory/'argv.json').read_text())
        expected=commands['self'][2:]+['--project-root',str(root/'t12049'),'--broker-socket',str(directory/'broker.sock'),'--registration',str(directory/'registration.json'),'--descriptor-out',str(directory/'descriptor.json')]
        assert argv==expected,(argv,expected)
        assert directory.stat().st_mode & 0o777 == 0o700
        assert (directory/'registration.json').stat().st_mode & 0o777 == 0o600
        assert (directory/'attach.token').stat().st_mode & 0o777 == 0o600
        assert max(len(str(directory/name).encode()) for name in ('hrcpty.sock','broker.sock'))<104
        assert registration['identity']['runtimeId']==rid and registration['status']=='registered',registration
        attempt_row=r.rows('SELECT * FROM participant_registration_attempts WHERE runtime_id=?',(rid,))[0]
        reg_row=r.rows('SELECT * FROM participant_registrations WHERE registration_id=?',(registration['identity']['registrationId'],))[0]
        for field,column in [('attemptId','attempt_id'),('runtimeId','runtime_id'),('invocationId','invocation_id'),('requestId','request_id'),('operationId','operation_id'),('attachEpoch','attach_epoch')]:
            assert registration['identity'][field]==attempt_row[column]
        assert registration['hostSessionId']==reg_row['host_session_id'] and registration['generation']==reg_row['generation']
        report['S2']={'pass':True,'argv':argv,'registration':registration,'mode':'0600'}
        second=ensure(registration['hostSessionId']); report['second']=second
        assert second[0]==200 and second[1]['runtimeId']==rid,second
        assert len(r.rows("SELECT * FROM participant_registration_attempts WHERE runtime_id=?",(rid,)))==1
        original_pid=int((directory/'child.pid').read_text());os.kill(original_pid,0)
        assert r.runtime(rid)['state']['broker']['brokerPid']==original_pid
        fresh=call('/v1/runtimes/start',{'hostSessionId':registration['hostSessionId'],'restartStyle':'fresh_pty','intent':{'harness':{'id':'claude-code','interactive':False}}})
        assert fresh[0]==503 and fresh[1]['error']['detail']['reason']=='host_binding_conflict',fresh
        assert len(r.rows("SELECT * FROM participant_registration_attempts WHERE registration_id=?",(registration['identity']['registrationId'],)))==1
        os.kill(original_pid,0)
        report['S4']={'pass':True,'sameRuntime':rid,'sameChildPid':original_pid,'livePredecessorRefusal':fresh}
        failures={}
        for agent in ('exit','stall','bad','establish'):
            h=target(agent); started=time.monotonic(); reply=ensure(h)
            assert reply[0]==503 and reply[1]['error']['code']=='runtime_unavailable' and reply[1]['error']['detail']['retryable'],reply
            attempt=r.rows('SELECT * FROM participant_registration_attempts a JOIN participant_registrations p USING(registration_id) WHERE p.scope_ref=?',(scope(agent),))[0]
            assert attempt['state']=='ABANDONED',attempt
            assert not r.rows("SELECT 1 FROM runtimes WHERE runtime_id=? AND status='ready'",(attempt['runtime_id'],))
            regfiles=list((root/'run/bipc').glob('*/registration.json'))
            regfile=next(f for f in regfiles if json.loads(f.read_text())['identity']['runtimeId']==attempt['runtime_id'])
            assert not (regfile.parent/'hrcpty.sock').exists()
            for pidfile in ('hrcpty.pid','child.pid'):
                path=regfile.parent/pidfile
                if path.exists():
                    try:os.kill(int(path.read_text()),0)
                    except ProcessLookupError:pass
                    else:raise AssertionError('failed launcher process survived: '+str(path))
            processes=subprocess.check_output(['ps','-axo','pid,command'],text=True)
            assert not any('hrc-pty serve' in line and str(regfile.parent/'hrcpty.sock') in line for line in processes.splitlines())
            failures[agent]={'reply':reply,'attempt':attempt,'elapsed':time.monotonic()-started}
        report['S3']={'pass':True,'cases':failures}
        invalid=ensure(target('invalid')); assert invalid[0]>=400 and 'launchCommand' in json.dumps(invalid),invalid
        report['invalidCommand']=invalid
        report['pass']=True
    finally:
        report['checks']=r.checks
        (a.artifacts/'summary.json').write_text(json.dumps(report,indent=2,default=str)+'\n')
        # Only processes whose sockets this private root owns.
        for token in (root/'run/bipc').glob('*/attach.token'):
            sock=token.parent/'hrcpty.sock'
            if sock.exists():
                from n2_participant import Rpc
                ops=Rpc(sock)
                try:
                    ops.call('hello',{'token':token.read_text().strip()})
                    ops.call('shutdown',{})
                finally: ops.close()

        for b in brokers:
            if b.poll() is None: b.terminate(); b.wait(timeout=15)
        for owner in r.owners:
            if owner.poll() is None: r.down(owner)
        fake.close()
    print(json.dumps({'pass':True,'artifacts':str(a.artifacts)}))

if __name__=='__main__': main()
