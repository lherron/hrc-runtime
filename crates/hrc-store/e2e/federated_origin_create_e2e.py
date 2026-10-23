#!/usr/bin/env python3
"""Real Bun/native origin JSON storage, retry, delivery-path and missing-receipt controls."""
import argparse,datetime,json,os,pathlib,re,sqlite3,subprocess,tempfile
p=argparse.ArgumentParser();p.add_argument('--binary',required=True);p.add_argument('--release',required=True);p.add_argument('--artifacts',required=True);a=p.parse_args();out=pathlib.Path(a.artifacts);out.mkdir(parents=True,exist_ok=True)
def normalized(v):
 if isinstance(v,list):return [normalized(x)for x in v]
 if not isinstance(v,dict):return v
 result={}
 for k,x in v.items():
  if k in {'createdAt','updatedAt','created_at','updated_at'} and isinstance(x,str):
   datetime.datetime.fromisoformat(x.replace('Z','+00:00'));result[k]='<clock>'
  elif k in {'envelope_json','receipt_json'}:
   result[k]=re.sub(r'"(createdAt|updatedAt)":"[^"]+"',lambda m:'"'+m[1]+'":"<clock>"',x)
  else:result[k]=normalized(x)
 return result
with tempfile.TemporaryDirectory(prefix='hrcp1-origin-create-',dir='/tmp')as scratch:
 values={};states={}
 for name in ['bun','native']:
  root=pathlib.Path(scratch)/name;root.mkdir()
  for phase,command in [('seed',['bun',str(pathlib.Path(__file__).with_name('oracle.ts')),a.release,str(root),'seed']),('run',['bun',str(pathlib.Path(__file__).with_name('federated_origin_create_control.ts')),a.release,str(root)]if name=='bun'else[a.binary,'legacy-mail-origin-create-contract','--db',str(root/'state.sqlite')])]:
   r=subprocess.run(command,capture_output=True,text=True,env=None if phase=='seed' or name=='bun'else{**os.environ,'PATH':'/usr/bin:/bin','HRC_SOCKET_PATH':str(root/'absent.sock')})
   (out/(name+'-'+phase+'.json')).write_text(json.dumps({'command':command,'exit':r.returncode,'stdout':r.stdout,'stderr':r.stderr},indent=2))
   assert r.returncode==0,r.stdout+r.stderr
  values[name]=json.loads(r.stdout)['results']
  with sqlite3.connect(root/'state.sqlite')as db:db.execute("DELETE FROM hrcmail_ingress_receipts WHERE ingress_id='origin-ingress'")
  command=['bun',str(pathlib.Path(__file__).with_name('federated_origin_create_control.ts')),a.release,str(root),'missing']if name=='bun'else[a.binary,'legacy-mail-origin-missing-receipt-contract','--db',str(root/'state.sqlite')]
  r=subprocess.run(command,capture_output=True,text=True)
  (out/(name+'-missing.json')).write_text(json.dumps({'command':command,'exit':r.returncode,'stdout':r.stdout,'stderr':r.stderr},indent=2));assert r.returncode==0,r.stdout+r.stderr
  values[name]+=json.loads(r.stdout)['results']
  with sqlite3.connect(root/'state.sqlite')as db,sqlite3.connect(out/(name+'-state.sqlite'))as backup:
   db.row_factory=sqlite3.Row
   states[name]={table:[dict(row)for row in db.execute('SELECT * FROM '+table+' ORDER BY 1')]for table in ['hrcmail_envelopes','hrcmail_ingress_receipts','hrcmail_federated_origins']}
   db.backup(backup)
  (out/(name+'-rows.json')).write_text(json.dumps(states[name],indent=2))
 diffs=[{'index':i,'bun':b,'native':n}for i,(b,n)in enumerate(zip(normalized(values['bun']),normalized(values['native'])))if b!=n]
 (out/'comparison.json').write_text(json.dumps({'differences':diffs,'rowDifferences':normalized(states['bun'])!=normalized(states['native'])},indent=2))
 assert len(values['bun'])==len(values['native'])==10
 assert not diffs,diffs[:3]
 assert normalized(states['bun'])==normalized(states['native'])
 origin=json.loads(next(r['envelope_json']for r in states['native']['hrcmail_federated_origins']if r['ingress_id']=='origin-ingress'))
 assert origin['payload']['body']=='X\ud800Y\udfff'
 assert '__proto__'not in origin['payload']['metadata']
 assert '__proto__'in values['bun'][0]['value']['envelope']['payload']['metadata']
 assert '__proto__'not in values['native'][1]['value']['envelope']['payload']['metadata']
 (out/'summary.json').write_text(json.dumps({'status':'PASS','observations':10,'jsonSurrogatesPreserved':True,'clockNormalization':'declared clocks only; raw outputs and coherent DB retained'},indent=2))
