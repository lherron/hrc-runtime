#!/usr/bin/env python3
"""Write-ahead intent, receipt/reminder fences and replay replacement, native then Bun."""
import argparse,json,pathlib,subprocess,tempfile,os
p=argparse.ArgumentParser();p.add_argument('--binary',required=True);p.add_argument('--release',required=True);p.add_argument('--artifacts',required=True);a=p.parse_args();out=pathlib.Path(a.artifacts);out.mkdir(parents=True,exist_ok=True)
with tempfile.TemporaryDirectory(prefix='hrcp1-mail-delivery-',dir='/tmp') as root:
    oracle=['bun',str(pathlib.Path(__file__).with_name('oracle.ts')),a.release,root]
    seed=subprocess.run(oracle+['seed'],capture_output=True,text=True);assert seed.returncode==0,seed.stderr
    n=subprocess.run([a.binary,'mail-delivery-contract','--db',str(pathlib.Path(root)/'state.sqlite')],capture_output=True,text=True,env={**os.environ,'PATH':'/usr/bin:/bin','HRC_SOCKET_PATH':str(pathlib.Path(root)/'absent.sock')})
    (out/'native.json').write_text(json.dumps({'exit':n.returncode,'stdout':n.stdout,'stderr':n.stderr},indent=2));assert n.returncode==0,n.stdout+n.stderr
    r=json.loads(n.stdout)
    assert r['duplicateIntent'] is None and r['terminalActive']==[]
    assert r['uncertainFirst']==r['uncertainRepeat'] and r['cleanup']=='first'
    assert r['beforeReceipt']==[] and r['armBeforeReceipt'] is False
    assert r['receiptCommitted'] and r['armAfterReceipt'] and not r['armRepeat']
    assert len(r['due'])==1 and r['reminderLanding']==[True,False]
    assert r['disposition']==[True,False] and r['replay']['recorded'] is False
    latest=r['latest']['presentation'];assert r['latest']['recorded'] is True and latest['landingHrcSeq']==11
    assert all(k not in latest for k in ['receiptCommittedAt','reminderArmedAt','reminderDueAt','disposedAt','disposition','reminderLandingHrcSeq'])
    assert [x['reason']for x in r['hints']]==['no_outstanding_mail','first','cadence','periodic','count_changed','no_outstanding_mail']
    bun=subprocess.run(oracle+['mail-delivery-read'],capture_output=True,text=True);(out/'unchanged-bun.json').write_text(json.dumps({'exit':bun.returncode,'stdout':bun.stdout,'stderr':bun.stderr},indent=2));assert bun.returncode==0,bun.stderr
    b=json.loads(bun.stdout);assert b['intent']==r['intent'] and b['presentation']==latest
