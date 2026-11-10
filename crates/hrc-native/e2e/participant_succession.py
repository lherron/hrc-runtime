#!/usr/bin/env python3
"""Foundry restart register shape, against a native scratch HTTP owner.

Failures: untyped responses, unsafe predecessor replacement, duplicate successors,
wrong continuation, lost retirement receipts/intent, binding/session lineage drift.
Endpoints deliberately absent: no fake broker claims host death or recovery.

Seeds are the native writers' own statements: the predecessor is joined and
attached through the owner's routes (descriptor from participant_descriptor.scratch);
its continuation is projection/state.rs's UPDATE; the invalidation barrier is the
session.continuation_dropped event turns/context.rs appends (n3_events.append_events);
the busy runtime and open run are broker.rs's inserts. Every case is judged here:
status, reply status, cardinality, lineage, retirement, continuation selection,
startup recovery and request-bounded clocks (formerly the parity comparator's
per-owner checks), plus the T-12279 bridge-continuation ruling.
"""
import argparse
import json
from pathlib import Path
import sqlite3
import time
from n4_federation import Node
from n3_events import append_events
import participant_descriptor
import datetime
import re

TABLES = ('participant_address_reservations', 'participant_registrations',
          'participant_host_bindings', 'participant_registration_attempts',
          'sessions', 'continuities', 'runtimes', 'runs')


def snapshot(node):
    with sqlite3.connect(node.db) as db:
        db.row_factory = sqlite3.Row
        rows = {t: [dict(r) for r in db.execute('SELECT * FROM '+t+' ORDER BY rowid')] for t in TABLES}
        rows['events'] = [dict(r) for r in db.execute("SELECT event_kind,host_session_id,scope_ref,lane_ref,generation,payload_json FROM hrc_events WHERE scope_ref!='server:hrc' ORDER BY hrc_seq")]
        return rows

UUID = re.compile(r'[a-z][a-z-]*-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}')
CLOCK = re.compile(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z')
NAMES = ['foundry-continue','foundry-fresh','wrong-predecessor','missing-predecessor','bridge','pre-attach-implicit',
         'pre-attach-explicit','pre-attach-own','legacy-arris','no-durable-endpoint','retired-only','reuse-disabled',
         'continuation-invalidated','declaration-mismatch','active-runs','recover-intent','bridge-fresh','bridge-disabled',
         'bridge-invalidated']


def clocks(value):
    if isinstance(value, dict): return set().union(set(), *(clocks(v) for v in value.values()))
    if isinstance(value, list): return set().union(set(), *(clocks(v) for v in value))
    return set(CLOCK.findall(value)) if isinstance(value, str) else set()


def judge(rows, artifacts):
    """Each branch's own literals (the former comparator's per-owner checks)."""
    checks = []
    def check(name, passed, reason): checks.append({'id':name, 'pass':bool(passed), 'reason':reason})
    check('required-cases', [r['case'] for r in rows]==[l for n in NAMES for l in (n, n+'-retry')], 'every branch and retry present exactly once')
    seen = set()
    for row in rows:
        name = row['case'].removesuffix('-retry')
        refused = name in ('wrong-predecessor','missing-predecessor') or row['case']=='declaration-mismatch-retry'
        pending = name in ('no-durable-endpoint','retired-only')
        own = name=='pre-attach-own'
        bridge = name in ('bridge','legacy-arris','bridge-fresh','bridge-disabled','bridge-invalidated')
        success = not refused and not pending
        d = row['durable']; body = row['body']
        check(row['case']+':status', row['status']==(409 if refused else 200), 'typed HTTP status follows the replacement gate')
        check(row['case']+':typed', isinstance(body,dict) and body.get('status')==('rejected' if refused else 'pending' if pending else 'registered'), 'every branch returns the join envelope')
        attempts = 2 if (success and not own) or row['case']=='declaration-mismatch-retry' else 1
        check(row['case']+':cardinality', len(d['participant_registration_attempts'])==attempts and len(d['participant_registrations'])==1, 'one successor at most, including on retry')
        if success and not own:
            check(row['case']+':sessions', len(d['sessions'])==(1 if bridge else 2), 'bridge retains its session; host replacement increments generation')
            if not bridge:
                check(row['case']+':lineage', d['sessions'][0]['status']=='archived' and d['sessions'][1]['prior_host_session_id']==d['sessions'][0]['host_session_id'], 'session lineage survives retirement')
                check(row['case']+':retirement', d['participant_host_bindings'][0]['state']=='RETIRED' and d['participant_registration_attempts'][0]['recovery_disposition']=='abandoned', 'predecessor is durably retired before the successor')
            reason = body.get('continuation',{}).get('reason') if isinstance(body,dict) else None
            expected = {'foundry-continue':'carried','foundry-fresh':'participant_fresh','legacy-arris':'continuation_invalidated',
                        'reuse-disabled':'reuse_disabled','continuation-invalidated':'continuation_invalidated','bridge':'carried',
                        'bridge-fresh':'participant_fresh','bridge-disabled':'reuse_disabled','bridge-invalidated':'continuation_invalidated'}.get(name)
            if expected: check(row['case']+':selection', reason==expected, 'continuation selection follows the declaration and durable barriers')
        if name=='active-runs':
            check(row['case']+':settled', bool(d['runs']) and all(r['status']=='failed' and r['error_code']=='runtime_unavailable' for r in d['runs']), 'the replaced runtime owns no open run')
        if name=='recover-intent':
            check(row['case']+':startup-recovery', row.get('startupRecovered') is True, 'startup resumes durable intent before any retry request')
        new = clocks(d)|clocks(body)
        for clock in new-seen-clocks(row['seed']):
            at = datetime.datetime.fromisoformat(clock.replace('Z','+00:00')).timestamp()
            check(row['case']+':clock:'+clock, row['before']-.01<=at<=row['after']+.01, 'new durable clocks are written within the request')
        seen.update(new)
    (artifacts/'checks.json').write_text(json.dumps(checks,indent=2)+'\n')
    return [c for c in checks if not c['pass']]


def main():
    p = argparse.ArgumentParser()
    for key in ('binary', 'scratch-root', 'artifacts'):
        p.add_argument('--'+key, type=Path, required=True)
    p.add_argument('--installed-release', type=Path, help='accepted and ignored')
    p.add_argument('--aspd-socket', type=Path, default=Path('/nonexistent'), help='accepted and ignored')
    a = p.parse_args()
    a.binary = a.binary.resolve()
    assert not a.scratch_root.exists()
    a.artifacts.mkdir(parents=True, exist_ok=True)
    node = Node(a.scratch_root, a.installed_release, a.aspd_socket, a.artifacts, 'succession', a.binary)
    node.write_config({'nodeId': 'max3', 'peers': {}})
    base = {'registrationMode':'direct', 'requestedSessionRef':'agent:foundry:project:n4-t11872:task:primary',
            'hostIncarnationId':'foundry-predecessor', 'laneRef':'main',
            'workspaceCwd':str(node.project), 'socketPath':str(node.root/'old.sock')}
    proc = None
    try:
        proc = node.up('native', a.binary, 'seed')
        status, joined, _ = node.http('POST','/v1/participants/register',base)
        assert status == 200 and joined['status']=='registered', joined
        with sqlite3.connect(node.db) as src, sqlite3.connect(node.root/'minted.sqlite') as dst: src.backup(dst)
        descriptor = participant_descriptor.scratch(joined, node.root)
        attach = {k:joined['identity'][k] for k in ('registrationId','attemptId','attachEpoch')}
        attach.update(socketPath=base['socketPath'], descriptor=descriptor)
        status, attached, _ = node.http('POST','/v1/participants/attach',attach)
        assert status==200 and attached['status']=='attached',attached
        node.down(proc); proc=None
        node.sql(node.db, [('UPDATE sessions SET continuation_json = ?, continuation_reuse_disabled = 0, updated_at = ? WHERE host_session_id = ?',
                            (json.dumps({'provider':'pi','key':'foundry-conversation'}), '2026-10-26T18:00:00.000Z', joined['hostSessionId']))])
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
                 ('declaration-mismatch', body, 'seed'), ('active-runs',body,'runs'), ('recover-intent',body,'recover')]
        plans += [
                 ('bridge-fresh', dict(body,hostIncarnationId=base['hostIncarnationId'],continuation='fresh'), 'seed'),
                 ('bridge-disabled', dict(body,hostIncarnationId=base['hostIncarnationId']), 'disabled'),
                 ('bridge-invalidated', dict(body,hostIncarnationId=base['hostIncarnationId']), 'invalidated')
        ]
        results = {}
        retired_seed = None
        for owner in ('native',):
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
                    append_events(node.db,[{'ts':'2026-10-26T18:00:00.000Z','hostSessionId':joined['hostSessionId'],'scopeRef':base['requestedSessionRef'],'laneRef':'main','generation':1,'category':'session','eventKind':'session.continuation_dropped','payload':{}}])
                if variant=='recover':
                    assert retired_seed is not None
                    old=retired_seed['participant_registration_attempts'][0]
                    intent=json.loads(old['replacement_intent_json']);intent.pop('allocatedAttemptId')
                    with sqlite3.connect(node.db) as db:
                        columns=('state','disposition_reason','writer_evidence_json','recovery_disposition','recovery_reason')
                        db.execute('UPDATE participant_registration_attempts SET '+','.join(c+'=?' for c in columns),tuple(old[c] for c in columns))
                        db.execute("UPDATE participant_registration_attempts SET replacement_intent_json=?,establishment_work_state='pending',establishment_attempt_count=0",(json.dumps(intent),))
                        db.execute("UPDATE participant_host_bindings SET state='RETIRING',retirement_receipt_json=?",(retired_seed['participant_host_bindings'][0]['retirement_receipt_json'],))
                proc=node.up(owner,a.binary,name)
                if variant=='runs':
                    now=datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z')
                    node.sql(node.db,[
                        ("INSERT INTO runtimes(runtime_id,host_session_id,scope_ref,lane_ref,generation,transport,status,supports_inflight_input,active_run_id,created_at,updated_at,status_changed_at,controller_kind,runtime_state_json) VALUES (?,?,?,'main',1,'sdk','busy',0,'run-succession',?,?,?,'harness-broker',?)",
                         (prior['runtimeId'],joined['hostSessionId'],base['requestedSessionRef'],now,now,now,json.dumps({'status':'busy','probe':'preserved'}))),
                        ("INSERT INTO runs(run_id,host_session_id,runtime_id,scope_ref,lane_ref,generation,transport,status,accepted_at,updated_at,execution_format) VALUES ('run-succession',?,?,?,'main',1,'headless','accepted',?,?,'format1')",
                         (joined['hostSessionId'],prior['runtimeId'],base['requestedSessionRef'],now,now))])
                recovered = None
                if variant=='recover':
                    for _ in range(60):
                        recovered=len(snapshot(node)['participant_registration_attempts'])==2
                        if recovered:break
                        time.sleep(.05)
                before=snapshot(node)
                for label in (name,name+'-retry'):
                    current_request=dict(request,continuation='fresh') if name=='declaration-mismatch' and label.endswith('-retry') else request
                    t=time.time();status,reply,_=node.http('POST','/v1/participants/register',current_request)
                    observed.append({'case':label,'request':current_request,'status':status,'body':reply,'before':t,'after':time.time(),'durable':snapshot(node),'seed':before,'startupRecovered':recovered})
                    if name.startswith('bridge'):
                        assert status == 200 and reply['status'] == 'registered', reply
                        assert reply['identity']['runtimeId'] == prior['runtimeId'], reply
                        selection = reply['continuation']
                        if name == 'bridge':
                            assert selection['carried'] is True, reply
                            assert selection['selected'] == {'provider':'pi','key':'foundry-conversation'}, reply
                        else:
                            reason = {'bridge-fresh':'participant_fresh', 'bridge-disabled':'reuse_disabled',
                                      'bridge-invalidated':'continuation_invalidated'}[name]
                            assert selection['carried'] is False and selection['reason'] == reason, reply
                    if label=='foundry-continue':retired_seed=snapshot(node)
                node.down(proc);proc=None
            results[owner]=observed
            directory=a.artifacts/owner;directory.mkdir(exist_ok=True)
            (directory/'observations.json').write_text(json.dumps(observed,indent=2)+'\n')
        failed = judge(results['native'], a.artifacts)
        print(json.dumps({'suite':'participant-succession','cases':len(results['native']),'failed':failed[:20]},indent=1))
        if failed:
            raise SystemExit(1)
    finally:
        if proc:node.down(proc)
        (a.artifacts/'steps.json').write_text(json.dumps(node.steps,indent=2)+'\n')
        node.cleanup()


if __name__=='__main__':main()
