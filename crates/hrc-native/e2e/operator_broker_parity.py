#!/usr/bin/env python3
"""Drive ensure and stale accepted-run recovery against real scratch brokers.

Failure modes: ensure replaces a live execution; dry-run mutates a run; recovery
withdraws without exact identity/quiet ownership; an idle real broker is mistaken
for a busy seat; retry evidence normalizes another runtime. The accepted/retry
rows are fault injections into a real idle broker's ledger, not fake broker RPCs.
"""
import argparse
import datetime
import json
from pathlib import Path
import sqlite3
import time
from n3_scratch import Scratch
from runtimes_start import normalize

PROJECT='ops-t12065'
PROMPT='Reply with exactly the word OK and nothing else. No tools.'


def run(owner,args):
    artifacts=args.artifacts/owner
    s=Scratch(args.scratch_root/owner,args.installed_release,args.aspd_socket,args.binary,artifacts,project_id=PROJECT)
    scope=f'agent:tabularasa:project:{PROJECT}:task:operator'
    out={}
    try:
        s.init_substrate();s.up(owner,'operator')
        status,declared=s.http('POST','/v1/declarations/resolve',{'scopeRef':scope,'runMode':'task','interactive':True,'preferredMode':'headless'})
        assert status==200,declared
        intent=declared['intent']
        intent['harness']={'id':'codex','interactive':True}
        intent['selection']={'harness':'codex','model':'gpt-6.1-sol','presentation':True}
        intent.pop('summonDirectives',None)
        birth_intent=json.loads(json.dumps(intent))
        status,session=s.http('POST','/v1/sessions/resolve',{'sessionRef':scope+'/lane:main','runtimeIntent':intent,'create':True,'summonIntent':'explicit_local'})
        assert status==200,session
        status,birth=s.http('POST','/v1/turns',{'hostSessionId':session['hostSessionId'],'runtimeIntent':intent,'prompt':PROMPT})
        assert status in (200,202),birth
        rt=birth['runtimeId'];runid=birth['runId']
        s.wait_completed(runid)
        s.wait(lambda:s.rows("SELECT 1 FROM runtimes WHERE runtime_id=? AND status='ready' AND active_run_id IS NULL",(rt,)),300,'ready')
        time.sleep(2) # Let the real terminal broker tail settle before fault injection.
        before=s.rows('SELECT * FROM runtimes WHERE runtime_id=?',(rt,))[0]
        host=before['host_session_id'];inv=before['active_invocation_id'];op=before['active_operation_id']
        # This first HTTP observation captures the actual current shape before
        # deriving any fault-injection declarations from it.
        out['real-inspect']=s.http('POST','/v1/runtimes/inspect',{'runtimeId':rt})
        artifacts.joinpath('real-inspect.json').write_text(json.dumps(out.pop('real-inspect'),indent=2))
        intent={'harness':{'interactive':True,'provider':'anthropic'}}
        out['ensure-reuse']=s.http('POST','/v1/runtimes/ensure',{'hostSessionId':host,'intent':intent})
        assert out['ensure-reuse'][0]==200,out
        if out['ensure-reuse'][0]==200: assert out['ensure-reuse'][1]['runtimeId']==rt,out
        assert s.rows('SELECT count(*) n FROM runtimes')[0]['n']==1
        with sqlite3.connect(s.db_path) as db:
            db.row_factory=sqlite3.Row
            template=dict(db.execute('SELECT * FROM runs WHERE run_id=?',(runid,)).fetchone())
            template.update(run_id='run-operator-stale',status='accepted',started_at=None,completed_at=None,error_code=None,error_message=None,
                            dispatched_input_id='operator-absent-input',broker_submission_id='operator-absent-input',updated_at='2026-10-01T00:00:00.000Z',invocation_id=inv,operation_id=op)
            keys=list(template)
            db.execute('INSERT INTO runs('+','.join(keys)+') VALUES('+','.join('?' for _ in keys)+')',list(template.values()))
            db.execute("UPDATE runtimes SET status='busy',active_run_id='run-operator-stale',last_activity_at='2026-10-01T00:00:00.000Z' WHERE runtime_id=?",(rt,))
            db.execute("UPDATE broker_invocations SET updated_at='2026-10-01T00:00:00.000Z' WHERE invocation_id=?",(inv,))
        req={'runId':'run-operator-stale','dryRun':True}
        out['recover-idle-dry']=s.http('POST','/v1/runs/recover-unstarted',req)
        assert out['recover-idle-dry'][1]['status']=='matched',out
        assert s.rows("SELECT status FROM runs WHERE run_id='run-operator-stale'")[0]['status']=='accepted'
        out['recover-not-held']=s.http('POST','/v1/runs/recover-unstarted',{'runId':req['runId'],'yes':True})
        assert out['recover-not-held'][1]['reason']=='withdrawal_not_durable',out
        assert s.rows("SELECT status FROM runs WHERE run_id='run-operator-stale'")[0]['status']=='accepted'
        # Simulate death after exact terminal projection but before ready
        # normalization. The retry must use a fresh real broker seat probe.
        now=datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00','Z')
        with sqlite3.connect(s.db_path) as db:
            db.execute("UPDATE runs SET status='failed',completed_at=?,error_code='accepted_run_never_started' WHERE run_id='run-operator-stale'",(now,))
            db.execute('UPDATE runtimes SET active_run_id=NULL WHERE runtime_id=?',(rt,))
        out['recover-unproved-retry']=s.http('POST','/v1/runs/recover-unstarted',{'runId':req['runId'],'yes':True})
        assert out['recover-unproved-retry'][1]['reason']=='recovery_retry_not_proven',out
        with sqlite3.connect(s.db_path) as db:
            db.execute("INSERT INTO broker_invocation_events(invocation_id,seq,time,type,run_id,runtime_id,broker_event_json,projection_status,created_at) VALUES(?,1000000,?,'submission.withdrawn','run-operator-stale',?,?,'projected',?)",(inv,now,rt,json.dumps({'submissionId':'operator-absent-input','reason':'accepted_run_never_started'}),now))
        out['recover-retry-dry']=s.http('POST','/v1/runs/recover-unstarted',req)
        assert out['recover-retry-dry'][1]['status']=='matched',out
        out['recover-retry']=s.http('POST','/v1/runs/recover-unstarted',{'runId':req['runId'],'yes':True})
        assert out['recover-retry'][1]['status'] in ('recovered','projection_pending'),out
        assert s.rows('SELECT status FROM runtimes WHERE runtime_id=?',(rt,))[0]['status']=='ready'
        out['recover-repeat']=s.http('POST','/v1/runs/recover-unstarted',{'runId':req['runId'],'yes':True})
        assert out['recover-repeat'][1]['reason']=='recovery_retry_not_proven',out
        with sqlite3.connect(s.db_path) as db:
            db.execute('UPDATE sessions SET continuation_json=NULL WHERE host_session_id=?',(host,))
        out['ensure-fresh']=s.http('POST','/v1/runtimes/ensure',{'hostSessionId':host,'intent':birth_intent,'restartStyle':'fresh_pty'})
        assert out['ensure-fresh'][0]==200 and out['ensure-fresh'][1]['runtimeId']!=rt,out
        assert s.rows('SELECT status FROM runtimes WHERE runtime_id=?',(rt,))[0]['status']=='stale'
        assert s.rows("SELECT count(*) n FROM hrc_events WHERE event_kind='runtime.stale' AND runtime_id=?",(rt,))[0]['n']==1
        artifacts.joinpath('observations.json').write_text(json.dumps(out,indent=2))
        # Compare per-workflow IDs; do not compare wall-clock/activity values.
        return normalize(json.loads(json.dumps(out)),{},s.root)
    finally:
        artifacts.joinpath('observations.json').write_text(json.dumps(out,indent=2))
        s.cleanup(f'agent:tabularasa:project:{PROJECT}:task:')


def main():
    p=argparse.ArgumentParser()
    for key in ('binary','installed-release','aspd-socket','scratch-root','artifacts'):p.add_argument('--'+key,type=Path,required=True)
    a=p.parse_args();a.artifacts.mkdir(parents=True,exist_ok=True)
    bun=run('bun',a);native=run('native',a)
    (a.artifacts/'comparison.json').write_text(json.dumps({'bun':bun,'native':native},indent=2))
    assert bun==native,(bun,native)
    (a.artifacts/'summary.json').write_text(json.dumps({'pass':True,'cases':len(bun)}))
    print(json.dumps({'pass':True,'cases':len(bun)}))


if __name__=='__main__':main()
