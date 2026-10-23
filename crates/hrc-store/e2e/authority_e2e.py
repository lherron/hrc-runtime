#!/usr/bin/env python3
"""Bounded broker authority and explicit run recovery CAS, no execution owner."""
import argparse,json,pathlib,subprocess,tempfile,os
p=argparse.ArgumentParser();p.add_argument('--binary',required=True);p.add_argument('--release',required=True);p.add_argument('--artifacts',required=True);a=p.parse_args();out=pathlib.Path(a.artifacts);out.mkdir(parents=True,exist_ok=True)
with tempfile.TemporaryDirectory(prefix='hrcp1-authority-',dir='/tmp') as root:
    seed=subprocess.run(['bun',str(pathlib.Path(__file__).with_name('oracle.ts')),a.release,root,'seed'],capture_output=True,text=True)
    (out/'seed.json').write_text(json.dumps({'exit':seed.returncode,'stdout':seed.stdout,'stderr':seed.stderr},indent=2));assert seed.returncode==0,seed.stderr
    n=subprocess.run([a.binary,'authority-contract','--db',str(pathlib.Path(root)/'state.sqlite')],capture_output=True,text=True,env={**os.environ,'PATH':'/usr/bin:/bin','HRC_SOCKET_PATH':str(pathlib.Path(root)/'absent.sock')})
    (out/'native.json').write_text(json.dumps({'exit':n.returncode,'stdout':n.stdout,'stderr':n.stderr},indent=2));assert n.returncode==0,n.stdout+n.stderr
    r=json.loads(n.stdout)
    assert r['openBeforeCloser']==1 and r['openAfterWrongIdentity']==1 and r['openAfterCloser']==0
    assert r['startedAtInclusive']==1 and r['startedAfterTerminal']==0
    assert r['firstInput']['seq']==1 and r['inputAfterFence'] is None
    assert r['fenced']['runId']=='p1-accepted'
    assert r['recoverWrongCarrier'] is False and r['recoverExactCarrier'] is True
    assert r['terminal']['status']=='failed' and r['terminal']['completedAt'] is not None
    assert [x['runId'] for x in r['coldCandidates']]==['p1-cold']
    assert r['priorBoundary']['hrcSeq']<r['boundaryCut']
