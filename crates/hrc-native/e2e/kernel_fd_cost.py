#!/usr/bin/env python3
"""T-12168: fds rusthrc holds per hrc-kernel.sock connection, on one isolated
scratch daemon (kernel_fold.substrate: scratch HRC_STATE_DIR/HRC_RUNTIME_DIR,
fake aspd, private wrkqd). Never the live daemon or the live kernel socket.

Failure modes: a kernel connection costs the daemon more than one fd (cardo
wire dups, fixed in cardo 2d62819, T-12170); a closed connection keeps an fd
until another client connects.

Phases, each measured with lsof on the scratch daemon pid:
  plain      N connections, one ingest.status each, held open
  events     N connections subscribed with events.subscribe, held open
  query      N connections subscribed with query.subscribe, held open
  closed     all closed, 1 s settle
  pruned     one more connect/close (the wire's accept loop prunes then)

Usage: kernel_fd_cost.py --artifacts <dir> [--binary <rusthrc>] [--n 10]
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import time

from kernel_fold import substrate, Wire, wire, REPO


def kernel_fds(pid, kernel):
    out = subprocess.run(['lsof', '-nP', '-p', str(pid)], capture_output=True, text=True).stdout
    lines = [l for l in out.splitlines() if l.endswith(str(kernel)) and ' unix ' in l]
    by_socket = {}
    for l in lines:
        by_socket.setdefault(l.split()[5], []).append(l.split()[3])
    return len(lines), by_socket


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--binary', type=Path, default=REPO / 'crates/target/debug/rusthrc')
    p.add_argument('--root', type=Path, default=Path(f'/tmp/hkfd-{os.getpid()}'))
    p.add_argument('--artifacts', type=Path, required=True)
    p.add_argument('--n', type=int, default=10)
    a = p.parse_args()
    root = a.root.absolute()
    root.mkdir()
    a.artifacts.mkdir(parents=True, exist_ok=True)
    r, aspd, _ = substrate(root, a.artifacts, a.binary.resolve())
    kernel = root / 'run/hrc-kernel.sock'
    report = {'n': a.n, 'phases': {}}
    try:
        daemon = r.up('fd')
        r.wait(lambda: kernel.exists() and wire(kernel, 'ingest.status', {'document_id': 'hrc'})['ok'], 30, 'kernel')
        time.sleep(1)
        pid = daemon.pid

        def measure(phase):
            total, by_socket = kernel_fds(pid, kernel)
            report['phases'][phase] = {'kernelFds': total, 'sockets': len(by_socket),
                                       'fdsPerSocket': sorted(len(v) for v in by_socket.values())}
            print(phase, json.dumps(report['phases'][phase]), flush=True)
            return total

        base = measure('baseline')
        held = []
        for _ in range(a.n):
            w = Wire(kernel)
            assert w.raw('ingest.status', {'document_id': 'hrc'})['ok']
            held.append(w)
        time.sleep(.5)
        plain = measure('plain') - base
        resync = wire(kernel, 'resync')['result']
        for _ in range(a.n):
            w = Wire(kernel)
            reply = w.raw('events.subscribe', dict(after=resync['cursor'], incarnation=resync['host_incarnation']))
            assert reply['ok'], reply
            held.append(w)
        time.sleep(.5)
        events = measure('events') - base - plain
        for _ in range(a.n):
            w = Wire(kernel)
            reply = w.raw('query.subscribe', dict(document_id='hrc', type='hrc.seat'))
            assert reply['ok'], reply
            held.append(w)
        time.sleep(.5)
        query = measure('query') - base - plain - events
        for w in held:
            w.close()
        time.sleep(1)
        closed = measure('closed') - base
        # The wire used to release a closed connection's last fd only here.
        wire(kernel, 'ingest.status', {'document_id': 'hrc'})
        time.sleep(.5)
        pruned = measure('pruned') - base
        report['perConnection'] = {'plain': plain / a.n, 'eventsSubscribe': events / a.n,
                                   'querySubscribe': query / a.n}
        report['residualAfterClose'] = closed
        report['residualAfterPrune'] = pruned
        report['pass'] = (all(v <= 1 for v in report['perConnection'].values())
                          and closed <= 1 and pruned <= 1)
    finally:
        for proc in r.owners:
            if proc.poll() is None:
                proc.send_signal(signal.SIGTERM)
                try:
                    proc.wait(timeout=30)
                except subprocess.TimeoutExpired:
                    proc.kill()
        subprocess.run(['pkill', '-f', str(root) + '/'], check=False)
        aspd.close()
        for log in r.logs:
            log.close()
        shutil.rmtree(root)
    (a.artifacts / 'summary.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({k: report[k] for k in ('perConnection', 'residualAfterClose', 'residualAfterPrune', 'pass')}))
    return 0 if report['pass'] else 1


if __name__ == '__main__':
    sys.exit(main())
