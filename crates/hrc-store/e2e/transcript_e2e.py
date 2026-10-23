#!/usr/bin/env python3
"""Real external-content FTS behavior must match unchanged Bun reads."""
import argparse,json,pathlib,subprocess,tempfile
p=argparse.ArgumentParser();p.add_argument('--binary',required=True);p.add_argument('--release',required=True);p.add_argument('--artifacts',required=True);a=p.parse_args()
out=pathlib.Path(a.artifacts);out.mkdir(parents=True,exist_ok=True)
with tempfile.TemporaryDirectory(prefix='hrcp1-fts-',dir='/tmp') as root:
    seed=subprocess.run(['bun',str(pathlib.Path(__file__).with_name('oracle.ts')),a.release,root,'seed'],capture_output=True,text=True);assert seed.returncode==0,seed.stderr
    r=subprocess.run([a.binary,'transcript-contract','--db',str(pathlib.Path(root)/'state.sqlite')],capture_output=True,text=True)
    (out/'native.json').write_text(json.dumps({'exit':r.returncode,'stdout':r.stdout,'stderr':r.stderr},indent=2));assert r.returncode==0,r.stdout+r.stderr
    result=json.loads(r.stdout)
    for key in ['ftsInsertUpdateDelete','ftsRollback','unicodeTokenizer','perRuntimeCap','invalidWeights','cursorAndMark']:
        assert result.get(key) is True,(key,result)
    r=subprocess.run(['bun',str(pathlib.Path(__file__).with_name('oracle.ts')),a.release,root,'transcript-read'],capture_output=True,text=True)
    (out/'bun-read.json').write_text(json.dumps({'exit':r.returncode,'stdout':r.stdout,'stderr':r.stderr},indent=2));assert r.returncode==0,r.stderr
    bun=json.loads(r.stdout);assert bun['stats']['turnsIndexed']==2 and len(bun['hits'])==2,bun
