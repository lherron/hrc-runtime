#!/usr/bin/env python3
"""N2 human /quit on a real hrcpty seat, on rusthrc.

A real claude-hrcpty seat is born and goes idle. The operator attaches with the
argv GET /v1/attach serves (`hrc-pty attach --socket ...`) in a real pty and
types `/quit`. The broker reports the prompt-input-exit continuation clear and
closes; the owner must end the runtime as a user-initiated termination (not
crashed or stale), write exactly one runtime.terminated with that reason, and
end the lease: no hrc-pty supervisor for the runtime survives. Failure modes:
the lease left alive after the harness quit, the runtime marked crashed or
stale instead of terminated, and a reap that fires twice or never.
"""
import argparse
import fcntl
import json
import os
import pty
import struct
import subprocess
import termios
import threading
import time
from pathlib import Path

from n2_scratch import Scratch

PROMPT = 'Reply with exactly the word OK and nothing else. No tools.'


def supervisors(runtime):
    out = subprocess.run(['/bin/ps', '-axo', 'pid=,command='], capture_output=True, text=True).stdout
    return [l for l in out.splitlines() if 'hrc-pty serve' in l and runtime in l]


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--binary', type=Path, required=True)
    p.add_argument('--installed-release', type=Path, required=True)
    p.add_argument('--aspd-socket', type=Path, required=True)
    p.add_argument('--scratch-root', type=Path, required=True)
    p.add_argument('--artifacts', type=Path, required=True)
    args = p.parse_args()
    s = Scratch(args.scratch_root, args.installed_release, args.aspd_socket, args.binary, args.artifacts)
    prefix = 'agent:tabularasa:project:n2-t11823:task:'
    scope = prefix + 'quit'
    out = {}
    client = None
    try:
        s.init_substrate()
        s.up('native', 'a')
        cold = s.command('cold-start', ['hrc', 'start', scope, '--project-id', s.project_id, '--project-root',
                                        s.project, '--cwd', s.project, '--json', '-p', PROMPT])
        runtime = cold['runtime']['runtimeId']
        s.wait_completed(cold['runtime']['runId'])
        s.wait(lambda: s.rows("SELECT 1 FROM runtimes WHERE runtime_id=? AND status='ready' AND active_run_id IS NULL", (runtime,)), 300, 'idle')
        time.sleep(2)
        status, attach = s.http('GET', f'/v1/attach?runtimeId={runtime}')
        assert status == 200 and attach.get('transport') == 'hrcpty' and attach['argv'][1] == 'attach', attach
        assert supervisors(runtime), 'no hrc-pty supervisor for the live seat'
        before = s.rows('SELECT COALESCE(MAX(hrc_seq),0) AS m FROM hrc_events')[0]['m']
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 120, 0, 0))
        client = subprocess.Popen(attach['argv'], env=s.env, cwd=s.project, stdin=slave, stdout=slave, stderr=slave,
                                  start_new_session=True)
        os.close(slave)
        screen = bytearray()
        def drain():
            while True:
                try:
                    chunk = os.read(master, 65536)
                except OSError:
                    return
                if not chunk:
                    return
                screen.extend(chunk)
        threading.Thread(target=drain, daemon=True).start()
        time.sleep(3)
        for ch in '/quit':
            os.write(master, ch.encode())
            time.sleep(.1)
        time.sleep(1)
        os.write(master, b'\r')
        s.wait(lambda: s.rows("SELECT 1 FROM runtimes WHERE runtime_id=? AND status IN ('terminated','dead','stale','crashed')", (runtime,)), 120, 'runtime ended')
        s.wait(lambda: not supervisors(runtime), 30, 'lease ended')
        time.sleep(3)
        r = s.rows('SELECT status, active_run_id, runtime_state_json FROM runtimes WHERE runtime_id=?', (runtime,))[0]
        st = json.loads(r['runtime_state_json'] or '{}')
        out['runtime'] = {'status': r['status'], 'activeRun': r['active_run_id'],
                          'terminationReason': st.get('terminationReason'), 'userExitReason': st.get('userExitReason')}
        out['events'] = [{'kind': e['event_kind'], 'payload': json.loads(e['payload_json'] or 'null')}
                         for e in s.rows("SELECT event_kind, payload_json FROM hrc_events WHERE hrc_seq>? AND runtime_id=? ORDER BY hrc_seq", (before, runtime))]
        out['supervisors'] = supervisors(runtime)
        out['screen'] = screen.decode(errors='replace')[-2000:]
        (args.artifacts / 'quit.json').write_text(json.dumps(out, indent=1, default=str) + '\n')
        s.dump('rows')
        assert out['runtime']['status'] == 'terminated' and out['runtime']['activeRun'] is None, out['runtime']
        assert out['runtime']['terminationReason'] == 'user_initiated_session_end', out['runtime']
        assert out['runtime']['userExitReason'] == 'prompt_input_exit', out['runtime']
        ended = [e for e in out['events'] if e['kind'] == 'runtime.terminated']
        assert len(ended) == 1 and ended[0]['payload']['reason'] == 'user_initiated_session_end', ended
        assert not [e for e in out['events'] if e['kind'] in ('runtime.crashed', 'runtime.stale')], out['events']
        assert not out['supervisors'], out['supervisors']
        print(json.dumps({'pass': True, 'runtime': out['runtime']}))
    finally:
        if client and client.poll() is None:
            client.terminate()
        (args.artifacts / 'steps.json').write_text(json.dumps(s.steps, indent=1) + '\n')
        s.cleanup(prefix)


if __name__ == '__main__':
    main()
