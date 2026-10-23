#!/usr/bin/env python3
"""Pending/response/ambiguous delivery persistence without harness delivery."""
import argparse,json,pathlib,subprocess,tempfile,os
p=argparse.ArgumentParser();p.add_argument('--binary',required=True);p.add_argument('--release',required=True);p.add_argument('--artifacts',required=True);a=p.parse_args();out=pathlib.Path(a.artifacts);out.mkdir(parents=True,exist_ok=True)
with tempfile.TemporaryDirectory(prefix='hrcp1-active-',dir='/tmp') as root:
    seed=subprocess.run(['bun',str(pathlib.Path(__file__).with_name('oracle.ts')),a.release,root,'seed'],capture_output=True,text=True);assert seed.returncode==0,seed.stderr
    n=subprocess.run([a.binary,'active-delivery-contract','--db',str(pathlib.Path(root)/'state.sqlite')],capture_output=True,text=True,env={**os.environ,'PATH':'/usr/bin:/bin','HRC_SOCKET_PATH':str(pathlib.Path(root)/'absent.sock')})
    (out/'native.json').write_text(json.dumps({'exit':n.returncode,'stdout':n.stdout,'stderr':n.stderr},indent=2));assert n.returncode==0,n.stdout+n.stderr
    r=json.loads(n.stdout)
    assert r['pending']['status']=='pending' and r['pending']['request']['prompt']=='fixture only'
    assert r['accepted']['status']=='accepted' and r['accepted']['runId']=='p1-run'
    assert r['ambiguous']['status']=='ambiguous' and r['ambiguous']['response']['status']=='accepted'
    assert r['failed']['status']=='failed' and r['failed']['errorCode']=='controlled-failure'
    assert r['rejected']['status']=='rejected' and r['rejected'].get('runId') is None
    bun=subprocess.run(['bun',str(pathlib.Path(__file__).with_name('oracle.ts')),a.release,root,'active-read'],capture_output=True,text=True)
    (out/'unchanged-bun.json').write_text(json.dumps({'exit':bun.returncode,'stdout':bun.stdout,'stderr':bun.stderr},indent=2));assert bun.returncode==0,bun.stderr
    assert json.loads(bun.stdout)==r['rejected']
