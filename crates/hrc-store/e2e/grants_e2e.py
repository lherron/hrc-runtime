#!/usr/bin/env python3
"""Single-use grant CAS, capacity and mint rollback against canonical SQLite."""
import argparse,json,pathlib,subprocess,tempfile,os,sqlite3
p=argparse.ArgumentParser();p.add_argument('--binary',required=True);p.add_argument('--release',required=True);p.add_argument('--artifacts',required=True);a=p.parse_args();out=pathlib.Path(a.artifacts);out.mkdir(parents=True,exist_ok=True)
with tempfile.TemporaryDirectory(prefix='hrcp1-grants-',dir='/tmp') as root:
    seed=subprocess.run(['bun',str(pathlib.Path(__file__).with_name('oracle.ts')),a.release,root,'seed'],capture_output=True,text=True)
    (out/'seed.json').write_text(json.dumps({'exit':seed.returncode,'stdout':seed.stdout,'stderr':seed.stderr},indent=2));assert seed.returncode==0,seed.stderr
    n=subprocess.run([a.binary,'grants-contract','--db',str(pathlib.Path(root)/'state.sqlite')],capture_output=True,text=True,env={**os.environ,'PATH':'/usr/bin:/bin','HRC_SOCKET_PATH':str(pathlib.Path(root)/'absent.sock')})
    (out/'native.json').write_text(json.dumps({'exit':n.returncode,'stdout':n.stdout,'stderr':n.stderr},indent=2));assert n.returncode==0,n.stdout+n.stderr
    r=json.loads(n.stdout)
    assert r['occupiedBefore']==1 and r['denied']['outcome']=='instances-exhausted'
    assert r['rollback']['consumed'] is False and r['rollback'].get('establishmentState') is None
    assert r['consumeRepeat'] is False and r['establishRepeat'] is False
    assert r['occupiedExpiredConsumed']==1 and r['occupiedRetired']==0
    assert r['retired']['retirementReason']=='external_registration_gc' and r['retireRepeat'] is True
    assert len(r['minted'])==1 and r['rendezvousAfterRetire']==[]
    assert r['controllerUpdated'] is True and r['retired']['controllerInstanceId']=='p1-controller-next'
    with sqlite3.connect(pathlib.Path(root)/'state.sqlite') as db:
        db.row_factory=sqlite3.Row;raw=[dict(x) for x in db.execute('SELECT * FROM external_registration_grants')]
    (out/'raw.json').write_text(json.dumps(raw,indent=2));assert len(raw)==2
    bun=subprocess.run(['bun',str(pathlib.Path(__file__).with_name('oracle.ts')),a.release,root,'grants-read'],capture_output=True,text=True)
    (out/'unchanged-bun.json').write_text(json.dumps({'exit':bun.returncode,'stdout':bun.stdout,'stderr':bun.stderr},indent=2));assert bun.returncode==0,bun.stderr
    assert json.loads(bun.stdout)['grant']==r['retired']
