#!/usr/bin/env python3
"""Exact landed server SQL predicates against typed native CAS under real SQLite."""
import argparse,json,pathlib,sqlite3,subprocess,tempfile,os
p=argparse.ArgumentParser();p.add_argument('--binary',required=True);p.add_argument('--release',required=True);p.add_argument('--artifacts',required=True);a=p.parse_args();out=pathlib.Path(a.artifacts);out.mkdir(parents=True,exist_ok=True)
variants={
'aging':['exact','pidWrong','childWrong','invocationMissing','invocationSkip','statusChanged','runChanged','opChanged','invChanged','activityChanged','stateChanged','hasAccepted','hasTerminal'],
'orphan':['free','noRuntime','ownsSame','ownsOtherOpen','ownsOtherTerminal','ownsOtherMissing','runTerminal','runCompleted'],
'finalize':['exact','wrongRuntime','ownerChanged','terminal','completed','unsupportedTransport'],
'reap':['exact','wrongRuntime','ownerChanged','terminal','completed','unsupportedTransport'],
'zombie':['exact','wrongTransport','terminal','completed'],
'release':['exact','changed']}
cases=[{'id':family+'-'+variant,'family':family,'variant':variant}for family,items in variants.items()for variant in items]
def fixture(path):
 with sqlite3.connect(path)as db:
  db.row_factory=sqlite3.Row;base_runtime=dict(db.execute("SELECT * FROM runtimes WHERE runtime_id='p1-runtime'").fetchone());base_run=dict(db.execute("SELECT * FROM runs WHERE run_id='p1-run'").fetchone())
  def insert(table,row):db.execute('INSERT INTO '+table+'('+','.join(row)+') VALUES('+','.join('?'for _ in row)+')',list(row.values()))
  db.execute("INSERT INTO broker_invocations(invocation_id,operation_id,runtime_id,broker_protocol,broker_driver,broker_pid,child_pid,invocation_state,capabilities_json,spec_hash,start_request_hash,selected_profile_hash,created_at,updated_at) VALUES('p1-process','dummy','p1-runtime','fixture','fixture',100,200,'ready','{}','x','x','x',?,?)",('2026-10-23T00:00:00.000Z',)*2)
  for c in cases:
   family,variant,id=c['family'],c['variant'],c['id'];rid=id+'-runtime';runid=id+'-run'
   runtime={**base_runtime,'runtime_id':rid,'status':'ready','active_run_id':None,'active_operation_id':None,'active_invocation_id':None,'last_activity_at':'2026-10-23T00:00:00.000Z','runtime_state_json':'{"v":1}'}
   run={**base_run,'run_id':runid,'runtime_id':rid,'status':'running','completed_at':None,'transport':'headless'}
   if family=='aging':
    changes={'statusChanged':('status','busy'),'runChanged':('active_run_id','different'),'opChanged':('active_operation_id','different'),'invChanged':('active_invocation_id','different'),'activityChanged':('last_activity_at',None),'stateChanged':('runtime_state_json','{ "v":1 }')}
    if variant in changes:k,v=changes[variant];runtime[k]=v
    if variant in ('hasAccepted','hasTerminal'):
     run['status']='accepted'if variant=='hasAccepted'else'coalesced';insert('runs',run)
   elif family=='orphan':
    if variant.startswith('owns'):
     runtime['active_run_id']=runid if variant=='ownsSame'else id+'-other'
     if variant in ('ownsOtherOpen','ownsOtherTerminal'):
      insert('runs',{**run,'run_id':id+'-other','status':'completed'if variant=='ownsOtherTerminal'else'accepted','completed_at':'2026-10-23T00:00:00.000Z'if variant=='ownsOtherTerminal'else None})
    if variant=='runTerminal':run['status']='failed'
    if variant=='runCompleted':run['completed_at']='2026-10-23T00:00:00.000Z'
    insert('runs',run)
   elif family in ('finalize','reap','release'):
    runtime['active_run_id']=runid if variant not in ('ownerChanged','changed')else'different'
    if variant=='wrongRuntime':run['runtime_id']='p1-runtime'
    if variant=='terminal':run['status']='completed'
    if variant=='completed':run['completed_at']='2026-10-23T00:00:00.000Z'
    if variant=='unsupportedTransport':run['transport']='external'
    insert('runs',run)
   else:
    if variant=='wrongTransport':run['transport']='tmux'
    if variant=='terminal':run['status']='completed'
    if variant=='completed':run['completed_at']='2026-10-23T00:00:00.000Z'
    insert('runs',run)
   if variant!='noRuntime':insert('runtimes',runtime)
  insert('runs',{**base_run,'run_id':'atomic-run','runtime_id':'atomic-runtime','status':'running','completed_at':None,'transport':'headless'})
  insert('runtimes',{**base_runtime,'runtime_id':'atomic-runtime','status':'busy','active_run_id':'atomic-run'})

def rows(path):
 with sqlite3.connect(path)as db:
  db.row_factory=sqlite3.Row
  return {table:[dict(r)for r in db.execute('SELECT * FROM '+table+' ORDER BY 1')]for table in ['runs','runtimes','session_index','broker_invocations','hrc_events','event_stream_cursor','sqlite_sequence']}
with tempfile.TemporaryDirectory(prefix='hrcp1-reconcile-',dir='/tmp')as scratch:
 values={};states={}
 for writer in ('bun','native'):
  root=pathlib.Path(scratch)/writer;root.mkdir();path=root/'state.sqlite';(root/'cases.json').write_text(json.dumps(cases))
  command=['bun',str(pathlib.Path(__file__).with_name('oracle.ts')),a.release,str(root),'seed'];r=subprocess.run(command,capture_output=True,text=True);(out/(writer+'-seed.json')).write_text(json.dumps({'command':command,'exit':r.returncode,'stdout':r.stdout,'stderr':r.stderr}));assert r.returncode==0,r.stderr
  fixture(path);(out/(writer+'-before.json')).write_text(json.dumps(rows(path),indent=2))
  command=['bun',str(pathlib.Path(__file__).with_name('reconciliation_control.ts')),a.release,str(root)]if writer=='bun'else[a.binary,'reconciliation-cas-contract','--db',str(path)]
  r=subprocess.run(command,capture_output=True,text=True,env=None if writer=='bun'else{**os.environ,'PATH':'/usr/bin:/bin','HRC_SOCKET_PATH':str(root/'absent.sock')});(out/(writer+'.json')).write_text(json.dumps({'command':command,'exit':r.returncode,'stdout':r.stdout,'stderr':r.stderr},indent=2));assert r.returncode==0,r.stdout+r.stderr
  body=json.loads(r.stdout);assert body.get('atomicRolledBack')is True and body.get('atomicCommitted')is True;values[writer]=body['results'];states[writer]=rows(path);(out/(writer+'-after.json')).write_text(json.dumps(states[writer],indent=2))
  with sqlite3.connect(path)as db,sqlite3.connect(out/(writer+'-state.sqlite'))as backup:db.backup(backup)
 assert len(values['bun'])==len(values['native'])==len(cases)==39
 assert values['bun']==values['native'],[(b,n)for b,n in zip(values['bun'],values['native'])if b!=n]
 assert states['bun']==states['native']
 expected_true={'aging-exact','aging-invocationSkip','aging-hasTerminal','orphan-free','orphan-noRuntime','orphan-ownsOtherTerminal','finalize-exact','finalize-unsupportedTransport','reap-exact','zombie-exact','release-exact'}
 assert {v['id']for v in values['native']if v['changed']}==expected_true
 (out/'comparison.json').write_text(json.dumps({'cases':len(cases),'exactSourceSql':True,'allResultAndPersistedRowsEqual':True,'winningPredicates':sorted(expected_true)},indent=2))
