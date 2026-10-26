#!/usr/bin/env python3
"""Real owners, own historical fixtures: recency, liveness, ordering and parsing.

Failures: housekeeping warms history, old live seats withheld, wrong lane or
scope selection, collapse performed before the window, ignored boolean aliases,
wrong error precedence, or reads mutating durable rows. No copied real rows.
"""
import argparse,datetime,json,os,signal,sqlite3,subprocess,time
from pathlib import Path
from http.client import HTTPException
from urllib.parse import urlencode
from foundation import UnixHTTP

p=argparse.ArgumentParser()
for key in ['binary','bun-release','scratch-root','artifacts']:p.add_argument('--'+key,type=Path,required=True)
a=p.parse_args();root=a.scratch_root.absolute();assert not root.exists();root.mkdir(parents=True);a.artifacts.mkdir(parents=True,exist_ok=True)
assert not any(os.environ.get(k) for k in ['CLAUDECODE','CLAUDE_CODE_ENTRYPOINT','CODEX_SANDBOX'])
release=a.bun_release.resolve();assert release.parent.name!='hrc-runtime-releases'
env=dict(os.environ,HRC_RUNTIME_DIR=str(root/'run'),HRC_STATE_DIR=str(root/'state'),HRC_PEER_CONFIG_FILE=str(root/'absent.json'),HRC_ACP_WEBHOOK_URL='',HRC_EVENT_INGEST_SOCKET=str(root/'run/ingest.sock'),HRC_WRKQ_DB=str(root/'wrkq.db'),WRKQ_DB=str(root/'wrkq.db'))
for k in ['HRC_SESSION_REF','HRC_RUNTIME_ID','HRC_RUN_ID','HRC_HOST_SESSION_ID','HRC_EVENT_FORWARD_URL','HRC_EVENT_INGEST_TCP_PORT','HRC_EVENT_FORWARD_SOURCE_REF','WRKQ_DB_PATH','WRKQ_DB_PATH_FILE','WRKQD_UNIX','WRKQD_TOKEN','WRKQD_TOKEN_FILE','WRKQD_NODE_TOKENS','WRKQD_NODE_TOKENS_FILE','HRC_BUN_PASSTHROUGH_SOCKET']:env.pop(k,None)
env.pop('HRC_SESSION_PROJECTION_DAYS',None)
state=root/'state/state.sqlite';proc=None;log=None
stamp=lambda t:datetime.datetime.fromtimestamp(t,datetime.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z')
now=stamp(time.time());old='2026-01-01T00:00:00.000Z';since=stamp(time.time()-86400)
scope='agent:tabularasa:project:n1-t11818:task:projection-'+str(time.time_ns())
# Cold head with warm predecessor proves selection precedes generation collapse.
fixtures=[('cold','z','main',1,old,'active'),('recent','a','main',1,now,'active'),('index','b','main',1,old,'active'),('runtime','c','main',1,old,'active'),('live','d','main',1,old,'active'),('active-run','e','main',1,old,'active'),('prior','f','main',1,now,'archived'),('head','f','main',2,old,'active'),('alternate','f','alternate',1,old,'active')]
def call(path):
 c=UnixHTTP(root/'run/hrc.sock');c.request('GET',path);r=c.getresponse();body=json.loads(r.read());headers={k.lower():v for k,v in r.getheaders() if k.lower().startswith('x-hrc-session-')};c.close();return {'status':r.status,'body':body,'headers':headers}
def down():
 global proc,log
 if proc and proc.poll() is None:proc.send_signal(signal.SIGTERM);proc.wait(timeout=20)
 if log:log.close()
 proc=None;log=None
def up(kind,label=None):
 global proc,log
 log=(a.artifacts/((label or kind)+'.log')).open('w');argv=[str(a.binary.resolve()),'server'] if kind=='native' else ['bun',str(release/'packages/hrc-cli/src/cli.ts'),'server','serve']
 proc=subprocess.Popen(argv,env=env,cwd=root,stdout=log,stderr=log)
 for _ in range(300):
  assert proc.poll() is None,kind+' exited'
  try:
   if call('/v1/health')['status']==200:return
  except (OSError,HTTPException):pass
  time.sleep(.05)
 raise RuntimeError('not ready')
def seed():
 with sqlite3.connect(state) as db:
  for host,suffix,lane,generation,created,status in fixtures:
   db.execute('INSERT INTO sessions(host_session_id,scope_ref,lane_ref,generation,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',('hsid-n1-'+host,scope+'-'+suffix,lane,generation,status,created,now))
  for host,suffix,lane,generation,created,status in fixtures:
   db.execute('INSERT INTO continuities(scope_ref,lane_ref,active_host_session_id,updated_at,scope_kind,agent_id,project_id,task_id) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(scope_ref,lane_ref) DO UPDATE SET active_host_session_id=excluded.active_host_session_id',(scope+'-'+suffix,lane,'hsid-n1-'+host,now,'project-task','tabularasa','n1-t11818',scope.split(':task:')[1]+'-'+suffix))
  # Explicit fixture clocks distinguish real activity from cosmetic updated_at.
  db.execute('UPDATE session_index SET last_activity_at=? WHERE host_session_id=?',(now,'hsid-n1-index'))
  for host,status,activity,run in [('runtime','terminated',now,None),('live','awaiting_input',old,None),('active-run','terminated',old,'run-n1-placeholder')]:
   suffix=next(x[1] for x in fixtures if x[0]==host)
   db.execute('INSERT INTO runtimes(runtime_id,host_session_id,scope_ref,lane_ref,generation,transport,status,supports_inflight_input,last_activity_at,active_run_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',('runtime-n1-'+host,'hsid-n1-'+host,scope+'-'+suffix,'main',1,'sdk',status,0,activity,run,old,old))
  # Insertion of terminal runtimes may advance projections; set all fixtures
  # back to their declared activity, then advance only the index case.
  for host,_,_,_,created,_ in fixtures:db.execute('UPDATE session_index SET last_activity_at=? WHERE host_session_id=?',(now if host=='index' else created,'hsid-n1-'+host))
def durable():
 with sqlite3.connect('file:'+str(state)+'?mode=ro',uri=True) as db:
  return {t:db.execute('SELECT * FROM '+t+' ORDER BY 1').fetchall() for t in ['sessions','runtimes','session_index']}
q=lambda **kw:'/v1/sessions?'+urlencode(kw)
cases=[('default','/v1/sessions'),('kernel',q(updatedSince=since,latestGeneration='true')),('all',q(all='true')),('yes',q(all=' YES ')),('all-invalid-since',q(all='1',updatedSince='bad')),('scoped-history',q(scopeRef=scope+'-f',updatedSince=since)),('scoped-invalid-since',q(scopeRef=' '+scope+'-f ',updatedSince='bad')),('lane',q(scopeRef=scope+'-f',laneRef=' alternate ')),('latest-scoped',q(scopeRef=scope+'-f',latestGeneration='YES')),('latest-status',q(scopeRef=scope+'-f',latestGeneration='true',status='archived')),('status-trimmed',q(all='true',status=' archived ')),('hex-limit',q(all='true',limit='0x2')),('invalid-since',q(updatedSince=' bad ')),('invalid-status-first',q(status=' nope ',updatedSince='bad')),('invalid-limit-first',q(limit='0',updatedSince='bad')),('date-only',q(updatedSince=now[:10])),('offset',q(updatedSince=since.replace('Z','+00:00')))]
try:
 subprocess.run(['wrkqadm','migrate'],env=env,check=True,capture_output=True)
 up('bun');down()
 with sqlite3.connect(state) as src,sqlite3.connect(root/'empty.sqlite') as dst:src.backup(dst)
 for kind in ['bun','native']:
  with sqlite3.connect(root/'empty.sqlite') as src,sqlite3.connect(state) as dst:src.backup(dst)
  up(kind);seed();before=durable();rows=[]
  for name,path in cases:rows.append({'case':name,'path':path,'response':call(path)})
  unchanged=before==durable();down()
  for name,value in [('config-zero','0'),('config-prefix','1000days'),('config-invalid','-1')]:
   with sqlite3.connect(root/'empty.sqlite') as src,sqlite3.connect(state) as dst:src.backup(dst)
   env['HRC_SESSION_PROJECTION_DAYS']=value;up(kind,kind+'-'+name);seed();before=durable()
   rows.append({'case':name,'path':'/v1/sessions','response':call('/v1/sessions')})
   unchanged=unchanged and before==durable();down()
  env.pop('HRC_SESSION_PROJECTION_DAYS',None)
  directory=a.artifacts/kind;directory.mkdir(exist_ok=True)
  (directory/'projection.json').write_text(json.dumps({'observations':rows,'scope':scope,'unchanged':unchanged,'fixtures':fixtures},indent=2)+'\n')
 compared=subprocess.run(['python3',str(Path(__file__).resolve().parents[3]/'conformance/hrc-parity/run.py'),'compare','--suite','n1-session-projection','--baseline',str(a.artifacts/'bun'),'--candidate',str(a.artifacts/'native'),'--out',str(a.artifacts/'compare')],capture_output=True,text=True)
 (a.artifacts/'compare.stdout').write_text(compared.stdout);(a.artifacts/'compare.stderr').write_text(compared.stderr)
 assert compared.returncode==0,compared.stdout+compared.stderr
 print(json.dumps({'pass':True,'cases':len(rows),'comparison':str(a.artifacts/'compare/summary.json')}))
finally:down()
