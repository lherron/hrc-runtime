"""Old qualified spill writer followed by new passive readers and exact retries."""
import argparse,hashlib,json,os,sqlite3,subprocess,tempfile
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--identity',required=True);p.add_argument('--old-identity',required=True);p.add_argument('--artifacts',required=True);a=p.parse_args()
current=json.loads(Path(a.identity).read_text());old=json.loads(Path(a.old_identity).read_text());out=Path(a.artifacts);out.mkdir(parents=True,exist_ok=False)
for identity in [current,old]:assert hashlib.sha256(Path(identity['native']['path']).read_bytes()).hexdigest()==identity['native']['sha256']
(out/'identities.json').write_text(json.dumps({'old':old,'current':current},indent=2))
def run(name,argv,env=None):
 r=subprocess.run(argv,env=env,capture_output=True,text=True);(out/(name+'.json')).write_text(json.dumps({'command':argv,'exit':r.returncode,'stdout':r.stdout,'stderr':r.stderr},indent=2));assert r.returncode==0,(name,r.returncode);return json.loads(r.stdout)
def raw(db):
 with sqlite3.connect(db)as c:
  names=[r[0]for r in c.execute("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name")]
  return {name:list(c.execute('SELECT * FROM "'+name.replace('"','""')+'"'))for name in names}
results=[]
for writer in ['old-native','old-bun']:
 with tempfile.TemporaryDirectory(prefix='hrcp1-pairs-',dir='/tmp')as root:
  db=Path(root)/'state.sqlite';run(writer+'-seed',['bun',str(Path(__file__).parents[1]/'oracle.ts'),current['bun']['release'],root,'seed'])
  if writer=='old-native':run(writer+'-write',[old['native']['path'],'serialization-contract','--db',str(db)])
  else:run(writer+'-write',['bun',str(Path(__file__).with_name('oracle.ts')),old['bun']['release'],root,'historical'])
  before=raw(db)
  with sqlite3.connect(db)as c:stored=c.execute("SELECT broker_event_json FROM broker_invocation_events WHERE invocation_id='p1-json' AND seq=2").fetchone()[0]
  head=json.loads(stored)['result']['content'][0]['text'].split('\n…[',1)[0].encode('utf-16-le','surrogatepass');assert len(head)==8192 and 0xd800<=int.from_bytes(head[-2:],'little')<=0xdbff
  n=run(writer+'-new-native-retry',[current['native']['path'],'spill-history-reappend','--db',str(db)],{**os.environ,'PATH':'/usr/bin:/bin'});assert n['idempotent']is True and raw(db)==before
  b=run(writer+'-new-bun-retry',['bun',str(Path(__file__).with_name('oracle.ts')),current['bun']['release'],root,'historical']);assert b==n and raw(db)==before
  with sqlite3.connect(db)as source,sqlite3.connect(out/(writer+'-state.sqlite'))as target:source.backup(target)
  results.append({'historicalWriter':writer,'storedHeadUnits':4096,'splitHistoricalUnitPreserved':True,'nativeAndBunRetryIdempotent':True,'allRowsUnchanged':True})
(out/'summary.json').write_text(json.dumps({'status':'PASS','scope':'HISTORICAL_SPILL_COMPATIBILITY_SUBSET','results':results},indent=2));print(json.dumps({'status':'PASS','historicalWriters':2,'newReaderWriterDirections':2}))
