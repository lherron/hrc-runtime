"""Real target-session intent and placement reads, on an existing ready scratch seat."""
import json
import socket
import sqlite3
from pathlib import Path
from runtime_reads import main


def cases(runtime,host,scope,root):
    # Use this physical node's ordinary standalone authority. Scope, ledger,
    # state, project and all destinations remain the workflow's private ones.
    config=root/'federation.json'
    config.write_text(json.dumps({'nodeId':socket.gethostname().split('.')[0].lower(),'peers':{}}))
    config.chmod(0o600)
    with sqlite3.connect(f'file:{root}/state/state.sqlite?mode=ro',uri=True) as db:
        recorded=json.loads(db.execute('SELECT last_applied_intent_json FROM sessions WHERE host_session_id=?',(host,)).fetchone()[0])
    placement={k:v for k,v in recorded['placement'].items() if k!='correlation'}
    existing=scope+'/lane:main'
    fresh=scope+'-ensure-new/lane:main'
    project_role='agent:tabularasa:project:n1-t11818:role:reviewer'
    # Add the unique task segment to the role name to keep this address private.
    project_role=project_role+'-'+scope.rsplit(':',1)[1]
    return [
        ('placement-scope','POST','/v1/placements/resolve',{'scopeRef':scope}),
        ('placement-explicit','POST','/v1/placements/resolve',{'agentId':'tabularasa','agentRoot':placement['agentRoot'],'projectId':'n1-t11818','projectRoot':str(root/'n1-t11818'),'cwd':str(root/'n1-t11818')}),
        ('placement-empty','POST','/v1/placements/resolve',{}),
        ('placement-bad-mode','POST','/v1/placements/resolve',{'scopeRef':scope,'runMode':'bad'}),
        ('ensure-no-persist','POST','/v1/targets/ensure',{'sessionRef':existing,'runtimeIntent':{'n1Probe':'not persisted'},'persistIntent':False}),
        ('ensure-persist','POST','/v1/targets/ensure',{'sessionRef':existing,'runtimeIntent':{'n1Probe':'stored'}}),
        ('ensure-repeat','POST','/v1/targets/ensure',{'sessionRef':existing,'runtimeIntent':{'n1Probe':'stored'}}),
        ('ensure-default','POST','/v1/targets/ensure',{'sessionRef':scope+'/lane:default','runtimeIntent':{},'persistIntent':False}),
        ('ensure-missing','POST','/v1/targets/ensure',{}),
        ('ensure-missing-intent','POST','/v1/targets/ensure',{'sessionRef':existing}),
        ('ensure-bad-selector','POST','/v1/targets/ensure',{'sessionRef':'bad','runtimeIntent':{}}),
        ('ensure-invalid-scope','POST','/v1/targets/ensure',{'sessionRef':'not-agent-n1-t11818/lane:main','runtimeIntent':{}}),
        ('ensure-empty-lane','POST','/v1/targets/ensure',{'sessionRef':scope+'/lane:','runtimeIntent':{}}),
        ('target-invalid-scope','GET','/v1/targets/by-session-ref?sessionRef=not-agent-n1-t11818%2Flane%3Amain',None),
        ('target-empty-lane','GET','/v1/targets/by-session-ref?sessionRef='+scope+'%2Flane%3A',None),
        ('ensure-bad-persist','POST','/v1/targets/ensure',{'sessionRef':existing,'runtimeIntent':{},'persistIntent':'yes'}),
        ('ensure-bad-cause','POST','/v1/targets/ensure',{'sessionRef':existing,'runtimeIntent':{},'birthCause':'bad'}),
        ('ensure-fresh','POST','/v1/targets/ensure',{'sessionRef':fresh,'runtimeIntent':{'placement':placement},'birthCause':'assignment'}),
        ('ensure-fresh-repeat','POST','/v1/targets/ensure',{'sessionRef':fresh,'runtimeIntent':{},'persistIntent':False}),
        ('ensure-fresh-no-persist','POST','/v1/targets/ensure',{'sessionRef':scope+'-ensure-ephemeral/lane:main','runtimeIntent':{'n1Probe':'not persisted'},'persistIntent':False}),
        ('ensure-task-role','POST','/v1/targets/ensure',{'sessionRef':scope+':role:reviewer/lane:main','runtimeIntent':{}}),
        ('ensure-project-role','POST','/v1/targets/ensure',{'sessionRef':project_role+'/lane:main','runtimeIntent':{}}),
    ]


def observe(kind,record,dbpath):
    with sqlite3.connect(f'file:{dbpath}?mode=ro',uri=True) as db:
        db.row_factory=sqlite3.Row
        sessions=[dict(r) for r in db.execute('SELECT * FROM sessions ORDER BY scope_ref,lane_ref,generation')]
        continuities=[dict(r) for r in db.execute('SELECT * FROM continuities ORDER BY scope_ref,lane_ref')]
        events=[dict(r) for r in db.execute("SELECT hrc_seq,ts,host_session_id,scope_ref,lane_ref,generation,category,event_kind,payload_json FROM hrc_events WHERE event_kind='session.created' ORDER BY hrc_seq")]
    return {'sessions':sessions,'continuities':continuities,'sessionEvents':events}


main(case_factory=cases,observe=observe,paginate=False)
