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
with tempfile.TemporaryDirectory(prefix='hrcp1-mail-body-',dir='/tmp')as scratch:
 all_values={};physical={}
 for writer in ('bun','native'):
  root=pathlib.Path(scratch)/writer;root.mkdir();path=root/'state.sqlite'
  def run(name,command,native=False):
   r=subprocess.run(command,capture_output=True,text=True,env={**os.environ,'PATH':'/usr/bin:/bin','HRC_SOCKET_PATH':str(root/'absent.sock')}if native else None)
   (out/(writer+'-'+name+'.json')).write_text(json.dumps({'command':command,'exit':r.returncode,'stdout':r.stdout,'stderr':r.stderr},indent=2));assert r.returncode==0,r.stdout+r.stderr;return json.loads(r.stdout)
  run('seed',['bun',str(pathlib.Path(__file__).with_name('oracle.ts')),a.release,str(root),'seed'])
  native=[a.binary,'legacy-mail-body-contract','--db',str(path)]
  bun=['bun',str(pathlib.Path(__file__).with_name('mail_body_control.ts')),a.release,str(root),str(fixture.resolve())]
  all_values[writer]=run('writer',native if writer=='native'else bun,writer=='native')['results']
  before=logical(path);(out/(writer+'-before-passive.json')).write_text(json.dumps(before))
  read=run('opposite-passive',bun+['read']if writer=='native'else[a.binary,'legacy-mail-body-read-contract','--db',str(path)],writer=='bun')
  after=logical(path);(out/(writer+'-after-passive.json')).write_text(json.dumps(after));assert before==after,'pure body read mutated DB'
  replay=run('opposite-retry-reappend',bun if writer=='native'else native,writer=='bun')['results'];assert norm(replay)==norm(all_values[writer]),'cross-writer retry/reappend mismatch'
  assert after==logical(path),'repeat/refusal effects leaked'
  with sqlite3.connect(path)as db,sqlite3.connect(out/(writer+'-state.sqlite'))as backup:
   rows=db.execute('SELECT envelope_id,hex(CAST(body AS BLOB)),typeof(body),request_fingerprint FROM hrcmail_envelopes JOIN hrcmail_ingress_receipts USING(envelope_id) ORDER BY envelope_seq').fetchall();db.backup(backup)
  physical[writer]=rows;(out/(writer+'-physical.json')).write_text(json.dumps(rows,indent=2))
  indexed={row[0]:row for row in rows};read_index={v['envelopeId']:v for v in read['envelopes']};success=0;conflicts=0;blank_reappend=0
  assert len(all_values[writer])==len(inputs)==2004
  for index,(source,result)in enumerate(zip(inputs,all_values[writer])):
   assert result['index']==index and result['units']==source['units'] and result['name']==source['name']
   create=result['create'];assert result['retry']=={**create,'name':'retry'}
   if 'error'in create:
    assert create['error']['code']=='invalid_transition' and result['reappend']is None and 'body-envelope-'+str(index)not in indexed;continue
   success+=1;id='body-envelope-'+str(index);row=indexed[id];raw=encoded(source['units'])
   assert row[1]==raw.hex().upper() and row[2]=='text',(index,row,raw.hex())
   try:expected=raw.decode('utf-8')
   except UnicodeDecodeError:expected=''
   assert create['value']['envelope']['payload']['body']==expected and read_index[id]['payload']['body']==expected
   expected_units=list(struct.unpack('<'+'H'*(len(expected.encode('utf-16-le'))//2),expected.encode('utf-16-le')))
   if expected_units==source['units']:assert result['reappend']=={**create,'name':'reappend'}
   elif expected=='':assert result['reappend']['error']['code']=='invalid_transition';blank_reappend+=1
   else:assert result['reappend']['error']['code']=='ingress_conflict';conflicts+=1
  assert len(rows)==len(read['envelopes'])==success>1900 and conflicts>100 and blank_reappend>20
 assert norm(all_values['bun'])==norm(all_values['native'])
 assert physical['bun']==physical['native']
 (out/'comparison.json').write_text(json.dumps({'cases':len(inputs),'bodyBytesAndFingerprintEqual':True,'resultsEqualExceptDeclaredClocks':True,'bothDirections':True,'pureReadsUnchanged':True,'created':success,'reappendConflicts':conflicts,'emptyReadReappendRefusals':blank_reappend,'qualifiedBun':a.release},indent=2))
