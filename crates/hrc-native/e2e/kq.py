#!/usr/bin/env python3
"""Inspect seats and runtimes in praesidium:praesidium (r1.9 / T-12360).
Uses the kernel projection without whole-table HRC owner scans.
$PRAESIDIUM_KERNEL_SOCKET overrides the read socket.
  kq.py status [--full]            bounded binding/cursor summary; full opt-in
  kq.py seats [regex] | runtimes [regex] | busy
  kq.py raw <op> '<json args>'   on the read socket; pass an explicit socket
                                override to inspect the ops-only HRC provider
"""
import json
import os
import re
import socket
import sys

SOCK = os.environ.get('PRAESIDIUM_KERNEL_SOCKET', os.path.expanduser('~/praesidium/var/run/praesidium/kernel.sock'))


def call(op, args=None):
    s = socket.socket(socket.AF_UNIX)
    s.settimeout(30)
    s.connect(SOCK)
    f = s.makefile('rwb', buffering=0)
    f.write((json.dumps(dict(id=op, op=op, args=args or {})) + '\n').encode())
    reply = json.loads(f.readline())
    s.close()
    if not reply.get('ok'):
        sys.exit(json.dumps(reply))
    return reply['result']


def rows(kind):
    out, cursor = [], None
    while True:
        args = dict(document_id='praesidium', type=kind, limit=1000)
        if cursor:
            args['after'] = cursor
        page = call('document.query', args)
        out += page['rows']
        cursor = page.get('next')
        if not cursor:
            return out


def seat_line(p):
    le = p.get('latestEvent') or {}
    return '\t'.join(str(x) for x in (
        p.get('sessionRef', '').replace('agent:', '').replace(':project:', '@').replace(':task:', ':'),
        p.get('status'), p.get('lastActivityAt', ''), le.get('kind', ''), le.get('time', '')))


def status_summary(status):
    def scalars(value, names):
        if not isinstance(value, dict):
            return None
        return {k: (v[:80] if isinstance(v, str) else v)
                for k in names if (v := value.get(k)) is None or isinstance(v, (str, bool, int, float))}

    bindings = status['bindings']
    summary = []
    for binding in bindings[:32]:
        cursor = binding.get('cursor')
        cursor_summary = scalars(cursor, ('seq', 'incarnation', 'version')) or {}
        cursor_summary['fields'] = len(cursor) if isinstance(cursor, dict) else 0
        entries = cursor.get('entries') if isinstance(cursor, dict) else None
        if isinstance(entries, (dict, list)):
            cursor_summary['entries'] = len(entries)
        summary.append(dict(binding=str(binding.get('binding', ''))[:80],
                            caught_up=binding.get('caught_up') is True,
                            cursor=cursor_summary,
                            resync=scalars(binding.get('resync'), ('every_ms', 'last_at', 'next_at'))))
    return dict(bindings=summary, total_bindings=len(bindings), omitted_bindings=max(0, len(bindings) - 32))


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else 'status'
    pat = re.compile(sys.argv[2]) if len(sys.argv) > 2 and cmd not in ('raw', 'status') else None
    if cmd == 'status':
        st = call('ingest.status', dict(document_id='praesidium'))
        if len(sys.argv) > 2 and sys.argv[2:] != ['--full']:
            sys.exit('usage: kq.py status [--full]')
        print(json.dumps(st if '--full' in sys.argv[2:] else status_summary(st)))
    elif cmd == 'seats':
        for r in rows('seat'):
            p = r['payload']
            if pat and not pat.search(p.get('sessionRef', '')):
                continue
            print(seat_line(p))
    elif cmd == 'busy':
        for r in rows('runtime'):
            p = r['payload']
            if p.get('status') == 'busy':
                print('\t'.join((p.get('scopeRef', '').replace('agent:', ''), p.get('runtimeId', ''), str(p.get('generation')))))
    elif cmd == 'runtimes':
        for r in rows('runtime'):
            p = r['payload']
            if pat and not pat.search(json.dumps(p)):
                continue
            print(json.dumps(p))
    elif cmd == 'raw':
        print(json.dumps(call(sys.argv[2], json.loads(sys.argv[3]) if len(sys.argv) > 3 else {})))
    else:
        sys.exit(__doc__)


if __name__ == '__main__':
    main()
