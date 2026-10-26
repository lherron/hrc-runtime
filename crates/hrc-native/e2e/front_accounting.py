#!/usr/bin/env python3
"""Separate-state front accounting probe; real Bun behind a byte-forwarding tap.

Failure modes: shared metrics writer/retention, wrong servedBy, synthetic reqId
changing sampling, lost full User-Agent, missing/double request records, or
L3 records entering the other daemon's output. No modeled endpoint responses.
"""
import argparse,datetime,json,os,select,signal,socket,sqlite3,subprocess,threading,time
from http.client import HTTPException
from pathlib import Path
from foundation import UnixHTTP

p=argparse.ArgumentParser()
for name in ['binary','bun-release','scratch-root','artifacts']:p.add_argument('--'+name,type=Path,required=True)
a=p.parse_args();root=a.scratch_root.absolute();assert not root.exists();root.mkdir(parents=True);a.artifacts.mkdir(parents=True,exist_ok=True)
assert not any(os.environ.get(k) for k in ['CLAUDECODE','CLAUDE_CODE_ENTRYPOINT','CODEX_SANDBOX'])
release=a.bun_release.resolve();assert release.parent.name!='hrc-runtime-releases'
base=dict(os.environ,HRC_PEER_CONFIG_FILE=str(root/'absent.json'),HRC_ACP_WEBHOOK_URL='',WRKQ_DB=str(root/'wrkq.db'),HRC_WRKQ_DB=str(root/'wrkq.db'))
for k in ['HRC_SESSION_REF','HRC_RUNTIME_ID','HRC_RUN_ID','HRC_HOST_SESSION_ID','HRC_EVENT_FORWARD_URL','HRC_EVENT_INGEST_TCP_PORT','HRC_EVENT_FORWARD_SOURCE_REF','WRKQ_DB_PATH','WRKQ_DB_PATH_FILE','WRKQD_UNIX','WRKQD_TOKEN','WRKQD_TOKEN_FILE','WRKQD_NODE_TOKENS','WRKQD_NODE_TOKENS_FILE','HRC_BUN_PASSTHROUGH_SOCKET','HRC_METRICS']:base.pop(k,None)
owners=[];logs=[];requests=[];error_controls=[];traces=[];threads=[];stop=threading.Event();listener=None

def call(endpoint,path,ua='front-ready',request_id=None):
 c=UnixHTTP(endpoint);headers={'User-Agent':ua}
 if request_id is not None:headers['x-hrc-request-id']=request_id
 before=time.time();c.request('GET',path,None,headers);r=c.getresponse();body=r.read().decode();status=r.status;c.close()
 return {'method':'GET','path':path,'ua':ua,'reqId':request_id,'status':status,'body':body,'before':before,'after':time.time()}

def up(kind,proxy=None):
 state=root/kind/'state';runtime=root/kind/'run';env=dict(base,HRC_STATE_DIR=str(state),HRC_RUNTIME_DIR=str(runtime),HRC_EVENT_INGEST_SOCKET=str(runtime/'ingest.sock'))
 log=(a.artifacts/(kind+'.log')).open('w');logs.append(log)
 argv=[str(a.binary.resolve()),'server'] if kind=='native' else ['bun',str(release/'packages/hrc-cli/src/cli.ts'),'server','serve']
 if proxy:argv.extend(['--bun-socket',str(proxy)])
 owner=subprocess.Popen(argv,env=env,cwd=root,stdout=log,stderr=log);owners.append(owner);endpoint=runtime/'hrc.sock'
 for _ in range(300):
  assert owner.poll() is None,kind+' exited'
  try:
   if call(endpoint,'/v1/health')['status']==200:return endpoint
  except (OSError,HTTPException):pass
  time.sleep(.05)
 raise RuntimeError(kind+' not ready')

def pipe(front,backend):
 with front,socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as back:
  back.connect(str(backend));front.settimeout(10);head=b''
  while b'\r\n\r\n' not in head:
   data=front.recv(8192)
   if not data:return
   head+=data
   if len(head)>1024*1024:raise RuntimeError('request head exceeded bound')
  text=head.split(b'\r\n\r\n',1)[0].decode('latin1');lines=text.split('\r\n');headers={}
  for line in lines[1:]:
   key,value=line.split(':',1);headers[key.lower()]=value.lstrip(' \t')
  traces.append({'requestLine':lines[0],'headers':headers})
  back.sendall(head);front.settimeout(None)
  while not stop.is_set():
   ready,_,_=select.select([front,back],[],[],.2)
   for source in ready:
    data=source.recv(65536)
    if not data:return
    (back if source is front else front).sendall(data)

def accept(backend):
 while not stop.is_set():
  try:front,_=listener.accept()
  except socket.timeout:continue
  except OSError:return
  thread=threading.Thread(target=pipe,args=(front,backend),daemon=True);threads.append(thread);thread.start()

try:
 subprocess.run(['wrkqadm','migrate'],env=base,capture_output=True,check=True)
 backend=up('bun')
 state=root/'native/state';state.mkdir(parents=True)
 module=release/'packages/hrc-store-sqlite/src/database.ts'
 subprocess.run(['bun','-e','import {openHrcDatabase} from '+json.dumps(str(module))+';openHrcDatabase(process.argv[1]).close()',str(state/'state.sqlite')],env=dict(base,HRC_STATE_DIR=str(state)),capture_output=True,check=True)
 tap=root/'tap.sock';listener=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);listener.bind(str(tap));listener.listen();listener.settimeout(.2)
 acceptor=threading.Thread(target=accept,args=(backend,),daemon=True);acceptor.start()
 front=up('native',tap)
 # Stay below the ten-record per-route/client/minute head. Reserve enough
 # time so route+minute reconciliation cannot straddle the UTC boundary.
 if time.time()%60>50:time.sleep(60-time.time()%60+.1)
 for pair in ['id','no-id']:
  ua='n1-front/'+pair+' untouched  second-product/7'
  for role,path in [('native','/v1/health'),('forwarded','/v1/targets')]:
   request_id='n1-front-'+role if pair=='id' else None
   row=call(front,path,ua,request_id);row.update(pair=pair,role=role);requests.append(row)
   assert row['status']==200,row
 # An upstream HTTP error is still Bun-served; a failed connection is a
 # native response. Closing only our own tap makes the latter deterministic.
 row=call(front,'/n1-accounting-unknown','n1-front-error/backend');row['role']='backend';error_controls.append(row)
 assert row['status']==404,row
 listener.close();tap.unlink()
 row=call(front,'/v1/targets','n1-front-error/local');row['role']='local';error_controls.append(row)
 assert row['status']==502,row
finally:
 for owner in reversed(owners):
  if owner.poll() is None:owner.send_signal(signal.SIGTERM);owner.wait(timeout=20)
 stop.set()
 if listener:listener.close()
 for thread in threads:thread.join(timeout=2)
 for log in logs:log.close()

for kind in ['bun','native']:
 state=root/kind/'state';directory=a.artifacts/kind;directory.mkdir(exist_ok=True)
 records=[];error_records=[];files=[]
 for file in sorted((state/'metrics').glob('*.ndjson')):
  files.append(file.name)
  for line in file.read_text().splitlines():
   r=json.loads(line)
   if r.get('kind')=='server' and r.get('client','').startswith('n1-front/'):
    records.append({'file':file.name,'record':r})
   elif r.get('kind')=='server' and r.get('client','').startswith('n1-front-error/'):
    error_records.append({'file':file.name,'record':r})
 lines=[];error_lines=[]
 for line in (a.artifacts/(kind+'.log')).read_text().splitlines():
  try:r=json.loads(line)
  except json.JSONDecodeError:continue
  if r.get('event')=='http.request' and r.get('data',{}).get('client','').startswith('n1-front/'):lines.append(r)
  elif r.get('event')=='http.request' and r.get('data',{}).get('client','').startswith('n1-front-error/'):error_lines.append(r)
 with sqlite3.connect('file:'+str(state/'state.sqlite')+'?mode=ro',uri=True) as db:runtime_count=db.execute('SELECT count(*) FROM runtimes').fetchone()[0]
 report={'side':kind,'stateRoot':str(state),'files':files,'metrics':records,'logs':lines,'requests':requests,'upstreamHeaders':traces,'runtimeCount':runtime_count,'errorControls':error_controls,'errorMetrics':error_records,'errorLogs':error_lines}
 (directory/'front-accounting.json').write_text(json.dumps(report,indent=2)+'\n')
(a.artifacts/'upstream-headers.json').write_text(json.dumps(traces,indent=2)+'\n')
print(json.dumps({'captured':True,'requests':len(requests),'forwarded':len(traces),'artifacts':str(a.artifacts)}))
