#!/usr/bin/env python3
"""T-13440 no-input launch acceptance; isolated daemon, real hrc-pty.

Failures: declaration projection/empty command; duplicate child; identity on argv;
wrong file modes; absent descriptor/early exit leaks; external row drift; missing
attach or stream bytes. Reuses ASP's exported noop participant broker, not a new
broker implementation. --baseline records the external row before source edits.
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import signal
import sqlite3
import socket
import struct
import subprocess
import sys
import time
from urllib.parse import urlencode
from hrcpty_substrate import Run, FakeAspd, LEAK
from foundation import daemon_env
import participant_descriptor
from n4_federation import local_tailnet_address, free_port

HERE = Path(__file__).resolve().parent

class Aspd(FakeAspd):
    def __init__(self, root, commands, log):
        self.root, self.commands = root, commands
        super().__init__(root/'aspd.sock', {}, log)

    def handle(self, method, params):
        if method == 'aspc.hello':
            hello = super().handle(method, params)
            hello['capabilities']['resolveRuntimeDeclaration'] = True
            return hello
        if method == 'aspc.resolveRuntimeDeclaration':
            c = params['context']; agent = c['agentId']
            placement = {'pins': {}, 'homes': {c.get('taskId', 'launch'): getattr(self, 'node_id', 'selftest')}}
            if agent in self.commands:
                placement.update(launch='self-brokered', launchCommand=self.commands[agent])
            elif agent == 'held': placement['launch'] = 'participant-only'
            return {'schemaVersion':'aspc-resolve-runtime-declaration-response/v1','ok':True,
                    'source':{'agentProfile':{'state':'present'}},
                    'placement':{'agentRoot':str(self.root/'agents'/agent),'projectRoot':str(self.root/'t12049'),
                                 'cwd':str(self.root/'t12049'),'runMode':c['runMode']},
                    'policy':{'claimsTask':False,'placement':placement},
                    'identity':{'operator':False},'agentSources':{},'provisioning':{'scalars':{},'effectiveHarness':'agent-harness'},'diagnostics':[]}
        raise AssertionError('Self-brokered birth must never compile: '+method)

LAUNCHER = r'''
import json, os, sys, time
from pathlib import Path
sys.path.insert(0, E2E)
import participant_descriptor as d
mode, module, *flags = sys.argv[1:]
a = dict(zip(flags[::2],flags[1::2])); root=Path(a['--registration']).parent
(root/'argv.json').write_text(json.dumps(sys.argv[1:]))
(root/'child.pid').write_text(str(os.getpid()))
if globals().get('SPAWNS'):
    with open(SPAWNS,'a') as f: f.write(json.dumps({'pid':os.getpid(),'registration':a['--registration'],'at':time.time()})+'\n')
print('SELF-BROKERED-TERMINAL',flush=True)
if mode == 'exit': sys.exit(23)
if mode == 'stall':
    while True: time.sleep(1)
j=json.loads(Path(a['--registration']).read_text())
v=d.scratch(j, a['--project-root']); s=v['harnessInvocation']['startRequest']['spec']
s['driver']['kind']=s['harness']['driver']=v['brokerDriver']='noop-driver'
if mode == 'establish': s['driver']['kind']=s['harness']['driver']=v['brokerDriver']='unsupported-launch-driver'
if mode == 'turn':
    # T-13441: a seat that completes turns; it continues what HRC offered.
    s['driver']['kind']=s['harness']['driver']=v['brokerDriver']='turn-stub-driver'
    if (j.get('continuation') or {}).get('carried'): s['continuation']=j['continuation']['selected']
    BROKER=TURN_BROKER
v=d.seal(v)
if mode == 'bad': v['descriptorHash']='invalid'
dest=Path(a['--descriptor-out']); tmp=dest.with_suffix('.tmp')
tmp.write_text(json.dumps(v)); tmp.rename(dest)
os.environ['PARTICIPANT_EVICTION_EFFECTS']=str(root/'effects.jsonl')
os.execvp('bun',['bun',BROKER,'run',module,'--transport','unix','--socket',a['--broker-socket'],
                       '--event-ledger',str(root/'events.ndjson'),'--join','participant-served'])
'''

def session_invariants(r):
    """One snapshot: every live HRC participant has exactly its current session."""
    rows=r.rows("""SELECT p.scope_ref,p.lane_ref,p.host_session_id,c.active_host_session_id,
        (SELECT COUNT(*) FROM sessions s WHERE s.scope_ref=p.scope_ref AND s.lane_ref=p.lane_ref AND s.status='active') AS active_count,
        (SELECT status FROM sessions s WHERE s.host_session_id=p.host_session_id) AS session_status
        FROM participant_registrations p LEFT JOIN continuities c ON c.scope_ref=p.scope_ref AND c.lane_ref=p.lane_ref
        WHERE p.lifecycle_owner='hrc-launched' AND EXISTS(SELECT 1 FROM runtimes r WHERE r.host_session_id=p.host_session_id AND r.status IN ('ready','busy'))""")
    for row in rows:
        assert row['active_count']==1 and row['session_status']=='active' and row['host_session_id']==row['active_host_session_id'],row
    return rows

def claim_body(r, scope, key, policy='reject'):
    """Source-derived prae seat summon: praesidium-kernel hrc_writes.rs:324-415.

    Mable approved direct HTTP acceptance for T-13451; installed prae is a
    separate post-deploy boundary. No existence-dependent fields in this body.
    """
    agent = scope.split(':')[1]
    resolved = r.http('POST', '/v1/declarations/resolve', {
        'agentId': agent, 'agentRoot': str(r.root/'agents'/agent),
        'cwd': str(r.root/'t12049'), 'projectRoot': str(r.root/'t12049'),
        'runMode': 'task', 'interactive': False, 'preferredMode': 'nonInteractive'})
    assert resolved[0] == 200, resolved
    intent = resolved[1]['intent']
    intent.setdefault('presentation', {})['operator'] = 'none'
    return {'runtimeIntent': intent, 'idempotencyKey': key, 'conflictPolicy': policy,
            'summonIntent': 'implicit' if policy == 'reject' else 'explicit_local',
            'sessionRef' if policy == 'reject' else 'baseSessionRef': scope+'/lane:main'}

def gates(r, root, report, call, scope, target, a_log):
    """T-13441: births caused by an input (contract 5.1): G1, G8, G2, G3, mail, lazy.

    Every turn's completion is read from its run row, never the HTTP reply.
    """
    import concurrent.futures
    def enqueue(agent, word, **extra):
        body = {'target': scope(agent)+'/lane:main', 'body': 'Reply '+word,
                'origin': {'principalRef': 'agent:clod'}, 'wait': True}
        body.update(extra)
        return call('/v1/submissions/enqueue', body)
    def attempts(agent):
        return r.rows('SELECT a.* FROM participant_registration_attempts a JOIN participant_registrations p USING(registration_id) WHERE p.scope_ref=? ORDER BY a.attach_epoch', (scope(agent),))
    def counts(agent):
        sc = scope(agent)
        return {'registrations': len(r.rows('SELECT 1 FROM participant_registrations WHERE scope_ref=?', (sc,))),
                'attempts': len(attempts(agent)),
                'bindings': len(r.rows('SELECT 1 FROM participant_host_bindings b JOIN participant_registrations p USING(registration_id) WHERE p.scope_ref=?', (sc,))),
                'sessions': len(r.rows('SELECT 1 FROM sessions WHERE scope_ref=?', (sc,))),
                'activeHost': r.rows('SELECT active_host_session_id FROM continuities WHERE scope_ref=?', (sc,))[0]['active_host_session_id'],
                'generation': r.rows('SELECT generation FROM participant_registrations WHERE scope_ref=?', (sc,))[0]['generation']}
    def regfile(runtime_id):
        f = next(f for f in (root/'run/bipc').glob('*/registration.json') if json.loads(f.read_text())['identity']['runtimeId'] == runtime_id)
        return f.parent, json.loads(f.read_text())
    def spawns(agent):
        p = root/'spawns.jsonl'
        lines = [json.loads(l) for l in p.read_text().splitlines()] if p.exists() else []
        return [x for x in lines if json.loads(Path(x['registration']).read_text())['scopeRef'] == scope(agent)]
    def completed(reply):
        assert reply[0] == 200 and reply[1].get('runId'), reply
        run_id = reply[1]['runId']
        r.wait(lambda: r.rows("SELECT 1 FROM runs WHERE run_id=? AND status='completed'", (run_id,)), 60)
        run = r.rows('SELECT * FROM runs WHERE run_id=?', (run_id,))[0]
        turn = r.rows("SELECT 1 FROM hrc_events WHERE event_kind='turn.completed' AND run_id=?", (run_id,))
        assert turn, ('no turn.completed for', run_id)
        return run
    def alive(pid):
        try: os.kill(pid, 0); return True
        except ProcessLookupError: return False
    def seat_pids(directory):
        return {name: int((directory/name).read_text()) for name in ('hrcpty.pid', 'child.pid') if (directory/name).exists()}
    def end_seat(rt, drop=False):
        """End a live self-brokered seat with what exists before T-13442's terminate."""
        directory, _ = regfile(rt)
        pids = seat_pids(directory)
        body = {'runtimeId': rt}
        if drop: body['dropContinuation'] = True
        reply = call('/v1/terminate', body)
        record = {'terminate': reply, 'pids': pids}
        deadline = time.time()+30
        while time.time() < deadline and any(alive(p) for p in pids.values()): time.sleep(.2)
        record['aliveAfterTerminate'] = {k: alive(p) for k, p in pids.items()}
        a = r.rows('SELECT state FROM participant_registration_attempts WHERE runtime_id=?', (rt,))[0]['state']
        record['attemptAfterTerminate'] = a
        record['runtimeAfterTerminate'] = r.runtime(rt)['status']
        # G-one: the predecessor's supervisor and child are gone before any later spawn.
        assert not any(record['aliveAfterTerminate'].values()), record
        assert a == 'TERMINAL' and record['runtimeAfterTerminate'] == 'terminated', record
        record['endedAt'] = time.time()
        return record
    def declarations(agent):
        lines = [json.loads(l) for l in (a_log).read_text().splitlines()]
        return [l for l in lines if (l.get('request') or {}).get('method') == 'aspc.resolveRuntimeDeclaration'
                and l['request']['params']['context']['agentId'] == agent]
    def knocks():
        return r.rows("SELECT payload_json FROM hrc_events WHERE event_kind='participant.host_requested'")

    g = report.setdefault('gates', {})
    # Participant-only control in the same daemon (S1 seeds it on a full run).
    if not r.rows('SELECT 1 FROM participant_registrations WHERE scope_ref=?', (scope('held'),)):
        held = call('/v1/participants/register', {'registrationMode': 'direct', 'requestedSessionRef': scope('held'),
            'hostIncarnationId': 'absent-external', 'workspaceCwd': str(root/'t12049'), 'socketPath': str(root/'absent.sock')})
        assert held[0] == 200, held
        with sqlite3.connect(r.db_path) as db:
            db.execute("UPDATE participant_registration_attempts SET state='ABANDONED',establishment_work_state='completed' WHERE attempt_id=?", (held[1]['identity']['attemptId'],))
            db.execute("UPDATE participant_host_bindings SET state='RETIRED',disposition_reason='scratch_absent_host',retired_at='2026-11-12T00:00:00Z' WHERE runtime_id=?", (held[1]['identity']['runtimeId'],))

    # G1: an enqueue to a self-brokered scope with no runtime births it on hrcpty.
    ensured = target('turn')
    k0 = len(knocks())
    control = enqueue('held', 'HELD')
    assert control[0] == 503 and control[1]['error']['code'] == 'runtime_unavailable', control
    # Never attached, so participant resolution answers pending (no knock); the
    # ensure door, which reaches the absent host, knocks once.
    assert control[1]['error']['detail']['reason'] == 'participant_attachment_pending', control
    ensure_held = call('/v1/targets/ensure', {'sessionRef': scope('held')+'/lane:main', 'runtimeIntent': {}})
    assert ensure_held[0] == 409 and ensure_held[1]['error']['detail']['reason'] == 'host_absent', ensure_held
    assert len(knocks()) == k0+1, 'participant-only ensure must knock once'
    assert not r.rows("SELECT 1 FROM runtimes WHERE scope_ref=?", (scope('held'),)), 'participant-only scope must never be born'
    first = enqueue('turn', 'ONE')
    run1 = completed(first)
    rt1 = first[1]['runtimeId']
    d1, reg1 = regfile(rt1)
    row1 = r.runtime(rt1)
    assert row1['transport'] == 'hrcpty' and row1['status'] in ('ready', 'busy'), row1
    assert row1['state']['participant']['lifecycleOwner'] == 'hrc-launched', row1['state']
    assert run1['host_session_id'] == reg1['hostSessionId'] and run1['generation'] == reg1['generation'], (run1, reg1)
    assert run1['runtime_id'] == rt1
    attach = r.http('GET', '/v1/attach?'+urlencode({'runtimeId': rt1}))
    assert attach[0] == 200 and 'hrcpty' in json.dumps(attach), attach
    trace = [json.loads(e['payload_json']) for e in r.rows("SELECT payload_json FROM hrc_events WHERE event_kind='submission.admission' AND run_id=?", (run1['run_id'],))]
    steps = {t['step']: t['outcome'] for t in trace[0]['trace']}
    assert steps['participant-resolution'] == 'passed' and steps['rotation'] == 'passed', trace
    assert len(spawns('turn')) == 1
    session1 = r.rows('SELECT * FROM sessions WHERE host_session_id=?', (reg1['hostSessionId'],))[0]
    key1 = json.loads(session1['continuation_json'])['key']
    g['G1'] = {'pass': True, 'reply': first, 'run': run1, 'registration': reg1, 'ensuredSession': ensured,
               'admissionTrace': trace[0], 'attach': attach, 'control': {'enqueue': control, 'ensure': ensure_held}, 'knocksAdded': 1,
               'sessionContinuation': session1['continuation_json']}

    # A second input into the live seat is delivered there, and reads no declaration.
    asked = len(declarations('turn'))
    again = enqueue('turn', 'AGAIN')
    run1b = completed(again)
    assert again[1]['runtimeId'] == rt1 and run1b['generation'] == reg1['generation'] and len(spawns('turn')) == 1, again
    assert len(declarations('turn')) == asked, 'a live self-brokered seat is resolved without an aspd declaration read'
    g['G1']['liveSecondInput'] = {'reply': again, 'run': run1b, 'declarationReads': 0}

    # End the first seat, continuation kept.
    ended1 = end_seat(rt1)
    g['end1'] = ended1

    # G8: freshContext on the retired scope is refused after participant resolution and changes nothing.
    before = counts('turn'); spawned = len(spawns('turn'))
    refused = enqueue('turn', 'FRESH', freshContext=True)
    after = counts('turn')
    assert refused[0] == 503 and refused[1]['error']['detail']['reason'] == 'participant_rotation_unsupported', refused
    assert before == after and len(spawns('turn')) == spawned, (before, after)
    g['G8'] = {'pass': True, 'refused': refused, 'before': before, 'after': after}

    # G2: the next plain enqueue births generation + 1 on a new host session, carrying the continuation.
    second = enqueue('turn', 'TWO')
    run2 = completed(second)
    rt2 = second[1]['runtimeId']
    d2, reg2 = regfile(rt2)
    assert reg2['generation'] == reg1['generation']+1, (reg1['generation'], reg2['generation'])
    assert run2['host_session_id'] == reg2['hostSessionId'] != reg1['hostSessionId'], (run2, reg2)
    assert run2['generation'] == reg2['generation']
    assert r.rows('SELECT status FROM sessions WHERE host_session_id=?', (reg1['hostSessionId'],))[0]['status'] == 'archived'
    assert reg2['continuation']['carried'] and reg2['continuation']['selected']['key'] == key1, reg2['continuation']
    session2 = r.rows('SELECT * FROM sessions WHERE host_session_id=?', (reg2['hostSessionId'],))[0]
    assert json.loads(session2['continuation_json'])['key'] == key1, 'the successor continued the same conversation'
    ended2 = end_seat(rt2, drop=True)
    third = enqueue('turn', 'THREE')
    run3 = completed(third)
    d3, reg3 = regfile(third[1]['runtimeId'])
    a3 = r.rows('SELECT continuation_carried,continuation_reason FROM participant_registration_attempts WHERE runtime_id=?', (third[1]['runtimeId'],))[0]
    assert reg3['generation'] == reg2['generation']+1 and not reg3['continuation']['carried'], reg3
    # The offer itself was fresh (store reason participant_fresh), not a refused continue.
    assert a3['continuation_reason'] == 'participant_fresh', a3
    for ended, spawn in [(ended1, spawns('turn')[1]), (ended2, spawns('turn')[2])]:
        assert spawn['at'] > ended['endedAt'], (spawn, ended)
    g['G2'] = {'pass': True, 'registrationFiles': {str(d1): reg1, str(d2): reg2, str(d3): reg3},
               'generations': [reg1['generation'], reg2['generation'], reg3['generation']],
               'runs': [run1, run2, run3], 'end2': ended2, 'thirdAttempt': a3}
    end_seat(third[1]['runtimeId'])

    # The turns door: a turn addressed to the retired seat's last host session births generation + 1.
    turn = call('/v1/turns', {'hostSessionId': reg3['hostSessionId'], 'prompt': 'Reply FOUR', 'waitFor': 'terminal'})
    run4 = completed(turn)
    d4, reg4 = regfile(turn[1]['runtimeId'])
    assert reg4['generation'] == reg3['generation']+1 and run4['host_session_id'] == reg4['hostSessionId'], (reg4, run4)
    g['turnsDoor'] = {'pass': True, 'reply': turn, 'run': run4, 'registration': reg4}
    end_seat(turn[1]['runtimeId'])

    # G3: two enqueues together to a scope with no runtime: one spawn, one child.
    target('race')
    with concurrent.futures.ThreadPoolExecutor(2) as pool:
        replies = list(pool.map(lambda w: enqueue('race', w), ['RACE-A', 'RACE-B']))
    ok = [x for x in replies if x[0] == 200]
    refusals = [x for x in replies if x[0] != 200]
    assert ok, replies
    for x in ok: completed(x)
    for x in refusals:
        assert x[0] == 503 and x[1]['error']['code'] == 'runtime_unavailable', x
    race = spawns('race')
    assert len(race) == 1, race
    assert len(attempts('race')) == 1, attempts('race')
    g['G3'] = {'pass': True, 'replies': replies, 'spawns': race,
               'outcome': 'both delivered' if not refusals else 'one delivered, one retryable refusal'}
    if refusals:
        retry = enqueue('race', 'RACE-RETRY'); completed(retry)
        assert len(spawns('race')) == 1, 'a retry after the birth is delivered, not born'
        g['G3']['retry'] = retry

    # An input whose launch fails is answered with the launch's retryable
    # runtime_unavailable; the attempt is abandoned and nothing keeps running.
    target('exit')
    failed = enqueue('exit', 'EXIT')
    assert failed[0] == 503 and failed[1]['error']['code'] == 'runtime_unavailable' and failed[1]['error']['detail']['retryable'], failed
    assert 'leaseError' not in failed[1]['error']['detail'] and 'abandonError' not in failed[1]['error']['detail'], failed
    fa = attempts('exit')[-1]
    assert fa['state'] == 'ABANDONED' and fa['disposition_reason'].startswith('launch_failed'), fa
    assert not r.rows("SELECT 1 FROM runtimes WHERE runtime_id=? AND status IN ('ready','busy')", (fa['runtime_id'],))
    fd, _ = regfile(fa['runtime_id'])
    assert not any(alive(p) for p in seat_pids(fd).values()) and not (fd/'hrcpty.sock').exists()
    assert not r.rows("SELECT 1 FROM runs WHERE scope_ref=?", (scope('exit'),)), 'no run row for an undelivered input'
    g['inputLaunchFailure'] = {'pass': True, 'reply': failed, 'attempt': fa}

    # Mail path: the enqueue door carrying an envelope origin, as mail delivery does.
    target('mail')
    mail = enqueue('mail', 'MAIL', origin={'principalRef': 'agent:clod', 'envelopeId': 'EN-T13441-1'})
    runm = completed(mail)
    adm = r.rows("SELECT envelope_id FROM submission_admissions WHERE run_id=?", (runm['run_id'],))
    assert adm and adm[0]['envelope_id'] == 'EN-T13441-1', adm
    g['mail'] = {'pass': True, 'door': 'POST /v1/submissions/enqueue with origin.envelopeId', 'reply': mail, 'admission': adm}

    # Lazy target: a handoff to a scope with no session; the first registration creates it.
    assert not r.rows('SELECT 1 FROM sessions WHERE scope_ref=?', (scope('lazy'),))
    lazy = call('/v1/messages/turn-handoff', {'from': {'kind': 'entity', 'entity': 'system'},
        'to': {'kind': 'session', 'sessionRef': scope('lazy')+'/lane:main'}, 'body': 'Reply LAZY', 'createIfMissing': True,
        'runtimeIntent': {'placement': {'agentRoot': str(root/'agents/lazy'), 'projectRoot': str(root/'t12049'),
                                        'cwd': str(root/'t12049'), 'runMode': 'task'},
                          'harness': {'id': 'claude-code', 'interactive': False}}})
    g['lazy'] = {'reply': lazy}
    assert lazy[0] == 200, lazy
    sessions = r.rows('SELECT * FROM sessions WHERE scope_ref=?', (scope('lazy'),))
    reg = r.rows('SELECT * FROM participant_registrations WHERE scope_ref=?', (scope('lazy'),))
    assert len(sessions) == 1 and reg and sessions[0]['host_session_id'] == reg[0]['host_session_id'], (sessions, reg)
    assert len(spawns('lazy')) == 1
    runl = completed((200, lazy[1])) if lazy[1].get('runId') else None
    if runl: assert runl['host_session_id'] == reg[0]['host_session_id'], runl
    g['lazy'].update({'pass': True, 'sessions': sessions, 'run': runl})

    # The operator preempt door is also capable of a cold birth. This origin
    # is a private fixture value, never a live caller credential. The stub
    # rejects preempt after launch; still prove allocation's session invariant.
    preempt=call('/v1/submissions/preempt',{'target':scope('turn')+'/lane:main',
        'body':'Reply PREEMPT','origin':{'principalRef':'human:lance'},'wait':True})
    assert preempt[0]==200 and preempt[1]['admission']=='rejected' and preempt[1]['reason']=='unsupported:preempt',preempt
    latest=attempts('turn')[-1]
    assert r.runtime(latest['runtime_id'])['status']=='ready',latest
    g['preempt']={'pass':True,'reply':preempt,'runtimeId':latest['runtime_id'],
                  'sessionInvariant':session_invariants(r)}

def main():
    p=argparse.ArgumentParser(description=__doc__)
    for name in ('binary','scratch-root','artifacts','broker-module'): p.add_argument('--'+name,type=Path,required=True)
    p.add_argument('--baseline',action='store_true')
    p.add_argument('--baseline-summary',type=Path)
    p.add_argument('--gates-only',action='store_true',help='T-13441 gates without S1-S5 (development only)')
    a=p.parse_args(); root=a.scratch_root.absolute(); assert not root.exists(); root.mkdir(parents=True)
    a.artifacts.mkdir(parents=True,exist_ok=True)
    (root/'t12049').mkdir(); (root/'t12049/.praesidium').mkdir()
    (root/'t12049/.praesidium/project.json').write_text(json.dumps({'id':'t12049'}))
    launcher=root/'launcher.py'
    launcher.write_text('E2E='+repr(str(HERE))+'\nBROKER='+repr(str(HERE/'participant_eviction_broker.mjs'))+'\nTURN_BROKER='+repr(str(HERE/'self_brokered_broker.mjs'))+'\nSPAWNS='+repr(str(root/'spawns.jsonl'))+'\n'+LAUNCHER)
    commands={agent:[sys.executable,str(launcher),mode,str(a.broker_module)] for agent,mode in
              [('self','ok'),('exit','exit'),('stall','stall'),('bad','bad'),('establish','establish'),
               ('turn','turn'),('race','turn'),('mail','turn'),('lazy','turn')]}
    commands['invalid']=[]
    for agent in [*commands,'external','held','ordinary']:
        profile=root/'agents'/agent;profile.mkdir(parents=True)
        (profile/'agent-profile.toml').write_text('# Watched declaration fixture; values served by fake aspd.\n')
    fake=Aspd(root,commands,a.artifacts/'aspd.jsonl')
    host=local_tailnet_address()
    (root/'federation.json').write_text(json.dumps({'nodeId':'selftest','peers':{},
        'registry':{'bind':f'http://{host}:{free_port(host)}'},
        'gate':{'mode':'enforce','registryHost':'selftest'}}))
    r=Run(root,a.artifacts,a.binary.resolve())
    r.env=daemon_env(dict({k:v for k,v in os.environ.items() if not k.startswith(LEAK)},HRC_RUNTIME_DIR=str(root/'run'),HRC_STATE_DIR=str(root/'state'),
                         HRC_PEER_CONFIG_FILE=str(root/'federation.json'),HRC_ASPD_SOCKET=str(root/'aspd.sock'),
                         ASP_PROJECT_ROOT_OVERRIDE=str(root/'t12049'),HRC_PROJECT_SEARCH_ROOTS=str(root/'t12049'),HRC_WRKQ_DB=str(root/'wrkq.db'),WRKQ_DB=str(root/'wrkq.db'),HRC_ACP_WEBHOOK_URL=''))
    report={}; brokers=[]
    def call(path,body):
        result=r.http('POST',path,body,timeout=700)
        report.setdefault('sessionInvariants',[]).append({'door':path,'rows':session_invariants(r)})
        return result
    def scope(agent): return 'agent:'+agent+':project:t12049:task:launch'
    def target(agent):
        result=call('/v1/targets/ensure',{'sessionRef':scope(agent)+'/lane:main','runtimeIntent':{}})
        assert result[0]==200,result
        return result[1]['activeHostSessionId']
    def ensure(host): return call('/v1/runtimes/start',{'hostSessionId':host,'intent':{'harness':{'id':'claude-code','interactive':False}}})
    def external():
        j=call('/v1/participants/register',{'registrationMode':'direct','requestedSessionRef':scope('external'),'hostIncarnationId':'external-one','workspaceCwd':str(root/'t12049'),'socketPath':str(root/'external.sock')})
        assert j[0]==200,j
        j=j[1]; d=participant_descriptor.scratch(j,root/'t12049'); s=d['harnessInvocation']['startRequest']['spec']
        s['driver']['kind']=s['harness']['driver']=d['brokerDriver']='noop-driver'; d=participant_descriptor.seal(d)
        log=(a.artifacts/'external.log').open('w')
        b=subprocess.Popen(['bun',str(HERE/'participant_eviction_broker.mjs'),'run',str(a.broker_module),'--transport','unix','--socket',str(root/'external.sock'),'--event-ledger',str(root/'external.ndjson'),'--join','participant-served'],env=dict(r.env,PARTICIPANT_EVICTION_EFFECTS=str(root/'external.effects')),stdout=log,stderr=log)
        brokers.append(b); r.wait(lambda:(root/'external.sock').exists(),15)
        body={k:j['identity'][k] for k in ('registrationId','attemptId','attachEpoch')}; body['descriptor']=d
        attached=call('/v1/participants/attach',body); assert attached[0]==200,attached
        rid=j['identity']['runtimeId']; r.wait(lambda:r.rows("SELECT 1 FROM runtimes WHERE runtime_id=? AND status='ready'",(rid,)),30)
        row=r.runtime(rid)
        return {'transport':row['transport'],'substrate':row['state']['broker']['substrate'],'lifecycleOwner':row['state']['lifecycleOwner']}
    try:
        r.up('self-brokered')
        if a.gates_only:
            gates(r,root,report,call,scope,target,a.artifacts/'aspd.jsonl'); report['pass']=True; return
        report['external']=external()
        if a.baseline:
            report['pass']=True; return
        assert a.baseline_summary
        before=json.loads(a.baseline_summary.read_text())['external']
        assert report['external']==before,(report['external'],before)
        report['S5']={'pass':True,'before':before,'after':report['external']}
        # Same unsupported label on an ordinary profile must still refuse verbatim.
        ordinary=call('/v1/targets/ensure',{'sessionRef':scope('ordinary')+'/lane:main','runtimeIntent':{}})
        expected=f'harness unavailable for {scope("ordinary")}: observed harness "agent-harness" names no supported driver — configure and install a supported harness on this node'
        assert ordinary[0]==409 and ordinary[1]['error']['detail']['reason']=='capability-harness-missing',ordinary
        assert ordinary[1]['error']['message']==expected,ordinary
        report['ordinaryHarnessRefusal']={'pass':True,'reply':ordinary}

        held=call('/v1/participants/register',{'registrationMode':'direct','requestedSessionRef':scope('held'),
            'hostIncarnationId':'absent-external','workspaceCwd':str(root/'t12049'),'socketPath':str(root/'absent.sock')})
        assert held[0]==200,held
        with sqlite3.connect(r.db_path) as db:
            db.execute("UPDATE participant_registration_attempts SET state='ABANDONED',establishment_work_state='completed' WHERE attempt_id=?",(held[1]['identity']['attemptId'],))
            db.execute("UPDATE participant_host_bindings SET state='RETIRED',disposition_reason='scratch_absent_host',retired_at='2026-11-12T00:00:00Z' WHERE runtime_id=?",(held[1]['identity']['runtimeId'],))
        refused=call('/v1/targets/ensure',{'sessionRef':scope('held')+'/lane:main','runtimeIntent':{}})
        assert refused[0]==409 and refused[1]['error']['detail']['reason']=='host_absent',refused
        # Knock attribution is deliberately host-neutral; its payload carries the address.
        knock=r.rows("SELECT payload_json FROM hrc_events WHERE event_kind='participant.host_requested'")
        assert len(knock)==1 and json.loads(knock[0]['payload_json'])['scopeRef']==scope('held'),knock
        report['participantOnly']={'reply':refused,'knock':knock}
        host=target('self'); answer=ensure(host); report['birth']=answer
        assert answer[0]==200,answer
        rid=answer[1]['runtimeId']; row=r.runtime(rid); state=row['state']; substrate=state['broker']['substrate']
        assert row['status']=='ready' and row['transport']=='hrcpty',row
        assert state['lifecycleOwner']=='hrc' and state['participant']['lifecycleOwner']=='hrc-launched',state
        attach=r.http('GET','/v1/attach?'+urlencode({'runtimeId':rid})); report['attach']=attach
        assert attach[0]==200 and 'hrcpty' in json.dumps(attach),attach
        # Same streamed PTY door as Loggia; handshake and raw output discriminated below.
        query={'scopeRef':scope('self'),'laneRef':'main','kind':'pty','mode':'take-control'}
        stream_path='/v1/streams/open?'+urlencode(query)
        report['streamPath']=stream_path
        wire=socket.socket(socket.AF_UNIX); wire.settimeout(10); wire.connect(str(r.socket))
        wire.sendall(('GET '+stream_path+' HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: hrc-stream/1\r\n\r\n').encode())
        f=wire.makefile('rb'); status=f.readline().decode(); assert ' 101 ' in status,status
        while f.readline().strip(): pass
        chunks=b''
        while b'SELF-BROKERED-TERMINAL' not in chunks:
            kind,length=struct.unpack('>BI',f.read(5)); payload=f.read(length)
            assert kind in (1,2),(kind,payload)
            if kind==1: chunks+=payload
        report['streamStatus']=101; report['streamBytes']=chunks.decode(errors='replace')
        f.close(); wire.close()
        report['S1']={'pass':True,'runtime':row,'streamBytes':report['streamBytes'],'participantOnly':report['participantOnly']}
        directory=Path(substrate['socketPath']).parent; registration=json.loads((directory/'registration.json').read_text())
        argv=json.loads((directory/'argv.json').read_text())
        expected=commands['self'][2:]+['--project-root',str(root/'t12049'),'--broker-socket',str(directory/'broker.sock'),'--registration',str(directory/'registration.json'),'--descriptor-out',str(directory/'descriptor.json')]
        assert argv==expected,(argv,expected)
        assert directory.stat().st_mode & 0o777 == 0o700
        assert (directory/'registration.json').stat().st_mode & 0o777 == 0o600
        assert (directory/'attach.token').stat().st_mode & 0o777 == 0o600
        assert max(len(str(directory/name).encode()) for name in ('hrcpty.sock','broker.sock'))<104
        assert registration['identity']['runtimeId']==rid and registration['status']=='registered',registration
        attempt_row=r.rows('SELECT * FROM participant_registration_attempts WHERE runtime_id=?',(rid,))[0]
        reg_row=r.rows('SELECT * FROM participant_registrations WHERE registration_id=?',(registration['identity']['registrationId'],))[0]
        for field,column in [('attemptId','attempt_id'),('runtimeId','runtime_id'),('invocationId','invocation_id'),('requestId','request_id'),('operationId','operation_id'),('attachEpoch','attach_epoch')]:
            assert registration['identity'][field]==attempt_row[column]
        assert registration['hostSessionId']==reg_row['host_session_id'] and registration['generation']==reg_row['generation']
        report['S2']={'pass':True,'argv':argv,'registration':registration,'mode':'0600'}
        second=ensure(registration['hostSessionId']); report['second']=second
        assert second[0]==200 and second[1]['runtimeId']==rid,second
        assert len(r.rows("SELECT * FROM participant_registration_attempts WHERE runtime_id=?",(rid,)))==1
        original_pid=int((directory/'child.pid').read_text());os.kill(original_pid,0)
        assert r.runtime(rid)['state']['broker']['brokerPid']==original_pid
        fresh=call('/v1/runtimes/start',{'hostSessionId':registration['hostSessionId'],'restartStyle':'fresh_pty','intent':{'harness':{'id':'claude-code','interactive':False}}})
        assert fresh[0]==503 and fresh[1]['error']['detail']['reason']=='host_binding_conflict',fresh
        assert len(r.rows("SELECT * FROM participant_registration_attempts WHERE registration_id=?",(registration['identity']['registrationId'],)))==1
        os.kill(original_pid,0)
        report['S4']={'pass':True,'sameRuntime':rid,'sameChildPid':original_pid,'livePredecessorRefusal':fresh}
        failures={}
        for agent in ('exit','stall','bad','establish'):
            h=target(agent); started=time.monotonic(); reply=ensure(h)
            assert reply[0]==503 and reply[1]['error']['code']=='runtime_unavailable' and reply[1]['error']['detail']['retryable'],reply
            attempt=r.rows('SELECT * FROM participant_registration_attempts a JOIN participant_registrations p USING(registration_id) WHERE p.scope_ref=?',(scope(agent),))[0]
            assert attempt['state']=='ABANDONED',attempt
            assert not r.rows("SELECT 1 FROM runtimes WHERE runtime_id=? AND status='ready'",(attempt['runtime_id'],))
            regfiles=list((root/'run/bipc').glob('*/registration.json'))
            regfile=next(f for f in regfiles if json.loads(f.read_text())['identity']['runtimeId']==attempt['runtime_id'])
            assert not (regfile.parent/'hrcpty.sock').exists()
            for pidfile in ('hrcpty.pid','child.pid'):
                path=regfile.parent/pidfile
                if path.exists():
                    try:os.kill(int(path.read_text()),0)
                    except ProcessLookupError:pass
                    else:raise AssertionError('failed launcher process survived: '+str(path))
            processes=subprocess.check_output(['ps','-axo','pid,command'],text=True)
            assert not any('hrc-pty serve' in line and str(regfile.parent/'hrcpty.sock') in line for line in processes.splitlines())
            failures[agent]={'reply':reply,'attempt':attempt,'elapsed':time.monotonic()-started}
        report['S3']={'pass':True,'cases':failures}
        invalid=ensure(target('invalid')); assert invalid[0]>=400 and 'launchCommand' in json.dumps(invalid),invalid
        report['invalidCommand']=invalid
        gates(r,root,report,call,scope,target,a.artifacts/'aspd.jsonl')
        report['pass']=True
    finally:
        report['checks']=r.checks
        (a.artifacts/'summary.json').write_text(json.dumps(report,indent=2,default=str)+'\n')
        # Only processes whose sockets this private root owns.
        for token in (root/'run/bipc').glob('*/attach.token'):
            sock=token.parent/'hrcpty.sock'
            if sock.exists():
                from n2_participant import Rpc
                ops=Rpc(sock)
                try:
                    ops.call('hello',{'token':token.read_text().strip()})
                    ops.call('shutdown',{})
                finally: ops.close()

        for b in brokers:
            if b.poll() is None: b.terminate(); b.wait(timeout=15)
        for owner in r.owners:
            if owner.poll() is None: r.down(owner)
        fake.close()
    print(json.dumps({'pass':True,'artifacts':str(a.artifacts)}))

if __name__=='__main__': main()
