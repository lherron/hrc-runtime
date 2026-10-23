#!/usr/bin/env python3
"""Existing-only guard, compatible extra objects, passive reads, contention and crash recovery."""
import argparse,json,pathlib,subprocess,tempfile,os,sqlite3,hashlib,time
p=argparse.ArgumentParser();p.add_argument('--binary',required=True);p.add_argument('--release',required=True);p.add_argument('--artifacts',required=True);a=p.parse_args();out=pathlib.Path(a.artifacts);out.mkdir(parents=True,exist_ok=True)
with tempfile.TemporaryDirectory(prefix='hrcp1-guards-',dir='/tmp') as root:
    root=pathlib.Path(root);dbpath=root/'state.sqlite';env={**os.environ,'PATH':'/usr/bin:/bin','HRC_SOCKET_PATH':str(root/'absent.sock')};results=[]
    def native(command,path=dbpath,*extra):
        argv=[a.binary,command,'--db',str(path),*extra];r=subprocess.run(argv,capture_output=True,text=True,env=env);results.append({'argv':argv,'exit':r.returncode,'stdout':r.stdout,'stderr':r.stderr});(out/'commands.json').write_text(json.dumps(results,indent=2));return r,json.loads(r.stdout) if r.stdout.strip() else None
    seed=subprocess.run(['bun',str(pathlib.Path(__file__).with_name('oracle.ts')),a.release,str(root),'seed'],capture_output=True,text=True);(out/'seed.json').write_text(json.dumps({'exit':seed.returncode,'stdout':seed.stdout,'stderr':seed.stderr},indent=2));assert seed.returncode==0,seed.stderr
    r,j=native('inspect',root/'missing.sqlite');assert r.returncode!=0 and j['error']['code']=='store_not_found' and not (root/'missing.sqlite').exists()
    def fork(name):
        path=root/(name+'.sqlite')
        with sqlite3.connect(dbpath) as source,sqlite3.connect(path) as target:source.backup(target)
        return path
    unknown=fork('unknown')
    with sqlite3.connect(unknown) as db:db.execute("INSERT INTO hrc_migrations(id,applied_at) VALUES('9999_future','fixture')")
    r,j=native('inspect',unknown);assert r.returncode!=0 and j['error']['code']=='store_schema_unknown'
    behind=fork('behind')
    with sqlite3.connect(behind) as db:db.execute("DELETE FROM hrc_migrations WHERE id=(SELECT id FROM hrc_migrations ORDER BY id DESC LIMIT 1)")
    r,j=native('inspect',behind);assert r.returncode!=0 and j['error']['code']=='store_schema_behind'
    compatible=fork('compatible')
    with sqlite3.connect(compatible) as db:db.execute('CREATE INDEX fixture_compatible_extra_index ON hrc_events(ts)')
    r,j=native('page',compatible);assert r.returncode==0 and len(j['rows'])==2
    def image():return {p.name:{'bytes':p.stat().st_size,'mtimeNs':p.stat().st_mtime_ns,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()} for p in root.glob('state.sqlite*')}
    before=image()
    r,page=native('page');assert r.returncode==0
    r,head=native('inspect');assert r.returncode==0
    after=image();(out/'passive-files.json').write_text(json.dumps({'before':before,'after':after},indent=2));assert before['state.sqlite']==after['state.sqlite'];assert after.get('state.sqlite-wal',{}).get('bytes',0)==0
    start=time.monotonic()
    with sqlite3.connect(dbpath) as locked:
        locked.execute('BEGIN IMMEDIATE')
        r,j=native('session-contract');assert r.returncode!=0 and j['error']['code']=='store_busy'
        locked.rollback()
    assert time.monotonic()-start<12
    # Real mutation control: after a completed native read, canonical Bun writes another fact.
    control=subprocess.run(['bun',str(pathlib.Path(__file__).with_name('oracle.ts')),a.release,str(root),'append-control'],capture_output=True,text=True)
    (out/'bun-mutation.json').write_text(json.dumps({'exit':control.returncode,'stdout':control.stdout,'stderr':control.stderr},indent=2));assert control.returncode==0,control.stderr
    r,new=native('page');assert r.returncode==0 and len(new['rows'])==len(page['rows'])+1 and new['head']>page['head']
    r,j=native('crash-contract',dbpath,'--phase','before');assert r.returncode==70,(r.returncode,j)
    r,rolled=native('page');assert r.returncode==0 and rolled==new
    r,j=native('crash-contract',dbpath,'--phase','after');assert r.returncode==71,(r.returncode,j)
    r,committed=native('page');assert r.returncode==0 and len(committed['rows'])==len(new['rows'])+1
