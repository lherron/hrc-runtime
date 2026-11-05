#!/usr/bin/env python3
"""Task-seat retirement and hrcpty aging, end to end on one isolated rusthrc (T-12236).

Reuses the hrcpty_substrate.py substrate: a fresh short root with a
Bun-created schema, a FAKE aspd and the stub broker release. Claude seats
(`claude-code-hrcpty`) run the stub's line-echo child; codex seats
(`codex-app-server` on hrcpty) use the real T-12163 aspc response. The
daemon's wrkq client reads a scratch wrkq DB (HRC_WRKQ_DB) holding the seat
tasks, and HRC_TASK_SEAT_IDLE_HOURS=0.02 (72 s) shortens the idle backstop.

Seats (project t12049, agent hrcptye2e):
  A codex  task:T-00001  task completed, a CONT turn stored a continuation
  B claude task:T-00002  task open, idle past the threshold
  C codex  task:T-00003  task completed, a HOLD turn is running at the tick
  D claude task:primary  idle, not a task seat
  E claude task:aging-e  standing seat, its Claude child is SIGKILLed
  F codex  task:aging-f  standing seat, its hrc-pty supervisor is SIGKILLed
E and F are standing seats so retirement never races aging for them.

Checks (no daemon restart: startup reconciliation would judge F first):
  1 aging (the daemon's second 300 s aging pass): E goes `stale` with
    broker_hrcpty_child_exited and stays stale once its lease ends (no
    crash re-mark), F with broker_hrcpty_supervisor_missing; the live seats
    are judged live, never stale
  2 retirement (the first pass, 300 s after boot): A terminated with
    trigger task_completed, B with idle_ttl, both droppedContinuation=false,
    supervisor and children gone; C (busy) and D (standing seat) untouched;
    the tick summary names busy/active_run and standing_seat skips
  3 continuation kept: A's session stays active with the same continuation
    key and reuse enabled; the next turn to A's session births a new runtime
    whose aspc compile request carries that continuation

Never touches the live daemon, the live aspd, the live wrkq ledger or any
shared service. Every process and root it creates is removed on exit.
"""
import argparse
import calendar
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import time
import uuid

from hrcpty_substrate import (FakeAspd, Run, ops, alive, descendants_of, LEAK, PROJECT, AGENT, HERE, REPO)

IDLE_HOURS = '0.02'
TICK_TIMEOUT = 420


class Aspd(FakeAspd):
    """Codex for the scopes the test names, the substrate's Claude otherwise."""
    codex_tasks = set()

    def compile(self, req):
        scope = req['correlation']['scopeRef']
        if scope.rsplit(':task:', 1)[-1] in self.codex_tasks:
            return self.codex(req, scope)
        return super().compile(req)


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--binary', type=Path, default=REPO / 'crates/target/debug/rusthrc')
    p.add_argument('--root', type=Path, default=Path(f'/tmp/h12236-{os.getpid()}'))
    p.add_argument('--artifacts', type=Path, default=Path.home() / 'praesidium/var/wrkq-artifacts/T-12236/e2e')
    p.add_argument('--keep', action='store_true')
    args = p.parse_args()
    binary = args.binary.resolve()
    assert (binary.parent / 'hrc-pty').is_file(), 'build hrc-pty beside rusthrc: cargo build -p hrc-native -p hrc-pty'
    root = args.root.absolute()
    if root.exists():
        raise SystemExit('root must be fresh: ' + str(root))
    root.mkdir(parents=True)
    args.artifacts.mkdir(parents=True, exist_ok=True)
    for stale in [*args.artifacts.glob('daemon-*.log'), args.artifacts / 'summary.json', args.artifacts / 'rows.json']:
        stale.unlink(missing_ok=True)
    r = Run(root, args.artifacts, binary)
    clean = {k: v for k, v in os.environ.items() if not k.startswith(LEAK)}

    # -- substrate ------------------------------------------------------------
    release_root = root / 'release'
    (release_root / 'bin').mkdir(parents=True)
    stub = release_root / 'bin/stub-broker'
    shutil.copy(HERE / 'hrcpty_stub_broker.py', stub)
    stub.chmod(0o755)
    release = {'releaseId': 'stub-broker-t12236', 'sourceCommit': '1' * 40, 'builtAt': '2026-11-01T00:00:00.000Z',
               'releaseRoot': str(release_root),
               'worker': {'protocol': 'harness-broker/0.2', 'executable': str(stub), 'argvPrefix': [],
                          'hostedDrivers': ['claude-code-hrcpty', 'claude-code-tmux', 'codex-app-server']}}
    (release_root / 'release.json').write_text(json.dumps({**{k: release[k] for k in ('releaseId', 'sourceCommit', 'builtAt')},
                                                           'protocol': 'harness-broker/0.2',
                                                           'hostedDrivers': release['worker']['hostedDrivers']}))
    for d in ('run', 'state', PROJECT):
        (root / d).mkdir()
    subprocess.run(['git', 'init', '-q'], cwd=root / PROJECT, check=True, env=clean)
    subprocess.run(['bun', '-e', 'import {openHrcDatabase} from "./packages/hrc-store-sqlite/src/database.ts";'
                    'openHrcDatabase(process.argv[1]).close()', str(r.db_path)],
                   cwd=REPO, check=True, capture_output=True, env=clean)
    config = root / 'federation.json'
    config.write_text(json.dumps({'nodeId': 'h12236', 'peers': {}, 'gate': {'mode': 'off'}}))
    config.chmod(0o600)

    # -- scratch wrkq ledger: T-00001..T-00005 --------------------------------
    wrkq_db = root / 'wrkq.db'
    wenv = {**clean, 'WRKQ_DB': str(wrkq_db), 'WRKQD_TOKEN': '', 'WRKQD_TOKEN_FILE': '', 'WRKQ_PRINCIPAL_REF': 'agent:e2e'}
    wrkq = lambda *a: subprocess.run([str(Path.home() / ".local/bin/wrkq"), *a], env=wenv, cwd=root, check=True, capture_output=True, text=True).stdout
    subprocess.run(['wrkqadm', 'migrate'], env=wenv, cwd=root, check=True, capture_output=True)
    wrkq('mkdir', '/e2e', '--kind', 'project')
    tasks = [json.loads(wrkq('touch', f'/e2e/seat-{n}', '-t', f'seat {n}', '--json'))[0]['id'] for n in range(1, 4)]
    assert tasks == ['T-00001', 'T-00002', 'T-00003'], tasks
    shown = subprocess.run([str(Path.home() / ".local/bin/wrkq"), 'rpc', '--stdio'], env=wenv, input='\n'.join(json.dumps(f) for f in (
        {'jsonrpc': '2.0', 'id': 1, 'method': 'rpc.initialize', 'params': {'protocolVersion': '2026-06-30', 'client': {'name': 'e2e', 'version': '0'}}},
    )) + '\n', capture_output=True, text=True).stdout
    db_path = json.loads(shown.splitlines()[0])['result']['database']['path']
    r.check('0.wrkq-is-scratch', Path(db_path).resolve() == wrkq_db.resolve(), databasePath=db_path)

    aspd_socket = root / 'aspd.sock'
    Aspd.codex_tasks = {'T-00001', 'T-00003', 'aging-f'}
    aspd = Aspd(aspd_socket, release, args.artifacts / 'fake-aspd.ndjson')
    env = dict(clean)
    env.update(HRC_RUNTIME_DIR=str(root / 'run'), HRC_STATE_DIR=str(root / 'state'), HRC_ASPD_SOCKET=str(aspd_socket),
               ASP_PROJECT_ROOT_OVERRIDE=str(root / PROJECT), HRC_PROJECT_SEARCH_ROOTS=str(root / PROJECT),
               HRC_WRKQ_DB=str(wrkq_db), WRKQ_DB=str(wrkq_db), HRC_WRKQD_TOKEN_FILE='',
               WRKQD_TOKEN_FILE='', WRKQD_TOKEN='', HRC_PEER_CONFIG_FILE=str(config),
               HRC_EVENT_INGEST_SOCKET=str(root / 'run/ingest.sock'), HRC_ACP_WEBHOOK_URL='',
               HRC_BROKER_DURABLE_IPC_ENABLED='1', ASP_HOME=str(root / 'asp-home'),
               HRC_TASK_SEAT_IDLE_HOURS=IDLE_HOURS)
    r.env = env
    print(f'root {root}\nbinary {binary}\nartifacts {args.artifacts}', flush=True)

    seats = {}
    failure = None
    try:
        daemon = r.up('1')

        def birth(name, task, prompt):
            ref = f'agent:{AGENT}:project:{PROJECT}:task:{task}/lane:main'
            status, out = r.http('POST', '/v1/sessions/resolve', {'sessionRef': ref, 'create': True, 'summonIntent': 'explicit_local'})
            assert status == 200, (status, out)
            host = out['hostSessionId']
            intent = {'placement': {'agentRoot': str(root / PROJECT), 'projectRoot': str(root / PROJECT), 'cwd': str(root / PROJECT),
                                    'runMode': 'task', 'bundle': {'kind': 'compose', 'compose': []}, 'dryRun': False},
                      'harness': {'provider': 'anthropic', 'interactive': True}}
            status, out = r.http('POST', '/v1/turns', {'hostSessionId': host, 'prompt': prompt, 'runtimeIntent': intent})
            assert status in (200, 202), ('birth', name, status, out)
            seat = {'name': name, 'task': task, 'ref': ref, 'host': host, 'rt': out['runtimeId'], 'run': out['runId'],
                    'intent': intent}
            row = r.runtime(seat['rt'])
            sub = row['state'].get('broker', {}).get('substrate', {})
            seat.update(sock=Path(sub.get('socketPath', '/nonexistent')), pid=sub.get('pid'))
            seat['token'] = seat['sock'].parent / 'attach.token'
            seats[name] = seat
            return seat

        def settle_claude(seat):
            """Answer the stub's AskUserQuestion so the first turn completes."""
            r.wait(lambda: r.rows("SELECT 1 FROM hrc_events WHERE run_id=? AND event_kind='turn.tool_call'", (seat['run'],)), 60, 'ask')
            status, out = r.http('POST', '/v1/active-run-contributions', {
                'inputApplicationId': 'app-' + uuid.uuid4().hex, 'inputAttemptId': 'att-' + uuid.uuid4().hex,
                'prompt': 'answer', 'selector': {'runtimeId': seat['rt']}})
            assert status == 200, (status, out)
            settled(seat)

        def settled(seat):
            r.wait(lambda: r.rows("SELECT 1 FROM runs WHERE run_id=? AND status='completed'", (seat['run'],)), 60, seat['name'] + ' turn')
            r.wait(lambda: r.runtime(seat['rt'])['status'] == 'ready', 30, seat['name'] + ' ready')

        a = birth('A', 'T-00001', 'first turn CONT')
        settled(a)
        b = birth('B', 'T-00002', 'first turn')
        settle_claude(b)
        c = birth('C', 'T-00003', 'first turn')
        settled(c)
        d = birth('D', 'primary', 'first turn')
        settle_claude(d)
        e = birth('E', 'aging-e', 'first turn')
        settle_claude(e)
        f = birth('F', 'aging-f', 'first turn')
        settled(f)
        wrkq('set', 'T-00001', '--state', 'completed')
        wrkq('set', 'T-00003', '--state', 'completed')
        for s in seats.values():
            r.check(f'0.{s["name"]}.born-hrcpty', r.runtime(s['rt'])['transport'] == 'hrcpty' and alive(s['pid']),
                    runtimeId=s['rt'], pid=s['pid'])
        session_a = r.rows('SELECT status, continuation_json, continuation_reuse_disabled FROM sessions WHERE host_session_id=?',
                           (a['host'],))[0]
        key_a = json.loads(session_a['continuation_json'] or '{}').get('key')
        r.check('0.A.continuation-stored', bool(key_a), session=session_a)

        # == 1. aging: kill E's child and F's supervisor on the running daemon
        booted = time.time()
        e_child = ops(e['sock'], e['token'], 'status')['status']['child']['pid']
        f_status = ops(f['sock'], f['token'], 'status')['status']
        os.kill(e_child, signal.SIGKILL)
        os.kill(f['pid'], signal.SIGKILL)
        r.wait(lambda: not alive(e_child) and not alive(f['pid']), 10, 'killed')
        time.sleep(2)
        r.check('1.pre-pass-still-ready', r.runtime(e['rt'])['status'] == 'ready' and r.runtime(f['rt'])['status'] == 'ready',
                E=r.runtime(e['rt'])['status'], F=r.runtime(f['rt'])['status'])
        boot_line = [l for l in r.daemon_log('1') if l.get('event') == 'runtime.hrcpty_aging_complete']
        r.check('1.boot-pass-ran', len(boot_line) == 1, lines=boot_line)
        booted = calendar.timegm(time.strptime(boot_line[0]['ts'][:19], '%Y-%m-%dT%H:%M:%S')) if boot_line else booted
        # == 2. retirement: C runs a held turn across the first pass ==========
        time.sleep(max(0, booted + 240 - time.time()))
        status, held = r.http('POST', '/v1/turns', {'hostSessionId': c['host'], 'prompt': 'HOLD across the tick',
                                                    'runtimeIntent': c['intent']})
        assert status in (200, 202), (status, held)
        r.wait(lambda: r.runtime(c['rt'])['active_run_id'] == held['runId'], 30, 'held turn')
        r.wait(lambda: [l for l in r.daemon_log('1') if l.get('event') == 'runtime.seat_retirement_complete']
               and len([l for l in r.daemon_log('1') if l.get('event') == 'runtime.hrcpty_aging_complete']) > 1, TICK_TIMEOUT,
               'retirement pass')
        log = r.daemon_log('1')
        passes = [l['data'] for l in log if l.get('event') == 'runtime.hrcpty_aging_complete']
        aging = passes[1] if len(passes) > 1 else {}
        time.sleep(3)
        e_row, f_row = r.runtime(e['rt']), r.runtime(f['rt'])
        r.check('1.E.child-exit-stale', e_row['status'] == 'stale'
                and e_row['state'].get('staleReason') == 'broker_hrcpty_child_exited'
                and not r.events(e['rt'], 'runtime.crashed'), status=e_row['status'],
                reason=e_row['state'].get('staleReason'), crashed=r.events(e['rt'], 'runtime.crashed'))
        r.check('1.F.supervisor-gone-stale', f_row['status'] == 'stale'
                and f_row['state'].get('staleReason') == 'broker_hrcpty_supervisor_missing', status=f_row['status'],
                reason=f_row['state'].get('staleReason'))
        r.check('1.E.lease-ended', not alive(e['pid']), supervisor=e['pid'])
        r.check('1.aging-summary', aging.get('stale') == 2 and aging.get('errors') == 0
                and all(r.runtime(seats[n]['rt'])['status'] != 'stale' for n in 'ABCD'), passes=passes)
        r.notes.append({'orphanBrokerAfterSupervisorKill': {'pid': f_status['broker']['pid'], 'alive': alive(f_status['broker']['pid'])}})
        tick = [l for l in log if l.get('event') == 'runtime.seat_retirement_complete'][0]['data']
        retired = {l['data']['runtimeId']: l['data'] for l in log if l.get('event') == 'runtime.seat_retired'}
        (args.artifacts / 'tick.json').write_text(json.dumps({'summary': tick, 'retired': retired, 'aging': aging}, indent=1) + '\n')
        for s, trigger in ((a, 'task_completed'), (b, 'idle_ttl')):
            row = r.runtime(s['rt'])
            ev = [x['payload'] for x in r.events(s['rt'], 'runtime.terminated')]
            r.check(f'2.{s["name"]}.retired-{trigger}', row['status'] == 'terminated' and retired.get(s['rt'], {}).get('trigger') == trigger
                    and ev and ev[-1].get('reason') == trigger and ev[-1].get('source') == 'hrc-seat-retirement'
                    and ev[-1].get('droppedContinuation') is False, status=row['status'], line=retired.get(s['rt']), events=ev)
            r.wait(lambda: not alive(s['pid']), 15, s['name'] + ' supervisor gone')
            r.check(f'2.{s["name"]}.processes-gone', not alive(s['pid']) and not descendants_of([str(s['sock'].parent)]),
                    leftovers=descendants_of([str(s['sock'].parent)]))
        c_row, d_row = r.runtime(c['rt']), r.runtime(d['rt'])
        r.check('2.C.busy-untouched', c_row['status'] in ('ready', 'busy') and c_row['active_run_id'] == held['runId']
                and c['rt'] not in retired, status=c_row['status'], activeRun=c_row['active_run_id'])
        r.check('2.D.primary-untouched', d_row['status'] == 'ready' and d['rt'] not in retired, status=d_row['status'])
        reasons = tick.get('skippedByReason', {})
        r.check('2.tick-summary', tick.get('retired') == 2 and tick.get('retiredByTrigger') == {'idle_ttl': 1, 'task_completed': 1}
                and reasons.get('standing_seat') in (1, 3) and (reasons.get('busy', 0) + reasons.get('active_run', 0)) == 1
                and tick.get('errors') == 0 and tick.get('idleThresholdHours') == float(IDLE_HOURS), summary=tick)

        # == 3. continuation kept; the next turn resumes it ===================
        after = r.rows('SELECT status, continuation_json, continuation_reuse_disabled FROM sessions WHERE host_session_id=?',
                       (a['host'],))[0]
        r.check('3.A.session-active-same-key', after['status'] == 'active' and json.loads(after['continuation_json'] or '{}').get('key') == key_a
                and not after['continuation_reuse_disabled'], before=session_a, after=after)
        status, resumed = r.http('POST', '/v1/turns', {'hostSessionId': a['host'], 'prompt': 'after retirement',
                                                       'runtimeIntent': a['intent']})
        ok = status in (200, 202) and resumed.get('runtimeId') not in (None, a['rt'])
        compiled = []
        if ok:
            # The continuation reaches the harness through the compile request.
            compiled = r.wait(lambda: [f['request']['params']['compileRequest'].get('continuation') for f in
                                       map(json.loads, (args.artifacts / 'fake-aspd.ndjson').read_text().splitlines())
                                       if f.get('request', {}).get('method') == 'aspc.compileHarnessInvocation'
                                       and f['request']['params']['compileRequest'].get('identity', {}).get('runtimeId')
                                       == resumed['runtimeId']], 30, 'resumed compile')
        r.check('3.A.next-turn-new-runtime', ok, status=status, response=resumed)
        r.check('3.A.resume-compiles-with-continuation', bool(compiled) and (compiled[-1] or {}).get('hrc', {}).get('key') == key_a,
                key=key_a, continuation=compiled[-1] if compiled else None)
        r.down(daemon)
    except Exception as error:  # noqa: BLE001 - recorded as a failed check
        import traceback
        failure = traceback.format_exc()
        print(failure, flush=True)
        r.check('harness-completed', False, error=repr(error)[:3000])
    finally:
        for proc in r.owners:
            if proc.poll() is None:
                proc.terminate()
                try:
                    proc.wait(timeout=20)
                except subprocess.TimeoutExpired:
                    proc.kill()
        for s in seats.values():
            if s.get('pid') and alive(s['pid']):
                os.kill(s['pid'], signal.SIGKILL)
        for pid, _ in descendants_of([str(root), root.name]):
            if pid != os.getpid():
                try:
                    os.kill(pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
        aspd.close()
        for log in r.logs:
            log.close()
        if r.db_path.exists():
            dump = {t: r.rows(f'SELECT * FROM {t}') for t in ('runtimes', 'sessions', 'runs')}
            dump['hrc_events'] = r.rows("SELECT hrc_seq,ts,event_kind,runtime_id,run_id,payload_json FROM hrc_events "
                                        "WHERE event_kind IN ('runtime.terminated','runtime.stale') ORDER BY hrc_seq")
            (args.artifacts / 'rows.json').write_text(json.dumps(dump, indent=1, default=str) + '\n')
        remaining = [l for _, l in descendants_of([str(root), root.name])]
        r.check('cleanup.no-leftover-processes', not remaining, remaining=remaining)
        if not args.keep:
            shutil.rmtree(root, ignore_errors=True)
        summary = {'pass': all(c['pass'] for c in r.checks), 'root': str(root), 'binary': str(binary),
                   'seats': {k: v['rt'] for k, v in seats.items()}, 'checks': r.checks, 'notes': r.notes, 'failure': failure}
        (args.artifacts / 'summary.json').write_text(json.dumps(summary, indent=1, default=str) + '\n')
        print('\n'.join(f"{'PASS' if c['pass'] else 'FAIL'}  {c['check']}" for c in r.checks))
        print(json.dumps({'pass': summary['pass'], 'checks': len(r.checks), 'failed': [c['check'] for c in r.checks if not c['pass']]}))
    sys.exit(0 if summary['pass'] else 1)


if __name__ == '__main__':
    main()
