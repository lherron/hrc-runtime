#!/usr/bin/env python3
"""Actual participant-owned bootstrap broker, real ASP compile, blank claude profile.
Failures: fake ready on join, wrong/flexible identity, duplicate ensure, lost events,
foreign roots, missing durable graph, ACK before N2, broker killed on owner shutdown.
"""
import argparse,json,os,signal,socket,sqlite3,subprocess,time,uuid
from pathlib import Path
from http.client import HTTPException
from foundation import UnixHTTP
p=argparse.ArgumentParser()
for k in ['binary','bun-release','scratch-root','artifacts','aspd-socket']:p.add_argument('--'+k,type=Path,required=True)
a=p.parse_args();root=a.scratch_root.absolute();assert not root.exists();root.mkdir(parents=True);a.artifacts.mkdir(parents=True,exist_ok=True)
assert not any(os.environ.get(k) for k in ['CLAUDECODE','CLAUDE_CODE_ENTRYPOINT','CODEX_SANDBOX'])
release=a.bun_release.resolve();assert release.parent.name!='hrc-runtime-releases'
base=dict(os.environ,HRC_ASPD_SOCKET=str(a.aspd_socket),HRC_ACP_WEBHOOK_URL='',HRC_WRKQ_DB=str(root/'wrkq.db'),WRKQ_DB=str(root/'wrkq.db'))
for k in ['HRC_SESSION_REF','HRC_RUNTIME_ID','HRC_RUN_ID','HRC_HOST_SESSION_ID','HRC_EVENT_FORWARD_URL','HRC_EVENT_INGEST_TCP_PORT','HRC_EVENT_FORWARD_SOURCE_REF','WRKQ_DB_PATH','WRKQ_DB_PATH_FILE','WRKQD_UNIX','WRKQD_TOKEN','WRKQD_TOKEN_FILE','WRKQD_NODE_TOKENS','WRKQD_NODE_TOKENS_FILE','HRC_BUN_PASSTHROUGH_SOCKET']:base.pop(k,None)
project=root/'n1-t11818';project.mkdir()
base.update(ASP_PROJECT_ROOT_OVERRIDE=str(project),HRC_PROJECT_SEARCH_ROOTS=str(project),HRC_STATE_DIR=str(root/'state'),HRC_RUNTIME_DIR=str(root/'run'))
config=root/'federation.json';config.write_text(json.dumps({'nodeId':socket.gethostname().split('.')[0].lower(),'peers':{}}));config.chmod(0o600);base['HRC_PEER_CONFIG_FILE']=str(config)
subprocess.run(['wrkqadm','migrate'],env=base,capture_output=True,check=True);subprocess.run(['wrkq','mkdir','/n1-t11818','--kind','project','--as','agent:cody'],env=base,capture_output=True,check=True)
class Rpc:
 def __init__(self,path):
  self.s=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);self.s.settimeout(120);self.s.connect(str(path));self.f=self.s.makefile('rwb');self.id=0
 def call(self,method,params):
  self.id+=1;self.f.write((json.dumps({'jsonrpc':'2.0','id':self.id,'method':method,'params':params})+'\n').encode());self.f.flush()
  while True:
   r=json.loads(self.f.readline())
   if r.get('id')==self.id:
    assert 'error' not in r,r;return r['result']
 def close(self):self.f.close();self.s.close()
def http(method,path,body=None):
 c=UnixHTTP(Path(base['HRC_RUNTIME_DIR'])/'hrc.sock');c.timeout=120;c.request(method,path,json.dumps(body) if body is not None else None,{'Content-Type':'application/json'});r=c.getresponse();raw=r.read();c.close();return r.status,json.loads(raw)
def rows():
 with sqlite3.connect('file:'+str(Path(base['HRC_STATE_DIR'])/'state.sqlite')+'?mode=ro',uri=True) as db:
  db.row_factory=sqlite3.Row
  return {t:[dict(r) for r in db.execute('SELECT * FROM '+t)] for t in ['participant_registrations','participant_registration_attempts','participant_host_bindings','sessions','continuities','runtimes','runtime_operations','broker_invocations','hrc_events']}
for kind in ['bun','native']:
 side=root/kind;side.mkdir();base.update(HRC_RUNTIME_DIR=str(side/'run'),HRC_STATE_DIR=str(side/'state'),HRC_EVENT_INGEST_SOCKET=str(side/'run/ingest.sock'))
 Path(base['HRC_RUNTIME_DIR']).joinpath('btmux').mkdir(parents=True);Path(base['HRC_STATE_DIR']).mkdir();subprocess.run(['bun','-e','import {openHrcDatabase} from '+json.dumps(str(release/'packages/hrc-store-sqlite/src/database.ts'))+';openHrcDatabase(process.argv[1]).close()',str(side/'state/state.sqlite')],env=base,capture_output=True,check=True)
 log=(a.artifacts/(kind+'.log')).open('w');brokerlog=(a.artifacts/(kind+'-broker.log')).open('w');broker=None;owner=None;record={}
 try:
  argv=[str(a.binary.resolve()),'server'] if kind=='native' else ['bun',str(release/'packages/hrc-cli/src/cli.ts'),'server','serve']
  owner=subprocess.Popen(argv,cwd=project,env=base,stdout=log,stderr=log)
  for _ in range(300):
   assert owner.poll() is None,kind+' owner exited'
   try:
    if http('GET','/v1/health')[0]==200:break
   except (OSError,HTTPException):pass
   time.sleep(.05)
  scope='agent:tabularasa:project:n1-t11818:task:participant-live-'+str(time.time_ns())
  status,joined=http('POST','/v1/participants/register',{'registrationMode':'direct','requestedSessionRef':scope,'hostIncarnationId':'participant-'+str(uuid.uuid4()),'workspaceCwd':str(project)})
  assert status==200,joined;record['joined']=joined;record['joinRows']=rows();assert len(record['joinRows']['runtimes'])==0
  status,placement=http('POST','/v1/placements/resolve',{'scopeRef':scope,'cwd':str(project),'projectRoot':str(project)})
  assert status==200,placement
  status,declaration=http('POST','/v1/declarations/resolve',{'agentId':'tabularasa','agentRoot':placement['agentRoot'],'projectId':'n1-t11818','projectRoot':str(project),'cwd':str(project),'preferredMode':'headless','interactive':False,'initialPrompt':'Reply with exactly the word OK and nothing else. No tools.'})
  assert status==200,declaration
  identity={k:joined['identity'][k] for k in ['requestId','operationId','runtimeId','invocationId']};identity.update(hostSessionId=joined['hostSessionId'],generation=joined['generation'],traceId='trace-'+str(uuid.uuid4()))
  pl=declaration['intent']['placement'];pl['correlation']={'sessionRef':{'scopeRef':scope,'laneRef':'main'},**identity};pl['dispatchEnv']={'AGENT_SCOPE_REF':scope,'ASP_SCOPE_REF':scope,'HRC_SESSION_REF':scope+'/lane:main','AGENT_HOST_SESSION_ID':joined['hostSessionId'],'HRC_HOST_SESSION_ID':joined['hostSessionId'],'HRC_RUNTIME_DIR':base['HRC_RUNTIME_DIR'],'HRC_STATE_DIR':base['HRC_STATE_DIR'],'HRC_MAIL_STOP_SOCKET':str(side/'run/hrc.sock'),'WRKQ_DB':str(root/'wrkq.db'),'WRKQ_DB_PATH':'','WRKQ_DB_PATH_FILE':''}
  request={'schemaVersion':'agent-runtime-compile-request/v2','agent':{'id':'tabularasa'},'identity':identity,'placement':pl,'requested':{'presentation':False},'materialization':{'initialPrompt':declaration['intent']['initialPrompt']},'hrcPolicy':{},'correlation':{'scopeRef':scope,**identity}}
  rpc=Rpc(a.aspd_socket);record['aspHello']=rpc.call('aspc.hello',{'clientInfo':{'name':'hrc-server'},'protocolVersions':['aspc/0.1']});compiled=rpc.call('aspc.compileHarnessInvocation',{'compileRequest':request});rpc.close();assert compiled['ok'],compiled
  record['compileRequest']=request;record['compiled']=compiled
  generated=subprocess.run(['bun',str(Path(__file__).with_name('participant_live_descriptor.mjs')),str(release)],input=json.dumps({'joined':joined,'compiled':compiled}),env=base,capture_output=True,text=True,check=True);d=json.loads(generated.stdout);record['descriptor']=d
  endpoint=side/'participant.sock';ledger=side/'events.ndjson';worker=compiled['executionRelease']['worker'];assert worker['executable'].startswith('/Users/lherron/praesidium/var/aspd/releases/')
  broker=subprocess.Popen([worker['executable'],*worker['argvPrefix'],'--socket',str(endpoint),'--event-ledger',str(ledger),'--join','participant-served'],env=base,cwd=project,stdout=brokerlog,stderr=brokerlog)
  for _ in range(300):
   assert broker.poll() is None,kind+' broker exited'
   if endpoint.exists():break
   time.sleep(.05)
  body={k:joined['identity'][k] for k in ['registrationId','attemptId','attachEpoch']};body.update(descriptor=d,socketPath=str(endpoint),dispatchEnv=compiled['plan']['execution']['dispatchRequest'].get('dispatchEnv',pl['dispatchEnv']))
  record['attach']=http('POST','/v1/participants/attach',body);assert record['attach'][0]==200,record['attach']
  for _ in range(1200):
   snapshot=rows();attempt=snapshot['participant_registration_attempts'][0]
   if attempt['establishment_work_state'] in ['completed','exhausted']:break
   time.sleep(.1)
  record['durable']=snapshot
  assert attempt['state']=='ACTIVE' and attempt['establishment_work_state']=='completed',attempt
  assert len(snapshot['runtimes'])==len(snapshot['runtime_operations'])==len(snapshot['broker_invocations'])==1,snapshot
  rpc=Rpc(endpoint);record['snapshot']=rpc.call('invocation.snapshot',{'invocationId':identity['invocationId']});rpc.close()
  record['retry']=http('POST','/v1/participants/attach',body);assert record['retry'][0]==200 and record['retry'][1]['prepared']==False,record['retry']
  owner.terminate();owner.wait(timeout=20);record['brokerAliveAfterShutdown']=broker.poll() is None;assert record['brokerAliveAfterShutdown']
 finally:
  if owner and owner.poll() is None:owner.terminate();owner.wait(timeout=20)
  if broker and broker.poll() is None:broker.terminate();broker.wait(timeout=20)
  log.close();brokerlog.close()
  # Kill only the presentation tmux server declared in our own frozen row.
  try:
   state=rows();attempt=state['participant_registration_attempts'][0];realized=json.loads(attempt.get('realized_hosting_json') or '{}');tui=realized.get('presentation',{}).get('tuiWindow')
   if tui:
    assert Path(tui['socketPath']).is_relative_to(side/'run');subprocess.run(['tmux','-S',tui['socketPath'],'kill-server'],capture_output=True)
  finally:(a.artifacts/(kind+'.json')).write_text(json.dumps(record,indent=2)+'\n')
print(json.dumps({'pass':True,'artifacts':str(a.artifacts)}))
