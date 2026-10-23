#!/usr/bin/env python3
"""Qualified repository UTF16 body bytes, finite reads and reappend in both directions."""
import argparse,datetime,json,os,pathlib,sqlite3,struct,subprocess,tempfile
p=argparse.ArgumentParser();p.add_argument('--binary',required=True);p.add_argument('--release',required=True);p.add_argument('--artifacts',required=True);a=p.parse_args();out=pathlib.Path(a.artifacts);out.mkdir(parents=True,exist_ok=True)
fixture=pathlib.Path(__file__).parent/'fixtures/mail-body.jsonl';inputs=[json.loads(line)for line in fixture.read_text().splitlines()];(out/'input.jsonl').write_text(fixture.read_text())
def norm(v):
 if isinstance(v,list):return [norm(x)for x in v]
 if not isinstance(v,dict):return v
 result={}
 for k,value in v.items():
  if k in ('createdAt','updatedAt','presentedAt','ackedAt')and isinstance(value,str):
   assert datetime.datetime.fromisoformat(value.replace('Z','+00:00')).utcoffset()==datetime.timedelta(0);result[k]='<clock>'
  else:result[k]=norm(value)
 return result
def encoded(units):
 result=bytearray();i=0
 while i<len(units):
  n=units[i]
  if 0xd800<=n<=0xdfff and i+1<len(units):
   i+=1;n=0x10000+((n&1023)<<10)+(units[i]&1023)
  result.extend(chr(n).encode('utf-8','surrogatepass'));i+=1
 return bytes(result)
def logical(path):
 with sqlite3.connect(path)as db:
  db.text_factory=bytes
  def encode(value):
   if isinstance(value,bytes):return {'sqliteBytes':value.hex()}
   if isinstance(value,(tuple,list)):return [encode(v)for v in value]
   return value
  schema=list(db.execute('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name'))
  tables=[r[1].decode()for r in schema if r[0]==b'table']
  return {'schema':encode(schema),'tables':{name:encode(list(db.execute('SELECT * FROM "'+name.replace('"','""')+'"')))for name in tables}}

with tempfile.TemporaryDirectory(prefix='hrcp1-origin-body-',dir='/tmp')as scratch:
 values={};physical={}
 for writer in ('bun','native'):
  root=pathlib.Path(scratch)/writer;root.mkdir();path=root/'state.sqlite'
  def run(name,command,native=False):
   r=subprocess.run(command,capture_output=True,text=True,env={**os.environ,'PATH':'/usr/bin:/bin','HRC_SOCKET_PATH':str(root/'absent.sock')}if native else None)
   (out/(writer+'-'+name+'.json')).write_text(json.dumps({'command':command,'exit':r.returncode,'stdout':r.stdout,'stderr':r.stderr},indent=2));assert r.returncode==0,r.stdout+r.stderr;return json.loads(r.stdout)
  run('seed',['bun',str(pathlib.Path(__file__).with_name('oracle.ts')),a.release,str(root),'seed'])
  native=[a.binary,'legacy-mail-origin-body-contract','--db',str(path)]
  bun=['bun',str(pathlib.Path(__file__).with_name('mail_body_control.ts')),a.release,str(root),str(fixture.resolve())]
  values[writer]=run('writer',native if writer=='native'else bun+['origin'],writer=='native')['results']
  before=logical(path);(out/(writer+'-before-passive.json')).write_text(json.dumps(before))
  read=run('opposite-passive',bun+['origin-read']if writer=='native'else[a.binary,'legacy-mail-origin-body-read-contract','--db',str(path)],writer=='bun')
  after=logical(path);(out/(writer+'-after-passive.json')).write_text(json.dumps(after));assert before==after
  replay=run('opposite-retry',bun+['origin']if writer=='native'else native,writer=='bun')['results']
  assert norm(replay)==norm(values[writer])
  assert after==logical(path)
  with sqlite3.connect(path)as db,sqlite3.connect(out/(writer+'-state.sqlite'))as backup:
   physical[writer]=db.execute('SELECT ingress_id,envelope_json,request_fingerprint FROM hrcmail_federated_origins ORDER BY ingress_id').fetchall()
   assert db.execute('SELECT COUNT(*) FROM hrcmail_envelopes').fetchone()[0]==0
   db.backup(backup)
  (out/(writer+'-physical.json')).write_text(json.dumps(physical[writer],indent=2))
  assert len(values[writer])==len(read['envelopes'])==len(physical[writer])==len(inputs)==2004
  for index,(source,observed,envelope)in enumerate(zip(inputs,values[writer],read['envelopes'])):
   expected=b''.join(int(n).to_bytes(2,'little')for n in source['units']).decode('utf-16-le','surrogatepass')
   assert observed['index']==index and observed['units']==source['units']
   assert observed['create']['value']['envelope']['payload']['body']==expected
   assert envelope['payload']['body']==expected
   assert norm(observed['retry'])=={**norm(observed['create']),'name':'retry'}
   assert norm(observed['reappend'])=={**norm(observed['create']),'name':'reappend'}
 assert norm(values['bun'])==norm(values['native'])
 def rows_norm(rows):
  return [(ingress,norm(json.loads(document)),fingerprint)for ingress,document,fingerprint in rows]
 assert rows_norm(physical['bun'])==rows_norm(physical['native'])
 (out/'comparison.json').write_text(json.dumps({'cases':2004,'bothWriterDirections':True,'pureReadsUnchanged':True,'originalUtf16Preserved':True,'allRetryReappendIdempotent':True,'localEnvelopeRows':0},indent=2))
