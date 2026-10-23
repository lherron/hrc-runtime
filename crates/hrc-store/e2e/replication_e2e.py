#!/usr/bin/env python3
"""Exact JSON fingerprints fence stale delivery acknowledgements and retry resets."""
import argparse,json,pathlib,subprocess,tempfile,os
p=argparse.ArgumentParser();p.add_argument('--binary',required=True);p.add_argument('--release',required=True);p.add_argument('--artifacts',required=True);a=p.parse_args();out=pathlib.Path(a.artifacts);out.mkdir(parents=True,exist_ok=True)
with tempfile.TemporaryDirectory(prefix='hrcp1-replication-',dir='/tmp') as root:
    oracle=['bun',str(pathlib.Path(__file__).with_name('oracle.ts')),a.release,root]
    seed=subprocess.run(oracle+['seed'],capture_output=True,text=True);assert seed.returncode==0,seed.stderr
    n=subprocess.run([a.binary,'replication-contract','--db',str(pathlib.Path(root)/'state.sqlite')],capture_output=True,text=True,env={**os.environ,'PATH':'/usr/bin:/bin','HRC_SOCKET_PATH':str(pathlib.Path(root)/'absent.sock')})
    (out/'native.json').write_text(json.dumps({'exit':n.returncode,'stdout':n.stdout,'stderr':n.stderr},indent=2));assert n.returncode==0,n.stdout+n.stderr
    r=json.loads(n.stdout);assert r['retry'] and r['staleDelivered'] is False and r['delivered'] is True
    assert r['afterDuplicate']==r['retried'] and r['retried'][0]['totalAttempts']==1
    assert r['reset'][0]['totalAttempts']==0 and r['first'][0]['fingerprint']!=r['reset'][0]['fingerprint']
    assert r['pending']==0 and r['due']==[]
    bun=subprocess.run(oracle+['replication-read'],capture_output=True,text=True);(out/'unchanged-bun.json').write_text(json.dumps({'exit':bun.returncode,'stdout':bun.stdout,'stderr':bun.stderr},indent=2));assert bun.returncode==0,bun.stderr
    b=json.loads(bun.stdout);assert b['pending']==0 and b['due']==[] and b['fingerprint']==r['reset'][0]['fingerprint']
