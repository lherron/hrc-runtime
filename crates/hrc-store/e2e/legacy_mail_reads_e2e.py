#!/usr/bin/env python3
"""Real Bun envelopes/origins decoded by finite typed native reads without mutation."""
import argparse,pathlib,subprocess,json,tempfile,os,sqlite3
p=argparse.ArgumentParser();p.add_argument('--binary',required=True);p.add_argument('--release',required=True);p.add_argument('--artifacts',required=True);a=p.parse_args();out=pathlib.Path(a.artifacts);out.mkdir(parents=True,exist_ok=True)
with tempfile.TemporaryDirectory(prefix='hrcp1-legacy-mail-',dir='/tmp') as root:
 path=pathlib.Path(root)/'state.sqlite';oracle=['bun',str(pathlib.Path(__file__).with_name('oracle.ts')),a.release,root]
 for mode in ['seed','legacy-mail-seed']:
  r=subprocess.run(oracle+[mode],capture_output=True,text=True);(out/(mode+'.json')).write_text(json.dumps({'exit':r.returncode,'stdout':r.stdout,'stderr':r.stderr},indent=2));assert r.returncode==0,r.stderr
 def snapshot():
  with sqlite3.connect(path) as db:return list(db.iterdump())
 before=snapshot()
 r=subprocess.run([a.binary,'legacy-mail-read-contract','--db',str(path)],capture_output=True,text=True,env={**os.environ,'PATH':'/usr/bin:/bin','HRC_SOCKET_PATH':root+'/absent.sock'});(out/'native.json').write_text(json.dumps({'exit':r.returncode,'stdout':r.stdout,'stderr':r.stderr},indent=2));assert r.returncode==0,r.stdout+r.stderr
 assert before==snapshot(),'passive reads mutated storage'
 b=subprocess.run(oracle+['legacy-mail-read'],capture_output=True,text=True);(out/'bun.json').write_text(json.dumps({'exit':b.returncode,'stdout':b.stdout,'stderr':b.stderr},indent=2));assert b.returncode==0,b.stderr
 assert json.loads(r.stdout)==json.loads(b.stdout)
 v=json.loads(r.stdout);assert len(v['all'])==4 and len(v['inbox'])==2 and len(v['pending'])==2
 assert 'response' in v['one'] and v['one']['response'] is None
 assert 'response' not in v['pending'][0]
 assert v['one']['payload']['metadata']['\ud800']=='\udfff'
