#!/usr/bin/env python3
"""N2 attached-run door on one owner (bun or native), recorded for `compare --suite n2-attached`.

The unchanged Bun `hrc run` drives the door in a real pty: prepare-attached,
tmux attach to the returned descriptor, resume-attached, then the operator
detaches. A first promptless run births a seat parked on the attach gate; a
second run with a prompt lands on the live seat. Failure modes: a birth that
starts its invocation before the operator is attached, a prepared response
without a resumable pending start, a warm seat answered `prepared`, and a
resume that never releases the birth.
"""
import argparse
from datetime import datetime, timedelta
import fcntl
import json
import os
from pathlib import Path
import pty
import struct
import subprocess
import termios
import threading
import time

from n2_scratch import Scratch

PROMPT = 'Reply with exactly the word OK and nothing else. No tools.'
HARNESS = {'harness': {'provider': 'anthropic', 'interactive': True}}


class Pty:
    """A child on a real terminal; output drained so the child never blocks."""
    def __init__(self, s, argv):
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 120, 0, 0))
        self.proc = subprocess.Popen([str(a) for a in argv], env=s.env, cwd=s.project, stdin=slave,
                                     stdout=slave, stderr=slave, start_new_session=True)
        os.close(slave)
        self.master, self.out = master, bytearray()
        threading.Thread(target=self._drain, daemon=True).start()

    def _drain(self):
        while True:
            try:
                chunk = os.read(self.master, 65536)
            except OSError:
                return
            if not chunk:
                return
            self.out.extend(chunk)

    def wait(self, timeout):
        try:
            return self.proc.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            return 'timeout'


def requests(s, owner, tag):
    """The prepare/resume request log lines this owner served."""
    out = []
    for line in (s.artifacts / f'{owner}-{tag}.log').read_text(errors='replace').splitlines():
        try:
            e = json.loads(line)
        except ValueError:
            continue
        d = e.get('data') or {}
        route = d.get('route') or d.get('path') or ''
        if e.get('event') in ('http.request', 'request') and 'attached' in route:
            out.append({'route': route, 'status': d.get('status')})
    return out


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--owner', choices=['bun', 'native'], required=True)
    p.add_argument('--binary', type=Path, required=True)
    p.add_argument('--installed-release', type=Path, required=True)
    p.add_argument('--aspd-socket', type=Path, required=True)
    p.add_argument('--scratch-root', type=Path, required=True)
    p.add_argument('--artifacts', type=Path, required=True)
    args = p.parse_args()
    s = Scratch(args.scratch_root, args.installed_release, args.aspd_socket, args.binary, args.artifacts)
    prefix = 'agent:tabularasa:project:n2-t11823:task:'
    scope = prefix + 'attached-' + args.owner
    observations = []
    try:
        s.init_substrate()
        s.up(args.owner, 'attached')
        door = '/v1/runs/prepare-attached'
        for name, path, body in [('prepare:not-object', door, 'x'), ('prepare:no-host', door, {}),
                                 ('prepare:no-intent', door, {'hostSessionId': 'hsid-x'}),
                                 ('prepare:bad-restart', door, {'hostSessionId': 'hsid-x', 'intent': {}, 'restartStyle': 'warm'}),
                                 ('prepare:no-harness', door, {'hostSessionId': 'hsid-x', 'intent': {}, 'prompt': 3}),
                                 ('prepare:bad-prompt', door, {'hostSessionId': 'hsid-x', 'intent': HARNESS, 'prompt': 3}),
                                 ('prepare:unknown-host', door, {'hostSessionId': 'hsid-00000000-0000-0000-0000-000000000000', 'intent': HARNESS}),
                                 ('resume:no-id', '/v1/runs/resume-attached', {}),
                                 ('resume:not-pending', '/v1/runs/resume-attached', {'pendingStartId': 'attached-nope'})]:
            status, value = s.http('POST', path, body)
            observations.append({'case': name, 'status': status, 'body': value})

        def run(name, extra):
            before = s.rows('SELECT COALESCE(MAX(hrc_seq),0) AS m FROM hrc_events')[0]['m']
            child = Pty(s, ['hrc', 'run', scope, '--project-id', s.project_id, '--project-root', s.project,
                            '--no-register', *extra])
            # The operator's client is on the lease's tui window once the run is up.
            attached = s.wait(lambda: [r for r in s.rows("SELECT runtime_id, tmux_json FROM runtimes WHERE host_session_id IN (SELECT host_session_id FROM sessions WHERE scope_ref=?) AND status NOT IN ('terminated','dead','stale','crashed')", (scope,))
                                       if r['tmux_json'] and subprocess.run(['tmux', '-S', json.loads(r['tmux_json'])['socketPath'], 'list-clients'],
                                                                            capture_output=True, text=True).stdout.strip()], 300, name + ' attached')
            runtime = attached[0]['runtime_id']
            tmux = json.loads(attached[0]['tmux_json'])
            if extra:
                s.wait(lambda: s.rows("SELECT 1 FROM runs WHERE runtime_id=? AND completed_at IS NOT NULL", (runtime,)),
                       300, name + ' turn completed')
            else:
                s.wait(lambda: s.rows("SELECT 1 FROM runtimes WHERE runtime_id=? AND status='ready'", (runtime,)), 300, name + ' ready')
            time.sleep(2)
            subprocess.run(['tmux', '-S', tmux['socketPath'], 'detach-client', '-s', tmux['sessionName']], capture_output=True)
            code = child.wait(60)
            kinds = [r['event_kind'] for r in s.rows('SELECT event_kind FROM hrc_events WHERE hrc_seq>? ORDER BY hrc_seq', (before,))]
            observations.append({'case': name, 'exit': code, 'eventKinds': kinds, 'runtimeId': runtime,
                                 'runtime': s.rows('SELECT status, transport, controller_kind, presentation_json FROM runtimes WHERE runtime_id=?', (runtime,))[0],
                                 'runs': s.rows('SELECT status, error_code FROM runs WHERE runtime_id=? ORDER BY accepted_at', (runtime,)),
                                 'output': child.out.decode(errors='replace')[-3000:]})
            return runtime

        first = run('run:cold-promptless', [])
        # The gate: the parked birth starts its invocation only after resume began.
        resumes = []
        for line in (s.artifacts / f'{args.owner}-attached.log').read_text(errors='replace').splitlines():
            try:
                e = json.loads(line)
            except ValueError:
                continue
            d = e.get('data') or {}
            if d.get('route') == '/v1/runs/resume-attached' and d.get('status') == 200:
                end = datetime.fromisoformat(e['ts'].replace('Z', '+00:00'))
                resumes.append(end - timedelta(milliseconds=d.get('durationMs', 0)))
        started = s.rows("SELECT time FROM broker_invocation_events WHERE runtime_id=? AND type='invocation.started' ORDER BY seq LIMIT 1", (first,))
        start_at = datetime.fromisoformat(started[0]['time'].replace('Z', '+00:00')) if started else None
        observations.append({'case': 'gate-order', 'value': bool(resumes and start_at and start_at > resumes[0])})
        second = run('run:warm-prompt', ['-p', PROMPT])
        observations.append({'case': 'same-runtime', 'value': first == second})
        observations.append({'case': 'requests', 'value': requests(s, args.owner, 'attached')})
        (args.artifacts / f'{args.owner}.json').write_text(json.dumps(
            {'observations': observations, 'scratchRoot': str(s.root), 'scope': scope}, indent=1, default=str) + '\n')
        s.dump(args.owner + '-rows')
        print(json.dumps({'owner': args.owner, 'cases': len(observations)}))
    finally:
        (args.artifacts / f'{args.owner}-steps.json').write_text(json.dumps(s.steps, indent=1) + '\n')
        s.cleanup(prefix)


if __name__ == '__main__':
    main()
