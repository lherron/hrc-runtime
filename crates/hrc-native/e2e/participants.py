#!/usr/bin/env python3
"""Direct join/attach HTTPs against sequential owners of empty scratch state.

Failure modes: duplicate identity or birth; false runnable/runtime claims at join;
missing reservation exclusion; metadata/selector/errors differ; stale epoch or
changed descriptor overwrites frozen bytes; failed endpoint retries lose selected
continuation or allocate a new identity; token/ledger/endpoint outside own roots.
No model runs and no broker stand-in. The declared external endpoint is absent;
this suite proves durable descriptor admission/retry, not live broker activation.
"""
import argparse,copy,hashlib,json,os,signal,socket,sqlite3,stat,subprocess,time
from http.client import HTTPException
from pathlib import Path
from foundation import UnixHTTP

p=argparse.ArgumentParser()
for name in ['binary','bun-release','scratch-root','artifacts']:p.add_argument('--'+name,type=Path,required=True)
p.add_argument('--foundry-client',type=Path)
a=p.parse_args();root=a.scratch_root.absolute();assert not root.exists();root.mkdir(parents=True);a.artifacts.mkdir(parents=True,exist_ok=True)
release=a.bun_release.resolve();assert release.parent.name!='hrc-runtime-releases'
assert not any(os.environ.get(k) for k in ['CLAUDECODE','CLAUDE_CODE_ENTRYPOINT','CODEX_SANDBOX'])
config=root/'federation.json';config.write_text(json.dumps({'nodeId':socket.gethostname().split('.')[0].lower(),'peers':{}}));config.chmod(0o600)
e=dict(os.environ,HRC_RUNTIME_DIR=str(root/'run'),HRC_STATE_DIR=str(root/'state'),HRC_PEER_CONFIG_FILE=str(config),HRC_WRKQ_DB=str(root/'wrkq.db'),WRKQ_DB=str(root/'wrkq.db'),HRC_ACP_WEBHOOK_URL='',HRC_EVENT_INGEST_SOCKET=str(root/'run/ingest.sock'))
for k in ['HRC_SESSION_REF','HRC_RUNTIME_ID','HRC_RUN_ID','HRC_HOST_SESSION_ID','HRC_EVENT_FORWARD_URL','HRC_EVENT_INGEST_TCP_PORT','HRC_EVENT_FORWARD_SOURCE_REF','WRKQ_DB_PATH','WRKQ_DB_PATH_FILE','WRKQD_UNIX','WRKQD_TOKEN','WRKQD_TOKEN_FILE','WRKQD_NODE_TOKENS','WRKQD_NODE_TOKENS_FILE','HRC_BUN_PASSTHROUGH_SOCKET']:e.pop(k,None)
proc=log=None;results={};dbpath=root/'state/state.sqlite'
foundry_scopes=['agent:foundry:project:n1-t11818-'+str(time.time_ns())+'-'+label+':task:primary' for label in (['absent','continue','fresh'] if a.foundry_client else [])]
scope='agent:tabularasa:project:n1-t11818:task:participant-'+str(time.time_ns());host='n1-incarnation-'+str(time.time_ns())

def call(path,body,raw=False):
 c=UnixHTTP(root/'run/hrc.sock');c.request('POST',path,body if raw else json.dumps(body),{'Content-Type':'application/json'});r=c.getresponse();raw=r.read().decode();c.close()
 try:v=json.loads(raw)
 except json.JSONDecodeError:v=raw
 return r.status,v

def up(kind,label):
 global proc,log
 log=(a.artifacts/(label+'.log')).open('w');argv=[str(a.binary.resolve()),'server'] if kind=='native' else ['bun',str(release/'packages/hrc-cli/src/cli.ts'),'server','serve']
 proc=subprocess.Popen(argv,env=e,cwd=root,stdout=log,stderr=log)
 for _ in range(300):
  assert proc.poll() is None,(label,'owner exited')
  try:
   c=UnixHTTP(root/'run/hrc.sock');c.request('GET','/v1/health');r=c.getresponse();r.read();c.close()
   if r.status==200:return
  except (OSError,HTTPException):pass
  time.sleep(.05)
 raise RuntimeError(label+' not ready')

def down():
 global proc,log
 if proc is not None and proc.poll() is None:proc.send_signal(signal.SIGTERM);proc.wait(timeout=20)
 if log:log.close()
 proc=log=None

def snapshot():
 with sqlite3.connect('file:'+str(dbpath)+'?mode=ro',uri=True) as db:
  db.row_factory=sqlite3.Row
  names=['participant_address_reservations','participant_host_bindings','participant_registrations','participant_registration_attempts','sessions','continuities','session_metadata','runtimes','runtime_operations','broker_invocations']
  d={name:[dict(r) for r in db.execute('SELECT * FROM '+name)] for name in names}
  scopes=[scope,scope+'-classful',*foundry_scopes]
  placeholders=','.join('?' for _ in scopes)
  d['events']=[dict(r) for r in db.execute('SELECT * FROM hrc_events WHERE scope_ref IN ('+placeholders+') ORDER BY hrc_seq',scopes)]
 return d

try:
 subprocess.run(['wrkqadm','migrate'],env=e,check=True,capture_output=True)
 subprocess.run(['wrkq','mkdir','/n1-t11818','--kind','project','--as','agent:cody'],env=e,check=True,capture_output=True)
 up('bun','prime');down()
 with sqlite3.connect(dbpath) as src,sqlite3.connect(root/'snapshot.sqlite') as dst:src.backup(dst)
 for kind in ['bun','native']:
  with sqlite3.connect(root/'snapshot.sqlite') as src,sqlite3.connect(dbpath) as dst:src.backup(dst)
  up(kind,kind);rows=[]
  def record(name,path,body,settle=False,raw=False):
   before_rows=snapshot();before=time.time();status,value=call(path,body,raw=raw)
   if settle and status==200:
    for _ in range(200):
     tables=snapshot();attempts=tables['participant_registration_attempts']
     if any(t['attempt_id']==body.get('attemptId') and t['establishment_work_state']=='exhausted' for t in attempts):break
     time.sleep(.05)
    else:raise RuntimeError(kind+' participant retries did not settle')
   rows.append({'case':name,'path':path,'request':body,'status':status,'body':value,'before':before,'after':time.time(),'beforeDurable':before_rows,'durable':snapshot()});return value
  reg='/v1/participants/register';attach='/v1/participants/attach';base={'registrationMode':'direct','requestedSessionRef':scope,'hostIncarnationId':host}
  for name,body in [('join-mode',{}),('join-array',[]),('join-unknown-field',dict(base,unknown=True)),('join-invalid-scope',dict(base,requestedSessionRef='bad')),('join-missing-incarnation',dict(base,hostIncarnationId='')),('join-null-lane',dict(base,laneRef=None)),('join-relative-endpoint',dict(base,socketPath='relative.sock')),('join-invalid-predecessor',dict(base,expectedPredecessor={})),('join-invalid-continuation',dict(base,continuation='bad'))]:record(name,reg,body)
  record('join-bad-json',reg,'{',raw=True)
  record('attach-bad-json',attach,'{',raw=True)
  joined=record('join',reg,base);record('join-retry',reg,base)
  record('join-metadata',reg,dict(base,metadata={'title':'N1 participant','custom.check':True}))
  record('join-metadata-invalid',reg,dict(base,metadata={'title':17}))
  record('join-retry-other-lane-metadata',reg,dict(base,laneRef='alternate',metadata={'title':'same incarnation keeps its allocated lane'}))
  identity=joined.get('identity',{}) if isinstance(joined,dict) else {}
  b={k:identity.get(k,'native-missing-'+k) for k in ['registrationId','attemptId','attachEpoch']};b['attachEpoch']=identity.get('attachEpoch',1)
  record('join-own-predecessor',reg,dict(base,expectedPredecessor={'hostIncarnationId':host,'runtimeId':identity.get('runtimeId','missing'),'generation':joined.get('generation',1) if isinstance(joined,dict) else 1}))
  record('join-incarnation-elsewhere',reg,dict(base,requestedSessionRef=scope+'-elsewhere'))
  record('reserved-target','/v1/targets/ensure',{'sessionRef':scope+'/lane:main','runtimeIntent':{}})
  for name,payload in [('attach-array',[]),('attach-extra',dict(b,descriptor={},unexpected=1)),('attach-zero-epoch',dict(b,descriptor={},attachEpoch=0)),('attach-null-descriptor',dict(b,descriptor=None)),('attach-null-env',dict(b,descriptor={},dispatchEnv=None)),('attach-relative-socket',dict(b,descriptor={},socketPath='bad')),('attach-false-unsupported',dict(b,resumeUnsupported=False)),('attach-mixed-unsupported',dict(b,resumeUnsupported=True,descriptor={},reason='no')),('attach-missing-reason',dict(b,resumeUnsupported=True))]:record(name,attach,payload)
  record('attach-unknown',attach,{'registrationId':'unknown','attemptId':'unknown','attachEpoch':1,'descriptor':{}})
  record('attach-stale-epoch',attach,dict(b,attachEpoch=2,descriptor={}))
  record('attach-invalid-descriptor',attach,dict(b,descriptor={}))
  record('attach-resume-unsupported',attach,dict(b,resumeUnsupported=True,reason='N1 scratch source cannot resume'))
  if identity:
   generated=subprocess.run(['bun',str(Path(__file__).with_name('participant_descriptor.mjs')),str(release),str(root)],input=json.dumps(joined),capture_output=True,text=True,env=e,check=True)
   descriptor=json.loads(generated.stdout)
  else:descriptor={}
  # Inner wire validation must happen before agreement hashes and before writes.
  for field,value in [('process.cwd',7),('process.lockedEnv',{'PATH':'bad'}),('harness.driver','other'),('process.harnessTransport',{'kind':'bad'}),('interaction',{'mode':'bad'}),('driver',{'kind':7}),('sdk',{}),('launch',{'initialPrompt':7}),('agent',{'agentId':''}),('correlation',{'generation':7})]:
   invalid=copy.deepcopy(descriptor);target=invalid['harnessInvocation']['startRequest']['spec'];parts=field.split('.')
   for key in parts[:-1]:target=target[key]
   target[parts[-1]]=value;record('attach-invalid-start-'+field,attach,dict(b,descriptor=invalid))
  wrong=copy.deepcopy(descriptor);wrong['harnessInvocation']['specHash']='not-the-spec-hash';record('attach-wrong-hash',attach,dict(b,descriptor=wrong))
  cont=copy.deepcopy(descriptor);cont['harnessInvocation']['startRequest']['spec']['continuation']=None;record('attach-unselected-continuation',attach,dict(b,descriptor=cont))
  record('attach-no-endpoint',attach,dict(b,descriptor=descriptor))
  body=dict(b,descriptor=descriptor,socketPath=str(root/'participant.sock'))
  record('attach-prepared',attach,body,settle=True)
  record('attach-retry',attach,body)
  record('attach-retry-env-endpoint',attach,dict(body,dispatchEnv={'OTHER':'ignored-on-identical-retry'},socketPath=str(root/'different.sock')))
  changed=copy.deepcopy(descriptor);changed['descriptorId']='different-descriptor'
  # Rehash with the published helper; valid different bytes must conflict.
  rewritten=subprocess.run(['bun',str(Path(__file__).with_name('participant_descriptor.mjs')),str(release),str(root),'rehash'],input=json.dumps(changed),capture_output=True,text=True,env=e,check=True)
  record('attach-changed-descriptor',attach,dict(body,descriptor=json.loads(rewritten.stdout)))
  record('join-after-attach',reg,base)
  record('join-classful',reg,dict(base,requestedSessionRef=scope+'-classful',hostIncarnationId=host+'-classful',classId='n1-scratch-class',participantKey='n1-scratch-key',workspaceCwd=str(root)))
  if a.foundry_client:
   (a.artifacts/'foundry-source.json').write_text(json.dumps({'path':str(a.foundry_client.resolve()),'sha256':hashlib.sha256(a.foundry_client.read_bytes()).hexdigest(),'registerFunction':'registerFleetSeat','descriptorFunction':'fleetDescriptor','attachFunction':'attachFleetSeat','boundary':'fresh private scopes and absent own endpoints; no Foundry host, broker or harness is launched'},indent=2)+'\n')
  for label,declared_scope in zip(['absent','continue','fresh'],foundry_scopes):
   # Exact registerFleetSeat keys; fresh scope/project and endpoint are ours.
   project=declared_scope.split(':project:')[1].split(':task:')[0]
   workspace=root/project;workspace.mkdir(exist_ok=True)
   socket_path=str(workspace/'participant.sock')
   body={'registrationMode':'direct','requestedSessionRef':declared_scope,'hostIncarnationId':host+'-foundry-'+label,'laneRef':'main','workspaceCwd':str(workspace),'socketPath':socket_path}
   if label!='absent':body['continuation']=label
   joined=record('foundry-register-'+label,reg,body)
   assert joined['status']=='registered' and joined['continuation']=={'carried':False,'reason':'no_continuation','selected':None,'resumeState':'not_requested'},joined
   request={'joined':joined,'options':{'project':project,'root':str(workspace),'agentRoot':'/Users/lherron/praesidium/var/agents/foundry','aspHome':'/Users/lherron/praesidium/var/spaces-repo','provider':'anthropic','modelId':'opus','authMode':'oauth','thinkingLevel':'high'}}
   generated=subprocess.run(['bun',str(Path(__file__).with_name('participant_foundry_descriptor.mjs')),str(a.foundry_client.resolve())],input=json.dumps(request),capture_output=True,text=True,env=e,check=True)
   descriptor=json.loads(generated.stdout)
   assert descriptor['harnessInvocation']['startRequest']['spec']['driver']['kind']=='foundry-resident'
   assert ('continuation' in descriptor['harnessInvocation']['startRequest']['spec']) is False
   attach_body={k:joined['identity'][k] for k in ['registrationId','attemptId','attachEpoch']};attach_body.update(socketPath=socket_path,descriptor=descriptor)
   assert set(attach_body)=={'registrationId','attemptId','attachEpoch','socketPath','descriptor'}
   answer=record('foundry-attach-'+label,attach,attach_body,settle=True)
   assert answer['status']=='attached' and answer['prepared'] is True,answer
  tokens=[]
  for token in (root/'run/bipc').glob('*/attach.token'):
   tokens.append({'path':str(token),'mode':stat.S_IMODE(token.stat().st_mode),'parentMode':stat.S_IMODE(token.parent.stat().st_mode),'value':token.read_text()})
  down();results[kind]=rows
  (a.artifacts/(kind+'-tokens.json')).write_text(json.dumps(tokens,indent=2)+'\n')
  directory=a.artifacts/kind;directory.mkdir(exist_ok=True);(directory/'observations.json').write_text(json.dumps(rows,indent=2)+'\n')
 (a.artifacts/'observations.json').write_text(json.dumps(results,indent=2)+'\n')
finally:down()
