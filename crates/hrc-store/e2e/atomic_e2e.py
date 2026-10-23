#!/usr/bin/env python3
"""Native transaction, guard and blob failure expectations, before implementation."""
import argparse
import json
import pathlib
import subprocess
import tempfile

p = argparse.ArgumentParser()
p.add_argument('--binary', required=True)
p.add_argument('--release', required=True)
p.add_argument('--artifacts', required=True)
a = p.parse_args()
out = pathlib.Path(a.artifacts)
out.mkdir(parents=True,exist_ok=True)
with tempfile.TemporaryDirectory(prefix='hrcp1-atomic-', dir='/tmp') as root:
    seed = subprocess.run(['bun',str(pathlib.Path(__file__).with_name('oracle.ts')),a.release,root,'seed'],capture_output=True,text=True)
    (out/'bun-seed.json').write_text(json.dumps({'stdout':seed.stdout,'stderr':seed.stderr,'exit':seed.returncode},indent=2))
    assert seed.returncode == 0
    r = subprocess.run([a.binary,'atomic-contract','--db',str(pathlib.Path(root)/'state.sqlite')],capture_output=True,text=True)
    (out/'native-atomic.json').write_text(json.dumps({'stdout':r.stdout,'stderr':r.stderr,'exit':r.returncode},indent=2))
    assert r.returncode == 0, r.stdout+r.stderr
    result=json.loads(r.stdout)
    for key in ['outerRollback','savepointRollback','commitHintsOnly','observerFailureIsolated','spillHydration','blobPartsValidated','readOnlyRefusal']:
        assert result.get(key) is True,(key,result)
    observations=result['observations']
    assert observations.get('partBoundaries'), 'missing raw part refusal boundaries'
    boundaries={item['stage']:item['state']for item in observations['partBoundaries']}
    assert boundaries['beforePart']['parts']==[] and boundaries['beforePart']['blob']is None
    assert len(boundaries['afterFirstPart']['parts'])==1
    assert boundaries['afterFirstPart']==boundaries['withinCaughtInvalidPart']==boundaries['afterInvalidPart']
    assert boundaries['afterCompletePart']['parts']==[] and boundaries['afterCompletePart']['blob']['resultJson']=='{"a":1}'
    assert observations['readOnlyBefore']==observations['readOnlyAfter']
    bun_root=pathlib.Path(root)/'parts-control';bun_root.mkdir()
    command=['bun',str(pathlib.Path(__file__).with_name('oracle.ts')),a.release,str(bun_root),'seed']
    seeded=subprocess.run(command,capture_output=True,text=True);assert seeded.returncode==0,seeded.stderr
    command=['bun',str(pathlib.Path(__file__).with_name('blob_part_control.ts')),a.release,str(bun_root)]
    control=subprocess.run(command,capture_output=True,text=True)
    (out/'bun-parts.json').write_text(json.dumps({'command':command,'exit':control.returncode,'stdout':control.stdout,'stderr':control.stderr},indent=2));assert control.returncode==0,control.stderr
    bun_parts=json.loads(control.stdout)
    assert bun_parts['initial']==observations['initialPartOutcome'] and bun_parts['complete']==observations['completePartOutcome']
    assert bun_parts['error']['message']==observations['invalidPartError']['cause']
    def normalize(value):
        if isinstance(value,list):return [normalize(v)for v in value]
        if not isinstance(value,dict):return value
        return {key:normalize(v)for key,v in value.items()if key not in ('rowid','createdAt')}
    assert normalize(bun_parts['boundaries'])==normalize(observations['partBoundaries'])
    (out/'summary.json').write_text(json.dumps({'claim':'p1-source-subset','complete':True,'result':result},indent=2))
