#!/usr/bin/env python3
"""Staged durable outbox lifecycle with real stored envelope and terminal/replay fences."""
import argparse,json,pathlib,subprocess,tempfile,os
p=argparse.ArgumentParser();p.add_argument('--binary',required=True);p.add_argument('--release',required=True);p.add_argument('--artifacts',required=True);a=p.parse_args();out=pathlib.Path(a.artifacts);out.mkdir(parents=True,exist_ok=True)
with tempfile.TemporaryDirectory(prefix='hrcp1-outbox-',dir='/tmp') as root:
    oracle=['bun',str(pathlib.Path(__file__).with_name('oracle.ts')),a.release,root]
    seed=subprocess.run(oracle+['seed'],capture_output=True,text=True);assert seed.returncode==0,seed.stderr
    n=subprocess.run([a.binary,'outbox-contract','--db',str(pathlib.Path(root)/'state.sqlite')],capture_output=True,text=True,env={**os.environ,'PATH':'/usr/bin:/bin','HRC_SOCKET_PATH':str(pathlib.Path(root)/'absent.sock')})
    (out/'native.json').write_text(json.dumps({'exit':n.returncode,'stdout':n.stdout,'stderr':n.stderr},indent=2));assert n.returncode==0,n.stdout+n.stderr
    r=json.loads(n.stdout);assert r['initial']['stage']=='establishing' and r['advanced']['stage']=='delivering'
    assert r['retry']['totalAttempts']==1 and r['retry']['lastError']['retryable'] is True
    assert r['dead']['totalAttempts']==2 and 'lastError' not in r['dead']
    assert r['replay']['cycleAttempts']==0 and r['replay']['replayCount']==1 and r['replay']['totalAttempts']==2
    assert r['cancelled']['totalAttempts']==2 and r['cancelled']['lastError']['code']=='operator_cancelled'
    assert r['dropped']==r['cancelled'] and r['afterDrop'] is None
    assert r['terminalRefused'] is True and r['delivered']['state']=='delivered' and r['due']==[]
    bun=subprocess.run(oracle+['outbox-read'],capture_output=True,text=True);(out/'unchanged-bun.json').write_text(json.dumps({'exit':bun.returncode,'stdout':bun.stdout,'stderr':bun.stderr},indent=2));assert bun.returncode==0,bun.stderr
    assert json.loads(bun.stdout)==[r['delivered']]
