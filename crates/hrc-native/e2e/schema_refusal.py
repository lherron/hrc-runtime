#!/usr/bin/env python3
"""Gate3: schema refusal preserves canonical DB and control files.

CLI usage and SQLite's SHM index are expected observational writes (EN-35424).
The main DB must remain byte/mtime identical, WAL gains no frames, and daemon
control files stay unchanged. Cases retain the complete before/after evidence
for both checkpointed WAL-header DBs and a live WAL containing the mismatch.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import socket
import stat
import subprocess


def snapshot(path):
    if not path.exists():return None
    if stat.S_ISSOCK(path.stat().st_mode):
        return {'kind':'socket','inode':path.stat().st_ino,'mtimeNs':path.stat().st_mtime_ns}
    data=path.read_bytes()
    return {'size':len(data),'mtimeNs':path.stat().st_mtime_ns,'sha256':hashlib.sha256(data).hexdigest()}


def main():
    p=argparse.ArgumentParser()
    for name in ('binary','scratch-root','artifacts'):p.add_argument('--'+name,type=Path,required=True)
    args=p.parse_args()
    root=args.scratch_root.absolute();assert not root.exists();root.mkdir(parents=True)
    args.artifacts.mkdir(parents=True,exist_ok=True)
    repo=Path(__file__).resolve().parents[3]
    env=dict(os.environ,HRC_STATE_DIR=str(root/'bootstrap-state'),HRC_RUNTIME_DIR=str(root/'bootstrap-run'))
    for key in ('HRC_METRICS','HRC_BUN_PASSTHROUGH_SOCKET'):env.pop(key,None)
    source=root/'source.sqlite'
    subprocess.run(['bun','-e','import {openHrcDatabase} from "./packages/hrc-store-sqlite/src/database.ts"; openHrcDatabase(process.argv[1]).close()',str(source)],cwd=repo,env=env,check=True,capture_output=True)
    observations=[]
    for mode in ('checkpointed','live-wal','checkpointed-owner'):
        for mismatch in ('extra','missing'):
            subject=root/(mode+'-'+mismatch);state=subject/'state';runtime=subject/'run'
            state.mkdir(parents=True);runtime.mkdir();dbpath=state/'state.sqlite'
            with sqlite3.connect(source) as original,sqlite3.connect(dbpath) as target:original.backup(target)
            writer=sqlite3.connect(dbpath)
            writer.execute('PRAGMA journal_mode=WAL')
            if mismatch=='extra':writer.execute("INSERT INTO hrc_migrations VALUES ('9999_unknown', 'now')")
            else:writer.execute('DELETE FROM hrc_migrations WHERE id=(SELECT MIN(id) FROM hrc_migrations)')
            writer.commit()
            if mode!='live-wal':writer.close()
            prior_owner=None
            if mode=='checkpointed-owner':
                (runtime/'server.lock').write_text('{"pid":999999999,"createdAt":"prior-owner"}\n')
                (runtime/'server.pid').write_text('999999999\n')
                prior_owner=socket.socket(socket.AF_UNIX);prior_owner.bind(str(runtime/'hrc.sock'));prior_owner.listen(1)
            protected=[state/'state.sqlite',state/'state.sqlite-wal',state/'state.sqlite-shm',runtime/'hrc.sock',runtime/'server.lock',runtime/'server.pid']
            before={str(p.relative_to(subject)):snapshot(p) for p in protected}
            result=subprocess.run([str(args.binary.resolve()),'server'],env=dict(env,HRC_STATE_DIR=str(state),HRC_RUNTIME_DIR=str(runtime)),capture_output=True,timeout=10)
            after={str(p.relative_to(subject)):snapshot(p) for p in protected}
            metrics=[json.loads(line) for file in (state/'metrics').glob('cli-*.ndjson') for line in file.read_text().splitlines()]
            files=sorted(str(file.relative_to(subject)) for file in subject.rglob('*') if file.is_file())
            same_db=before['state/state.sqlite']==after['state/state.sqlite']
            old_wal,new_wal=before['state/state.sqlite-wal'],after['state/state.sqlite-wal']
            no_frames=(new_wal is None or new_wal['size']==0) if old_wal is None else (new_wal is not None and new_wal['size']==old_wal['size'] and new_wal['sha256']==old_wal['sha256'])
            controls_unchanged=all(before[name]==after[name] for name in ('run/hrc.sock','run/server.lock','run/server.pid'))
            row={'mode':mode,'mismatch':mismatch,'exit':result.returncode,'stderr':result.stderr.decode(),'before':before,'after':after,'files':files,'observationalCliRecords':metrics,
                 'mainDatabaseUnchanged':same_db,'walNoFramesAppended':no_frames,'controlFilesUnchanged':controls_unchanged,'shmChanged':before['state/state.sqlite-shm']!=after['state/state.sqlite-shm'],'refused':result.returncode!=0 and 'schema' in result.stderr.decode().lower(),
                 'expectedCliRecord':len(metrics)==1 and metrics[0].get('bin')=='rusthrc' and metrics[0].get('cmd')=='server' and metrics[0].get('exitCode',0)!=0}
            observations.append(row)
            if mode=='live-wal':writer.close()
            if prior_owner is not None:prior_owner.close()
    report={'pass':all(r['mainDatabaseUnchanged'] and r['walNoFramesAppended'] and r['controlFilesUnchanged'] and r['refused'] and r['expectedCliRecord'] for r in observations),'cases':observations}
    (args.artifacts/'results.json').write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps({'pass':report['pass'],'cases':[{k:r[k] for k in ('mode','mismatch','mainDatabaseUnchanged','walNoFramesAppended','controlFilesUnchanged','shmChanged','refused','expectedCliRecord')} for r in observations]}))
    assert report['pass'],'schema gate effects differ; see results.json'


if __name__=='__main__':main()
