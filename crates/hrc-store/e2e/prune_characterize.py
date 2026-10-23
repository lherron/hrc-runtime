#!/usr/bin/env python3
"""Record bounded canonical Bun result semantics; no inference from count labels."""
import argparse,json,pathlib,tempfile,subprocess
p=argparse.ArgumentParser();p.add_argument('--release',required=True);p.add_argument('--artifacts',required=True);a=p.parse_args();out=pathlib.Path(a.artifacts);out.mkdir(parents=True,exist_ok=True);results=[]
for ledgers in [False,True]:
 for singular in [False,True]:
  for counts in ([[0],[1],[2],[4]] if singular else [[0],[1],[2],[4],[0,0],[0,2],[1,2],[3,4]]):
   name=('full' if ledgers else 'minimal')+('-single-' if singular else '-batch-')+'-'.join(map(str,counts))
   with tempfile.TemporaryDirectory(prefix='hrcp1-prunechar-',dir='/tmp') as root:
    seed=subprocess.run(['bun',str(pathlib.Path(__file__).with_name('oracle.ts')),a.release,root,'seed'],capture_output=True,text=True);assert seed.returncode==0,seed.stderr
    config=pathlib.Path(root)/'case.json';config.write_text(json.dumps({'runs':counts,'singular':singular,'includeLedgers':ledgers}))
    argv=['bun',str(pathlib.Path(__file__).with_name('prune_characterize.ts')),a.release,root,str(config)]
    r=subprocess.run(argv,capture_output=True,text=True);(out/(name+'.json')).write_text(json.dumps({'argv':argv,'exit':r.returncode,'stdout':r.stdout,'stderr':r.stderr},indent=2));assert r.returncode==0,r.stderr
    row=json.loads(r.stdout);results.append(row)
    assert row['afterCount']==0 and row['sqliteChanges']['value']==(len(counts) if ledgers else 1)
(out/'observations.json').write_text(json.dumps(results,indent=2))
for r in results:
 expected=(2*len(r['ids'])==1 if r['config']['singular'] else 2*len(r['ids'])) if r['config']['includeLedgers'] else (True if r['config']['singular'] else len(r['ids']))
 assert r['result']==expected,r
print(json.dumps({'observations':len(results),'fullResultIncludesCanonicalRuntimeTriggerChanges':True,'minimalResultEqualsRuntimeDeletes':True}))
