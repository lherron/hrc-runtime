#!/usr/bin/env python3
"""Lazy node placement and separate existing-only registry, no authority service."""
import argparse,json,pathlib,subprocess,tempfile,os,sqlite3
p=argparse.ArgumentParser();p.add_argument('--binary',required=True);p.add_argument('--release',required=True);p.add_argument('--artifacts',required=True);a=p.parse_args();out=pathlib.Path(a.artifacts);out.mkdir(parents=True,exist_ok=True)
with tempfile.TemporaryDirectory(prefix='hrcp1-placement-',dir='/tmp') as root:
    root=pathlib.Path(root);env={**os.environ,'PATH':'/usr/bin:/bin','HRC_SOCKET_PATH':str(root/'absent.sock')}
    def run(argv,name,native=False):
        r=subprocess.run(argv,capture_output=True,text=True,env=env if native else None);(out/(name+'.json')).write_text(json.dumps({'argv':argv,'exit':r.returncode,'stdout':r.stdout,'stderr':r.stderr},indent=2));assert r.returncode==0,r.stdout+r.stderr;return json.loads(r.stdout)
    oracle=['bun',str(pathlib.Path(__file__).with_name('oracle.ts')),a.release,str(root)]
    run(oracle+['seed'],'seed')
    absent=run([a.binary,'placement-absent-contract','--db',str(root/'state.sqlite')],'absent',True)
    assert absent['rows']==[] and absent['writeRefused'] is True and absent['missingRegistryRefused'] is True
    with sqlite3.connect(root/'state.sqlite') as db:assert db.execute("SELECT count(*) FROM sqlite_schema WHERE name='placement_ledger'").fetchone()[0]==0
    run(oracle+['placement'],'canonical-lazy-factory')
    run(oracle+['registry-init'],'canonical-registry-factory')
    observed=run([a.binary,'placement-registry-contract','--db',str(root/'state.sqlite'),'--registry',str(root/'registry.sqlite')],'native',True)
    assert observed['retireWrong']['outcome']=='conflict' and observed['retired']['outcome']=='retired' and observed['retireRepeat']['outcome']=='idempotent'
    assert observed['installRetiredRefused'] is True and observed['designationMismatch']['outcome']=='designation-mismatch'
    assert observed['created']['outcome']=='created' and observed['repeat']['outcome']=='existing'
    assert observed['deleted']['outcome']=='deleted' and observed['deleteRepeat']['outcome']=='idempotent'
    assert observed['retiredHome']=='p1-node-b' and observed['latest']['designationEpoch']==2
    assert [d['state'] for d in observed['history']]==['superseded','live']
    bun=run(oracle+['placement-read'],'unchanged-bun')
    assert bun['placement']==observed['placement'] and bun['records']==observed['records'] and bun['history']==observed['history']
