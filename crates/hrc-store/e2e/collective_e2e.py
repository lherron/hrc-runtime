#!/usr/bin/env python3
"""Locale canonical selection, bounded topological history and independent Bun reconstruction."""
import argparse,json,pathlib,subprocess,tempfile,os
p=argparse.ArgumentParser();p.add_argument('--binary',required=True);p.add_argument('--release',required=True);p.add_argument('--artifacts',required=True);a=p.parse_args();out=pathlib.Path(a.artifacts);out.mkdir(parents=True,exist_ok=True)
with tempfile.TemporaryDirectory(prefix='hrcp1-collective-',dir='/tmp') as root:
    oracle=['bun',str(pathlib.Path(__file__).with_name('oracle.ts')),a.release,root]
    seed=subprocess.run(oracle+['seed'],capture_output=True,text=True);assert seed.returncode==0,seed.stderr
    n=subprocess.run([a.binary,'collective-contract','--db',str(pathlib.Path(root)/'state.sqlite')],capture_output=True,text=True,env={**os.environ,'PATH':'/usr/bin:/bin','HRC_SOCKET_PATH':str(pathlib.Path(root)/'absent.sock')})
    (out/'native.json').write_text(json.dumps({'exit':n.returncode,'stdout':n.stdout,'stderr':n.stderr},indent=2));assert n.returncode==0,n.stdout+n.stderr
    r=json.loads(n.stdout);assert r['canonical']['body']=='lowercase destination' and r['origin']['body']=='origin authoritative'
    assert r['originConflict'] is True and r['count']==5
    assert [x['messageId']for x in r['page']]==['p1-parent']
    assert [x['messageId']for x in r['reverse']]==list(reversed([x['messageId']for x in r['all']]))[:2]
    assert [x['messageId']for x in r['filtered']]==['p1-child']
    bun=subprocess.run(oracle+['collective-read'],capture_output=True,text=True);(out/'unchanged-bun.json').write_text(json.dumps({'exit':bun.returncode,'stdout':bun.stdout,'stderr':bun.stderr},indent=2));assert bun.returncode==0,bun.stderr
    assert json.loads(bun.stdout)=={k:r[k]for k in ['all','page','reverse','filtered']}

    fixture=out/'inputs.json';fixture.write_text(json.dumps(r['inputs']))
    with tempfile.TemporaryDirectory(prefix='hrcp1-collective-control-',dir='/tmp') as control_root:
        control=['bun',str(pathlib.Path(__file__).with_name('oracle.ts')),a.release,control_root]
        seed=subprocess.run(control+['seed'],capture_output=True,text=True);assert seed.returncode==0,seed.stderr
        b=subprocess.run(control+['collective-reconstruct'],capture_output=True,text=True,env={**os.environ,'P1_COLLECTIVE_INPUTS':str(fixture)})
        (out/'independent-bun.json').write_text(json.dumps({'exit':b.returncode,'stdout':b.stdout,'stderr':b.stderr},indent=2));assert b.returncode==0,b.stderr
        assert json.loads(b.stdout)=={k:r[k]for k in ['canonical','origin','originConflict','count','all','page','reverse','filtered']}
