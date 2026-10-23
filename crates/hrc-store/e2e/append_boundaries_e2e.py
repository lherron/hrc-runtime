#!/usr/bin/env python3
"""Caught repository error must not leak cursor/row into a successful outer transaction."""
import argparse,json,pathlib,subprocess,tempfile,os
p=argparse.ArgumentParser();p.add_argument('--binary',required=True);p.add_argument('--release',required=True);p.add_argument('--artifacts',required=True);a=p.parse_args();out=pathlib.Path(a.artifacts);out.mkdir(parents=True,exist_ok=True)
with tempfile.TemporaryDirectory(prefix='hrcp1-append-boundary-',dir='/tmp') as root:
 oracle=['bun',str(pathlib.Path(__file__).with_name('oracle.ts')),a.release,root]
 seed=subprocess.run(oracle+['seed'],capture_output=True,text=True);assert seed.returncode==0,seed.stderr
 native=subprocess.run([a.binary,'append-boundary-contract','--db',str(pathlib.Path(root)/'state.sqlite')],capture_output=True,text=True,env={**os.environ,'PATH':'/usr/bin:/bin','HRC_SOCKET_PATH':str(pathlib.Path(root)/'absent.sock')})
 (out/'native.json').write_text(json.dumps({'exit':native.returncode,'stdout':native.stdout,'stderr':native.stderr},indent=2));assert native.returncode==0,native.stdout+native.stderr
 r=json.loads(native.stdout);assert r['rejected'] is True
 assert r['before']==r['afterCaught'],'caught append leaked row/cursor'
 assert r['withinCaught']['head']==r['afterCommit']['head']+1 and r['callerRolledBack'] is True
 assert r['afterRollback']==r['afterCommit']
 assert r['afterCommit']['head']==r['before']['head']+1 and len(r['afterCommit']['rows'])==len(r['before']['rows'])+1
 with tempfile.TemporaryDirectory(prefix='hrcp1-append-control-',dir='/tmp') as control_root:
  control=['bun',str(pathlib.Path(__file__).with_name('oracle.ts')),a.release,control_root]
  s=subprocess.run(control+['seed'],capture_output=True,text=True);assert s.returncode==0,s.stderr
  b=subprocess.run(control+['append-boundary-control'],capture_output=True,text=True);(out/'independent-bun.json').write_text(json.dumps({'exit':b.returncode,'stdout':b.stdout,'stderr':b.stderr},indent=2));assert b.returncode==0,b.stderr
  expected=json.loads(b.stdout)
  for value in [r,expected]:
   for key in ['before','afterCaught','afterCommit','withinCaught','afterRollback']:value[key].pop('ledgerIncarnationId')
  assert r==expected
