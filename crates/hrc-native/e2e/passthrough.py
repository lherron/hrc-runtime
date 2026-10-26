#!/usr/bin/env python3
"""Proxy workflow: real copied Bun, separate stores, buffered and live responses.

Failure modes: wrong owner/store, lost method/query/body/headers/status, buffered
streaming, recursive forwarding, or disabled-proxy behavior changing.
"""
import argparse
from http.client import HTTPException
import json
import os
from pathlib import Path
import signal
import sqlite3
import subprocess
import time
from foundation import UnixHTTP


def main():
    p=argparse.ArgumentParser()
    p.add_argument('--binary',type=Path,required=True)
    p.add_argument('--bun-release',type=Path,required=True)
    p.add_argument('--scratch-root',type=Path,required=True)
    p.add_argument('--artifacts',type=Path,required=True)
    args=p.parse_args()
    assert not any(os.environ.get(k) for k in ('CLAUDECODE','CLAUDE_CODE_ENTRYPOINT','CODEX_SANDBOX'))
    root=args.scratch_root.absolute()
    assert not root.exists()
    root.mkdir(parents=True)
    args.artifacts.mkdir(parents=True,exist_ok=True)
    release=args.bun_release.resolve()
    assert release.parent.name!='hrc-runtime-releases'
    owners=[];logs=[];observations=[]
    base=dict(os.environ,HRC_PEER_CONFIG_FILE=str(root/'no-federation.json'),HRC_ACP_WEBHOOK_URL='',WRKQ_DB=str(root/'wrkq.db'),HRC_WRKQ_DB=str(root/'wrkq.db'))
    for key in ('HRC_SESSION_REF','HRC_RUNTIME_ID','HRC_RUN_ID','HRC_HOST_SESSION_ID','HRC_EVENT_FORWARD_URL','HRC_EVENT_INGEST_TCP_PORT','HRC_EVENT_FORWARD_SOURCE_REF','WRKQ_DB_PATH','WRKQ_DB_PATH_FILE','HRC_BUN_PASSTHROUGH_SOCKET'):
        base.pop(key,None)
    def request(socket,method,path,body=None,stream=False):
        http=UnixHTTP(socket)
        http.timeout=5
        http.request(method,path,body,{'Content-Type':'application/json','x-hrc-principal-ref':'agent:cody','x-n1-proxy-test':'retained'})
        response=http.getresponse()
        headers={k.lower():v for k,v in response.getheaders()}
        content=response.readline().decode() if stream else response.read().decode()
        result={'method':method,'path':path,'status':response.status,'headers':headers,'body':content}
        http.close()
        return result
    def up(kind,proxy=None):
        env=dict(base,HRC_RUNTIME_DIR=str(root/kind/'run'),HRC_STATE_DIR=str(root/kind/'state'),HRC_EVENT_INGEST_SOCKET=str(root/kind/'run/ingest.sock'))
        if proxy:env['HRC_BUN_PASSTHROUGH_SOCKET']=str(proxy)
        log=(args.artifacts/(kind+'.log')).open('w');logs.append(log)
        argv=[str(args.binary.resolve()),'server'] if kind=='native' else ['bun',str(release/'packages/hrc-cli/src/cli.ts'),'server','serve']
        proc=subprocess.Popen(argv,env=env,cwd=root,stdout=log,stderr=log);owners.append(proc)
        socket=root/kind/'run/hrc.sock'
        for _ in range(300):
            assert proc.poll() is None,(kind,'exited')
            try:
                if request(socket,'GET','/v1/health')['status']==200:return socket
            except (OSError,HTTPException):pass
            time.sleep(.05)
        raise AssertionError(kind+' not ready')
    try:
        subprocess.run(['wrkqadm','migrate'],env=base,check=True,capture_output=True)
        subprocess.run(['wrkq','mkdir','/n1-t11818','--kind','project','--as','agent:cody'],env=base,check=True,capture_output=True)
        bun=up('bun')
        scope='agent:tabularasa:project:n1-t11818:task:proxy-'+str(time.time_ns())
        created=request(bun,'POST','/v1/sessions/resolve',json.dumps({'sessionRef':scope+'/lane:main','create':True,'summonIntent':'explicit_local'}))
        assert created['status']==200,created
        host=json.loads(created['body'])['hostSessionId']
        db=root/'native/state/state.sqlite';db.parent.mkdir(parents=True)
        subprocess.run(['bun','-e',f'import {{openHrcDatabase}} from {json.dumps(str(release/"packages/hrc-store-sqlite/src/database.ts"))};openHrcDatabase(process.argv[1]).close()',str(db)],check=True)
        native=up('native')
        disabled=request(native,'GET','/v1/targets')
        assert disabled['status']==404 and disabled['body']=='Not Found', disabled
        observations.append({'noSocket':disabled})
        owners[-1].send_signal(signal.SIGTERM)
        owners[-1].wait(timeout=20)
        native=up('native',bun)
        assert native.resolve()!=bun.resolve()
        assert all(proc.poll() is None for proc in (owners[0],owners[-1]))
        for method,path,body in [
            ('GET','/v1/targets?includeDormant=true&projectId=n1-t11818',None),
            ('POST','/v1/runtimes/ensure',json.dumps({'hostSessionId':'hsid-body-forwarded'})),
            ('POST','/v1/runtimes/ensure','{"broken":'),
            ('POST','/v1/runtimes/ensure',' '*(3*1024*1024)+'{}'),
            ('DELETE','/v1/not-a-native-route?forwarded=yes','payload'),
            ('POST','/v1/surfaces/unbind','{'),
            ('POST','/v1/capture/recover','{'),
            ('POST','/v1/in-flight-input','{'),
            ('POST','/v1/transcript-search','{'),
            ('GET','/v1/surfaces',None),
            ('GET','/v1/transcript-index/status',None),
        ]:
            direct=request(bun,method,path,body)
            forwarded=request(native,method,path,body)
            observations.append({'direct':direct,'forwarded':forwarded})
            assert (direct['status'],direct['body'])==(forwarded['status'],forwarded['body']),observations[-1]
            for key,value in direct['headers'].items():
                if key.lower() not in ('date','connection','keep-alive','transfer-encoding','content-length'):
                    assert forwarded['headers'].get(key)==value,(key,direct,forwarded)
        page=json.loads(request(bun,'GET','/v1/events/page?afterSeq=0&limit=1')['body'])
        path=f'/v1/events/bounded-stream?hostSessionId={host}&generation=1&afterSeq=0&ledgerIncarnationId={page["ledgerIncarnationId"]}&follow=true'
        started=time.monotonic()
        direct=request(bun,'GET',path,stream=True)
        forwarded=request(native,'GET',path,stream=True)
        assert time.monotonic()-started<5,'live response buffered until completion'
        assert direct['status']==200 and (direct['status'],direct['body'])==(forwarded['status'],forwarded['body']), (direct,forwarded)
        assert json.loads(forwarded['body'])['type']=='ready'
        observations.append({'direct':direct,'forwarded':forwarded,'streaming':True})
        with sqlite3.connect(db) as subject:
            assert subject.execute('SELECT count(*) FROM sessions').fetchone()[0]==0
        for kind,key in [('bun','direct'),('native','forwarded')]:
            directory=args.artifacts/kind
            directory.mkdir(exist_ok=True)
            (directory/'observations.json').write_text(json.dumps([o[key] for o in observations if key in o],indent=2)+'\n')
        compared=subprocess.run(['python3',str(Path(__file__).resolve().parents[3]/'conformance/hrc-parity/run.py'),
            'compare','--suite','n1-passthrough','--baseline',str(args.artifacts/'bun'),
            '--candidate',str(args.artifacts/'native'),'--out',str(args.artifacts/'compare')],capture_output=True,text=True)
        (args.artifacts/'compare.stdout').write_text(compared.stdout)
        assert compared.returncode==0,compared.stdout+compared.stderr
        print(json.dumps({'pass':True,'requests':len(observations),'separateStores':True,'streaming':True}))
    finally:
        for proc in reversed(owners):
            if proc.poll() is None:proc.send_signal(signal.SIGTERM);proc.wait(timeout=20)
        for log in logs:log.close()
        (args.artifacts/'observations.json').write_text(json.dumps(observations,indent=2)+'\n')


if __name__=='__main__':main()
