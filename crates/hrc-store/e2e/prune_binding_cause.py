#!/usr/bin/env python3
"""Bound trigger contribution for the exact CTE return operation and controls."""
import argparse,subprocess,tempfile,pathlib,json
p=argparse.ArgumentParser();p.add_argument('--release',required=True);p.add_argument('--artifacts',required=True);a=p.parse_args();src=pathlib.Path(__file__).parent;out=pathlib.Path(a.artifacts);out.mkdir(parents=True,exist_ok=True);rows=[]
for direct in ['cte','plain','simple']:
 for projection in [True,False]:
  for count in ([1] if direct=='simple' else [1,2]):
   with tempfile.TemporaryDirectory(prefix='hrcp1-cause-',dir='/tmp') as root:
    r=subprocess.run(['bun',str(src/'oracle.ts'),a.release,root,'seed'],capture_output=True,text=True);assert r.returncode==0,r.stderr
    cfg={'runs':[0]*count,'singular':False,'includeLedgers':True,'direct':direct,'removeProjection':not projection};f=pathlib.Path(root)/'case.json';f.write_text(json.dumps(cfg))
    r=subprocess.run(['bun',str(src/'prune_characterize.ts'),a.release,root,str(f)],capture_output=True,text=True);(out/f'{direct}-projection-{projection}-n{count}.json').write_text(json.dumps({'exit':r.returncode,'stdout':r.stdout,'stderr':r.stderr},indent=2));assert r.returncode==0,r.stderr
    x=json.loads(r.stdout);rows.append(x);assert x['afterCount']==0 and x['sqliteChanges']['value']==count
    assert x['result']['changes']==x['totalDelta'],x
(out/'observations.json').write_text(json.dumps(rows,indent=2));print(json.dumps({'cases':len(rows),'exactCteMatchesTotalDelta':True,'allTestedDeleteFormsIncludeTriggerChanges':True}))
