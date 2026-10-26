"""Real live-seat safety and Bun-authored orphan maintenance in both modes.

Failures: dry runs write, apply silently does nothing, live owners are pruned or
aged, satellites survive deletion, continuation flags/events differ, invalid
filters admit writes, or a probe touches a foreign root. Each owner restores one
Bun-authored snapshot; orphan rows are added after startup to isolate this
workflow from N2 legacy startup reconciliation.
No fixture has a process, broker endpoint or terminal target. Live safety comes
from the ordinary real prompt/broker created by runtime_reads itself.
"""
import json
import sqlite3
import subprocess
from pathlib import Path
from runtime_reads import main

context={}

def cases(runtime,host,scope,root):
    context.update(runtime=runtime,host=host,scope=scope,root=root)
    common={'scope':scope,'transport':'sdk','olderThan':'24h'}
    prune='/v1/runtimes/prune';sweep='/v1/runtimes/sweep'
    return [
      ('prune-dry','POST',prune,dict(common,dryRun=True)),
      ('prune-no-confirm','POST',prune,dict(common,dryRun=False)),
      ('prune-ready-refusal','POST',prune,dict(common,status=['ready'],dryRun=True)),
      ('prune-apply','POST',prune,dict(common,dryRun=False,yes=True)),
      ('prune-repeat','POST',prune,dict(common,dryRun=False,yes=True)),
      ('sweep-dry','POST',sweep,dict(common,dryRun=True)),
      ('sweep-busy-refusal','POST',sweep,dict(common,status=['busy'],dryRun=True)),
      ('sweep-live-refusal','POST',sweep,{'scope':scope,'transport':'tmux','olderThan':'0ms','dryRun':True}),
      ('sweep-apply','POST',sweep,dict(common,dryRun=False,dropContinuation=True)),
      ('prune-swept','POST',prune,dict(common,dryRun=False,yes=True)),
      ('sweep-no-matches','POST',sweep,dict(common,scope=scope+'-absent',dryRun=False)),
      ('prune-duration-invalid','POST',prune,dict(common,olderThan='bad')),
      ('sweep-duration-invalid','POST',sweep,dict(common,olderThan='bad')),
      ('prune-status-invalid','POST',prune,dict(common,status='stale')),
      ('sweep-status-invalid','POST',sweep,dict(common,status=[''])),
      ('prune-transport-invalid','POST',prune,dict(common,transport='bad')),
      ('sweep-bool-invalid','POST',sweep,dict(common,dryRun='true')),
      ('prune-empty-manifest','POST',prune,{'runtimeIds':[],'includeLedgers':True}),
      ('prune-unpaired-manifest','POST',prune,{'runtimeIds':[runtime]}),
      ('prune-live-safety','POST',prune,{'scope':scope,'transport':'tmux','olderThan':'0ms','status':['ready'],'dryRun':False,'yes':True}),
      ('prune-wrong-shape','POST',prune,[]),
      ('sweep-wrong-shape','POST',sweep,[]),
      ('prune-duplicate-manifest','POST',prune,{'runtimeIds':[runtime,runtime],'includeLedgers':True}),
      ('prune-unallowlisted-manifest','POST',prune,{'runtimeIds':[runtime],'includeLedgers':True,'dryRun':True}),
      ('prune-filtered-manifest','POST',prune,{'runtimeIds':[runtime],'includeLedgers':True,'scope':scope}),
      ('prune-missing-disposition-reason','POST',prune,{'disposeRetainedEvidence':True,'runtimeIds':[runtime]}),
      ('prune-no-held-evidence-disposition','POST',prune,{'disposeRetainedEvidence':True,'runtimeIds':[runtime+'-gc-busy'],'reason':'scratch control','dryRun':True}),
    ]


def prepare(kind,dbpath,root):
    # Discover the named Bun release from the CLI symlink pinned by the parent.
    release=(root/'bin/hrc').resolve().parents[3]
    module=release/'packages/hrc-store-sqlite/src/database.ts'
    assert module.is_file(),module
    script='''import {openHrcDatabase} from MODULE;
const db=openHrcDatabase(process.argv[1]);
const host=db.sessions.getByHostSessionId(process.argv[2]);
for(const [suffix,status] of [['prune','stale'],['sweep','ready'],['busy','busy']]) db.runtimes.insert({runtimeId:process.argv[3]+'-gc-'+suffix,hostSessionId:host.hostSessionId,scopeRef:host.scopeRef,laneRef:host.laneRef,generation:host.generation,transport:'sdk',status,supportsInflightInput:false,createdAt:'2026-01-01T00:00:00.000Z',updatedAt:'2026-01-01T00:00:00.000Z'});
const rt=process.argv[3]+'-gc-prune', run='run-'+rt, now='2026-01-01T00:00:00.000Z';
db.runs.insert({runId:run,hostSessionId:host.hostSessionId,runtimeId:rt,scopeRef:host.scopeRef,laneRef:host.laneRef,generation:host.generation,transport:'sdk',status:'completed',acceptedAt:now,completedAt:now,updatedAt:now});
db.sqlite.query("INSERT INTO runtime_buffers(runtime_id,run_id,chunk_seq,text,created_at) VALUES (?,?,0,'prune satellite',?)").run(rt,run,now);
db.sqlite.query("INSERT INTO surface_bindings(surface_kind,surface_id,host_session_id,runtime_id,generation,bound_at) VALUES ('scratch','n1-maintenance-prune',?,?,?,?)").run(host.hostSessionId,rt,host.generation,now);
db.close();'''.replace('MODULE',json.dumps(str(module)))
    # This uses a store helper, never an hrc CLI; all destinations are explicit.
    run=subprocess.run(['bun','-e',script,str(dbpath),context['host'],context['runtime']],capture_output=True,text=True)
    assert run.returncode==0,run.stderr


def observe(kind,record,dbpath):
    with sqlite3.connect('file:'+str(dbpath)+'?mode=ro',uri=True) as db:
        db.row_factory=sqlite3.Row
        tables={}
        for table in ['sessions','continuities','runs','runtime_buffers','surface_bindings']:
            tables[table]=[dict(r) for r in db.execute('SELECT * FROM '+table+' ORDER BY rowid')]
        tables['runtimes']=[dict(r) for r in db.execute("SELECT * FROM runtimes WHERE transport='sdk' ORDER BY runtime_id")]
        tables['liveGuard']=[dict(r) for r in db.execute('SELECT runtime_id,status,active_run_id,active_operation_id,active_invocation_id FROM runtimes WHERE runtime_id=?',(context['runtime'],))]
        tables['events']=[dict(r) for r in db.execute("SELECT * FROM hrc_events WHERE event_kind IN ('runtime.stale','runtime.sweep_completed') ORDER BY hrc_seq")]
    return {'durable':tables}


main(case_factory=cases,observe=observe,paginate=False,before_subject=prepare,before_request=lambda kind,name,dbpath:observe(kind,None,dbpath)['durable'])
