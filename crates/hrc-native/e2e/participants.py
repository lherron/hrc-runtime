#!/usr/bin/env python3
"""Direct join/attach HTTPs against one native owner of empty scratch state.

Failure modes: duplicate identity or birth; false runnable/runtime claims at join;
missing reservation exclusion; wrong status or refusal reason per door; a refusal
that writes; stale epoch or changed descriptor overwrites frozen bytes; failed
endpoint retries lose the frozen attempt or allocate a new identity; token,
ledger or endpoint outside own roots.
No model runs and no broker stand-in. The declared external endpoint is absent;
this suite proves durable descriptor admission/retry, not live broker activation
(participant_live.py does that). Descriptors come from participant_descriptor.scratch,
hashed by descriptor.rs's own projection.

Every case's (HTTP status, reply status, reason or error code) is a literal in
EXPECT below, read off participants/mod.rs (parse_registration, parse_attach,
attach, attachment_reply: rejected -> 409, pending -> 200) and descriptor.rs.
"""
import argparse,copy,datetime,hashlib,json,os,re,signal,socket,sqlite3,stat,subprocess,time
from http.client import HTTPException
from pathlib import Path
from foundation import daemon_env, UnixHTTP
import participant_descriptor

p=argparse.ArgumentParser()
for name in ['binary','scratch-root','artifacts']:p.add_argument('--'+name,type=Path,required=True)
p.add_argument('--installed-release',type=Path,help='accepted and ignored')
p.add_argument('--aspd-socket',type=Path,help='accepted and ignored')
a=p.parse_args();root=a.scratch_root.absolute();assert not root.exists();root.mkdir(parents=True);a.artifacts.mkdir(parents=True,exist_ok=True)
assert not any(os.environ.get(k) for k in ['CLAUDECODE','CLAUDE_CODE_ENTRYPOINT','CODEX_SANDBOX'])
config=root/'federation.json';config.write_text(json.dumps({'nodeId':socket.gethostname().split('.')[0].lower(),'peers':{}}));config.chmod(0o600)
e=dict(os.environ,HRC_RUNTIME_DIR=str(root/'run'),HRC_STATE_DIR=str(root/'state'),HRC_PEER_CONFIG_FILE=str(config),HRC_WRKQ_DB=str(root/'wrkq.db'),WRKQ_DB=str(root/'wrkq.db'),HRC_ACP_WEBHOOK_URL='',HRC_EVENT_INGEST_SOCKET=str(root/'run/ingest.sock'))
for k in ['HRC_SESSION_REF','HRC_RUNTIME_ID','HRC_RUN_ID','HRC_HOST_SESSION_ID','HRC_EVENT_FORWARD_URL','HRC_EVENT_INGEST_TCP_PORT','HRC_EVENT_FORWARD_SOURCE_REF','WRKQ_DB_PATH','WRKQ_DB_PATH_FILE','WRKQD_UNIX','WRKQD_TOKEN','WRKQD_TOKEN_FILE','WRKQD_NODE_TOKENS','WRKQD_NODE_TOKENS_FILE']:e.pop(k,None)
proc=log=None;dbpath=root/'state/state.sqlite'
scope='agent:tabularasa:project:n1-t11818:task:participant-'+str(time.time_ns());host='n1-incarnation-'+str(time.time_ns())

M=('malformed_request',)  # ApiError::bad -> 400 malformed_request
# case -> (http status, reply status or None, reason/error code)
EXPECT={
 'join-mode':(400,None,M[0]),'join-array':(400,None,M[0]),'join-unknown-field':(400,None,M[0]),
 'join-invalid-scope':(400,None,M[0]),'join-missing-incarnation':(400,None,M[0]),'join-null-lane':(400,None,M[0]),
 'join-relative-endpoint':(400,None,M[0]),'join-invalid-predecessor':(400,None,M[0]),'join-invalid-continuation':(400,None,M[0]),
 'join-bad-json':(400,None,M[0]),'attach-bad-json':(400,None,M[0]),
 'join':(200,'registered',None),'join-retry':(200,'registered',None),'join-metadata':(200,'registered',None),
 'join-metadata-invalid':(200,'registered',None),'join-retry-other-lane-metadata':(200,'registered',None),
 'join-own-predecessor':(200,'registered',None),
 'join-incarnation-elsewhere':(409,'rejected','participant_host_incarnation_bound_elsewhere'),
 'reserved-target':(409,None,'stale_context'),
 'attach-array':(400,None,M[0]),'attach-extra':(400,None,M[0]),'attach-zero-epoch':(400,None,M[0]),
 'attach-null-descriptor':(400,None,M[0]),'attach-null-env':(400,None,M[0]),'attach-relative-socket':(400,None,M[0]),
 'attach-false-unsupported':(400,None,M[0]),'attach-mixed-unsupported':(400,None,M[0]),'attach-missing-reason':(400,None,M[0]),
 'attach-unknown':(409,'rejected','participant_registration_unknown'),
 'attach-stale-epoch':(409,'rejected','participant_attach_epoch_stale'),
 'attach-invalid-descriptor':(409,'rejected','participant_descriptor_invalid'),
 'attach-resume-unsupported':(200,'pending','participant_resume_unsupported'),
 **{'attach-invalid-start-'+f:(409,'rejected','participant_descriptor_invalid') for f in ['process.cwd','process.lockedEnv','harness.driver','process.harnessTransport','interaction','driver','sdk','launch','agent','correlation']},
 'attach-wrong-hash':(409,'rejected','participant_descriptor_invalid'),
 'attach-unselected-continuation':(409,'rejected','participant_continuation_mismatch'),
 'attach-no-endpoint':(409,'rejected','participant_serving_endpoint_missing'),
 'attach-prepared':(200,'attached',None),'attach-retry':(200,'attached',None),'attach-retry-env-endpoint':(200,'attached',None),
 'attach-changed-descriptor':(409,'rejected','participant_attach_conflict'),
 'join-after-attach':(200,'registered',None),
 'join-classful':(200,'registered',None),
}
UUID=re.compile(r'^(.*-)?[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
CLOCK=re.compile(r'^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$')
IDENTITIES={'participant_address_reservations':('reservation_id',),'participant_host_bindings':('binding_id',),'participant_registrations':('registration_id','host_session_id'),'participant_registration_attempts':('attempt_id','request_id','operation_id','invocation_id','runtime_id')}
checks=[]
def check(name,passed,reason):checks.append({'id':name,'pass':bool(passed),'reason':reason})

def call(path,body,raw=False):
 c=UnixHTTP(root/'run/hrc.sock');c.request('POST',path,body if raw else json.dumps(body),{'Content-Type':'application/json'});r=c.getresponse();raw=r.read().decode();c.close()
 try:v=json.loads(raw)
 except json.JSONDecodeError:v=raw
 return r.status,v

def up(label):
 global proc,log
 log=(a.artifacts/(label+'.log')).open('w')
 dbpath.parent.mkdir(parents=True,exist_ok=True)
 subprocess.run([str(a.binary.resolve()),'store','migrate',str(dbpath)],env=e,check=True,capture_output=True)
 proc=subprocess.Popen([str(a.binary.resolve()),'server'],env=daemon_env(e),cwd=root,stdout=log,stderr=log)
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
  d['events']=[dict(r) for r in db.execute('SELECT * FROM hrc_events WHERE scope_ref IN (?,?) ORDER BY hrc_seq',[scope,scope+'-classful'])]
 return d

def code(value):
 if not isinstance(value,dict):return None
 if isinstance(value.get('error'),dict):return value['error'].get('code')
 return value.get('reason') or value.get('code')

rows=[]
def record(name,path,body,settle=False,raw=False):
 before_rows=snapshot();before=time.time();status,value=call(path,body,raw=raw)
 if settle and status==200:
  for _ in range(200):
   if any(t['attempt_id']==body.get('attemptId') and t['establishment_work_state']=='exhausted' for t in snapshot()['participant_registration_attempts']):break
   time.sleep(.05)
  else:raise RuntimeError('participant retries did not settle')
 rows.append({'case':name,'path':path,'request':body,'status':status,'body':value,'before':before,'after':time.time(),'beforeDurable':before_rows,'durable':snapshot()});return value

try:
 subprocess.run(['wrkqadm','migrate'],env=e,check=True,capture_output=True)
 subprocess.run([str(Path.home()/'.local/bin/wrkq'),'mkdir','/n1-t11818','--kind','project','--as','agent:cody'],env=e,check=True,capture_output=True)
 up('native')
 reg='/v1/participants/register';attach='/v1/participants/attach';base={'registrationMode':'direct','requestedSessionRef':scope,'hostIncarnationId':host}
 for name,body in [('join-mode',{}),('join-array',[]),('join-unknown-field',dict(base,unknown=True)),('join-invalid-scope',dict(base,requestedSessionRef='bad')),('join-missing-incarnation',dict(base,hostIncarnationId='')),('join-null-lane',dict(base,laneRef=None)),('join-relative-endpoint',dict(base,socketPath='relative.sock')),('join-invalid-predecessor',dict(base,expectedPredecessor={})),('join-invalid-continuation',dict(base,continuation='bad'))]:record(name,reg,body)
 record('join-bad-json',reg,'{',raw=True)
 record('attach-bad-json',attach,'{',raw=True)
 joined=record('join',reg,base);record('join-retry',reg,base)
 record('join-metadata',reg,dict(base,metadata={'title':'N1 participant','custom.check':True}))
 record('join-metadata-invalid',reg,dict(base,metadata={'title':17}))
 record('join-retry-other-lane-metadata',reg,dict(base,laneRef='alternate',metadata={'title':'same incarnation keeps its allocated lane'}))
 identity=joined['identity']
 b={k:identity[k] for k in ['registrationId','attemptId','attachEpoch']}
 record('join-own-predecessor',reg,dict(base,expectedPredecessor={'hostIncarnationId':host,'runtimeId':identity['runtimeId'],'generation':joined['generation']}))
 record('join-incarnation-elsewhere',reg,dict(base,requestedSessionRef=scope+'-elsewhere'))
 record('reserved-target','/v1/targets/ensure',{'sessionRef':scope+'/lane:main','runtimeIntent':{}})
 for name,payload in [('attach-array',[]),('attach-extra',dict(b,descriptor={},unexpected=1)),('attach-zero-epoch',dict(b,descriptor={},attachEpoch=0)),('attach-null-descriptor',dict(b,descriptor=None)),('attach-null-env',dict(b,descriptor={},dispatchEnv=None)),('attach-relative-socket',dict(b,descriptor={},socketPath='bad')),('attach-false-unsupported',dict(b,resumeUnsupported=False)),('attach-mixed-unsupported',dict(b,resumeUnsupported=True,descriptor={},reason='no')),('attach-missing-reason',dict(b,resumeUnsupported=True))]:record(name,attach,payload)
 record('attach-unknown',attach,{'registrationId':'unknown','attemptId':'unknown','attachEpoch':1,'descriptor':{}})
 record('attach-stale-epoch',attach,dict(b,attachEpoch=2,descriptor={}))
 record('attach-invalid-descriptor',attach,dict(b,descriptor={}))
 record('attach-resume-unsupported',attach,dict(b,resumeUnsupported=True,reason='N1 scratch source cannot resume'))
 descriptor=participant_descriptor.scratch(joined,root)
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
 # Valid different bytes (rehashed) must conflict with the frozen descriptor.
 record('attach-changed-descriptor',attach,dict(body,descriptor=participant_descriptor.rehash(changed)))
 record('join-after-attach',reg,base)
 record('join-classful',reg,dict(base,requestedSessionRef=scope+'-classful',hostIncarnationId=host+'-classful',classId='n1-scratch-class',participantKey='n1-scratch-key',workspaceCwd=str(root)))
 tokens=[{'path':str(t),'mode':stat.S_IMODE(t.stat().st_mode),'parentMode':stat.S_IMODE(t.parent.stat().st_mode),'value':t.read_text()} for t in (root/'run/bipc').glob('*/attach.token')]
 down()
finally:down()
(a.artifacts/'observations.json').write_text(json.dumps(rows,indent=2)+'\n')
(a.artifacts/'tokens.json').write_text(json.dumps(tokens,indent=2)+'\n')

# ---- verdicts: every case's literal, then the durable invariants per request ----
by={r['case']:r for r in rows}
check('cases',set(by)==set(EXPECT) and len(by)==len(rows),'the driver runs exactly the EXPECT case mix once each')
for name,(http,status,reason) in EXPECT.items():
 r=by.get(name,{});v=r.get('body')
 got=(r.get('status'),v.get('status') if isinstance(v,dict) and not isinstance(v.get('error'),dict) else None,code(v))
 ok=got[0]==http and (status is None or got[1]==status) and (reason is None or got[2]==reason)
 check('literal:'+name,ok,f'expected {(http,status,reason)}, got {got}')
check('join:not-runnable',joined['observation']['state']=='attachment_pending' and joined['continuation']=={'carried':False,'reason':'no_continuation','selected':None,'resumeState':'not_requested'},'a join allocates identity only and selects no continuation unasked')
check('join-retry:same-identity',by['join-retry']['body']['identity']==identity,'an identical join retry returns the same allocation')
check('join-retry-other-lane:keeps-lane',by['join-retry-other-lane-metadata']['body']['identity']['laneRef']=='main','the same incarnation keeps its allocated lane')
check('join-metadata-invalid:rejected-field',bool(by['join-metadata-invalid']['body'].get('rejectedMetadata')),'an invalid metadata value is reported rejected, the join itself succeeds')
check('attach-prepared:prepared',by['attach-prepared']['body'].get('prepared') is True and by['attach-retry']['body'].get('prepared') is False and by['attach-retry-env-endpoint']['body'].get('prepared') is False,'first attach freezes; identical retries do not re-prepare')
check('join-classful:own-identity',by['join-classful']['body']['identity']['registrationId']!=identity['registrationId'],'a second incarnation on its own scope gets its own registration')

final=rows[-1]['durable'];seen=set()
for table,columns in IDENTITIES.items():
 for i,row in enumerate(final[table]):
  for column in columns:
   value=row[column]
   check(f'uuid:{table}:{i}:{column}',isinstance(value,str) and bool(UUID.fullmatch(value)),'identities use a (prefixed) UUIDv4')
   check(f'unique-id:{table}:{i}:{column}',value not in seen,'new allocations must not alias');seen.add(value)
check('cardinality',len(final['participant_registrations'])==2 and len(final['participant_registration_attempts'])==2 and len(final['sessions'])==2,'two incarnations -> two registrations, two attempts, two sessions; no retry allocated another')
for attempt in final['participant_registration_attempts']:
 if not attempt['hosting_intent_json']:continue
 stored=json.loads(attempt['prepared_profile_json'])
 check('frozen-from-request:'+attempt['attempt_id'],stored==by['attach-prepared']['request']['descriptor'],'stored descriptor equals the successful attachment request byte-for-byte')
 token=json.loads(attempt['hosting_intent_json'])['endpoint']['attachTokenRef']['path']
 leaf=hashlib.sha256((stored['brokerDriver']+':'+attempt['runtime_id']).encode()).hexdigest()[:12]
 check('credential-derived',token==str(root/'run/bipc'/leaf/'attach.token'),'token path derives from driver/runtime identity under this owner\'s own run dir')
 owned=next((t for t in tokens if t['path']==token),None)
 check('credential-file',owned is not None and owned['mode']==0o600 and owned['parentMode']==0o700 and bool(re.fullmatch(UUID.pattern.replace('^(.*-)?','^'),owned['value'])),'credential is a UUIDv4 in an owner-only file and directory')
prepared=by['attach-prepared']['durable']['participant_registration_attempts'][0]
check('retry-exhaustion',prepared['state']=='DISPATCH_FROZEN' and prepared['establishment_work_state']=='exhausted' and prepared['establishment_attempt_count']==5 and prepared['establishment_next_attempt_at'] is None and prepared['establishment_last_error']=='Failed to connect to broker unix socket' and prepared['broker_identity_json'] is None,'five failed connections exhaust only work, preserving the frozen dispatch and nonterminal identity')
for name in ('attach-retry','attach-retry-env-endpoint','attach-changed-descriptor','join-after-attach'):
 check(name+':frozen',by[name]['durable']['participant_registration_attempts'][0]==prepared,'descriptor, endpoint, adapter env and exhausted work stay byte-for-byte frozen')
for r in rows:
 name=r['case'];before,after=r['beforeDurable'],r['durable']
 for table,records in after.items():
  for rec in records:
   for column,value in rec.items():
    if isinstance(value,str) and CLOCK.fullmatch(value) and value not in seen:
     epoch=datetime.datetime.fromisoformat(value.replace('Z','+00:00')).timestamp()
     check(f'{name}:clock:{table}:{column}',r['before']-.01<=epoch<=r['after']+.01,'a new clock lies within the request that first wrote it');seen.add(value)
 if r['status']>=400:check(name+':no-write',before==after,'a refusal preserves every captured row byte-for-byte')
 if name in ('join-retry','join-own-predecessor','attach-no-endpoint','attach-retry','attach-retry-env-endpoint'):check(name+':converges',before==after,'retry or missing endpoint cannot rewrite a frozen allocation')
 if name=='join':
  clocks=[x['created_at'] for t in ('sessions','participant_registrations','participant_registration_attempts') for x in after[t]]
  check('birth-clock',len(set(clocks))==1 and after['events'][0]['ts']==clocks[0],'session, registration, attempt and birth event share one transaction clock')
 check(name+':no-runtime',all(not after[t] for t in ('runtimes','runtime_operations','broker_invocations')),'identity admission or a failed external endpoint never fabricates a runtime')
 check(name+':event-kinds',all(ev['event_kind'] in ('session.created','session.metadata.changed','session.metadata.rejected') for ev in after['events']),'only session birth and metadata events precede establishment')
failed=[c for c in checks if not c['pass']]
(a.artifacts/'checks.json').write_text(json.dumps(checks,indent=2)+'\n')
print(json.dumps({'suite':'participants','checks':len(checks),'failed':failed[:20]},indent=1))
raise SystemExit(1 if failed else 0)
