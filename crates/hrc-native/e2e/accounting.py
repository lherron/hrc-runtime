#!/usr/bin/env python3
"""Native owner accounting with weighted counts and writer controls.

Failure modes: route/method/client strata drift, dropped errors/request IDs,
wrong weights or bytes, metrics in a shared state root, missing
traffic, missing successful-request L3 lines, or buffering/cancellation of streams.
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
from foundation import daemon_env, UnixHTTP, owner_follow_ready


def main():
    p=argparse.ArgumentParser()
    for name in ('binary','scratch-root','artifacts'):
        p.add_argument('--'+name,type=Path,required=True)
    args=p.parse_args()
    assert not any(os.environ.get(k) for k in ('CLAUDECODE','CLAUDE_CODE_ENTRYPOINT','CODEX_SANDBOX'))
    root=args.scratch_root.absolute();assert not root.exists();root.mkdir(parents=True)
    args.artifacts.mkdir(parents=True,exist_ok=True)
    base=dict(os.environ,HRC_PEER_CONFIG_FILE=str(root/'absent.json'),HRC_ACP_WEBHOOK_URL='',WRKQ_DB=str(root/'wrkq.db'),HRC_WRKQ_DB=str(root/'wrkq.db'))
    for key in ('HRC_SESSION_REF','HRC_RUNTIME_ID','HRC_RUN_ID','HRC_HOST_SESSION_ID','HRC_EVENT_FORWARD_URL','HRC_EVENT_INGEST_TCP_PORT','HRC_EVENT_FORWARD_SOURCE_REF','WRKQ_DB_PATH','WRKQ_DB_PATH_FILE','HRC_METRICS'):
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
    def up(kind):
        state=root/kind/'state';runtime=root/kind/'run'
        env=dict(base,HRC_STATE_DIR=str(state),HRC_RUNTIME_DIR=str(runtime),HRC_EVENT_INGEST_SOCKET=str(runtime/'ingest.sock'))
        log=(args.artifacts/(kind+'.log')).open('w');logs.append(log)
        argv=[str(args.binary.resolve()),'server','serve']
        schema_path = Path(env['HRC_STATE_DIR']) / 'state.sqlite'
        if not schema_path.exists():
            schema_path.parent.mkdir(parents=True, exist_ok=True)
            subprocess.run([str(args.binary.resolve()), 'store', 'migrate', str(schema_path)],
                           env=env, check=True, capture_output=True)
        proc=subprocess.Popen(argv,env=daemon_env(env),cwd=root,stdout=log,stderr=log);owners.append(proc)
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
        native=up('native')
        subprocess.run([str(Path.home() / ".local/bin/wrkq"),'mkdir','/n1-t11818','--kind','project','--as','agent:cody'],env=base,check=True,capture_output=True)
        http=UnixHTTP(native)
        http.request('POST','/v1/sessions/resolve',json.dumps({'sessionRef':'agent:tabularasa:project:n1-t11818:task:accounting-'+str(time.time_ns())+'/lane:main','create':True,'summonIntent':'explicit_local'}),{'Content-Type':'application/json'})
        response=http.getresponse();assert response.status==200
        host=json.loads(response.read())['hostSessionId'];http.close()
        with sqlite3.connect(root/'native/state/state.sqlite') as db:
            assert db.execute("SELECT count(*) FROM hrc_events WHERE event_kind='session.created'").fetchone()[0] > 0, 'empty accounting ledger'
        # Run a whole systematic tail, avoiding the UTC-minute boundary.
        if time.time()%60>50:time.sleep(60-time.time()%60+.1)
        for kind,socket in [('native',native)]:
            rows=[]
            for path in ('/v1/health','/v1/targets','/v1/sessions?all=true'):
                client='n1-accounting/'+kind+'/'+path.split('/')[-1].split('?')[0]
                for _ in range(50):rows.append(call(socket,'GET',path,client))
            for i in range(7):rows.append(call(socket,'GET','/v1/health','n1-accounting/'+kind+'/request-id',' id-'+str(i)+' '))
            for _ in range(13):rows.append(call(socket,'GET','/v1/sessions/by-host/hsid-no-such-host?private=query','n1-accounting/'+kind+'/error'))
            client='n1-accounting/'+kind+'/stream'
            stream=owner_follow_ready(socket,host,{'User-Agent':client+' extra ignored'})
            rows.append(dict(method='GET',path=stream['wirePath'],status=stream['status'],
                             bytes=len(stream['wireBody'].encode()),client=client,requestId=None,
                             streamProbe=stream))
            observations[kind]=rows
        time.sleep(1.5)
    finally:
        for proc in reversed(owners):
            if proc.poll() is None:proc.send_signal(signal.SIGTERM);proc.wait(timeout=20)
        for log in logs:log.close()
    metrics={};counts={};request_logs={}
    for kind in ('native',):
        records=[]
        prefix='rusthrc-server-'
        for file in (root/kind/'state/metrics').glob(prefix+'*.ndjson'):
            records.extend(json.loads(line) for line in file.read_text().splitlines())
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
        assert sum(r['event']=='http.request' and r['data']['route']=='/v1/sessions' and r['data']['status']<400 for r in lines)==50,lines
        assert any(r['event']=='http.request' and r['level']=='warn' and r['data'].get('code')=='unknown_host_session' for r in lines),lines
        assert any(r['event']=='http.stream.open' for r in lines),lines
        assert any(r['event']=='http.stream.close' and r['data']['outcome'] in ('end','cancel') for r in lines),lines
        assert all('?' not in r['data']['path'] for r in lines),lines
    expected={'GET /v1/health n1-accounting/health':50,'GET /v1/targets n1-accounting/targets':50,'GET /v1/sessions n1-accounting/sessions':50,'GET /v1/health n1-accounting/request-id':7,'GET /v1/sessions/by-host/:hostSessionId n1-accounting/error':13,'GET /v1/events/bounded-stream n1-accounting/stream':1}
    report={'observations':observations,'counts':counts,'expected':expected,'metrics':metrics,'logs':request_logs}
    (args.artifacts/'accounting.json').write_text(json.dumps(report,indent=2)+'\n')
    for kind in ('native',):
        directory=args.artifacts/kind;directory.mkdir(exist_ok=True)
        (directory/'accounting.json').write_text(json.dumps({'metrics':metrics[kind],'observations':observations[kind],'logs':request_logs[kind]},indent=2)+'\n')
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
        # Retention covers every writer's dated day files (T-13047): a stopped
        # writer's dated files age out too.
        other_writer=directory/'other-2000-01-01.ndjson';other_writer.write_text('another writer')
        legacy_owned=directory/'server-2000-01-01.ndjson';legacy_owned.write_bytes(b'legacy writer canary')
        not_metrics=[directory/'notes-2000-01-01.txt',directory/'rusthrc-server.ndjson',directory/'-2000-01-01.ndjson']
        for file in not_metrics:file.write_text('not a dated metrics file')
        for file in (expired,calendar_invalid,other_writer,legacy_owned,*not_metrics):os.utime(file,(time.time()-15*86400,)*2)
        socket=up('native-cap')
        assert call(socket,'GET','/v1/health','n1-cap')['status']==200
        time.sleep(1.2)
        assert cap.stat().st_size==128*1024*1024
        assert not any(f.exists() for f in (expired,calendar_invalid,other_writer,legacy_owned)) and recent.exists()
        assert all(f.exists() for f in not_metrics)
    finally:
        for proc in reversed(owners):
            if proc.poll() is None:proc.send_signal(signal.SIGTERM);proc.wait(timeout=20)
        for log in logs:log.close()
    assert 'server.metrics.day_cap_reached' in (args.artifacts/'native-cap.log').read_text()
    (args.artifacts/'results.json').write_text(json.dumps({'pass':True,'weightedCounts':counts,'writerControls':{'dropRecovery':True,'dayCap':True,'retention':True}},indent=2)+'\n')
    import shutil
    shutil.rmtree(root)
    print(json.dumps({'pass':True,'artifacts':str(args.artifacts)}))

if __name__=='__main__':main()
