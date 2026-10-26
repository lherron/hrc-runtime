#!/usr/bin/env python3
"""N1 session index workflow on a real Bun-created scratch store.

Run from a clean terminal. Bun creates sessions through its public API. Each
owner then receives the same request sequence from the same scratch snapshot.
Only response timestamps created by that sequence may differ; their types and
request-time bounds are checked. All other response keys/values must agree.
"""
import argparse
import base64
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


def main():
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
        written=call('PATCH','/v1/sessions/metadata',{'scopeRef':scope,'set':{'title':'N1 index title'}})
        assert written['status']==200,written
        local_node=call('GET','/v1/status')['body']['node']['nodeId']
        down()
        fixture = """
import {openHrcDatabase} from PATH_DATABASE;
import {createPlacementLedgerRepository} from PATH_LEDGER;
const db=openHrcDatabase(process.argv[1]);
const ledger=createPlacementLedgerRepository(db.sqlite);
const base=process.argv[2],local=process.argv[3],at='2026-10-25T12:00:00.000Z';
for (const [suffix,node] of [['local-a',local],['local-b',local],['remote','n1-remote'],['retired',local]]) {
  ledger.installActive({scopeRef:base+'-'+suffix,homeNodeId:node,updatedAt:at});
}
ledger.retire({scopeRef:base+'-retired',expectedHomeNodeId:local,reason:'n1 scratch fixture',retiredAt:at});
db.close();
""".replace('PATH_DATABASE',json.dumps(str(release/'packages/hrc-store-sqlite/src/database.ts'))).replace('PATH_LEDGER',json.dumps(str(release/'packages/hrc-store-sqlite/src/federation-repositories.ts')))
        subprocess.run(['bun','-e',fixture,str(dbpath),scope,local_node],env=env,check=True,capture_output=True)
        with sqlite3.connect(dbpath) as source, sqlite3.connect(root/'snapshot.sqlite') as target:source.backup(target)
        cases = [
            ('placement-bindings','GET','/v1/placement/bindings?home=self&state=active',None),
            ('placement-bindings-missing','GET','/v1/placement/bindings',None),
            ('placement-bindings-wrong-state','GET','/v1/placement/bindings?home=self&state=retired',None),
            ('placement-bindings-untrimmed','GET','/v1/placement/bindings?home=%20self&state=active',None),
            ('index-page','GET','/v1/sessions/page?limit=1',None),
            ('index-page-all','GET','/v1/sessions/page',None),
            ('index-page-filter','GET',query('/v1/sessions/page',agentId='tabularasa',projectId='n1-t11818',effectiveStatus='inactive',executionMode='nonInteractive',q='n1-t11818'),None),
            ('index-page-lossy','GET','/v1/sessions/page?q=%ff',None),
            ('index-page-empty','GET',query('/v1/sessions/page',q='%_'),None),
            ('index-page-lane','GET','/v1/sessions/page?laneRef=alternate',None),
            ('index-page-limit','GET','/v1/sessions/page?limit=0',None),
            ('index-page-limit-fraction','GET','/v1/sessions/page?limit=1.5',None),
            ('index-page-limit-overflow','GET','/v1/sessions/page?limit=201',None),
            ('index-page-status','GET','/v1/sessions/page?effectiveStatus=invalid',None),
            ('index-page-mode','GET','/v1/sessions/page?executionMode=invalid',None),
            ('index-page-nodes','GET','/v1/sessions/page?nodes=missing',None),
            ('index-page-nodes-order','GET','/v1/sessions/page?nodes=z,a',None),
            ('index-page-duplicate-limit','GET','/v1/sessions/page?limit=1&limit=0',None),
            ('index-page-cursor','GET','/v1/sessions/page?cursor=bad',None),
            ('index-facets','GET','/v1/sessions/facets',None),
            ('index-facets-filter','GET',query('/v1/sessions/facets',agentId='absent',effectiveStatus='active',executionMode='headless'),None),
            ('index-facets-agent','GET','/v1/sessions/facets?agentId=absent',None),
            ('index-facets-effective','GET','/v1/sessions/facets?effectiveStatus=active',None),
            ('index-facets-execution','GET','/v1/sessions/facets?executionMode=headless',None),
            ('index-facets-project','GET','/v1/sessions/facets?projectId=absent',None),
            ('index-facets-status','GET','/v1/sessions/facets?effectiveStatus=invalid',None),
            ('index-facets-mode','GET','/v1/sessions/facets?executionMode=invalid',None),
            ('index-facets-limit','GET','/v1/sessions/facets?limit=1',None),
            ('index-facets-cursor','GET','/v1/sessions/facets?cursor=bad',None),
        ]
        for kind in ('bun','native'):
            with sqlite3.connect(root/'snapshot.sqlite') as source,sqlite3.connect(dbpath) as target:source.backup(target)
            up(kind,kind)
            observed=[]
            with sqlite3.connect(f'file:{dbpath}?mode=ro',uri=True) as db:highwater=db.execute('SELECT COALESCE(MAX(hrc_seq),0) FROM hrc_events').fetchone()[0]
            for name,method,path,body in cases:
                before=time.time()
                before_events=metadata_events()
                value=call(method,path,body)
                observed.append({'case':name,'method':method,'path':path,'request':body,'response':value,'before':before,'after':time.time(),'metadataEvents':metadata_events()-before_events,'databaseMaxHrcSeq':highwater})
            first=next(row for row in observed if row['case']=='index-page')['response']['body']
            if isinstance(first,dict) and 'nextCursor' in first:
                numeric_cursor=json.loads(base64.urlsafe_b64decode(first['nextCursor']+'='*(-len(first['nextCursor'])%4)))
                numeric_cursor['v']=5.0
                numeric_cursor=base64.urlsafe_b64encode(json.dumps(numeric_cursor,separators=(',',':')).encode()).decode().rstrip('=')
                for name,path in [('index-cursor-number',query('/v1/sessions/page',limit=1,cursor=numeric_cursor)),('index-next',query('/v1/sessions/page',limit=1,cursor=first['nextCursor'])),('index-cursor-mismatch',query('/v1/sessions/page',limit=1,cursor=first['nextCursor'],agentId='absent'))]:
                    before=time.time();value=call('GET',path)
                    observed.append({'case':name,'method':'GET','path':path,'request':None,'response':value,'before':before,'after':time.time(),'metadataEvents':0,'databaseMaxHrcSeq':highwater})
            down()
            results[kind]=observed
        (args.artifacts/'observations.json').write_text(json.dumps(results,indent=2)+'\n')
        for kind, observations in results.items():
            directory=args.artifacts/kind
            directory.mkdir(exist_ok=True)
            (directory/'observations.json').write_text(json.dumps(observations,indent=2)+'\n')
        compared=subprocess.run(['python3',str(Path(__file__).resolve().parents[3]/'conformance/hrc-parity/run.py'),
            'compare','--suite','n1-index','--baseline',str(args.artifacts/'bun'),
            '--candidate',str(args.artifacts/'native'),'--out',str(args.artifacts/'compare')],capture_output=True,text=True)
        (args.artifacts/'compare.stdout').write_text(compared.stdout)
        (args.artifacts/'compare.stderr').write_text(compared.stderr)
        assert compared.returncode==0, compared.stdout+compared.stderr
        print(json.dumps({'pass':True,'comparison':str(args.artifacts/'compare/summary.json')}))
    finally:down()


if __name__=='__main__':main()
