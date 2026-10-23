#!/usr/bin/env python3
"""Real watch CAS and contribution write-ahead recovery, no runtime actuation."""
import argparse,json,pathlib,subprocess,tempfile,os,sqlite3
p=argparse.ArgumentParser();p.add_argument('--binary',required=True);p.add_argument('--release',required=True);p.add_argument('--artifacts',required=True);a=p.parse_args();out=pathlib.Path(a.artifacts);out.mkdir(parents=True,exist_ok=True)
with tempfile.TemporaryDirectory(prefix='hrcp1-recovery-',dir='/tmp') as root:
    seed=subprocess.run(['bun',str(pathlib.Path(__file__).with_name('oracle.ts')),a.release,root,'seed'],capture_output=True,text=True)
    (out/'seed.json').write_text(json.dumps({'exit':seed.returncode,'stdout':seed.stdout,'stderr':seed.stderr},indent=2));assert seed.returncode==0,seed.stderr
    native=subprocess.run([a.binary,'recovery-contract','--db',str(pathlib.Path(root)/'state.sqlite')],capture_output=True,text=True,env={**os.environ,'PATH':'/usr/bin:/bin','HRC_SOCKET_PATH':str(pathlib.Path(root)/'absent.sock')})
    (out/'native.json').write_text(json.dumps({'exit':native.returncode,'stdout':native.stdout,'stderr':native.stderr},indent=2));assert native.returncode==0,native.stdout+native.stderr
    r=json.loads(native.stdout)
    assert r['armRepeat'] is None and r['tripRepeat'] is False and r['lateFirstTurn'] is True
    assert [x['generation'] for x in r['due']]==[1]
    assert r['trip']['firstTurnAt']=='2026-10-23T00:03:00.000Z'
    assert r['trip']['tripEventSeq']==3 and r['trip']['diagnosticsEventSeq']==5
    assert r['trip']['bundleDir']=='/scratch/opaque-pointer'
    assert r['cleared'].get('bundleDir') is None
    assert r['orphanCount']==1 and r['orphansAfter']==[]
    assert r['sealed']['state']=='ambiguous' and r['sealed']['outcomeCode']=='urgent_delivery_ambiguous'
    assert r['sealedPointerChanged'] is False and r['sealed']['activeRunId']=='p1-rerouted'
    with sqlite3.connect(pathlib.Path(root)/'state.sqlite') as db:
        db.row_factory=sqlite3.Row
        raw={t:[dict(x) for x in db.execute('SELECT * FROM '+t)] for t in ['runtime_first_turn_watch','steer_contributions']}
    (out/'raw.json').write_text(json.dumps(raw,indent=2))
    assert len(raw['runtime_first_turn_watch'])==2
    assert raw['steer_contributions'][0]['state']=='ambiguous'
    bun=subprocess.run(['bun',str(pathlib.Path(__file__).with_name('oracle.ts')),a.release,root,'recovery-read'],capture_output=True,text=True)
    (out/'unchanged-bun.json').write_text(json.dumps({'exit':bun.returncode,'stdout':bun.stdout,'stderr':bun.stderr},indent=2));assert bun.returncode==0,bun.stderr
    observed=json.loads(bun.stdout)
    assert observed['watch']==r['cleared'] and observed['contribution']==r['sealed']
