#!/usr/bin/env python3
"""Driver rejects an otherwise valid store outside admitted scratch and symlink escapes."""
import argparse,json,pathlib,subprocess,tempfile,os,sqlite3
p=argparse.ArgumentParser();p.add_argument('--binary',required=True);p.add_argument('--release',required=True);p.add_argument('--artifacts',required=True);a=p.parse_args();out=pathlib.Path(a.artifacts);out.mkdir(parents=True,exist_ok=True)
with tempfile.TemporaryDirectory(prefix='hrcp1-admission-',dir='/tmp') as root,tempfile.TemporaryDirectory(prefix='outside-p1-admission-',dir='/tmp') as outside:
    root=pathlib.Path(root);outside=pathlib.Path(outside);oracle=['bun',str(pathlib.Path(__file__).with_name('oracle.ts')),a.release,str(root)]
    seed=subprocess.run(oracle+['seed'],capture_output=True,text=True);assert seed.returncode==0,seed.stderr
    foreign=outside/'state.sqlite'
    with sqlite3.connect(root/'state.sqlite') as source,sqlite3.connect(foreign) as dest:source.backup(dest)
    (root/'escape.sqlite').symlink_to(foreign);rows=[]
    for path in [foreign,root/'escape.sqlite']:
        result=subprocess.run([a.binary,'inspect','--db',str(path)],capture_output=True,text=True);rows.append({'path':str(path),'exit':result.returncode,'stdout':result.stdout,'stderr':result.stderr})
    (out/'commands.json').write_text(json.dumps(rows,indent=2))
    assert all(r['exit']!=0 and json.loads(r['stdout'])['error']['code']=='malformed_request' and 'scratch admission' in r['stderr']for r in rows)
