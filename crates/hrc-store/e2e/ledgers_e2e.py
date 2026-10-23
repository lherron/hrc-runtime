#!/usr/bin/env python3
"""Lifecycle import, legacy/global sequences and monitor predicates."""
import argparse,json,pathlib,subprocess,tempfile,os
p=argparse.ArgumentParser();p.add_argument('--binary',required=True);p.add_argument('--release',required=True);p.add_argument('--artifacts',required=True);a=p.parse_args();out=pathlib.Path(a.artifacts);out.mkdir(parents=True,exist_ok=True)
with tempfile.TemporaryDirectory(prefix='hrcp1-ledgers-',dir='/tmp') as root:
    seed=subprocess.run(['bun',str(pathlib.Path(__file__).with_name('oracle.ts')),a.release,root,'seed'],capture_output=True,text=True)
    (out/'seed.json').write_text(json.dumps({'exit':seed.returncode,'stdout':seed.stdout,'stderr':seed.stderr},indent=2));assert seed.returncode==0,seed.stderr
    n=subprocess.run([a.binary,'ledgers-contract','--db',str(pathlib.Path(root)/'state.sqlite')],capture_output=True,text=True,env={**os.environ,'PATH':'/usr/bin:/bin','HRC_SOCKET_PATH':str(pathlib.Path(root)/'absent.sock')})
    (out/'native.json').write_text(json.dumps({'exit':n.returncode,'stdout':n.stdout,'stderr':n.stderr},indent=2));assert n.returncode==0,n.stdout+n.stderr
    r=json.loads(n.stdout)
    assert r['importRepeat'] is True and r['importConflict']=='imported_hrc_event_conflict'
    assert r['raw']['streamSeq']+1==r['lifecycle']['streamSeq']
    assert r['legacyCount']==1 and len(r['legacy'])==1
    assert len(r['monitorTool'])==1 and len(r['milestones'])==2
    assert len(r['taskWithChildren'])==2 and len(r['exactTask'])==1
    assert r['malformedAdmission'] is None and r['duplicateAdmission'] is None
    bun=subprocess.run(['bun',str(pathlib.Path(__file__).with_name('oracle.ts')),a.release,root,'ledgers-read'],capture_output=True,text=True)
    (out/'unchanged-bun.json').write_text(json.dumps({'exit':bun.returncode,'stdout':bun.stdout,'stderr':bun.stderr},indent=2));assert bun.returncode==0,bun.stderr
    observed=json.loads(bun.stdout);assert observed['legacy']==r['legacy'] and observed['filtered']==r['taskWithChildren']
