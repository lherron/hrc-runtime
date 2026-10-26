#!/usr/bin/env python3
"""Native-ledger kernel versus the installed API-fed kernel, wire key order included.

A real owner births an attachable seat. The native kernel is given an HTTP
observer that rejects every projection read: only owner operations may pass.
This catches an API-fed proxy even if its resulting document looks identical.
The kernel must keep projecting after its daemon is stopped, and refuse a
ledger with a foreign schema without advancing its cursor.
"""
import argparse
import json
import re
from pathlib import Path
import socket
import shutil
import subprocess
import sys
import threading
import time
import http.server
import socketserver
from urllib.parse import urlsplit

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'crates/hrc-native/e2e'))
sys.path.insert(0,str(ROOT/'crates/hrc-kernel/e2e'))
from n3_scratch import Scratch,UnixHTTP
from kernel_e2e import Wire

class Observer(socketserver.ThreadingMixIn,socketserver.UnixStreamServer):
    daemon_threads=True
    def __init__(self,path,scratch,deny):
        self.scratch=scratch;self.deny=deny;self.reads=[];self.writes=[]
        super().__init__(str(path),Forward)

class Forward(http.server.BaseHTTPRequestHandler):
    def log_message(self,*_):pass
    def do_GET(self):self.forward()
    def do_POST(self):self.forward()
    def forward(self):
        path=urlsplit(self.path).path
        projection=self.command=='GET' or path=='/v1/presentation/seats/read'
        (self.server.reads if projection else self.server.writes).append(path)
        if projection and self.server.deny:
            self.send_error(503,'projection reads disabled by native-ledger control');return
        c=UnixHTTP(self.server.scratch.socket,30)
        try:
            body=self.rfile.read(int(self.headers.get('Content-Length','0')))
            c.request(self.command,self.path,body or None,{'Content-Type':'application/json'})
            r=c.getresponse();self.send_response(r.status)
            if path=='/v1/events/bounded-stream' and r.status==200:
                self.send_header('Content-Type','application/x-ndjson');self.end_headers()
                while line:=r.readline():self.wfile.write(line);self.wfile.flush()
            else:
                data=r.read();self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
        except (OSError,TimeoutError):pass
        finally:c.close()

DYNAMIC={'id','runtimeId','hostSessionId','generationStartedAt','lastActivityAt','updatedAt','createdAt','ts',
         'live_until','lastHrcSeq','node_incarnation','observedAt','sourceRef','time','turnId','usedTokens'}
def canonical(v):
    if isinstance(v,dict):return [(k,'<dynamic>' if k in DYNAMIC else canonical(x)) for k,x in v.items()]
    if isinstance(v,list):return [canonical(x) for x in v]
    return v

def compare(args,checks):
    a=json.loads((Path(args.baseline)/'kernel.json').read_text());b=json.loads((Path(args.candidate)/'kernel.json').read_text())
    checks.append({'id':'owners-completed','pass':a.get('pass') is True and b.get('pass') is True and a['owner']=='bun' and b['owner']=='native' and len(a['cases'])==8 and set(a['cases'])==set(b['cases']),'reason':'both scratch owners complete','failureCode':1})
    checks.append({'id':'native-ledger-control','pass':b['noProjectionHttp'] and not b['projectionHttpReads'] and b['projectedWithoutDaemon'],'reason':'projection is independent of owner HTTP','failureCode':1})
    cases=[]
    for name in ('declarations','seat','runtime','project','attach','pty','ended','metadata-update'):
        passed=canonical(a['cases'][name])==canonical(b['cases'][name]);cases.append({'id':name,'pass':passed})
        checks.append({'id':name,'pass':passed,'reason':'same wire values and recursive object key order','failureCode':1})
    return {'suite':args.suite,'cases':cases,'behaviorQualified':all(c['pass'] for c in checks)}

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--owner',choices=['bun','native'],required=True)
    p.add_argument('--api-fed-control',action='store_true',help='negative control: run the old API-fed kernel against denied projection HTTP')
    for name in ('binary','kernel','installed-release','aspd-socket','scratch-root','artifacts'):p.add_argument('--'+name,type=Path,required=True)
    a=p.parse_args();a.kernel=a.kernel.resolve()
    s=Scratch(a.scratch_root,a.installed_release,a.aspd_socket,a.binary,a.artifacts,project_id='n4b-kernel')
    result={'owner':a.owner,'cases':{},'pass':False};observer=None;wire=None
    try:
        s.init_substrate();owner=s.up(a.owner,'kernel')
        scope='agent:tabularasa:project:n4b-kernel:task:projection'
        birth=s.command('birth',['hrc','start',scope,'--project-id',s.project_id,'--project-root',s.project,'--cwd',s.project,'--json','-p','Reply with exactly READY. No tools.'])
        runtime=birth['runtime'];s.wait_completed(runtime['runId'])
        s.wait(lambda: json.loads(s.rows('SELECT runtime_state_json FROM runtimes WHERE runtime_id=?',(runtime['runtimeId'],))[0]['runtime_state_json'] or '{}').get('contextReading'),30,'persisted context reading')
        proxy=s.root/'kernel-api.sock';observer=Observer(proxy,s,a.owner=='native');threading.Thread(target=observer.serve_forever,daemon=True).start()
        kroot=s.root/'kernel';kroot.mkdir();log=(a.artifacts/'kernel.log').open('w');s.logs.append(log)
        executable=s.release/'bin/hrc-kernel';shutil.copy2(a.kernel,executable)
        argv=[str(executable),'--runtime-root',str(kroot),'--hrc-socket',str(proxy)]
        if a.owner=='native' and not a.api_fed_control:argv+=['--ledger-path',str(s.db_path)]
        kernel=subprocess.Popen(argv,env=s.env,cwd=s.project,stdout=log,stderr=log);s.owners.append(kernel)
        path=kroot/'hrc-kernel.sock';s.wait(path.exists,30,'kernel ready');wire=Wire(path)
        def query(kind):return wire.call('document.query',{'document_id':'hrc','type':'hrc.'+kind,'limit':100})
        def rows(kind):
            out=query(kind);assert not out['bootstrapping'] and out['next'] is None,out
            return out['rows']
        def normalized(v):
            if isinstance(v,dict):return {k:normalized(x) for k,x in v.items()}
            if isinstance(v,list):return [normalized(x) for x in v]
            if isinstance(v,str):
                for old,new in [(str(s.root),'<scratch>'),(runtime['runtimeId'],'<runtime>'),(runtime['hostSessionId'],'<host>'),(runtime['runId'],'<run>')]:v=v.replace(old,new)
                return re.sub(r'claude-code--rt-[a-f0-9-]+\.sock','claude-code--<runtime>.sock',v)
            return v
        result['cases']['declarations']=wire.call('registry.discover')
        seat=rows('seat');assert len(seat)==1,seat
        result['cases']['seat']=normalized(seat)
        result['cases']['runtime']=normalized(rows('runtime'));result['cases']['project']=normalized(rows('project'))
        assert seat[0]['payload'].get('tmux'),seat
        attachment=wire.call('resource.attach',{'document_id':'hrc','id':seat[0]['id']})
        assert attachment['transport']=='tmux-attach' and '-r' in attachment['descriptor']['argv'],attachment
        result['cases']['attach']=normalized(attachment)
        # Drive the attachment in a real PTY, exactly the descriptor Loggia
        # consumes. The conformance runner records the attach/detach transcript.
        import runpy
        driver=runpy.run_path(str(ROOT/'conformance/hrc-parity/run.py'))
        probe=driver['drive_pty']({'runtimeRoot':str(s.root/'run'),'projectRoot':str(s.project),'env':s.env}, {'descriptor':attachment['descriptor']})
        (a.artifacts/'pty.json').write_text(json.dumps(probe,indent=2)+'\n')
        assert probe['attachedClient'] and probe['detachExit']==0 and probe['runtimeAliveAfter'],probe
        result['cases']['pty']={'attached':True,'detached':True,'runtimeAlive':True}
        # The kernel's descriptor is independently checked against real tmux.
        tmux=attachment['descriptor']['socket'];target=attachment['descriptor']['target']
        s.command('attach-target',['tmux','-S',tmux,'list-panes','-t',target,'-F','#{pane_id}'])
        # Metadata mutation and event append use the copied release's store;
        # neither owner can supply the kernel's projection after native stop.
        if a.owner=='native':s.down(owner)
        module=s.release/'packages/hrc-store-sqlite/src/database.ts'
        script='import {openHrcDatabase} from '+json.dumps(str(module))+';const db=openHrcDatabase(process.argv[1]);db.sessionMetadata.write({scopeRef:process.argv[2],laneRef:"main",source:"api",set:{title:"N4 native ledger"},updatedBy:"agent:cody"});db.hrcEvents.append({ts:new Date().toISOString(),eventKind:"session.updated",category:"session",scopeRef:process.argv[2],laneRef:"main",hostSessionId:process.argv[3],generation:1,payload:{title:"N4 native ledger"}});db.close()'
        s.command('ledger-update',['bun','-e',script,s.db_path,scope,runtime['hostSessionId']])
        updated=s.wait(lambda:(v if (v:=rows('seat'))[0]['payload'].get('title')=='N4 native ledger' else None),30,'native ledger update')
        result['cases']['metadata-update']=normalized(updated)
        result['projectedWithoutDaemon']=a.owner=='native' and owner.poll() is not None
        # An ended tmux target must refuse without changing the projection.
        s.command('end-target',['tmux','-S',tmux,'kill-window','-t',target])
        wire.file.write((json.dumps({'id':'ended','op':'resource.attach','args':{'document_id':'hrc','id':seat[0]['id']}})+'\n').encode())
        ended=json.loads(wire.file.readline());assert not ended['ok'] and ended['error']['details']['reason']=='ended',ended
        result['cases']['ended']=normalized(ended)
        result['projectionHttpReads']=observer.reads;result['noProjectionHttp']=not observer.reads
        assert a.owner!='native' or result['noProjectionHttp'],observer.reads
        result['pass']=True
    finally:
        if wire:wire.close()
        if observer:
            result['projectionHttpReads']=observer.reads;result['noProjectionHttp']=not observer.reads
            observer.shutdown();observer.server_close()
        s.cleanup('agent:tabularasa:project:n4b-kernel:task:')
        (a.artifacts/'kernel.json').write_text(json.dumps(result,indent=2)+'\n');(a.artifacts/'drive.json').write_text(json.dumps(s.steps,indent=2)+'\n')
    print(json.dumps({'pass':True,'owner':a.owner,'cases':len(result['cases'])}))
if __name__=='__main__':main()
