#!/usr/bin/env python3
"""Foundry restart register shape, against real Bun/native scratch HTTP owners.

Failures: untyped responses, unsafe predecessor replacement, duplicate successors,
wrong continuation, lost retirement receipts/intent, binding/session lineage drift.
Endpoints deliberately absent: no fake broker claims host death or recovery.
"""
import argparse
import json
from pathlib import Path
import sqlite3
import time
from n4_federation import Node

TABLES = ('participant_address_reservations', 'participant_registrations',
          'participant_host_bindings', 'participant_registration_attempts',
          'sessions', 'continuities', 'runtimes')


def snapshot(node):
    with sqlite3.connect(node.db) as db:
        db.row_factory = sqlite3.Row
        rows = {t: [dict(r) for r in db.execute('SELECT * FROM '+t+' ORDER BY rowid')] for t in TABLES}
        rows['events'] = [dict(r) for r in db.execute("SELECT event_kind,host_session_id,scope_ref,lane_ref,generation,payload_json FROM hrc_events WHERE scope_ref!='server:hrc' ORDER BY hrc_seq")]
        return rows


def main():
    p = argparse.ArgumentParser()
    for key in ('binary', 'installed-release', 'aspd-socket', 'scratch-root', 'artifacts'):
        p.add_argument('--'+key, type=Path, required=True)
    p.add_argument('--owners', default='bun,native')
    a = p.parse_args()
    a.binary = a.binary.resolve()
    assert not a.scratch_root.exists()
    a.artifacts.mkdir(parents=True, exist_ok=True)
    node = Node(a.scratch_root, a.installed_release, a.aspd_socket, a.artifacts, 'succession')
    node.write_config({'nodeId': 'max3', 'peers': {}})
    base = {'registrationMode':'direct', 'requestedSessionRef':'agent:foundry:project:n4-t11872:task:primary',
            'hostIncarnationId':'foundry-predecessor', 'laneRef':'main',
            'workspaceCwd':str(node.project), 'socketPath':str(node.root/'old.sock')}
    proc = None
    try:
        proc = node.up('bun', a.binary, 'seed')
        status, joined, _ = node.http('POST','/v1/participants/register',base)
        assert status == 200 and joined['status']=='registered', joined
        with sqlite3.connect(node.db) as src, sqlite3.connect(node.root/'minted.sqlite') as dst: src.backup(dst)
        descriptor = json.loads(node.run('descriptor', ['bun', Path(__file__).with_name('participant_descriptor.mjs'), node.release, node.root], json.dumps(joined)))
        attach = {k:joined['identity'][k] for k in ('registrationId','attemptId','attachEpoch')}
        attach.update(socketPath=base['socketPath'], descriptor=descriptor)
        status, attached, _ = node.http('POST','/v1/participants/attach',attach)
        assert status==200 and attached['status']=='attached',attached
        node.down(proc); proc=None
        node.bun_store('continuation', "const db=openHrcDatabase(a[0]);db.sessions.updateContinuation(a[1],{provider:'pi',key:'foundry-conversation'},'2026-10-26T18:00:00.000Z');db.close()", node.db, joined['hostSessionId'])
        with sqlite3.connect(node.db) as db:
            db.execute("UPDATE participant_registration_attempts SET establishment_work_state='exhausted',establishment_attempt_count=5,establishment_next_attempt_at=NULL")
        with sqlite3.connect(node.db) as src, sqlite3.connect(node.root/'seed.sqlite') as dst: src.backup(dst)
        prior = {'hostIncarnationId':base['hostIncarnationId'], 'runtimeId':joined['identity']['runtimeId'], 'generation':joined['generation']}
        body = dict(base, hostIncarnationId='foundry-successor', socketPath=str(node.root/'new.sock'), expectedPredecessor=prior, continuation='continue')
        plans = [('foundry-continue', body, 'seed'), ('foundry-fresh', dict(body, continuation='fresh'), 'seed'),
                 ('wrong-predecessor', dict(body, expectedPredecessor=dict(prior,generation=99)), 'seed'),
                 ('missing-predecessor', {k:v for k,v in body.items() if k!='expectedPredecessor'}, 'seed'),
                 ('bridge', dict(body,hostIncarnationId=base['hostIncarnationId']), 'seed'),
                 ('pre-attach-implicit', {k:v for k,v in body.items() if k!='expectedPredecessor'}, 'minted'),
                 ('pre-attach-explicit', body, 'minted'),
                 ('pre-attach-own', dict(body,hostIncarnationId=base['hostIncarnationId']), 'minted'),
                 ('legacy-arris', dict(body,hostIncarnationId=base['hostIncarnationId']), 'legacy'),
                 ('no-durable-endpoint', body, 'no-endpoint'),
                 ('retired-only', body, 'retired'),
                 ('reuse-disabled', body, 'disabled'),
                 ('continuation-invalidated', body, 'invalidated'),
                 ('declaration-mismatch', body, 'seed')]
        results = {}
        for owner in a.owners.split(','):
            observed=[]
            for name, request, variant in plans:
                source='minted' if variant in ('minted','legacy') else 'seed'
                with sqlite3.connect(node.root/(source+'.sqlite')) as src, sqlite3.connect(node.db) as dst: src.backup(dst)
                with sqlite3.connect(node.db) as db:
                    if variant=='legacy':
                        value=json.dumps({'provider':'arris','kind':'host-incarnation','key':'legacy'})
                        db.execute('UPDATE sessions SET continuation_json=?',(value,))
                        db.execute("UPDATE participant_registration_attempts SET continuation_carried=1,continuation_selected_json=?,continuation_reason='carried'",(value,))
                    if variant=='no-endpoint':db.execute('UPDATE participant_registration_attempts SET attach_socket_path=NULL')
                    if variant=='retired':db.execute("UPDATE participant_host_bindings SET state='RETIRED',disposition_reason='fixture-retired'")
                    if variant=='disabled':db.execute('UPDATE sessions SET continuation_reuse_disabled=1')
                if variant=='invalidated':
                    node.bun_store('barrier', "const db=openHrcDatabase(a[0]);db.hrcEvents.append({ts:'2026-10-26T18:00:00.000Z',hostSessionId:a[1],scopeRef:a[2],laneRef:'main',generation:1,category:'session',eventKind:'session.continuation_dropped',payload:{}});db.close()",node.db,joined['hostSessionId'],base['requestedSessionRef'])
                proc=node.up(owner,a.binary,name)
                before=snapshot(node)
                for label in (name,name+'-retry'):
                    current_request=dict(request,continuation='fresh') if name=='declaration-mismatch' and label.endswith('-retry') else request
                    t=time.time();status,reply,_=node.http('POST','/v1/participants/register',current_request)
                    observed.append({'case':label,'request':current_request,'status':status,'body':reply,'before':t,'after':time.time(),'durable':snapshot(node),'seed':before})
                node.down(proc);proc=None
            results[owner]=observed
            directory=a.artifacts/owner;directory.mkdir(exist_ok=True)
            (directory/'observations.json').write_text(json.dumps(observed,indent=2)+'\n')
        print(json.dumps({o:[(r['case'],r['status'],r['body'].get('status') if isinstance(r['body'],dict) else r['body']) for r in rows] for o,rows in results.items()}))
    finally:
        if proc:node.down(proc)
        (a.artifacts/'steps.json').write_text(json.dumps(node.steps,indent=2)+'\n')
        node.cleanup()


if __name__=='__main__':main()
