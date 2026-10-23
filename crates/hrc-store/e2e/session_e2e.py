#!/usr/bin/env python3
"""Bun/native lineage, title facade and transaction expectations, before port."""
import argparse,json,pathlib,subprocess,tempfile
p=argparse.ArgumentParser();p.add_argument('--binary',required=True);p.add_argument('--release',required=True);p.add_argument('--artifacts',required=True);a=p.parse_args()
out=pathlib.Path(a.artifacts);out.mkdir(parents=True,exist_ok=True)
with tempfile.TemporaryDirectory(prefix='hrcp1-session-',dir='/tmp') as root:
    r=subprocess.run(['bun',str(pathlib.Path(__file__).with_name('oracle.ts')),a.release,root,'seed'],capture_output=True,text=True)
    assert r.returncode==0,r.stderr
    r=subprocess.run([a.binary,'session-contract','--db',str(pathlib.Path(root)/'state.sqlite')],capture_output=True,text=True)
    (out/'native.json').write_text(json.dumps({'exit':r.returncode,'stdout':r.stdout,'stderr':r.stderr},indent=2))
    assert r.returncode==0,r.stdout+r.stderr
    data=json.loads(r.stdout)
    for k in ['lineage','continuationReuseReset','metadataPrecedence','titleContinuityFacade','metadataRollback','cursorMonotonic']:
        assert data.get(k) is True,(k,data)
    r=subprocess.run(['bun',str(pathlib.Path(__file__).with_name('oracle.ts')),a.release,root,'read'],capture_output=True,text=True)
    (out/'bun-readback.json').write_text(json.dumps({'exit':r.returncode,'stdout':r.stdout,'stderr':r.stderr},indent=2))
    assert r.returncode==0,r.stderr
    assert len(json.loads(r.stdout)['sessions'])==2
