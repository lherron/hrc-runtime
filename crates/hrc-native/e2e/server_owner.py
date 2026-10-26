#!/usr/bin/env python3
"""Real owner recovery, with refusal and concurrent-reclaimer controls.

Failure modes: a dead owner blocks boot; a malformed/live/replaced lock is
deleted; a responsive socket is stolen; cleanup claimants race; a prior-boot
PID reuse blocks recovery; cleanup removes files while an owner is alive.
All processes, sockets, claims and ledgers belong to this fresh scratch root.
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT/'crates/hrc-cli/e2e'))
from copied_release import copied_bun_cli, preflight_unmanaged
from foundation import UnixHTTP
from metrics_isolation import isolated_suite


@isolated_suite
def main():
    p = argparse.ArgumentParser()
    for flag in ('binary', 'oracle', 'artifacts'):
        p.add_argument('--'+flag, type=Path, required=True)
    a = p.parse_args()
    a.artifacts.mkdir(parents=True, exist_ok=True)
    env = {k:v for k,v in os.environ.items() if not k.startswith(
        ('HRC_', 'ASP_', 'WRKQ', 'HARNESS_', 'CLAUDE', 'CODEX', 'ACP_', 'AGENT_', 'TMUX'))}
    env.pop('XPC_SERVICE_NAME', None)
    results = []
    with tempfile.TemporaryDirectory(prefix='n5o77-', dir='/tmp') as temporary:
        root = Path(temporary)
        oracle = copied_bun_cli(a.oracle, root/'release')
        env.update(HRC_ACP_WEBHOOK_URL='', HRC_EVENT_FORWARD_URL='',
                   HRC_WRKQ_DB=str(root/'wrkq.db'), WRKQ_DB=str(root/'wrkq.db'),
                   HRC_PEER_CONFIG_FILE=str(root/'absent-federation.json'))
        processes = []
        def spawn(owner, run, state, label):
            child_env = dict(env, HRC_RUNTIME_DIR=str(run), HRC_STATE_DIR=str(state),
                             HRC_EVENT_INGEST_SOCKET=str(run/'ingest.sock'))
            if owner == 'bun':
                preflight_unmanaged(oracle, child_env, a.artifacts/(label+'-preflight.json'))
            argv = [shutil.which('bun'), str(oracle)] if owner == 'bun' else [str(a.binary.resolve())]
            with (a.artifacts/(label+'.log')).open('w') as log:
                proc = subprocess.Popen(argv+['server','serve'], env=child_env, cwd=root,
                                        stdin=subprocess.DEVNULL, stdout=log, stderr=log)
            processes.append(proc)
            return proc
        def ready(proc, run, timeout=10):
            end = time.monotonic()+timeout
            while proc.poll() is None and time.monotonic()<end:
                try:
                    h = UnixHTTP(run/'hrc.sock');h.timeout=.3
                    h.request('GET','/v1/status');response=h.getresponse()
                    value=json.loads(response.read());h.close()
                    if response.status==200:
                        assert value['release']['mode']!='atomic'
                        assert int((run/'server.pid').read_text())==proc.pid
                        return True
                except (OSError, ValueError):pass
                time.sleep(.03)
            return False
        def stop(proc):
            if proc.poll() is None:
                proc.terminate()
                try:proc.wait(timeout=10)
                except subprocess.TimeoutExpired:proc.kill();proc.wait(timeout=5)
        def lock(pid, stamp='2026-10-26T00:00:00.000Z'):
            return json.dumps(dict(pid=pid,createdAt=stamp))+'\n'
        # A reaped private process supplies an actually dead PID, never a guess.
        dead=subprocess.Popen([sys.executable,'-c','pass']);dead.wait()
        try:
            for owner in ('bun','native'):
                run=root/(owner+'-crash')/'run';state=run.parent/'state'
                if owner=='native':
                    bootstrap=spawn('bun',run,state,'native-crash-schema')
                    assert ready(bootstrap,run);stop(bootstrap)
                first=spawn(owner,run,state,owner+'-first')
                assert ready(first,run),'initial owner did not boot'
                first.kill();first.wait(timeout=5)
                before=(run/'server.lock').read_text()
                successor=spawn(owner,run,state,owner+'-successor')
                recovered=ready(successor,run)
                results.append(dict(owner=owner,case='sigkill-restart',pass_=recovered,
                                    predecessorPid=first.pid,successorPid=successor.pid,
                                    staleLockRetained=before))
                stop(successor)
                # Every fixture below has its own files, including refusals.
                variants={
                    'dead-json':(lock(dead.pid),True),
                    'dead-number':(str(dead.pid)+'\n',True),
                    'dead-legacy-prefix':(str(dead.pid)+' trailing legacy text\n',True),
                    'preboot-reused-pid':(lock(os.getpid(),'1970-01-01T00:00:00.000Z'),True),
                    'live-owner':(lock(os.getpid(),'unknown'),False),
                    'malformed-object':('{"pid":0,"createdAt":"bad"}\n',False),
                    'malformed-text':('not a lock\n',False),
                    'empty-lock':('',False),
                    'responsive-socket':(lock(dead.pid),False),
                    'dead-cleanup-claim':(lock(dead.pid),True),
                    'changed-under-claim':(lock(dead.pid),False),
                }
                for index,(name,(raw,expected)) in enumerate(variants.items()):
                    run=root/(owner[0]+'-'+str(index))/'run';run.mkdir(parents=True)
                    # Bootstrap each schema under its own Bun owner first.
                    state=run.parent/'state'
                    bootstrap=spawn('bun',run,state,owner+'-'+name+'-schema')
                    assert ready(bootstrap,run);stop(bootstrap)
                    path=run/'server.lock';path.write_text(raw)
                    sentinel='unchanged sentinel\n';(run/'server.pid').write_text(sentinel)
                    held=None;claim=None
                    if name=='responsive-socket':
                        held=socket.socket(socket.AF_UNIX);held.bind(str(run/'hrc.sock'));held.listen(10)
                        socket_inode=(run/'hrc.sock').stat().st_ino
                    if name=='dead-cleanup-claim':
                        (run/'server.lock.cleanup').write_text(lock(dead.pid))
                    if name=='changed-under-claim':
                        claim=run/'server.lock.cleanup';claim.write_text(lock(os.getpid(),'unknown'))
                    proc=spawn(owner,run,state,owner+'-'+name)
                    if claim:
                        time.sleep(.3)
                        raw=lock(os.getpid(),'unknown');path.write_text(raw)
                        claim.unlink()
                    started=ready(proc,run,3)
                    if not expected:
                        try:proc.wait(timeout=3)
                        except subprocess.TimeoutExpired:pass
                        preserved=path.read_text()==raw and (run/'server.pid').read_text()==sentinel
                        # Bun's CLI probes the existing HTTP owner before the
                        # lock path; an open, silent socket keeps that probe
                        # pending. Both paths must leave its files untouched.
                        refused=proc.poll() not in (None,0) or held is not None
                        passed=not started and refused and preserved
                        if held:passed=passed and (run/'hrc.sock').stat().st_ino==socket_inode
                    else:
                        passed=started and json.loads(path.read_text())['pid']==proc.pid
                    stop(proc)
                    if held:held.close()
                    results.append(dict(owner=owner,case=name,expectedStarted=expected,
                                        started=started,pass_=passed))
                # Two real successors compete for the same stale lock.
                run=root/(owner+'-race')/'run';run.mkdir(parents=True);state=run.parent/'state'
                bootstrap=spawn('bun',run,state,owner+'-race-schema')
                assert ready(bootstrap,run);stop(bootstrap)
                (run/'server.lock').write_text(lock(dead.pid))
                rivals=[spawn(owner,run,state,owner+'-race-'+str(i)) for i in range(2)]
                time.sleep(.5)
                alive=[proc for proc in rivals if proc.poll() is None]
                passed=len(alive)==1 and ready(alive[0],run)
                for proc in rivals:stop(proc)
                results.append(dict(owner=owner,case='concurrent-reclaimers',pass_=passed,
                                    survivingOwners=len(alive)))
        finally:
            for proc in processes:stop(proc)
        report={'cases':results,'pass':bool(results) and all(r['pass_'] for r in results),
                'cleanup':{'ownedProcessesExited':all(p.poll() is not None for p in processes)}}
        (a.artifacts/'results.json').write_text(json.dumps(report,indent=2)+'\n')
        print(json.dumps({'pass':report['pass'],'cases':len(results)}))
        return 0 if report['pass'] else 1


if __name__=='__main__':
    sys.exit(main())
