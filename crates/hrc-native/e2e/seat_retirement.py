#!/usr/bin/env python3
"""Seat retirement and hrcpty aging, end to end on one isolated rusthrc (T-12236, T-13432).

Reuses the hrcpty_substrate.py substrate: a fresh short root with a
Rust-created schema, a FAKE aspd and the stub broker release. Claude seats
(`claude-code-hrcpty`) run the stub's line-echo child; codex seats
(`codex-app-server` on hrcpty) use the real T-12163 aspc response. The
daemon's wrkq client reads a scratch wrkq DB (HRC_WRKQ_DB) holding the seat
tasks, and HRC_TASK_SEAT_IDLE_HOURS=0.02 (72 s) shortens the idle backstop.
The Foundry primary window (60 min) is a production constant with no knob: the
suite backdates `runtimes.last_activity_at` of D and G to two hours ago in the
scratch state DB just before the first pass, so the real window is exercised.

Seats (project t12049, agent hrcptye2e unless named):
  A codex  task:T-00001  task completed, a CONT turn stored a continuation
  B claude task:T-00002  task open, idle past the threshold
  C codex  task:T-00003  task completed, a HOLD turn is running at the tick
  D claude task:primary  idle, not a task seat
  E claude task:aging-e  standing seat, its Claude child is SIGKILLed
  F codex  task:aging-f  standing seat, its hrc-pty supervisor is SIGKILLed
  G codex  agent foundry, task:primary, a CONT turn stored a continuation,
           backdated two hours: the Foundry idle rule retires it
  H codex  agent foundry, project t13432h, task:primary, idle past the 72 s
           task window but well under 60 min: not due
D is backdated with G: same task `primary`, same idle age, different agent.
E and F are standing seats so retirement never races aging for them.

Ways the Foundry rule (T-13432) could fail, and the check that catches each:
  - another agent's primary matches the rule (agent ignored): 2.D
  - the rule seat stays a standing_seat (rule never consulted): 2.G.retired
  - the rule seat is judged on the task window, not 60 min: 2.H (H is idle
    past 72 s, so a task-window bug retires it)
  - the rule seat asks wrkq for task `primary` and is skipped as
    task_state_unavailable, or inflates tasksQueried: 2.tick-summary
  - a trigger other than idle_ttl, or a taskState other than null: 2.G.line
  - retirement drops the continuation or archives the session: 2.G retired
    droppedContinuation=false, 3.G.session-active-same-key
  - the next message cannot birth a successor, or births it without the
    continuation: 3.G.next-turn-new-runtime, 3.G.resume-compiles-with-continuation
  - the backdate is overwritten by later seat activity, so the pass never saw
    a 60-minute idle seat: 2.G.line idleMs >= 3600000

Checks (no daemon restart: startup reconciliation would judge F first):
  1 aging (the daemon's second 300 s aging pass): E goes `stale` with
    broker_hrcpty_child_exited and stays stale once its lease ends (no
    crash re-mark), F with broker_hrcpty_supervisor_missing; the live seats
    are judged live, never stale
  2 retirement (the first pass, 300 s after boot): A terminated with
    trigger task_completed, B and G with idle_ttl, all droppedContinuation=false,
    supervisor and children gone; C (busy), D (standing seat) and H (not due)
    untouched; the tick summary names busy/active_run, standing_seat and
    not_due skips, and wrkq was asked about A's and B's tasks only
  3 continuation kept, for A and G: the session stays active with the same
    continuation key and reuse enabled; the next turn to it births a new
    runtime whose aspc compile request carries that continuation

Never touches the live daemon, the live aspd, the live wrkq ledger or any
shared service. Every process and root it creates is removed on exit.
"""
import argparse
import calendar
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import shutil
import signal
import sqlite3
import subprocess
import sys
import time
import uuid

from hrcpty_substrate import (FakeAspd, Run, ops, alive, descendants_of, LEAK, PROJECT, AGENT, HERE, REPO)

IDLE_HOURS = '0.02'
TICK_TIMEOUT = 420
FOUNDRY_WINDOW_MS = 60 * 60 * 1000


class Aspd(FakeAspd):
    """Codex for the scopes the test names and every Foundry seat, the substrate's Claude otherwise."""
    codex_tasks = set()

    def compile(self, req):
        scope = req['correlation']['scopeRef']
        if scope.rsplit(':task:', 1)[-1] in self.codex_tasks or scope.startswith('agent:foundry:'):
            return self.codex(req, scope)
        return super().compile(req)


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--binary', type=Path, default=REPO / 'crates/target/debug/rusthrc')
    p.add_argument('--root', type=Path, default=Path(f'/tmp/h13432-{os.getpid()}'))
    p.add_argument('--artifacts', type=Path, default=Path.home() / 'praesidium/var/wrkq-artifacts/T-13432/e2e')
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
    subprocess.run([str(binary), 'store', 'migrate', str(r.db_path)],
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

        def birth(name, task, prompt, agent=AGENT, project=PROJECT):
            ref = f'agent:{agent}:project:{project}:task:{task}/lane:main'
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
        g = birth('G', 'primary', 'first turn CONT', agent='foundry')
        settled(g)
        h = birth('H', 'primary', 'first turn', agent='foundry', project='t13432h')
        settled(h)
        wrkq('set', 'T-00001', '--state', 'completed')
        wrkq('set', 'T-00003', '--state', 'completed')
        for s in seats.values():
            r.check(f'0.{s["name"]}.born-hrcpty', r.runtime(s['rt'])['transport'] == 'hrcpty' and alive(s['pid']),
                    runtimeId=s['rt'], pid=s['pid'])
        sessions_before, keys = {}, {}
        for s in (a, g):
            sessions_before[s['name']] = r.rows('SELECT status, continuation_json, continuation_reuse_disabled FROM sessions '
                                                'WHERE host_session_id=?', (s['host'],))[0]
            keys[s['name']] = json.loads(sessions_before[s['name']]['continuation_json'] or '{}').get('key')
            r.check(f'0.{s["name"]}.continuation-stored', bool(keys[s['name']]), session=sessions_before[s['name']])

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
        # D and G look two hours idle to the first pass; nothing else moves.
        backdated = (datetime.now(timezone.utc) - timedelta(hours=2)).strftime('%Y-%m-%dT%H:%M:%S.%f')[:-3] + 'Z'
        with sqlite3.connect(r.db_path, timeout=30) as db:
            db.executemany('UPDATE runtimes SET last_activity_at=? WHERE runtime_id=?', [(backdated, d['rt']), (backdated, g['rt'])])
        r.check('2.backdated', all(r.runtime(s['rt'])['last_activity_at'] == backdated for s in (d, g)),
                at=backdated, D=r.runtime(d['rt'])['last_activity_at'], G=r.runtime(g['rt'])['last_activity_at'])
        h_activity = r.runtime(h['rt'])['last_activity_at']
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
                and all(r.runtime(seats[n]['rt'])['status'] != 'stale' for n in 'ABCDGH'), passes=passes)
        r.notes.append({'orphanBrokerAfterSupervisorKill': {'pid': f_status['broker']['pid'], 'alive': alive(f_status['broker']['pid'])}})
        tick_line = [l for l in log if l.get('event') == 'runtime.seat_retirement_complete'][0]
        tick, tick_ts = tick_line['data'], tick_line['ts']
        retired = {l['data']['runtimeId']: l['data'] for l in log if l.get('event') == 'runtime.seat_retired'}
        (args.artifacts / 'tick.json').write_text(json.dumps({'summary': tick, 'retired': retired, 'aging': aging}, indent=1) + '\n')
        for s, trigger in ((a, 'task_completed'), (b, 'idle_ttl'), (g, 'idle_ttl')):
            row = r.runtime(s['rt'])
            ev = [x['payload'] for x in r.events(s['rt'], 'runtime.terminated')]
            r.check(f'2.{s["name"]}.retired-{trigger}', row['status'] == 'terminated' and retired.get(s['rt'], {}).get('trigger') == trigger
                    and ev and ev[-1].get('reason') == trigger and ev[-1].get('source') == 'hrc-seat-retirement'
                    and ev[-1].get('droppedContinuation') is False, status=row['status'], line=retired.get(s['rt']), events=ev)
            r.wait(lambda: not alive(s['pid']), 15, s['name'] + ' supervisor gone')
            r.check(f'2.{s["name"]}.processes-gone', not alive(s['pid']) and not descendants_of([str(s['sock'].parent)]),
                    leftovers=descendants_of([str(s['sock'].parent)]))
        g_line = retired.get(g['rt'], {})
        r.check('2.G.line', g_line.get('taskId') == 'primary' and 'taskState' in g_line and g_line['taskState'] is None
                and g_line.get('trigger') == 'idle_ttl' and g_line.get('droppedContinuation') is False
                and (g_line.get('idleMs') or 0) >= FOUNDRY_WINDOW_MS, line=g_line)
        c_row, d_row, h_row = r.runtime(c['rt']), r.runtime(d['rt']), r.runtime(h['rt'])
        r.check('2.C.busy-untouched', c_row['status'] in ('ready', 'busy') and c_row['active_run_id'] == held['runId']
                and c['rt'] not in retired, status=c_row['status'], activeRun=c_row['active_run_id'])
        r.check('2.D.other-agent-primary-untouched', d_row['status'] == 'ready' and d['rt'] not in retired
                and d_row['last_activity_at'] == backdated, status=d_row['status'], lastActivityAt=d_row['last_activity_at'])
        pass_ms = calendar.timegm(time.strptime(tick_ts[:19], '%Y-%m-%dT%H:%M:%S')) * 1000
        h_idle_ms = pass_ms - calendar.timegm(time.strptime(h_activity[:19], '%Y-%m-%dT%H:%M:%S')) * 1000
        r.check('2.H.not-due-under-window', h_row['status'] == 'ready' and h['rt'] not in retired
                and float(IDLE_HOURS) * 3_600_000 < h_idle_ms < FOUNDRY_WINDOW_MS,
                status=h_row['status'], idleMsAtPass=h_idle_ms, lastActivityAt=h_activity)
        reasons = tick.get('skippedByReason', {})
        r.check('2.tick-summary', tick.get('retired') == 3 and tick.get('retiredByTrigger') == {'idle_ttl': 2, 'task_completed': 1}
                and reasons.get('standing_seat') in (1, 3) and (reasons.get('busy', 0) + reasons.get('active_run', 0)) == 1
                and reasons.get('not_due') == 1 and 'task_state_unavailable' not in reasons and tick.get('tasksQueried') == 2
                and tick.get('errors') == 0 and tick.get('idleThresholdHours') == float(IDLE_HOURS), summary=tick)

        # == 3. continuation kept; the next turn resumes it ===================
        for s in (a, g):
            name, key = s['name'], keys[s['name']]
            after = r.rows('SELECT status, continuation_json, continuation_reuse_disabled FROM sessions WHERE host_session_id=?',
                           (s['host'],))[0]
            r.check(f'3.{name}.session-active-same-key', after['status'] == 'active'
                    and json.loads(after['continuation_json'] or '{}').get('key') == key
                    and not after['continuation_reuse_disabled'], before=sessions_before[name], after=after)
            status, resumed = r.http('POST', '/v1/turns', {'hostSessionId': s['host'], 'prompt': 'after retirement',
                                                           'runtimeIntent': s['intent']})
            ok = status in (200, 202) and resumed.get('runtimeId') not in (None, s['rt'])
            compiled = []
            if ok:
                # The continuation reaches the harness through the compile request.
                compiled = r.wait(lambda: [f['request']['params']['compileRequest'].get('continuation') for f in
                                           map(json.loads, (args.artifacts / 'fake-aspd.ndjson').read_text().splitlines())
                                           if f.get('request', {}).get('method') == 'aspc.compileHarnessInvocation'
                                           and f['request']['params']['compileRequest'].get('identity', {}).get('runtimeId')
                                           == resumed['runtimeId']], 30, name + ' resumed compile')
            r.check(f'3.{name}.next-turn-new-runtime', ok, status=status, response=resumed)
            r.check(f'3.{name}.resume-compiles-with-continuation', bool(compiled) and (compiled[-1] or {}).get('hrc', {}).get('key') == key,
                    key=key, continuation=compiled[-1] if compiled else None)
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
