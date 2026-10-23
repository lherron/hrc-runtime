#!/usr/bin/env python3
"""Federated terminal projection fingerprints, authority, idempotency and conflicts versus Bun."""
import argparse,pathlib,subprocess,json,tempfile,os,sqlite3,datetime
p=argparse.ArgumentParser();p.add_argument('--binary',required=True);p.add_argument('--release',required=True);p.add_argument('--artifacts',required=True);a=p.parse_args();out=pathlib.Path(a.artifacts);out.mkdir(parents=True,exist_ok=True)
with tempfile.TemporaryDirectory(prefix='hrcp1-mail-transition-',dir='/tmp') as root:
 root=pathlib.Path(root);oracle=['bun',str(pathlib.Path(__file__).with_name('oracle.ts')),a.release,str(root)]
 for mode in ['seed','legacy-mail-seed']:
  r=subprocess.run(oracle+[mode],capture_output=True,text=True);assert r.returncode==0,r.stderr
 clone=root/'control';clone.mkdir()
 with sqlite3.connect(root/'state.sqlite') as source,sqlite3.connect(clone/'state.sqlite') as dest:source.backup(dest)
 native=subprocess.run([a.binary,'legacy-mail-origin-contract','--db',str(root/'state.sqlite')],capture_output=True,text=True,env={**os.environ,'PATH':'/usr/bin:/bin','HRC_SOCKET_PATH':str(root/'absent.sock')});(out/'native.json').write_text(json.dumps({'exit':native.returncode,'stdout':native.stdout,'stderr':native.stderr},indent=2));assert native.returncode==0,native.stdout+native.stderr
 bun=subprocess.run(['bun',str(pathlib.Path(__file__).with_name('oracle.ts')),a.release,str(clone),'legacy-mail-origin-control'],capture_output=True,text=True);(out/'bun.json').write_text(json.dumps({'exit':bun.returncode,'stdout':bun.stdout,'stderr':bun.stderr},indent=2));assert bun.returncode==0,bun.stderr
 n=json.loads(native.stdout);b=json.loads(bun.stdout)
 assert n==b
 assert n['failures']==['invalid_transition','unknown_envelope','conflicting_disposition','conflicting_disposition','conflicting_disposition']
 assert n['applied']['outcome']=='applied' and n['repeated']['outcome']=='idempotent'
 assert n['origin']['envelope']['response']['\ud800']=='\udfff'
