"""Bidirectional deep current repository writes/reads/reappend on canonical scratch."""
import argparse,hashlib,json,os,sqlite3,subprocess,tempfile
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--identity',required=True);p.add_argument('--artifacts',required=True);a=p.parse_args()
identity=json.loads(Path(a.identity).read_text());native=identity['native'];binary=native['path'];release=identity['bun']['release'];out=Path(a.artifacts);out.mkdir(parents=True,exist_ok=False)
def digest(path):return hashlib.sha256(Path(path).read_bytes()).hexdigest()
assert digest(binary)==native['sha256']
(out/'identity.json').write_text(json.dumps(identity,indent=2));results=[]
def run(name,argv,env=None):
 r=subprocess.run(argv,capture_output=True,text=True,env=env);(out/(name+'.json')).write_text(json.dumps({'command':argv,'exit':r.returncode,'stdout':r.stdout,'stderr':r.stderr},indent=2));assert r.returncode==0,(name,r.returncode);return json.loads(r.stdout)
def rows(db):
 with sqlite3.connect(db)as c:
  names=[r[0]for r in c.execute("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name")]
  return {name:list(c.execute('SELECT * FROM "'+name.replace('"','""')+'"'))for name in names}
for writer in ['native','bun']:
 with tempfile.TemporaryDirectory(prefix='hrcp1-depth-',dir='/tmp')as root:
  db=Path(root)/'state.sqlite';run(writer+'-seed',['bun',str(Path(__file__).parents[1]/'oracle.ts'),release,root,'seed']);oracle=['bun',str(Path(__file__).with_name('store_oracle.ts')),release,root]
  first=run(writer+'-write',[binary,'json-depth-contract','--db',str(db)]if writer=='native'else oracle+['write']);before=rows(db)
  b=run(writer+'-bun-read',oracle+['read']);assert rows(db)==before
  n=run(writer+'-native-read',[binary,'json-depth-observe','--db',str(db)],{**os.environ,'PATH':'/usr/bin:/bin'});assert rows(db)==before
  assert first==b==n
  repeat=run(writer+'-opposite-reappend',oracle+['write']if writer=='native'else[binary,'json-depth-contract','--db',str(db)]);assert repeat==first and rows(db)==before
  with sqlite3.connect(db)as source,sqlite3.connect(out/(writer+'-state.sqlite'))as target:source.backup(target)
  results.append({'writer':writer,'passiveReadExact':True,'oppositeReappendExact':True,'rows':len(n['events'])})
assert digest(binary)==native['sha256']
(out/'summary.json').write_text(json.dumps({'status':'PASS','scope':'SOURCE_DEEP_JSON_SUBSET','results':results},indent=2))
