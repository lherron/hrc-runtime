#!/usr/bin/env python3
"""Finite N1 API workflow on a real Bun-created scratch store.

Run from a clean terminal. Bun creates sessions through its public API. Each
owner then receives the same request sequence from the same scratch snapshot.
Only response timestamps created by that sequence may differ; their types and
request-time bounds are checked. All other response keys/values must agree.
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
from urllib.parse import urlencode
from foundation import UnixHTTP


def main(prepare=None, case_factory=None, observe=None, suite="n1-routes"):
    p = argparse.ArgumentParser()
    p.add_argument('--binary', type=Path, required=True)
    p.add_argument('--bun-release', type=Path, required=True)
    p.add_argument('--scratch-root', type=Path, required=True)
    p.add_argument('--artifacts', type=Path, required=True)
    args = p.parse_args()
    assert not any(os.environ.get(k) for k in ('CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CODEX_SANDBOX'))
    root = args.scratch_root.absolute()
    assert not root.exists(), 'fresh scratch root required'
    root.mkdir(parents=True)
    args.artifacts.mkdir(parents=True, exist_ok=True)
    release = args.bun_release.resolve()
    assert release.parent.name != 'hrc-runtime-releases'
    env = dict(os.environ, HRC_RUNTIME_DIR=str(root/'run'), HRC_STATE_DIR=str(root/'state'),
               HRC_PEER_CONFIG_FILE=str(root/'absent-federation.json'),
               HRC_WRKQ_DB=str(root/'wrkq.db'), WRKQ_DB=str(root/'wrkq.db'),
               HRC_ACP_WEBHOOK_URL='', HRC_EVENT_INGEST_SOCKET=str(root/'run/ingest.sock'))
    for key in ('HRC_SESSION_REF','HRC_RUNTIME_ID','HRC_RUN_ID','HRC_HOST_SESSION_ID',
                'HRC_EVENT_FORWARD_URL','HRC_EVENT_INGEST_TCP_PORT','HRC_EVENT_FORWARD_SOURCE_REF',
                'WRKQ_DB_PATH','WRKQ_DB_PATH_FILE'):
        env.pop(key, None)
    dbpath = root/'state/state.sqlite'
    proc, log = None, None
    results = {}
    def metadata_events():
        with sqlite3.connect(f'file:{dbpath}?mode=ro', uri=True) as db:
            return db.execute("SELECT count(*) FROM hrc_events WHERE event_kind='session.metadata.changed'").fetchone()[0]
    def call(method,path,body=None):
        http = UnixHTTP(root/'run/hrc.sock')
        http.request(method,path,json.dumps(body) if body is not None else None,{'Content-Type':'application/json','x-hrc-principal-ref':'agent:cody'})
        response = http.getresponse()
        raw = response.read().decode()
        headers = {k.lower():v for k,v in response.getheaders() if k.lower().startswith('x-hrc-session-')}
        http.close()
        try: value = json.loads(raw)
        except json.JSONDecodeError: value = raw
        return {'status':response.status,'body':value,'headers':headers}
    def up(kind,label):
        nonlocal proc,log
        log = (args.artifacts/f'{label}.log').open('w')
        argv = [str(args.binary.resolve()),'server'] if kind=='native' else ['bun',str(release/'packages/hrc-cli/src/cli.ts'),'server','serve']
        proc = subprocess.Popen(argv,env=env,cwd=root,stdout=log,stderr=log)
        for _ in range(300):
            assert proc.poll() is None, (label,'owner exited')
            try:
                if call('GET','/v1/health')['status']==200:return
            except (OSError,HTTPException):pass
            time.sleep(.05)
        raise AssertionError(label+' not ready')
    def down():
        nonlocal proc,log
        if proc is not None and proc.poll() is None:
            proc.send_signal(signal.SIGTERM)
            proc.wait(timeout=20)
        if log:log.close()
        proc,log=None,None
    scope = 'agent:tabularasa:project:n1-t11818:task:route-'+str(time.time_ns())
    host = None
    query = lambda path,**kw:path+'?'+urlencode(kw)
    try:
        subprocess.run(['wrkqadm','migrate'],env=env,check=True,capture_output=True)
        subprocess.run(['wrkq','mkdir','/n1-t11818','--kind','project','--as','agent:cody'],env=env,check=True,capture_output=True)
        up('bun','prime')
        for lane in ('main','alternate'):
            created = call('POST','/v1/sessions/resolve',{'sessionRef':scope+'/lane:'+lane,'create':True,'summonIntent':'explicit_local'})
            assert created['status']==200 and created['body']['created'] is True,created
            if lane=='main':host=created['body']['hostSessionId']
        down()
        if prepare: prepare(release, dbpath, scope, host, env)
        with sqlite3.connect(dbpath) as source, sqlite3.connect(root/'snapshot.sqlite') as target:source.backup(target)
        cases = [
            ('sessions-list','GET','/v1/sessions?all=true',None),
            ('sessions-scope','GET',query('/v1/sessions',scopeRef=scope,laneRef='main',limit=1),None),
            ('sessions-invalid-status','GET','/v1/sessions?status=invalid',None),
            ('sessions-invalid-limit','GET','/v1/sessions?limit=0',None),
            ('sessions-invalid-latest','GET','/v1/sessions?latestGeneration=invalid',None),
            ('session-by-host','GET','/v1/sessions/by-host/'+host,None),
            ('session-missing-host','GET','/v1/sessions/by-host/hsid-unknown',None),
            ('session-continuity','GET',query('/v1/sessions/get',scopeRef=scope),None),
            ('session-continuity-missing','GET','/v1/sessions/get',None),
            ('metadata-empty','GET',query('/v1/sessions/metadata',scopeRef=scope),None),
            ('metadata-write','PATCH','/v1/sessions/metadata',{'scopeRef':scope,'set':{'title':'N1 scratch','custom.check':True}}),
            ('session-after-metadata-write','GET','/v1/sessions/by-host/'+host,None),
            ('sessions-title','GET',query('/v1/sessions',scopeRef=scope,laneRef='main'),None),
            ('metadata-read','GET',query('/v1/sessions/metadata',scopeRef=scope),None),
            ('metadata-repeat','PATCH','/v1/sessions/metadata',{'scopeRef':scope,'set':{'title':'N1 scratch'}}),
            ('metadata-clear','PATCH','/v1/sessions/metadata',{'scopeRef':scope,'clear':['title']}),
            ('metadata-invalid','PATCH','/v1/sessions/metadata',{'scopeRef':scope,'set':{'title':17}}),
            ('sessions-page','GET','/v1/sessions/page?limit=1',None),
            ('sessions-page-invalid','GET','/v1/sessions/page?cursor=bad',None),
            ('sessions-facets','GET','/v1/sessions/facets',None),
            ('sessions-facets-invalid','GET','/v1/sessions/facets?effectiveStatus=invalid',None),
            ('runtimes-empty','GET','/v1/runtimes',None),
            ('runtimes-live-refs-empty','GET','/v1/runtimes/live-refs',None),
            ('wrong-method','DELETE','/v1/sessions/metadata',None),
        ]
        if case_factory: cases = case_factory(scope, host)
        for kind in ('bun','native'):
            with sqlite3.connect(root/'snapshot.sqlite') as source,sqlite3.connect(dbpath) as target:source.backup(target)
            up(kind,kind)
            observed=[]
            for name,method,path,body in cases:
                before=time.time()
                before_events=metadata_events()
                value=call(method,path,body)
                observed.append({'case':name,'method':method,'path':path,'request':body,'response':value,'before':before,'after':time.time(),'metadataEvents':metadata_events()-before_events})
                if observe: observed[-1].update(observe(dbpath))
            down()
            results[kind]=observed
        (args.artifacts/'observations.json').write_text(json.dumps(results,indent=2)+'\n')
        for kind, observations in results.items():
            directory=args.artifacts/kind
            directory.mkdir(exist_ok=True)
            (directory/'observations.json').write_text(json.dumps(observations,indent=2)+'\n')
        compared=subprocess.run(['python3',str(Path(__file__).resolve().parents[3]/'conformance/hrc-parity/run.py'),
            'compare','--suite',suite,'--baseline',str(args.artifacts/'bun'),
            '--candidate',str(args.artifacts/'native'),'--out',str(args.artifacts/'compare')],capture_output=True,text=True)
        (args.artifacts/'compare.stdout').write_text(compared.stdout)
        (args.artifacts/'compare.stderr').write_text(compared.stderr)
        assert compared.returncode==0, compared.stdout+compared.stderr
        print(json.dumps({'pass':True,'comparison':str(args.artifacts/'compare/summary.json')}))
    finally:down()


if __name__=='__main__':main()
