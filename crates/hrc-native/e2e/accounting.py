#!/usr/bin/env python3
"""Real-owner accounting differential, with separate stores for proxy traffic.

Failure modes: route/method/client strata drift, dropped errors/request IDs,
wrong weights or bytes, metrics in a shared state root, missing forwarded
traffic, successful-poll L3 leakage, or buffering/cancellation of streams.
"""
import argparse
from collections import Counter
from http.client import HTTPException
import json
import os
from pathlib import Path
import signal
import sqlite3
import datetime
import subprocess
import time
from foundation import UnixHTTP


def main():
    p=argparse.ArgumentParser()
    for name in ('binary','bun-release','scratch-root','artifacts'):
        p.add_argument('--'+name,type=Path,required=True)
    args=p.parse_args()
    assert not any(os.environ.get(k) for k in ('CLAUDECODE','CLAUDE_CODE_ENTRYPOINT','CODEX_SANDBOX'))
    root=args.scratch_root.absolute();assert not root.exists();root.mkdir(parents=True)
    args.artifacts.mkdir(parents=True,exist_ok=True)
    release=args.bun_release.resolve();assert release.parent.name!='hrc-runtime-releases'
    base=dict(os.environ,HRC_PEER_CONFIG_FILE=str(root/'absent.json'),HRC_ACP_WEBHOOK_URL='',WRKQ_DB=str(root/'wrkq.db'),HRC_WRKQ_DB=str(root/'wrkq.db'))
    for key in ('HRC_SESSION_REF','HRC_RUNTIME_ID','HRC_RUN_ID','HRC_HOST_SESSION_ID','HRC_EVENT_FORWARD_URL','HRC_EVENT_INGEST_TCP_PORT','HRC_EVENT_FORWARD_SOURCE_REF','WRKQ_DB_PATH','WRKQ_DB_PATH_FILE','HRC_BUN_PASSTHROUGH_SOCKET','HRC_METRICS'):
        base.pop(key,None)
    owners=[];logs=[];observations={}
    def call(socket,method,path,client='probe',request_id=None,stream=False):
        http=UnixHTTP(socket);http.timeout=5
        headers={'User-Agent':client+' extra ignored'}
        if request_id is not None:headers['x-hrc-request-id']=request_id
        http.request(method,path,None,headers);response=http.getresponse()
        body=response.readline() if stream else response.read()
        row={'method':method,'path':path,'status':response.status,'bytes':len(body),'client':client,'requestId':request_id}
        http.close();return row
    def up(kind,proxy=None):
        state=root/kind/'state';runtime=root/kind/'run'
        env=dict(base,HRC_STATE_DIR=str(state),HRC_RUNTIME_DIR=str(runtime),HRC_EVENT_INGEST_SOCKET=str(runtime/'ingest.sock'))
        log=(args.artifacts/(kind+'.log')).open('w');logs.append(log)
        argv=[str(args.binary.resolve()),'server'] if kind.startswith('native') else ['bun',str(release/'packages/hrc-cli/src/cli.ts'),'server','serve']
        if proxy:argv.extend(['--bun-socket',str(proxy)])
        proc=subprocess.Popen(argv,env=env,cwd=root,stdout=log,stderr=log);owners.append(proc)
        socket=runtime/'hrc.sock'
        for _ in range(300):
            assert proc.poll() is None,kind+' exited'
            try:
                if call(socket,'GET','/v1/health')['status']==200:return socket
            except (OSError,HTTPException):pass
            time.sleep(.05)
        raise AssertionError(kind+' not ready')
    try:
        subprocess.run(['wrkqadm','migrate'],env=base,check=True,capture_output=True)
        bun=up('bun')
        subprocess.run(['wrkq','mkdir','/n1-t11818','--kind','project','--as','agent:cody'],env=base,check=True,capture_output=True)
        http=UnixHTTP(bun)
        http.request('POST','/v1/sessions/resolve',json.dumps({'sessionRef':'agent:tabularasa:project:n1-t11818:task:accounting-'+str(time.time_ns())+'/lane:main','create':True,'summonIntent':'explicit_local'}),{'Content-Type':'application/json'})
        response=http.getresponse();assert response.status==200
        host=json.loads(response.read())['hostSessionId'];http.close()
        http=UnixHTTP(bun);http.request('GET','/v1/events/page?afterSeq=0&limit=1');response=http.getresponse()
        incarnation=json.loads(response.read())['ledgerIncarnationId'];http.close()
        stream_path=f'/v1/events/bounded-stream?hostSessionId={host}&generation=1&afterSeq=0&ledgerIncarnationId={incarnation}&follow=true'
        state=root/'native/state';state.mkdir(parents=True)
        subprocess.run(['bun','-e',f'import {{openHrcDatabase}} from {json.dumps(str(release/"packages/hrc-store-sqlite/src/database.ts"))};openHrcDatabase(process.argv[1]).close()',str(state/'state.sqlite')],check=True)
        native=up('native',bun)
        # Run a whole systematic tail, avoiding the UTC-minute boundary.
        if time.time()%60>50:time.sleep(60-time.time()%60+.1)
        for kind,socket in [('bun',bun),('native',native)]:
            rows=[]
            for path in ('/v1/health','/v1/targets','/v1/sessions?all=true'):
                client='n1-accounting/'+kind+'/'+path.split('/')[-1].split('?')[0]
                for _ in range(50):rows.append(call(socket,'GET',path,client))
            for i in range(7):rows.append(call(socket,'GET','/v1/health','n1-accounting/'+kind+'/request-id',' id-'+str(i)+' '))
            for _ in range(13):rows.append(call(socket,'GET','/v1/sessions/by-host/hsid-no-such-host?private=query','n1-accounting/'+kind+'/error'))
            rows.append(call(socket,'GET',stream_path,'n1-accounting/'+kind+'/stream',stream=True))
            observations[kind]=rows
        time.sleep(1.5)
    finally:
        for proc in reversed(owners):
            if proc.poll() is None:proc.send_signal(signal.SIGTERM);proc.wait(timeout=20)
        for log in logs:log.close()
    metrics={};counts={};request_logs={}
    for kind in ('bun','native'):
        records=[]
        prefix='rusthrc-server-' if kind=='native' else 'server-'
        for file in (root/kind/'state/metrics').glob(prefix+'*.ndjson'):
            records.extend(json.loads(line) for line in file.read_text().splitlines())
        # Bun also records upstream forwarded traffic with the native client's
        # label. Select each owner's own request population by its client prefix.
        records=[r for r in records if r.get('kind')=='server' and r.get('client','').startswith('n1-accounting/'+kind+'/')]
        metrics[kind]=records
        count=Counter()
        for r in records:
            assert r['v']==1 and 'listener' not in r and 'peer' not in r,r
            assert isinstance(r['ms'],(float,int)) and r['ms']>=0 and 'ts' in r,r
            assert ('stream' in r) != ('bytes' in r),r
            if 'reqId' in r:assert r['reqId'].strip().startswith('id-'),r
            count[(r['method'],r['route'],r['client'].replace('/'+kind+'/', '/'))]+=r.get('sampleWeight',1)
        counts[kind]={' '.join(k):v for k,v in sorted(count.items())}
        lines=[]
        for line in (args.artifacts/(kind+'.log')).read_text().splitlines():
            try:r=json.loads(line)
            except json.JSONDecodeError:continue
            if r.get('component')=='http' and r.get('data',{}).get('client','').startswith('n1-accounting/'):lines.append(r)
        lines=[r for r in lines if r['data']['client'].startswith('n1-accounting/'+kind+'/')]
        request_logs[kind]=lines
        (args.artifacts/(kind+'-metrics.json')).write_text(json.dumps(records,indent=2)+'\n')
        assert not any(r['event']=='http.request' and r['data']['route']=='/v1/sessions' and r['data']['status']<400 for r in lines),lines
        assert any(r['event']=='http.request' and r['level']=='warn' and r['data'].get('code')=='unknown_host_session' for r in lines),lines
        assert any(r['event']=='http.stream.open' for r in lines),lines
        assert any(r['event']=='http.stream.close' and r['data']['outcome'] in ('end','cancel') for r in lines),lines
        assert all('?' not in r['data']['path'] for r in lines),lines
    expected={'GET /v1/health n1-accounting/health':50,'GET /v1/targets n1-accounting/targets':50,'GET /v1/sessions n1-accounting/sessions':50,'GET /v1/health n1-accounting/request-id':7,'GET /v1/sessions/by-host/:hostSessionId n1-accounting/error':13,'GET /v1/events/bounded-stream n1-accounting/stream':1}
    report={'observations':observations,'counts':counts,'expected':expected,'metrics':metrics,'logs':request_logs}
    (args.artifacts/'accounting.json').write_text(json.dumps(report,indent=2)+'\n')
    for kind in ('bun','native'):
        directory=args.artifacts/kind;directory.mkdir(exist_ok=True)
        (directory/'accounting.json').write_text(json.dumps({'metrics':metrics[kind],'observations':observations[kind],'logs':request_logs[kind]},indent=2)+'\n')
    compared=subprocess.run(['python3',str(Path(__file__).resolve().parents[3]/'conformance/hrc-parity/run.py'),'compare','--suite','n1-accounting','--baseline',str(args.artifacts/'bun'),'--candidate',str(args.artifacts/'native'),'--out',str(args.artifacts/'compare')],capture_output=True,text=True)
    (args.artifacts/'compare.stdout').write_text(compared.stdout+compared.stderr)
    assert compared.returncode==0,compared.stdout+compared.stderr
    assert counts['bun']==expected,counts['bun']
    assert counts['native']==expected,counts['native']
    assert any(r.get('sampleWeight')==20 for r in metrics['native'])
    # Writer failures and limits are isolated from the differential population.
    def init_control(kind):
        state=root/kind/'state';state.mkdir(parents=True)
        with sqlite3.connect(root/'native/state/state.sqlite') as source, sqlite3.connect(state/'state.sqlite') as target:source.backup(target)
        return state/'metrics'
    try:
        directory=init_control('native-drop')
        directory.write_text('mkdir must fail without failing requests')
        socket=up('native-drop')
        assert call(socket,'GET','/v1/health','n1-drop')['status']==200
        time.sleep(1.2)
        directory.unlink()
        assert call(socket,'GET','/v1/health','n1-drop-recovery')['status']==200
        time.sleep(1.2)
        records=[json.loads(line) for file in directory.glob('rusthrc-server-*.ndjson') for line in file.read_text().splitlines()]
        assert any(r.get('name')=='metrics.dropped' and r['value']>=1 for r in records),records
        directory=init_control('native-cap');directory.mkdir()
        today=datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%d')
        cap=directory/('rusthrc-server-'+today+'.ndjson')
        with cap.open('wb') as file:file.truncate(128*1024*1024)
        expired=directory/'rusthrc-server-2000-01-01.ndjson';expired.write_text('old')
        recent=directory/'rusthrc-server-2000-01-02.ndjson';recent.write_text('recent mtime')
        calendar_invalid=directory/'rusthrc-server-2000-99-99.ndjson';calendar_invalid.write_text('pattern still matches')
        unrelated=directory/'other-2000-01-01.ndjson';unrelated.write_text('keep')
        bun_owned=directory/'server-2000-01-01.ndjson';bun_owned.write_bytes(b'Bun-owned canary')
        for file in (expired,calendar_invalid,unrelated,bun_owned):os.utime(file,(time.time()-15*86400,)*2)
        bun_before=(bun_owned.read_bytes(),bun_owned.stat().st_mtime_ns)
        socket=up('native-cap')
        assert call(socket,'GET','/v1/health','n1-cap')['status']==200
        time.sleep(1.2)
        assert (bun_owned.read_bytes(),bun_owned.stat().st_mtime_ns)==bun_before
        assert cap.stat().st_size==128*1024*1024
        assert not expired.exists() and not calendar_invalid.exists() and recent.exists() and unrelated.exists()
    finally:
        for proc in reversed(owners):
            if proc.poll() is None:proc.send_signal(signal.SIGTERM);proc.wait(timeout=20)
        for log in logs:log.close()
    assert 'server.metrics.day_cap_reached' in (args.artifacts/'native-cap.log').read_text()
    (args.artifacts/'results.json').write_text(json.dumps({'pass':True,'weightedCounts':counts,'writerControls':{'dropRecovery':True,'dayCap':True,'retention':True}},indent=2)+'\n')
    print(json.dumps({'pass':True,'artifacts':str(args.artifacts)}))

if __name__=='__main__':main()
