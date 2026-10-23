#!/usr/bin/env python3
"""Actual unchanged Bun create/ack results and persisted rows versus native typed calls."""
import argparse,datetime,json,os,pathlib,re,sqlite3,subprocess,tempfile
p=argparse.ArgumentParser();p.add_argument('--binary',required=True);p.add_argument('--release',required=True);p.add_argument('--artifacts',required=True);a=p.parse_args();out=pathlib.Path(a.artifacts);out.mkdir(parents=True,exist_ok=True)
target='agent:tabularasa:project:hrc-runtime:task:p1-store'
clock_keys={'createdAt','updatedAt','presentedAt','ackedAt','created_at','updated_at','presented_at','acked_at'}
def normalized(value):
 if isinstance(value,list):return [normalized(v)for v in value]
 if not isinstance(value,dict):return value
 result={}
 for k,v in value.items():
  if k in clock_keys and isinstance(v,str):
   parsed=datetime.datetime.fromisoformat(v.replace('Z','+00:00'));assert parsed.utcoffset()==datetime.timedelta(0);result[k]='<explicit-native-clock-or-observed-Bun-clock>'
  elif k=='receipt_json':
   parsed=json.loads(v);assert 'createdAt'in parsed;datetime.datetime.fromisoformat(parsed['createdAt'].replace('Z','+00:00'));result[k]=re.sub(r'"createdAt":"[^"]+"','"createdAt":"<clock>"',v)
  else:result[k]=normalized(v)
 return result
with tempfile.TemporaryDirectory(prefix='hrcp1-mail-mutations-',dir='/tmp')as scratch:
 values={};states={}
 for name in ['bun','native']:
  root=pathlib.Path(scratch)/name;root.mkdir();seed=['bun',str(pathlib.Path(__file__).with_name('oracle.ts')),a.release,str(root),'seed']
  r=subprocess.run(seed,capture_output=True,text=True);(out/(name+'-seed.json')).write_text(json.dumps({'command':seed,'exit':r.returncode,'stdout':r.stdout,'stderr':r.stderr},indent=2));assert r.returncode==0,r.stderr
  path=root/'state.sqlite'
  with sqlite3.connect(path)as db:db.execute("INSERT INTO hrcmail_stop_refusals VALUES(?,?,0,3,8,?,?)",('p1-runtime',target,'2026-10-23T00:00:00.000Z','2026-10-23T00:00:00.000Z'))
  command=['bun',str(pathlib.Path(__file__).with_name('legacy_mail_mutations_control.ts')),a.release,str(root)]if name=='bun'else[a.binary,'legacy-mail-create-ack-contract','--db',str(path)]
  r=subprocess.run(command,capture_output=True,text=True,env=None if name=='bun'else{**os.environ,'PATH':'/usr/bin:/bin','HRC_SOCKET_PATH':str(root/'absent.sock')});(out/(name+'.json')).write_text(json.dumps({'command':command,'exit':r.returncode,'stdout':r.stdout,'stderr':r.stderr},indent=2));assert r.returncode==0,r.stdout+r.stderr
  values[name]=json.loads(r.stdout)['results']
  with sqlite3.connect(path)as db,sqlite3.connect(out/(name+'-state.sqlite'))as backup:
   db.row_factory=sqlite3.Row
   states[name]={table:[dict(row)for row in db.execute('SELECT * FROM '+table+' ORDER BY 1')]for table in ['hrcmail_envelopes','hrcmail_ingress_receipts','hrcmail_stop_refusals']}
   db.backup(backup)
  (out/(name+'-rows.json')).write_text(json.dumps(states[name],indent=2))
 comparison={'clockNormalization':'Only declared DTO/SQL clock fields and receipt createdAt; raw outputs and coherent DBs retained. Native uses explicit fixed clock, Bun uses actual Date.','resultDifferences':[{'index':i,'bun':b,'native':n}for i,(b,n)in enumerate(zip(normalized(values['bun']),normalized(values['native'])))if b!=n],'rowDifferences':normalized(states['bun'])!=normalized(states['native'])}
 (out/'comparison.json').write_text(json.dumps(comparison,indent=2))
 assert len(values['bun'])==len(values['native'])==23
 assert not comparison['resultDifferences'],comparison['resultDifferences'][:3]
 assert not comparison['rowDifferences']
 assert len(states['native']['hrcmail_envelopes'])==2 and all(r['state']=='acked'for r in states['native']['hrcmail_envelopes'])
 assert states['native']['hrcmail_stop_refusals'][0]['refusal_count']==0 and states['native']['hrcmail_stop_refusals'][0]['total_refusal_count']==8 and states['native']['hrcmail_stop_refusals'][0]['observed_envelope_seq']==2
 assert states['native']['hrcmail_envelopes'][0]['materialization_intent_json']=='{"first":true}'
