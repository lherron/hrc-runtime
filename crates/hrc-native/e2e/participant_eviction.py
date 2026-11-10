#!/usr/bin/env python3
"""Real external broker eviction through terminate and context invalidation.

Failures: runtime stays ready; token retained; attempt reattached after eviction
or owner restart; duplicate audit; broker/presentation killed; address released;
placement or continuation changed. Broker-side credential revocation is unsupported.
"""
import argparse
import json
import hashlib
from pathlib import Path
import sqlite3
import subprocess
from n2_scratch import Scratch
from n2_participant import register, rows
import participant_descriptor


def main():
    p = argparse.ArgumentParser(description=__doc__)
    for key in ('binary', 'installed-release', 'aspd-socket', 'scratch-root', 'artifacts'):
        p.add_argument('--'+key, type=Path, required=True)
    p.add_argument('--broker-module', type=Path, required=True)
    args = p.parse_args()
    args.owner = 'native'
    s = Scratch(args.scratch_root, args.installed_release, args.aspd_socket,
                args.binary, args.artifacts, project_id='n2-t12619')
    source_binary = s.binary
    prefix = 'agent:tabularasa:project:n2-t12619:task:'
    held, report = {}, {'binary':{'source':str(source_binary),'sha256':hashlib.sha256(s.binary.read_bytes()).hexdigest()}}
    log = (s.artifacts/'broker.log').open('w')
    try:
        s.init_substrate()
        (s.root/'run/btmux').mkdir()
        owner = s.up('native', 'eviction')
        for door in ('terminate', 'context'):
            case = report[door] = {}
            scope = prefix+door
            joined = register(s, scope, case, single=False)
            identity = joined['identity']
            rid = identity['runtimeId']
            descriptor = participant_descriptor.scratch(joined, s.root)
            spec = descriptor['harnessInvocation']['startRequest']['spec']
            spec['driver']['kind'] = spec['harness']['driver'] = descriptor['brokerDriver'] = 'noop-driver'
            descriptor['brokerTerminal'] = {'host':'tmux'}
            descriptor = participant_descriptor.seal(descriptor)
            endpoint = s.root/(door+'.sock')
            broker = subprocess.Popen(['bun', str(Path(__file__).with_name('participant_eviction_broker.mjs')),
                'run', str(args.broker_module), '--transport','unix','--socket',str(endpoint),
                '--event-ledger',str(s.root/(door+'.ndjson')),'--join','participant-served'],
                env=dict(s.env, PARTICIPANT_EVICTION_EFFECTS=str(s.root/(door+'-effects.jsonl'))),
                cwd=s.project, stdout=log, stderr=log)
            held.setdefault('brokers', []).append(broker)
            s.wait(lambda: endpoint.exists(), 15, 'fixture broker socket')
            body = {k:identity[k] for k in ('registrationId','attemptId','attachEpoch')}
            body.update(descriptor=descriptor, socketPath=str(endpoint))
            case['attach'] = s.http('POST','/v1/participants/attach',body)
            assert case['attach'][0] == 200, case['attach']
            s.wait(lambda: s.rows("SELECT 1 FROM runtimes WHERE runtime_id=? AND status='ready'", (rid,)),
                   30, 'external ready')
            attempt = s.rows('SELECT * FROM participant_registration_attempts WHERE attempt_id=?',
                             (joined['identity']['attemptId'],))[0]
            intent = json.loads(attempt['hosting_intent_json'])
            token = Path(intent['endpoint']['attachTokenRef']['path'])
            assert token.read_text().strip(), 'positive token control'
            continuation = json.dumps({'provider':'pi', 'key':'eviction-preserve'})
            with sqlite3.connect(s.db_path) as db:
                db.execute("CREATE TABLE IF NOT EXISTS placement_ledger(scope_ref TEXT PRIMARY KEY,home_node_id TEXT,state TEXT,retired_at TEXT,retirement_reason TEXT,created_at TEXT,updated_at TEXT)")
                db.execute("INSERT OR IGNORE INTO placement_ledger VALUES (?, 'n2-t12619', 'active', NULL, NULL, '2026-11-05T00:00:00Z', '2026-11-05T00:00:00Z')", (scope,))
                db.execute('UPDATE sessions SET continuation_json=? WHERE host_session_id=?',
                           (continuation, joined['hostSessionId']))
            def preserved():
                return {t: s.rows('SELECT * FROM '+t) for t in
                        ('participant_address_reservations', 'placement_ledger')}
            # Accepted work can remain open even while the external broker is
            # idle; eviction settles all its observations, not just activeRunId.
            with sqlite3.connect(s.db_path) as db:
                for suffix in ('active', 'other'):
                    db.execute("INSERT INTO runs(run_id,host_session_id,runtime_id,scope_ref,lane_ref,generation,transport,status,accepted_at,updated_at,execution_format) SELECT ?,host_session_id,runtime_id,scope_ref,lane_ref,generation,'headless','accepted',created_at,updated_at,'format1' FROM runtimes WHERE runtime_id=?", (rid+'-'+suffix,rid))
                db.execute('UPDATE runtimes SET active_run_id=? WHERE runtime_id=?', (rid+'-active',rid))
            before = case['preservedBefore'] = preserved()
            case['before'] = rows(s)
            path, request = ('/v1/terminate', {'runtimeId':rid, 'dropContinuation':True,
                                             'reason':'eviction e2e', 'source':'t12619'}) if door == 'terminate' else (
                '/v1/clear-context', {'hostSessionId':joined['hostSessionId'], 'dropContinuation':False})
            case['action'] = s.http('POST', path, request)
            assert case['action'][0] == 200, case['action']
            if door == 'terminate':
                assert case['action'][1]['droppedContinuation'] is False
                case['retry'] = s.http('POST', path, request)
                assert case['retry'][0] == 200, case['retry']
            runtime = s.rows('SELECT * FROM runtimes WHERE runtime_id=?', (rid,))[0]
            assert runtime['status'] == 'terminated' and runtime['lifecycle_terminal_reason'] == 'operator_evict', runtime
            assert not token.exists(), 'HRC attach token must be removed'
            settled = s.rows('SELECT status,completed_at FROM runs WHERE runtime_id=?', (rid,))
            assert len(settled) == 2 and all(r['completed_at'] and r['status']=='failed' for r in settled), settled
            assert broker.poll() is None, 'participant process must survive'
            case['brokerPid'] = broker.pid
            effects = s.root/(door+'-effects.jsonl')
            case['lifecycleCalls'] = effects.read_text() if effects.exists() else ''
            assert case['lifecycleCalls'] == '', 'no broker stop/dispose RPC'
            hosting = json.loads(attempt['realized_hosting_json'])
            tui = hosting['presentation']['tuiWindow']
            subprocess.run(['tmux','-S',tui['socketPath'],'has-session','-t',tui['sessionName']], check=True)
            assert preserved() == before, 'reservation and placement must remain byte-identical'
            assert before['participant_address_reservations'] and all(
                r['state']=='held' for r in before['participant_address_reservations'])
            sessions = s.rows('SELECT continuation_json,continuation_reuse_disabled FROM sessions WHERE host_session_id=?',
                              (joined['hostSessionId'],))
            assert sessions == [{'continuation_json':continuation,'continuation_reuse_disabled':0}], sessions
            audit = s.rows("SELECT payload_json FROM hrc_events WHERE runtime_id=? AND event_kind='runtime.terminated'", (rid,))
            assert len(audit) == 1 and json.loads(audit[0]['payload_json'])['reason']=='operator_evict', audit
            case['reattach'] = s.http('POST', '/v1/participants/attach', body)
            assert case['reattach'][0] == 409 and case['reattach'][1]['reason']=='participant_operator_evicted', case['reattach']
            case['coldBirth'] = s.http('POST', '/v1/targets/ensure', {'sessionRef':scope+'/lane:main','runtimeIntent':{}})
            assert case['coldBirth'][0] == 409, case['coldBirth']
            assert case['coldBirth'][1]['error']['detail']['reason'] == 'host_absent', case['coldBirth']
            assert len(s.rows('SELECT 1 FROM runtimes WHERE scope_ref=?',(scope,))) == 1
            case['proof'] = {'tokenRemoved':not token.exists(), 'brokerAlive':broker.poll() is None,
                             'settledRuns':settled, 'audit':audit, 'preservedAfter':preserved(),
                             'continuation':sessions, 'presentationAlive':True}
            case['after'] = rows(s)
            s.down(owner)
            owner = s.up('native', door+'-restart')
            case['afterRestartAttach'] = s.http('POST', '/v1/participants/attach', body)
            assert case['afterRestartAttach'][0] == 409, case['afterRestartAttach']
            assert not token.exists() and broker.poll() is None
            assert s.rows('SELECT status FROM runtimes WHERE runtime_id=?', (rid,)) == [{'status':'terminated'}]
        report['pass'] = True
    finally:
        report['final'] = rows(s)
        (s.artifacts/'result.json').write_text(json.dumps(report, indent=2)+'\n')
        (s.artifacts/'steps.json').write_text(json.dumps(s.steps, indent=2)+'\n')
        s.cleanup(prefix)
        for attempt in report['final']['participant_registration_attempts']:
            tui = json.loads(attempt.get('realized_hosting_json') or '{}').get('presentation',{}).get('tuiWindow')
            if tui:
                assert Path(tui['socketPath']).is_relative_to(s.root/'run')
                subprocess.run(['tmux','-S',tui['socketPath'],'kill-server'],capture_output=True,timeout=5)
        for broker in held.get('brokers', []):
            if broker.poll() is None:
                broker.terminate()
                broker.wait(timeout=20)
        log.close()
    print(json.dumps({'pass':True,'artifacts':str(s.artifacts)}))


if __name__ == '__main__':
    main()
