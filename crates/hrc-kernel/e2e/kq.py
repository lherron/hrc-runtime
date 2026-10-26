#!/usr/bin/env python3
"""Inspect HRC through Loggia's hrc-kernel (the same wire Loggia mounts).

Reads the kernel's own projection, so it adds no load to the HRC daemon: no
whole-table scans, no store lock. Prefer it to `hrc runtime list` / `/v1/status`
for read-only inspection. Socket: $HRC_KERNEL_SOCKET, else the default below.
  kq.py status                      ingest binding: caught_up, cursor, resync
  kq.py seats [regex]               hrc.seat rows: sessionRef, status, latest event
  kq.py runtimes [regex]            hrc.runtime rows
  kq.py busy                        runtimes whose status is busy
  kq.py raw <op> '<json args>'      any kernel op
"""
import json
import os
import re
import socket
import sys

SOCK = os.environ.get('HRC_KERNEL_SOCKET', os.path.expanduser('~/praesidium/var/run/hrc/hrc-kernel.sock'))


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
        args = dict(document_id='hrc', type=kind, limit=1000)
        if cursor:
            args['cursor'] = cursor
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


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else 'status'
    pat = re.compile(sys.argv[2]) if len(sys.argv) > 2 and cmd != 'raw' else None
    if cmd == 'status':
        st = call('ingest.status', dict(document_id='hrc'))
        print(json.dumps([dict(caught_up=b.get('caught_up'), cursor=b.get('cursor'),
                               resync=b.get('resync')) for b in st['bindings']]))
    elif cmd == 'seats':
        for r in rows('hrc.seat'):
            p = r['payload']
            if pat and not pat.search(p.get('sessionRef', '')):
                continue
            print(seat_line(p))
    elif cmd == 'busy':
        for r in rows('hrc.runtime'):
            p = r['payload']
            if p.get('status') == 'busy':
                print('\t'.join((p.get('scopeRef', '').replace('agent:', ''), p.get('runtimeId', ''), str(p.get('generation')))))
    elif cmd == 'runtimes':
        for r in rows('hrc.runtime'):
            p = r['payload']
            if pat and not pat.search(json.dumps(p)):
                continue
            print(json.dumps(p)[:400])
    elif cmd == 'raw':
        print(json.dumps(call(sys.argv[2], json.loads(sys.argv[3]) if len(sys.argv) > 3 else {})))
    else:
        sys.exit(__doc__)


if __name__ == '__main__':
    main()
