"""Qualified inward UTF16 cuts and genuine lone-unit persistence, both writers."""
import argparse,hashlib,json,os,sqlite3,subprocess,tempfile
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--identity',required=True);p.add_argument('--artifacts',required=True);a=p.parse_args()
identity=json.loads(Path(a.identity).read_text());native=identity['native'];release=identity['bun']['release'];binary=native['path'];out=Path(a.artifacts);out.mkdir(parents=True,exist_ok=False)
assert hashlib.sha256(Path(binary).read_bytes()).hexdigest()==native['sha256'];(out/'identity.json').write_text(json.dumps(identity,indent=2));outputs=[]
def run(name,argv,env=None):
 r=subprocess.run(argv,env=env,capture_output=True,text=True);(out/(name+'.json')).write_text(json.dumps({'command':argv,'exit':r.returncode,'stdout':r.stdout,'stderr':r.stderr},indent=2));assert r.returncode==0,(name,r.returncode);return json.loads(r.stdout)
def raw(db):
 with sqlite3.connect(db)as c:
  return list(c.execute("SELECT seq,broker_event_json FROM broker_invocation_events WHERE invocation_id='p1-pairs' ORDER BY seq"))
def units(text):return [int.from_bytes(text.encode('utf-16-le','surrogatepass')[i:i+2],'little')for i in range(0,len(text.encode('utf-16-le','surrogatepass')),2)]
for writer in ['native','bun']:
 with tempfile.TemporaryDirectory(prefix='hrcp1-pairs-',dir='/tmp')as root:
  db=Path(root)/'state.sqlite';run(writer+'-seed',['bun',str(Path(__file__).parents[1]/'oracle.ts'),release,root,'seed']);oracle=['bun',str(Path(__file__).with_name('oracle.ts')),release,root]
  first=run(writer+'-write',[binary,'spill-pair-contract','--db',str(db)]if writer=='native'else oracle+['write']);before=raw(db)
  b=run(writer+'-bun-read',oracle+['read']);assert raw(db)==before
  n=run(writer+'-native-read',[binary,'spill-pair-observe','--db',str(db)],{**os.environ,'PATH':'/usr/bin:/bin'});assert raw(db)==before;assert first==b==n
  lengths=[]
  for (seq,text),(headlen,taillen)in zip(before,[(4095,1024),(4096,1023),(4095,1023),(4096,1024),(4096,1024),(4096,1024)],strict=True):
   payload=json.loads(text);excerpt=payload['result']['content'][0]['text'];head,rest=excerpt.split('\n…[',1);tail=rest.split(']…\n',1)[1];h=units(head);t=units(tail);assert (len(h),len(t))==(headlen,taillen)
   if seq<=4:assert not 0xd800<=h[-1]<=0xdbff and not 0xdc00<=t[0]<=0xdfff
   if seq==5:assert h[-1]==0xd800
   if seq==6:assert t[0]==0xdc00
   lengths.append({'seq':seq,'headUnits':len(h),'tailUnits':len(t)})
  repeat=run(writer+'-opposite-reappend',oracle+['write']if writer=='native'else[binary,'spill-pair-contract','--db',str(db)]);assert repeat==first and raw(db)==before
  (out/(writer+'-raw.json')).write_text(json.dumps(before,indent=2))
  with sqlite3.connect(db)as source,sqlite3.connect(out/(writer+'-state.sqlite'))as target:source.backup(target)
  outputs.append({'writer':writer,'lengths':lengths,'passive':True,'oppositeReappend':True})
assert json.loads((out/'native-raw.json').read_text())==json.loads((out/'bun-raw.json').read_text())
(out/'summary.json').write_text(json.dumps({'status':'PASS','scope':'SOURCE_SPILL_PAIR_SUBSET','results':outputs},indent=2))
print(json.dumps({'status':'PASS','writerDirections':2,'cases':6,'rawPayloadIdentity':True}))
