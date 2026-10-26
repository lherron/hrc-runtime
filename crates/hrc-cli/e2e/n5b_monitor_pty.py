#!/usr/bin/env python3
"""monitor output under a real PTY: TTY format defaults, chalk color, width.

Failure modes: a TTY stdout keeps ndjson instead of tree, color detection
diverges from chalk/supports-color (TERM, COLORTERM, FORCE_COLOR, dumb),
chalk's nested/multi-line escapes differ, and the tree rule ignores the
terminal's column count. Both CLIs run in an identical fixed-size PTY.
"""
import argparse
import fcntl
import json
import os
from pathlib import Path
import pty
import select
import struct
import termios
import time

from metrics_isolation import isolated_suite
from n5b_common import Runner, normalize, scratch_env

NORMALIZATION = {
    'timestamp': (r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z', '<timestamp>'),
}


def run_pty(command, env, cwd, cols, rows=40, timeout=30):
    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(cwd)
        os.execvpe(command[0], command, env)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
    out = b''
    deadline = time.time() + timeout
    while time.time() < deadline:
        ready, _, _ = select.select([fd], [], [], 0.2)
        if ready:
            try:
                chunk = os.read(fd, 65536)
            except OSError:
                break
            if not chunk:
                break
            out += chunk
    _, status = os.waitpid(pid, 0)
    os.close(fd)
    return dict(exit=os.waitstatus_to_exitcode(status), stdout=out.decode('utf-8', 'replace'), stderr='')


@isolated_suite
def main():
    p = argparse.ArgumentParser()
    for flag in ('binary', 'oracle', 'runtime-root', 'state-root', 'seat', 'artifacts'):
        p.add_argument('--' + flag, type=Path, required=True)
    args = p.parse_args()
    seat = json.loads(args.seat.read_text())
    rid = seat['start']['runtimeId']
    base = scratch_env(args.runtime_root, args.state_root)
    for key in ('NO_COLOR', 'FORCE_COLOR', 'COLORTERM', 'TERM_PROGRAM', 'TERM_PROGRAM_VERSION', 'CI'):
        base.pop(key, None)
    runner = Runner(args.binary, args.oracle, args.artifacts, base, NORMALIZATION)
    envs = {
        'xterm-256color': dict(base, TERM='xterm-256color'),
        'dumb': dict(base, TERM='dumb'),
        'dumb-force': dict(base, TERM='dumb', FORCE_COLOR='1'),
        'force-0': dict(base, TERM='xterm-256color', FORCE_COLOR='0'),
        'truecolor': dict(base, TERM='vt52', COLORTERM='truecolor'),
    }
    rt = 'runtime:' + rid
    cases = [
        ('xterm-256color', 100, ['monitor', 'watch', rt, '--last', '8']),
        ('xterm-256color', 100, ['monitor', 'watch', rt, '--from-seq', '25', '--max-lines', '3']),
        ('xterm-256color', 140, ['monitor', 'watch', rt, '--last', '4']),
        ('xterm-256color', 50, ['monitor', 'watch', rt, '--last', '4']),
        ('xterm-256color', 100, ['monitor', 'watch', rt, '--last', '6', '--format', 'compact']),
        ('xterm-256color', 100, ['monitor', 'watch', rt, '--last', '3', '--format', 'verbose']),
        ('xterm-256color', 100, ['monitor', 'watch', rt, '--last', '3', '--json']),
        ('dumb', 100, ['monitor', 'watch', rt, '--last', '5']),
        ('dumb-force', 100, ['monitor', 'watch', rt, '--last', '5']),
        ('force-0', 100, ['monitor', 'watch', rt, '--last', '5']),
        ('truecolor', 100, ['monitor', 'watch', rt, '--last', '5', '--format', 'verbose']),
        ('xterm-256color', 100, ['monitor', 'session-report', '--runtime', rid]),
        ('xterm-256color', 100, ['monitor', 'show', rt]),
        ('xterm-256color', 100, ['monitor', 'transcript', rid, '--tail', '3']),
    ]
    for env_name, cols, argv in cases:
        env = envs[env_name]
        observed = []
        for subject in (False, True):
            e = dict(env)
            command = [str(runner.binary)] if subject else [runner.bun, str(runner.oracle)]
            if subject:
                e['PATH'] = runner.subject_path
            observed.append(run_pty(command + argv, e, runner.cwd, cols))
        ok = normalize(observed[0], NORMALIZATION) == normalize(observed[1], NORMALIZATION)
        runner.results.append(dict(case=f'{env_name} {cols}x40 ' + ' '.join(argv), argv=argv, env=env_name, cols=cols,
                                   oracle=observed[0], subject=observed[1], **{'pass': ok}))
    return runner.finish(seat=rid, execution='real PTY; Bun absent from subject PATH')


if __name__ == '__main__':
    raise SystemExit(main())
