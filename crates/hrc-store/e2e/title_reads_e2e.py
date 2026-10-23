#!/usr/bin/env python3
"""Current title facade emits metadata provenance and omits unpersisted model fields."""
import argparse,pathlib,subprocess,json,tempfile,os,sqlite3
p=argparse.ArgumentParser();p.add_argument('--binary',required=True);p.add_argument('--release',required=True);p.add_argument('--artifacts',required=True);a=p.parse_args();out=pathlib.Path(a.artifacts);out.mkdir(parents=True,exist_ok=True)
with tempfile.TemporaryDirectory(prefix='hrcp1-legacy-mail-',dir='/tmp') as root:
 path=pathlib.Path(root)/'state.sqlite';oracle=['bun',str(pathlib.Path(__file__).with_name('oracle.ts')),a.release,root]
 for mode in ['seed','title-read-seed']:
  r=subprocess.run(oracle+[mode],capture_output=True,text=True);(out/(mode+'.json')).write_text(json.dumps({'exit':r.returncode,'stdout':r.stdout,'stderr':r.stderr},indent=2));assert r.returncode==0,r.stderr
 def snapshot():
  with sqlite3.connect(path) as db:return list(db.iterdump())
 before=snapshot()
 r=subprocess.run([a.binary,'title-read-contract','--db',str(path)],capture_output=True,text=True,env={**os.environ,'PATH':'/usr/bin:/bin','HRC_SOCKET_PATH':root+'/absent.sock'});(out/'native.json').write_text(json.dumps({'exit':r.returncode,'stdout':r.stdout,'stderr':r.stderr},indent=2));assert r.returncode==0,r.stdout+r.stderr
 assert before==snapshot(),'passive reads mutated storage'
 b=subprocess.run(oracle+['title-read-control'],capture_output=True,text=True);(out/'bun.json').write_text(json.dumps({'exit':b.returncode,'stdout':b.stdout,'stderr':b.stderr},indent=2));assert b.returncode==0,b.stderr
 assert json.loads(r.stdout)==json.loads(b.stdout)
 v=json.loads(r.stdout);assert v['one']['source']=='manual' and 'model' not in v['one'] and len(v['all'])==1

 s=subprocess.run(oracle+['title-surrogate-seed'],capture_output=True,text=True);assert s.returncode==0,s.stderr
 n=subprocess.run([a.binary,'title-read-contract','--db',str(path)],capture_output=True,text=True,env={**os.environ,'PATH':'/usr/bin:/bin'});(out/'native-surrogate.json').write_text(json.dumps({'exit':n.returncode,'stdout':n.stdout,'stderr':n.stderr},indent=2));assert n.returncode==0,n.stderr
 b=subprocess.run(oracle+['title-read-control'],capture_output=True,text=True);(out/'bun-surrogate.json').write_text(json.dumps({'exit':b.returncode,'stdout':b.stdout,'stderr':b.stderr},indent=2));assert b.returncode==0,b.stderr
 assert json.loads(n.stdout)==json.loads(b.stdout)
 assert json.loads(n.stdout)['one']['title']=='\ud800 title \udfff'

 n=subprocess.run([a.binary,'title-reappend-contract','--db',str(path)],capture_output=True,text=True,env={**os.environ,'PATH':'/usr/bin:/bin'});(out/'native-reappend.json').write_text(json.dumps({'exit':n.returncode,'stdout':n.stdout,'stderr':n.stderr},indent=2));assert n.returncode==0,n.stdout+n.stderr
 b=subprocess.run(oracle+['title-read-control'],capture_output=True,text=True);(out/'bun-after-native-reappend.json').write_text(json.dumps({'exit':b.returncode,'stdout':b.stdout,'stderr':b.stderr},indent=2));assert b.returncode==0,b.stderr
 assert json.loads(n.stdout)==json.loads(b.stdout)['one']

 s=subprocess.run(oracle+['title-whitespace-seed'],capture_output=True,text=True);assert s.returncode==0,s.stderr
 n=subprocess.run([a.binary,'title-reappend-contract','--db',str(path)],capture_output=True,text=True,env={**os.environ,'PATH':'/usr/bin:/bin'});(out/'native-whitespace-reappend.json').write_text(json.dumps({'exit':n.returncode,'stdout':n.stdout,'stderr':n.stderr},indent=2));assert n.returncode==0,n.stdout+n.stderr
 b=subprocess.run(oracle+['title-read-control'],capture_output=True,text=True);(out/'bun-whitespace-after-native.json').write_text(json.dumps({'exit':b.returncode,'stdout':b.stdout,'stderr':b.stderr},indent=2));assert b.returncode==0,b.stderr
 assert json.loads(n.stdout)==json.loads(b.stdout)['one']
 assert json.loads(n.stdout)['title']=='\u0085 title \u0085'
