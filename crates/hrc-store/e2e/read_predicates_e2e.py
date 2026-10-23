#!/usr/bin/env python3
"""Finite exact selectors, input/terminal bounds, raw absorption and lifecycle recency."""
import argparse,json,pathlib,sqlite3,subprocess,tempfile,os
p=argparse.ArgumentParser();p.add_argument('--binary',required=True);p.add_argument('--release',required=True);p.add_argument('--artifacts',required=True);a=p.parse_args();out=pathlib.Path(a.artifacts);out.mkdir(parents=True,exist_ok=True)
at='2026-10-23T00:00:00.000Z';recent='2026-10-23T00:01:00.000Z';old='2026-10-22T00:00:00.000Z'
def snapshot(path):
 with sqlite3.connect(path)as db:
  return list(db.iterdump())
with tempfile.TemporaryDirectory(prefix='hrcp1-read-predicates-',dir='/tmp')as scratch:
 root=pathlib.Path(scratch);path=root/'state.sqlite'
 command=['bun',str(pathlib.Path(__file__).with_name('oracle.ts')),a.release,str(root),'seed'];r=subprocess.run(command,capture_output=True,text=True);(out/'seed.json').write_text(json.dumps({'command':command,'exit':r.returncode,'stdout':r.stdout,'stderr':r.stderr}));assert r.returncode==0,r.stderr
 with sqlite3.connect(path)as db:
  db.row_factory=sqlite3.Row
  base_runtime=dict(db.execute('SELECT * FROM runtimes LIMIT 1').fetchone());base_run=dict(db.execute('SELECT * FROM runs LIMIT 1').fetchone());base_session=dict(db.execute('SELECT * FROM sessions LIMIT 1').fetchone());base_event=dict(db.execute('SELECT * FROM hrc_events LIMIT 1').fetchone());base_cont=dict(db.execute('SELECT * FROM continuities LIMIT 1').fetchone())
  def insert(table,row):db.execute('INSERT INTO '+table+'('+','.join(row)+') VALUES('+','.join('?'for _ in row)+')',list(row.values()))
  def event(runtime,ts):
   seq=db.execute('SELECT next_seq FROM event_stream_cursor WHERE id=1').fetchone()[0];db.execute('UPDATE event_stream_cursor SET next_seq=next_seq+1 WHERE id=1')
   row={**base_event,'stream_seq':seq,'runtime_id':runtime,'ts':ts};row.pop('hrc_seq');insert('hrc_events',row)
  for i,(name,status,run_status,complete,ts,transport)in enumerate([
    ('flight-tmux','busy','running',None,recent,'tmux'),('flight-headless','busy','started',None,recent,'headless'),
    ('flight-stale','busy','running',None,old,'headless'),('flight-ready','ready','running',None,recent,'headless'),
    ('flight-completed','busy','running',at,recent,'headless'),('flight-terminal','busy','completed',None,recent,'headless'),
    ('flight-equal','busy','running',None,at,'headless'),('flight-accepted','ready','accepted',None,'2026-10-23T00:02:00.000Z','headless'),
    ('flight-accepted-old','ready','accepted',None,at,'headless')]):
   insert('runs',{**base_run,'run_id':name,'runtime_id':name,'status':run_status,'completed_at':complete,'started_at':None if i==0 or run_status=='accepted'else at,'updated_at':ts,'transport':transport})
   insert('runtimes',{**base_runtime,'runtime_id':name,'status':status,'active_run_id':name,'last_activity_at':old})
   if name=='flight-stale':event(name,recent)
   event(name,ts)
  for status in ['dead','terminated','crashed','stale','exited']:
   insert('runtimes',{**base_runtime,'runtime_id':'terminal-'+status,'status':status,'active_run_id':'missing-but-selected'})
  for seq,kind,run,payload,inv in [
   (1,'input.accepted',None,{'inputId':'chosen'},'read-invocation'),(2,'input.accepted',None,{'inputId':'chosen'},'read-invocation'),
   (3,'turn.completed','owned',{},'read-invocation'),(4,'turn.failed','',{},'read-invocation'),(5,'turn.interrupted',None,{},'read-invocation'),
   (6,'submission.absorbed',None,{'submissionId':'b'},'read-invocation'),(1,'submission.absorbed',None,{'submissionId':'a'},'aaa-invocation')]:
   insert('broker_invocation_events',{'invocation_id':inv,'seq':seq,'time':at,'type':kind,'run_id':run,'runtime_id':'p1-runtime','broker_event_json':json.dumps(payload,separators=(',',':')),'created_at':at})
  scopes=['agent:literal_%\\','agent:literal_%\\:role:review','agent:literal_%\\:role:other','agent:literalAAx','agent:other:task:wrong']
  for index,scope in enumerate(scopes):
   for generation in [1,2]:
    insert('sessions',{**base_session,'host_session_id':'selector-'+str(index)+'-'+str(generation),'scope_ref':scope,'generation':generation,'lane_ref':'alt'if index==4 else'main'})
   insert('continuities',{**base_cont,'scope_ref':scope,'lane_ref':'main','active_host_session_id':'selector-'+str(index)+'-2','task_id':'same-task'if index in [0,4]else'different-task'})
 before=snapshot(path);(out/'before.json').write_text(json.dumps(before))
 values={}
 for name,command in [('bun',['bun',str(pathlib.Path(__file__).with_name('read_predicates_control.ts')),a.release,str(root)]),('native',[a.binary,'reconciliation-query-contract','--db',str(path)])]:
  r=subprocess.run(command,capture_output=True,text=True,env=None if name=='bun'else{**os.environ,'PATH':'/usr/bin:/bin','HRC_SOCKET_PATH':str(root/'absent.sock')});(out/(name+'.json')).write_text(json.dumps({'command':command,'exit':r.returncode,'stdout':r.stdout,'stderr':r.stderr},indent=2));assert r.returncode==0,r.stdout+r.stderr
  values[name]=json.loads(r.stdout)['result'];after=snapshot(path);(out/(name+'-after.json')).write_text(json.dumps(after));assert after==before,name+' read mutated logical DB'
 assert values['bun']==values['native'],{k:[values['bun'][k],values['native'].get(k)]for k in values['bun']if values['bun'][k]!=values['native'].get(k)}
 value=values['native'];assert value['accepted']==[2,None];assert value['terminals']==['turn.failed','turn.failed','turn.failed','turn.interrupted',None,None]
 assert [r['runId']for r in value['inFlight']]==['flight-tmux','flight-headless']
 assert [r['runId']for r in value['acceptedInFlight']]==['flight-headless','flight-tmux','flight-accepted']
 assert [r['runId']for r in value['excluded']]==['flight-accepted']
 assert len(value['absorbedAll'])==2 and len(value['absorbedOne'])==1
 assert value['scoped'][0]==[] and value['scoped'][1]==['selector-'+str(i)+'-'+str(g)for i in range(3)for g in [1,2]]
 assert value['scoped'][2]==['selector-0-1','selector-0-2']
 assert value['roleTree']==value['scoped'][1] and value['roleExact']==['selector-1-1','selector-1-2']
 assert len(value['terminalRuntimes'])==3
 with sqlite3.connect(path)as db,sqlite3.connect(out/'state-evidence.sqlite')as backup:db.backup(backup)
 (out/'comparison.json').write_text(json.dumps({'allFieldsAndOrderEqual':True,'pureReadsUnchanged':True,'nonemptyPredicates':list(value),'selectorGenerationAndEscaping':True},indent=2))
