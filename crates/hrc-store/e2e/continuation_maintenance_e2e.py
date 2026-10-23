#!/usr/bin/env python3
"""Explicit repair/backfill writes, tested against unchanged exported Bun helpers."""
import argparse,json,pathlib,subprocess,tempfile,os,sqlite3
p=argparse.ArgumentParser();p.add_argument('--binary',required=True);p.add_argument('--release',required=True);p.add_argument('--artifacts',required=True);a=p.parse_args();out=pathlib.Path(a.artifacts);out.mkdir(parents=True,exist_ok=True)
with tempfile.TemporaryDirectory(prefix='hrcp1-continuation-',dir='/tmp') as root:
 root=pathlib.Path(root);oracle=['bun',str(pathlib.Path(__file__).with_name('oracle.ts')),a.release,str(root)]
 s=subprocess.run(oracle+['seed'],capture_output=True,text=True);assert s.returncode==0,s.stderr
 def native(command,path,name):
  r=subprocess.run([a.binary,command,'--db',str(path)],capture_output=True,text=True,env={**os.environ,'PATH':'/usr/bin:/bin','HRC_SOCKET_PATH':str(root/'absent.sock')});(out/name).write_text(json.dumps({'exit':r.returncode,'stdout':r.stdout,'stderr':r.stderr},indent=2));assert r.returncode==0,r.stdout+r.stderr;return json.loads(r.stdout)
 native('continuation-maintenance-seed',root/'state.sqlite','native-seed.json')
 target=root/'control';target.mkdir()
 with sqlite3.connect(root/'state.sqlite') as source,sqlite3.connect(target/'state.sqlite') as dest:source.backup(dest)
 controls=subprocess.run(oracle+['continuation-maintenance-count-controls'],capture_output=True,text=True);(out/'bun-count-controls.json').write_text(json.dumps({'exit':controls.returncode,'stdout':controls.stdout,'stderr':controls.stderr},indent=2));assert controls.returncode==0,controls.stderr
 for case in json.loads(controls.stdout):
  assert case['directChanges']==case['count'] and case['restored']==case['count'] and case['repeated']=={'sessions':0}
  assert case['repaired']['sessions']==case['totalDelta']==case['count']*(2 if case['projection'] else 1)
 r=native('continuation-maintenance-contract',root/'state.sqlite','native.json')
 assert r['backfilled']==1 and r['repeatBackfill']==0 and r['repaired']['sessions']==2 and r['repeatRepair']['sessions']==0
 assert r['session']['continuation']=={'key':'newest-provider','provider':'fixture'}
 assert r['reuseDisabled'] is True and r['hasBarrier'] is True
 b=subprocess.run(['bun',str(pathlib.Path(__file__).with_name('oracle.ts')),a.release,str(target),'continuation-maintenance-control'],capture_output=True,text=True);(out/'unchanged-bun.json').write_text(json.dumps({'exit':b.returncode,'stdout':b.stdout,'stderr':b.stderr},indent=2));assert b.returncode==0,b.stderr
 assert json.loads(b.stdout)==r

 for case in json.loads(controls.stdout):
  case_root=root/f"case-{case['count']}-{case['projection']}";case_root.mkdir()
  with sqlite3.connect(target/'state.sqlite') as source,sqlite3.connect(case_root/'state.sqlite') as dest:source.backup(dest)
  setup=subprocess.run(['bun',str(pathlib.Path(__file__).with_name('oracle.ts')),a.release,str(case_root),'continuation-maintenance-count-seed',str(case['count']),str(case['projection']).lower()],capture_output=True,text=True)
  (out/f"setup-{case['count']}-{case['projection']}.json").write_text(json.dumps({'exit':setup.returncode,'stdout':setup.stdout,'stderr':setup.stderr},indent=2));assert setup.returncode==0,setup.stderr
  observed=native('continuation-maintenance-repair-only',case_root/'state.sqlite',f"native-{case['count']}-{case['projection']}.json")
  assert observed=={'repaired':case['repaired'],'repeated':case['repeated']}
