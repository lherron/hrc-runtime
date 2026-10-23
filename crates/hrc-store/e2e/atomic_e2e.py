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
    (out/'summary.json').write_text(json.dumps({'claim':'p1-source-subset','complete':True,'result':result},indent=2))
