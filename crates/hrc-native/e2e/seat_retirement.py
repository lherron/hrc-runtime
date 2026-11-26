#!/usr/bin/env python3
"""Retire-door and hrcpty aging E2E on an isolated native daemon.

Uses the hrcpty substrate's fake aspd, stub broker and private state root.
The retire-door cases (T-14454 gate 2) cover module-only authorization,
request validation, busy/active refusal, refusal while a person is typing
(an untouched attached pane does not hold the seat, T-14698), the activity fence,
opaque policy diagnostics in the response and log, process teardown,
repeat refusal, and continuation reuse. C is a busy Codex seat, D is a
ready Claude seat, and R is the Codex seat retired by the door.

The aging cases (T-12236) run across the daemon's normal 300 s aging
interval. E's Claude child exits and F's Codex supervisor disappears.
Both runtimes go stale with their corresponding reasons. E's lease is
ended, and the live controls stay live.
"""
import argparse
import socket
import threading
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
from n2_scratch import UnixHTTP

# How the kernel presents the seat-retirement module's admitted identity to HRC.
MODULE = {'x-hrc-principal-ref': 'agent:seat-retirement',
          'x-hrc-session-ref': 'agent:seat-retirement:project:hrc-runtime'}


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
    p.add_argument('--root', type=Path, default=Path(f'/tmp/h14455-{os.getpid()}'))
    p.add_argument('--artifacts', type=Path, default=Path(os.environ.get('SCRATCH') or '/tmp') / 'seat-retirement-e2e')
    p.add_argument('--keep', action='store_true')
    args = p.parse_args()
    binary = args.binary.resolve()
    assert (binary.parent / 'hrc-pty').is_file(), 'build hrc-pty beside rusthrc: cargo build -p hrc-native -p hrc-pty'
    root = args.root.absolute()
    if root.exists():
        raise SystemExit('root must be fresh: ' + str(root))
    root.mkdir(parents=True)
    # One directory per run: a later run must not delete an earlier run's evidence.
    args.artifacts = args.artifacts / root.name
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

    aspd_socket = root / 'aspd.sock'
    wrkq_db = root / 'wrkq.db'
    Aspd.codex_tasks = {'door-c', 'aging-f'}
    aspd = Aspd(aspd_socket, release, args.artifacts / 'fake-aspd.ndjson')
    env = dict(clean)
    env.update(HRC_RUNTIME_DIR=str(root / 'run'), HRC_STATE_DIR=str(root / 'state'), HRC_ASPD_SOCKET=str(aspd_socket),
               ASP_PROJECT_ROOT_OVERRIDE=str(root / PROJECT), HRC_PROJECT_SEARCH_ROOTS=str(root / PROJECT),
               HRC_WRKQ_DB=str(wrkq_db), WRKQ_DB=str(wrkq_db), HRC_WRKQD_TOKEN_FILE='',
               WRKQD_TOKEN_FILE='', WRKQD_TOKEN='', HRC_PEER_CONFIG_FILE=str(config),
               HRC_EVENT_INGEST_SOCKET=str(root / 'run/ingest.sock'), HRC_ACP_WEBHOOK_URL='',
               HRC_BROKER_DURABLE_IPC_ENABLED='1', ASP_HOME=str(root / 'asp-home'),
               HRC_METRICS='0')
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

        def seat_kind(seat):
            return r.rows('SELECT seat_kind FROM continuities WHERE scope_ref=?', (seat['ref'].split('/lane:')[0],))[0]['seat_kind']

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

        c = birth('C', 'door-c', 'first turn')
        settled(c)
        d = birth('D', 'primary', 'first turn')
        settle_claude(d)
        e = birth('E', 'aging-e', 'first turn')
        settle_claude(e)
        f = birth('F', 'aging-f', 'first turn')
        settled(f)
        for s in seats.values():
            r.check(f'0.{s["name"]}.born-hrcpty', r.runtime(s['rt'])['transport'] == 'hrcpty' and alive(s['pid']),
                    runtimeId=s['rt'], pid=s['pid'])
        # == 1. aging: kill E's child and F's supervisor on the running daemon
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
        status, held = r.http('POST', '/v1/turns', {'hostSessionId': c['host'], 'prompt': 'HOLD for the retire door',
                                                    'runtimeIntent': c['intent']})
        assert status in (200, 202), (status, held)
        r.wait(lambda: r.runtime(c['rt'])['active_run_id'] == held['runId'], 30, 'held turn')

        # Continuation readback and next-turn resume.
        def resumes(s, key, before, step):
            name = s['name']
            after = r.rows('SELECT status, continuation_json, continuation_reuse_disabled FROM sessions WHERE host_session_id=?',
                           (s['host'],))[0]
            r.check(f'{step}.{name}.session-active-same-key', after['status'] == 'active'
                    and json.loads(after['continuation_json'] or '{}').get('key') == key
                    and not after['continuation_reuse_disabled'], before=before, after=after)
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
            r.check(f'{step}.{name}.next-turn-new-runtime', ok, status=status, response=resumed)
            r.check(f'{step}.{name}.resume-compiles-with-continuation', bool(compiled) and (compiled[-1] or {}).get('hrc', {}).get('key') == key,
                    key=key, continuation=compiled[-1] if compiled else None)
            return resumed

        # == 4. the retire door (T-14454 gate 2) ==============================
        def door(body, headers=MODULE):
            conn = UnixHTTP(r.socket, 120)
            conn.request('POST', '/v1/runtimes/retire', json.dumps(body), {'Content-Type': 'application/json', **headers})
            res = conn.getresponse()
            raw = res.read().decode()
            conn.close()
            try:
                return res.status, json.loads(raw)
            except ValueError:
                return res.status, raw

        def ask(s, expect=None, **extra):
            return {'runtimeId': s['rt'], 'expectLastActivityAt': expect or r.runtime(s['rt'])['last_activity_at'],
                    'trigger': 'idle_ttl', 'rule': 'e2e:door', 'policyRevision': 'e2e-r1', **extra}

        def refused(name, s, out, got, want, code, **detail):
            err = out.get('error', {}) if isinstance(out, dict) else {}
            ok = got == want and err.get('code') == code and all(err.get('detail', {}).get(k) == v for k, v in detail.items())
            return r.check(name, ok and r.runtime(s['rt'])['status'] != 'terminated', httpStatus=got, response=out,
                           runtimeStatus=r.runtime(s['rt'])['status'])

        rr = birth('R', 'door-r', 'first turn CONT', agent='foundry')
        settled(rr)
        r_before = r.rows('SELECT status, continuation_json, continuation_reuse_disabled FROM sessions WHERE host_session_id=?',
                          (rr['host'],))[0]
        r_key = json.loads(r_before['continuation_json'] or '{}').get('key')
        r.check('4.R.continuation-stored', bool(r_key), session=r_before)

        # Callers other than the module principal.
        status, out = door(ask(rr), {})
        refused('4.not-authorized.anonymous', rr, out, status, 403, 'not_authorized')
        status, out = door(ask(rr), {'x-hrc-principal-ref': 'agent:mable',
                                     'x-hrc-session-ref': 'agent:mable:project:hrc-runtime:task:primary'})
        refused('4.not-authorized.mable-primary', rr, out, status, 403, 'not_authorized',
                caller='agent:mable:project:hrc-runtime:task:primary')
        # The daemon mints R's lifecycle credential on its coalesced reconcile, after the birth commits.
        cred_file = root / 'run/lifecycle' / f"{rr['rt']}.credential"
        r.wait(lambda: cred_file.is_file() and cred_file.read_text().strip(), 30, 'R lifecycle credential')
        credential = cred_file.read_text().strip()
        r_scope = r.runtime(rr['rt'])['scope_ref']
        status, out = door(ask(rr), {**MODULE, 'x-hrc-lifecycle-session-ref': r_scope + '/lane:main',
                                     'x-hrc-lifecycle-runtime-id': rr['rt'], 'x-hrc-lifecycle-credential': credential})
        refused('4.not-authorized.runtime-credential', rr, out, status, 403, 'not_authorized', caller=r_scope)
        refusals = [l['data'] for l in r.daemon_log('1') if l.get('event') == 'server.lifecycle.refused'
                    and l['data'].get('action') == 'retire a seat']
        r.check('4.not-authorized.logged', len(refusals) == 3 and all(x['refusal'] == 'not_authorized' for x in refusals),
                lines=refusals)

        # Malformed and unknown, with the module's identity.
        status, out = door({**ask(rr), 'runtimeId': 'rt-does-not-exist'})
        r.check('4.unknown-runtime', status == 404 and out.get('error', {}).get('code') == 'unknown_runtime', status=status, response=out)
        status, out = door(ask(rr, trigger='t' * 129))
        refused('4.trigger-over-128-chars', rr, out, status, 400, 'malformed_request', field='trigger')

        # The guards.
        c_now = r.runtime(c['rt'])
        status, out = door(ask(c))
        refused('4.C.busy-not-ready', c, out, status, 409, 'not_ready', status='busy')
        r.check('4.C.was-busy-with-held-run', c_now['status'] == 'busy' and c_now['active_run_id'] == held['runId'], row=c_now['status'])
        with sqlite3.connect(r.db_path, timeout=30) as db:
            db.execute("UPDATE runtimes SET active_run_id='run-e2e-staged' WHERE runtime_id=?", (d['rt'],))
        status, out = door(ask(d))
        with sqlite3.connect(r.db_path, timeout=30) as db:
            db.execute("UPDATE runtimes SET active_run_id=NULL WHERE runtime_id=? AND active_run_id='run-e2e-staged'", (d['rt'],))
        refused('4.D.active-run', d, out, status, 409, 'active_run')
        def attach_rw(s):
            """A real read-write client on s's hrc-pty supervisor; returns (send, close)."""
            opsock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            opsock.settimeout(10)
            opsock.connect(str(s['sock']))
            opf = opsock.makefile('r')
            for i, (m, prm) in enumerate((('hello', {'token': s['token'].read_text().strip()}), ('attach', {'readOnly': False})), 1):
                opsock.sendall((json.dumps({'jsonrpc': '2.0', 'id': i, 'method': m, 'params': prm}) + '\n').encode())
                reply = json.loads(opf.readline())
            attach_id = reply['result']['attachId']
            data = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            data.connect(str(s['sock']))
            data.sendall((json.dumps({'attach': attach_id}) + '\n').encode())

            def drain_attach():
                try:
                    while data.recv(65536):
                        pass
                except OSError:
                    pass

            drain = threading.Thread(target=drain_attach, daemon=True)
            drain.start()

            def close():
                try:
                    data.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass
                drain.join(timeout=10)
                data.close()
                opf.close()
                opsock.close()
            return data.sendall, close

        def pty_status(s):
            return ops(s['sock'], s['token'], 'status')['status']

        # A person typing into D's pane holds it (T-14698): a read-write
        # client that has sent a keystroke, held open across the call.
        send, close = attach_rw(d)
        rw = r.wait(lambda: pty_status(d)['clients'].get('readWrite'), 10, 'read-write client')
        send(b'x')
        typed = r.wait(lambda: pty_status(d).get('humanIdleMs') is not None and pty_status(d), 10, 'keystroke seen')
        status, out = door(ask(d))
        refused('4.D.attached-client-typed', d, out, status, 409, 'attached_client')
        r.check('4.D.client-was-read-write-and-typed', rw == 1 and typed['humanIdleMs'] < 30 * 60 * 1000,
                readWrite=rw, humanIdleMs=typed.get('humanIdleMs'))
        close()
        r.wait(lambda: pty_status(d)['clients'].get('readWrite') == 0, 10, 'client gone')

        # The fence: an instant one second off is refused; the same instant in another format is not.
        at = r.runtime(rr['rt'])['last_activity_at']
        assert at.endswith('Z'), at
        when = datetime.strptime(at[:-1], '%Y-%m-%dT%H:%M:%S.%f').replace(tzinfo=timezone.utc)
        off = (when - timedelta(seconds=1)).strftime('%Y-%m-%dT%H:%M:%S.%f')[:-3] + 'Z'
        status, out = door(ask(rr, off))
        refused('4.R.stale-expect-activity-changed', rr, out, status, 409, 'activity_changed', lastActivityAt=at)
        # An attached pane nobody has typed into does not hold R (T-14698).
        _, close_r = attach_rw(rr)
        untouched = r.wait(lambda: pty_status(rr)['clients'].get('readWrite') == 1 and pty_status(rr), 10, 'R read-write client')
        r.check('4.R.untouched-pane-attached', 'humanIdleMs' in untouched and untouched['humanIdleMs'] is None,
                readWrite=untouched['clients'].get('readWrite'), humanIdleMs=untouched.get('humanIdleMs', 'missing'))
        novel = 'e2e.novel-trigger/policy-edit-v9'
        same_instant = at[:-1] + '+00:00'
        request = ask(rr, same_instant, trigger=novel, rule='e2e:door-rule-7', policyRevision='rev-2026-11-23T10:00')
        status, out = door(request)
        row = r.runtime(rr['rt'])
        r.check('4.R.retired', status == 200 and out.get('retired') is True and out.get('runtimeId') == rr['rt']
                and out.get('scopeRef') == r_scope and out.get('trigger') == novel and out.get('rule') == 'e2e:door-rule-7'
                and out.get('policyRevision') == 'rev-2026-11-23T10:00' and isinstance(out.get('idleMs'), int)
                and out.get('droppedContinuation') is False and row['status'] == 'terminated',
                status=status, response=out, runtimeStatus=row['status'], expect=same_instant, stored=at)
        ev = [x['payload'] for x in r.events(rr['rt'], 'runtime.terminated')]
        r.check('4.R.terminated-event', ev and ev[-1].get('reason') == novel and ev[-1].get('source') == 'seat-retirement-module'
                and ev[-1].get('droppedContinuation') is False, events=ev)
        time.sleep(0.5)
        lines = [l['data'] for l in r.daemon_log('1') if l.get('event') == 'runtime.seat_retired' and l['data'].get('runtimeId') == rr['rt']]
        line = lines[-1] if lines else {}
        r.check('4.R.retired-line', len(lines) == 1 and line.get('trigger') == novel and line.get('rule') == 'e2e:door-rule-7'
                and line.get('policyRevision') == 'rev-2026-11-23T10:00' and line.get('source') == 'seat-retirement-module'
                and line.get('agentId') == 'foundry' and line.get('kind') == seat_kind(rr) and line.get('taskId') == 'door-r'
                and line.get('scopeRef') == r_scope and isinstance(line.get('idleMs'), int)
                and line.get('droppedContinuation') is False, lines=lines, seatKind=seat_kind(rr))
        r.wait(lambda: not alive(rr['pid']), 15, 'R supervisor gone')
        r.check('4.R.processes-gone', not alive(rr['pid']) and not descendants_of([str(rr['sock'].parent)]),
                leftovers=descendants_of([str(rr['sock'].parent)]))
        close_r()
        status, out = door(request)
        r.check('4.R.repeat-not-ready', status == 409 and out.get('error', {}).get('code') == 'not_ready'
                and out['error'].get('detail', {}).get('status') == 'terminated', status=status, response=out)
        resumes(rr, r_key, r_before, '4')
        r.check('4.C.D.untouched', r.runtime(c['rt'])['status'] == 'busy' and r.runtime(d['rt'])['status'] == 'ready'
                and r.runtime(d['rt'])['active_run_id'] is None, C=r.runtime(c['rt'])['status'], D=r.runtime(d['rt'])['status'])
        # Wait for the next real aging pass after the boot pass.
        r.wait(lambda: sum(l.get('event') == 'runtime.hrcpty_aging_complete'
                           for l in r.daemon_log('1')) > 1, 420, 'hrcpty aging pass')
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
                and all(r.runtime(seats[n]['rt'])['status'] in ('ready', 'busy') for n in 'CD'), passes=passes)
        r.notes.append({'orphanBrokerAfterSupervisorKill': {'pid': f_status['broker']['pid'], 'alive': alive(f_status['broker']['pid'])}})
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
        for pid, _ in descendants_of([f'{root}/']):
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
        remaining = [l for _, l in descendants_of([f'{root}/'])]
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
