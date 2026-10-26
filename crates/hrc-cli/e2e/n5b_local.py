#!/usr/bin/env python3
"""server subscribers, server tmux status, runtime diagnostics/sweep/prune,
doctor and info: Bun oracle vs native rusthrc against the owned scratch seat.

Failure modes: a follow-stream admission row drops or reorders a field, a
null renders as "null" instead of "-", the tmux probe reads the wrong socket,
loses the 64-lease probe limit or its skipped count, leases sort differently,
a relative or unnormalized runtime root prints a different path, a trip id is
resolved as a runtime selector (or the reverse), the sweep/prune mutation gate
lets a non-TTY run mutate, the legacy argv rescan stops seeing flags hidden in
option values, request defaults (24h, dryRun) drift, an NDJSON row is pretty
printed, doctor's exit code ignores fail/--strict, a target error loses its
[code], and info's node block misreads the federation config (JSON.parse
messages, URL normalization, integer-key order, every field diagnostic).

Safety: the only runtime is the acceptance seat. Every sweep/prune that may
mutate is gated by a filter that cannot select it (another scope, transport or
status), and the suite records the seat's runtime row before and after and
fails if anything about it changed. tmux probes only list sessions.
"""
import argparse
import http.client
import json
import os
from pathlib import Path
import shutil
import socket
import tempfile
import threading

from metrics_isolation import isolated_suite
from n5b_common import Runner, scratch_env

NORMALIZATION = {
    # Daemon uptime advances between the oracle and subject observations.
    'doctor_uptime_human': (r'(hrc-daemon \(up )\d+(s\))', r'\1<uptime>\2'),
    'doctor_uptime_json': (r'("detail": "up )\d+(s")', r'\1<uptime>\2'),
}

OTHER_SCOPE = 'agent:nobody-n5b:project:none-n5b'


class UnixHTTP(http.client.HTTPConnection):
    def __init__(self, path):
        super().__init__('hrc', timeout=10)
        self.path = path

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX)
        self.sock.settimeout(10)
        self.sock.connect(self.path)


SEAT_IDENTITY = ('runtimeId', 'hostSessionId', 'scopeRef', 'laneRef', 'generation', 'transport', 'status',
                 'statusChangedAt', 'lastActivityAt', 'activeInvocationId', 'createdAt')


def seat_row(sock, rid):
    """The seat's lifecycle identity. updatedAt and the periodic live-seat probe
    advance on their own, so only fields a sweep/prune would change compare."""
    conn = UnixHTTP(sock)
    conn.request('GET', '/v1/runtimes?limit=500')
    rows = json.loads(conn.getresponse().read())
    conn.close()
    row = next((r for r in rows if r['runtimeId'] == rid), None)
    if row is None:
        return None
    projection = {k: row.get(k) for k in SEAT_IDENTITY}
    projection['brokerPid'] = row['runtimeStateJson']['broker'].get('brokerPid')
    projection['brokerAttached'] = row['runtimeStateJson']['control'].get('brokerAttached')
    return projection


class Follow:
    """Hold one read-only follow stream open so the admission is live."""

    def __init__(self, sock, query):
        self.sock = socket.socket(socket.AF_UNIX)
        self.sock.connect(sock)
        self.sock.sendall(f'GET /v1/events?{query} HTTP/1.1\r\nHost: hrc\r\n\r\n'.encode())
        head = b''
        while b'\r\n\r\n' not in head:
            head += self.sock.recv(4096)
        assert head.startswith(b'HTTP/1.1 200'), head

    def close(self):
        self.sock.close()


def write_configs(root):
    """Federation config fixtures; each run points HRC_PEER_CONFIG_FILE at one."""
    files = {
        'single.json': '{"nodeId":"lab"}',
        'empty-object.json': '{}',
        'peers.json': json.dumps({
            'nodeId': 'lab',
            'peers': {
                'svc': {'endpoint': ' HTTPS://Svc.Example.ts.net:443/a/../b?x#y ', 'token': 't1'},
                '10': {'endpoint': 'http://[::1]:80', 'token': 't2', 'acceptedTokens': ['t2', 't2b']},
                '2': {'endpoint': 'http://1.2.3.4:8080/', 'token': 't3',
                      'registryEndpoint': 'https://svc.example.ts.net:18491/'},
            },
            'registry': {'bind': 'http://100.64.0.1:18491'},
            'peerListener': {'bind': 'http://lab.example.ts.net:18490/'},
            'gate': {'mode': 'advisory', 'registryHost': 'svc'},
        }),
        'derived-peers.json': '{"peers":{"svc":{"endpoint":"http://svc:1","token":"a"}}}',
        'derived-registry.json': '{"registry":{"bind":"http://100.64.0.1:1"}}',
        'derived-listener.json': '{"peerListener":{"bind":"http://100.64.0.1:1"}}',
        'listener-no-peers.json': '{"nodeId":"lab","peerListener":{"bind":"http://100.64.0.1:1"}}',
        'bom.json': '﻿{"nodeId":"lab"}',
        'dup-keys.json': '{"nodeId":"a","nodeId":"lab"}',
        'proto.json': '{"nodeId":"lab","peers":{"__proto__":{"endpoint":"http://x:1","token":"p"}}}',
    }
    bad = {
        'trunc': '{"nodeId":', 'ident': 'nope', 'empty': '', 'blank': ' \n', 'trail': '{"a":1,}',
        'array': '[1,2]', 'string': '"lab"', 'null': 'null', 'extra': '{"nodeId":"lab"} x',
        'unterm': '"str', 'colon': '{"a" 1}', 'brace': '{', 'rbrace': '{"a":1 "b":2}',
        'arr-comma': '[1,]', 'arr-open': '[1 2]', 'rtoken': ']', 'single': "'a'", 'at': '{"a":@}',
        'nbsp': ' {}', 'esc': '"a\\x"', 'u-short': '"a\\u12"', 'u-bad': '"a\\u12G4"',
        'ctrl': '{"a":"\u0001"}', 'num-dash': '-', 'num-dot': '1.', 'num-lead': '01', 'num-exp': '[1e]',
        'truex': '{"a":truex}', 'tr': '{"a":tr}', 'paren': '(', 'dot': '.5', 'plus': '+1', 'uni': 'nulé',
        'nodeid-number': '{"nodeId":5}', 'nodeid-null': '{"nodeId":null}', 'nodeid-empty': '{"nodeId":""}',
        'nodeid-long': json.dumps({'nodeId': 'x' * 65}), 'nodeid-chars': '{"nodeId":"a b/c bé😀"}',
        'nodeid-local': '{"nodeId":"LoCaL"}', 'peers-array': '{"nodeId":"lab","peers":[]}',
        'peer-key': '{"nodeId":"lab","peers":{"bad key":{}}}',
        'peer-self': '{"nodeId":"lab","peers":{"lab":{}}}',
        'peer-entry': '{"nodeId":"lab","peers":{"svc":"x"}}',
        'peer-endpoint': '{"nodeId":"lab","peers":{"svc":{"endpoint":"  ","token":"a"}}}',
        'peer-registry-type': '{"nodeId":"lab","peers":{"svc":{"endpoint":"http://s:1","registryEndpoint":5,"token":"a"}}}',
        'peer-token': '{"nodeId":"lab","peers":{"svc":{"endpoint":"http://s:1","token":""}}}',
        'peer-accepted': '{"nodeId":"lab","peers":{"svc":{"endpoint":"http://s:1","token":"a","acceptedTokens":[]}}}',
        'peer-accepted-dup': '{"nodeId":"lab","peers":{"svc":{"endpoint":"http://s:1","token":"a","acceptedTokens":["b","b"]}}}',
        'peer-token-reuse': '{"nodeId":"lab","peers":{"svc":{"endpoint":"http://s:1","token":"a"},"web":{"endpoint":"http://w:1","token":"z","acceptedTokens":["a"]}}}',
        'endpoint-url': '{"nodeId":"lab","peers":{"svc":{"endpoint":"not a url","token":"a"}}}',
        'endpoint-scheme': '{"nodeId":"lab","peers":{"svc":{"endpoint":"ftp://s:1","token":"a"}}}',
        'endpoint-wild': '{"nodeId":"lab","peers":{"svc":{"endpoint":"http://0.0.0.0:1","token":"a"}}}',
        'endpoint-v6wild': '{"nodeId":"lab","peers":{"svc":{"endpoint":"http://[::]:1","token":"a"}}}',
        'endpoint-star': '{"nodeId":"lab","peers":{"svc":{"endpoint":"http://*.example:1","token":"a"}}}',
        'registry-url': '{"nodeId":"lab","peers":{"svc":{"endpoint":"http://s:1","token":"a","registryEndpoint":"::"}}}',
        'registry-scheme': '{"nodeId":"lab","peers":{"svc":{"endpoint":"http://s:1","token":"a","registryEndpoint":"ws://a.ts.net:1"}}}',
        'registry-creds': '{"nodeId":"lab","peers":{"svc":{"endpoint":"http://s:1","token":"a","registryEndpoint":"http://u:p@a.ts.net:1"}}}',
        'registry-port': '{"nodeId":"lab","peers":{"svc":{"endpoint":"http://s:1","token":"a","registryEndpoint":"https://a.ts.net"}}}',
        'registry-port0': '{"nodeId":"lab","peers":{"svc":{"endpoint":"http://s:1","token":"a","registryEndpoint":"https://a.ts.net:0"}}}',
        'registry-host': '{"nodeId":"lab","peers":{"svc":{"endpoint":"http://s:1","token":"a","registryEndpoint":"https://10.0.0.1:5"}}}',
        'registry-path': '{"nodeId":"lab","peers":{"svc":{"endpoint":"http://s:1","token":"a","registryEndpoint":"https://a.ts.net:5/x"}}}',
        'registry-v6': '{"nodeId":"lab","peers":{"svc":{"endpoint":"http://s:1","token":"a","registryEndpoint":"http://[FD7A:115C:A1E0::1]:5"}}}',
        'bind-object': '{"nodeId":"lab","registry":"x"}',
        'bind-missing': '{"nodeId":"lab","registry":{}}',
        'bind-url': '{"nodeId":"lab","registry":{"bind":"nope"}}',
        'bind-https': '{"nodeId":"lab","registry":{"bind":"https://100.64.0.1:1"}}',
        'bind-port': '{"nodeId":"lab","registry":{"bind":"http://100.64.0.1"}}',
        'bind-path': '{"nodeId":"lab","registry":{"bind":"http://100.64.0.1:1/x"}}',
        'bind-host': '{"nodeId":"lab","registry":{"bind":"http://100.128.0.1:1"}}',
        'listener-object': '{"nodeId":"lab","peerListener":[]}',
        'listener-missing': '{"nodeId":"lab","peerListener":{"bind":5}}',
        'listener-host': '{"nodeId":"lab","peerListener":{"bind":"http://127.0.0.1:1"}}',
        'listener-query': '{"nodeId":"lab","peerListener":{"bind":"http://100.64.0.1:1?x"}}',
        'gate-object': '{"nodeId":"lab","gate":true}',
        'gate-mode': '{"nodeId":"lab","gate":{"mode":"on"}}',
        'gate-mode-missing': '{"nodeId":"lab","gate":{}}',
        'gate-mode-number': '{"nodeId":"lab","gate":{"mode":1.0}}',
        'gate-host-type': '{"nodeId":"lab","gate":{"mode":"off","registryHost":7}}',
        'gate-host': '{"nodeId":"lab","gate":{"mode":"off","registryHost":"local"}}',
    }
    for name, text in bad.items():
        files[f'bad-{name}.json'] = text
    for name, text in files.items():
        (root / name).write_text(text, encoding='utf-8')
        os.chmod(root / name, 0o600)
    (root / 'loose.json').write_text('{"nodeId":"lab"}')
    os.chmod(root / 'loose.json', 0o644)
    (root / 'noread.json').write_text('{"nodeId":"lab"}')
    os.chmod(root / 'noread.json', 0)
    (root / 'dir.json').mkdir()
    (root / 'file').write_text('x')
    os.symlink('loop.json', root / 'loop.json')
    (root / 'invalid-utf8.json').write_bytes(b'{"nodeId":"\xff\xfelab"}')
    names = sorted(files) + ['loose.json', 'noread.json', 'dir.json', 'loop.json', 'invalid-utf8.json',
                             'absent.json', 'file/child.json']
    return names


def tmux_roots(root):
    """Scratch runtime roots for tmux status; nothing listens on these sockets."""
    (root / 'tm-empty').mkdir()
    leases = root / 'tm-leases' / 'btmux'
    leases.mkdir(parents=True)
    for name in ('b.sock', 'A.sock', '0.sock', 'notsock.txt', '_z.sock'):
        (leases / name).write_text('')
    many = root / 'tm-many' / 'btmux'
    many.mkdir(parents=True)
    for i in range(66):
        (many / f'l{i:02}.sock').write_text('')
    (root / 'tm-file').mkdir()
    (root / 'tm-file' / 'btmux').write_text('not a dir')


@isolated_suite
def main():
    p = argparse.ArgumentParser()
    for flag in ('binary', 'oracle', 'runtime-root', 'state-root', 'seat', 'artifacts'):
        p.add_argument('--' + flag, type=Path, required=True)
    args = p.parse_args()
    seat = json.loads(args.seat.read_text())
    rid, host, scope = seat['start']['runtimeId'], seat['start']['hostSessionId'], seat['scope']
    handle, session_ref = seat['handle'], seat['sessionRef']
    env = scratch_env(args.runtime_root, args.state_root)
    runner = Runner(args.binary, args.oracle, args.artifacts, env, NORMALIZATION)
    sock = str(args.runtime_root / 'hrc.sock')
    before = seat_row(sock, rid)
    assert before is not None and before['status'] == 'ready', before
    scratch = Path(tempfile.mkdtemp(prefix='n5b-local-'))
    try:
        cases(runner, env, args, scratch, rid, host, scope, handle, session_ref, sock)
    finally:
        if (scratch / 'fed' / 'noread.json').exists():
            os.chmod(scratch / 'fed' / 'noread.json', 0o600)
        shutil.rmtree(scratch, ignore_errors=True)
    after = seat_row(sock, rid)
    unchanged = after == before
    runner.results.append(dict(case='seat unchanged after suite', argv=[], oracle=before, subject=after,
                               **{'pass': unchanged}))
    return runner.finish(seat=rid, seatBefore=before, seatAfter=after,
                         execution='native-required; Bun absent from subject PATH')


def cases(runner, env, args, scratch, rid, host, scope, handle, session_ref, sock):
    def with_env(**extra):
        e = dict(env)
        e.update(extra)
        return e

    # Missing and stale daemon sockets.
    (scratch / 'stale-run').mkdir()
    (scratch / 'stale-run' / 'hrc.sock').write_text('')
    missing, stale = with_env(HRC_RUNTIME_DIR=str(scratch / 'missing-run')), with_env(HRC_RUNTIME_DIR=str(scratch / 'stale-run'))
    for argv in (['server', 'subscribers'], ['runtime', 'diagnostics'], ['runtime', 'sweep', '--dry-run'],
                 ['runtime', 'prune', '--dry-run'], ['doctor'], ['doctor', '--json']):
        runner.case(argv, name='missing socket: ' + ' '.join(argv), env=missing)
        runner.case(argv, name='stale socket: ' + ' '.join(argv), env=stale)

    # server subscribers: whatever state exists, then live, then closed admissions.
    sub = ['server', 'subscribers']
    for extra in ([], ['--json'], ['--output', 'json'], ['--output=json'], ['extra'], ['--bogus'], ['--human'], ['--agent']):
        runner.case(sub + extra)
    streams = [Follow(sock, 'follow=true&fromSeq=999999999&runtimeId=rt-n5b-none'),
               Follow(sock, 'follow=true&fromSeq=999999998&scopeRef=agent%3Anobody&receipt=consumer-ack-v1')]
    for extra in ([], ['--json']):
        runner.case(sub + extra, name='live admissions: ' + ' '.join(sub + extra))
    for s in streams:
        s.close()
    threading.Event().wait(0.5)
    for extra in ([], ['--json']):
        runner.case(sub + extra, name='closed admissions: ' + ' '.join(sub + extra))

    # server tmux status: the fixture root (a live lease), then scratch roots.
    tm = ['server', 'tmux', 'status']
    for extra in ([], ['--json'], ['--output', 'json'], ['extra'], ['--bogus']):
        runner.case(tm + extra)
    tmux_roots(scratch)
    for root in ('tm-empty', 'tm-leases', 'tm-many', 'tm-file', 'tm-absent'):
        for extra in ([], ['--json']):
            runner.case(tm + extra, name=f'{root}: ' + ' '.join(tm + extra),
                        env=with_env(HRC_RUNTIME_DIR=str(scratch / root)))
    # Relative and unnormalized roots resolve against cwd and print as Node joins them.
    cwd = runner.cwd
    runner.cwd = scratch
    for root in ('tm-leases', './tm-leases/', 'tm-many//', 'tm-empty/../tm-leases', 'tm-empty'):
        for extra in ([], ['--json']):
            runner.case(tm + extra, name=f'relative root {root}: ' + ' '.join(tm + extra),
                        env=with_env(HRC_RUNTIME_DIR=root))
    runner.cwd = cwd
    # tmux absent: both sides get a PATH without it (the subject's still lacks bun).
    subject_path = runner.subject_path
    runner.subject_path = subject_path.split(':')[0] + ':/usr/bin:/bin'
    assert not shutil.which('tmux', path=runner.subject_path)
    for extra in ([], ['--json']):
        runner.case(tm + extra, name='tmux absent from PATH: ' + ' '.join(tm + extra), env=with_env(PATH='/usr/bin:/bin'))
    runner.subject_path = subject_path

    # runtime diagnostics: list, trip ids, runtime selectors and type errors.
    diag = ['runtime', 'diagnostics']
    for target in ([], [rid], ['runtime:' + rid], [handle], ['scope:' + scope], [scope], ['rt-missing'],
                   ['runtime:rt-missing'], ['5'], ['0'], ['007'], ['99999999999999999999'],
                   ['1' * 22], ['1e3'], [' 5'], [''], [host], ['host:' + host], ['wat:foo'],
                   ['msg:x'], ['nobody@hrc-runtime:x'], ['--', '-5'], ['a', 'b']):
        for flags in ([], ['--json']):
            runner.case(diag + target + flags)
    runner.case(diag + ['--bogus'])

    # runtime sweep: gate, defaults, request shaping, legacy flag rescans.
    sweep = ['runtime', 'sweep']
    for extra in ([], ['--json'], ['--transport', 'tmux'], ['--transport', 'bogus'], ['--transport', 'bogus', '--dry-run'],
                  ['--dry-run'], ['--dry-run', '--json'], ['--dry-run', '--older-than', '1s'],
                  ['--dry-run', '--older-than', '1s', '--json'], ['--dry-run', '--yes', '--older-than', '1s'],
                  ['--dry-run', '--older-than', 'bogus'], ['--dry-run', '--older-than', ''],
                  ['--dry-run', '--status', 'bogus'], ['--dry-run', '--status', ','],
                  ['--dry-run', '--status', ' ready , busy ', '--older-than', '1s'],
                  ['--dry-run', '--scope', ''], ['--dry-run', '--scope', 'nope'], ['--dry-run', '--scope', scope, '--older-than', '1s'],
                  ['--dry-run', '--drop-continuation', '--older-than', '1s', '--json'],
                  ['--dry-run', '--transport', 'headless'], ['--dry-run', '--transport', 'sdk', '--json'],
                  ['--scope', '--dry-run'], ['--scope', '--dry-run', '--older-than', '1s', '--json'],
                  ['--older-than', '--dry-run'], ['--status', '--dry-run'], ['--older-than=1s', '--dry-run'],
                  ['--dry-run', 'extra'], ['--bogus']):
        runner.case(sweep + extra)
    # Mutating sweeps, each filtered so it cannot select the seat.
    for extra in (['--yes', '--scope', OTHER_SCOPE], ['--yes', '--scope', OTHER_SCOPE, '--older-than', '1s', '--json'],
                  ['--yes', '--transport', 'headless', '--older-than', '1s'], ['--yes', '--transport', 'sdk', '--older-than', '1s', '--json'],
                  ['--yes', '--status', 'stale', '--scope', OTHER_SCOPE, '--older-than', '1s', '--drop-continuation'],
                  ['--yes', '--transport', 'tmux', '--scope', OTHER_SCOPE, '--older-than', '1s']):
        runner.case(sweep + extra)

    # runtime prune: gate, disposition rules, legacy rescans, request defaults.
    prune = ['runtime', 'prune']
    for extra in ([], ['--json'], ['--dry-run'], ['--dry-run', '--json'], ['--dry-run', '--yes'],
                  ['--dry-run', '--status', 'ready', '--older-than', '1s'],
                  ['--dry-run', '--status', 'ready', '--older-than', '1s', '--json'],
                  ['--dry-run', '--older-than', 'bogus'], ['--dry-run', '--status', ','], ['--dry-run', '--scope', ''],
                  ['--dry-run', '--transport', 'bogus'], ['--dry-run', '--transport', 'sdk'],
                  ['--dispose-retained-evidence', '--dry-run'], ['--dispose-retained-evidence', '--dry-run', '--reason', '  '],
                  ['--dispose-retained-evidence', '--dry-run', '--reason', 'r'],
                  ['--dispose-retained-evidence', '--dry-run', '--reason', 'r', '--runtime-id', ''],
                  ['--dispose-retained-evidence', '--dry-run', '--reason', 'r', '--runtime-id', 'rt-missing'],
                  ['--dispose-retained-evidence', '--dry-run', '--reason', 'r', '--runtime-id', 'rt-missing', '--json'],
                  ['--dispose-retained-evidence', '--dry-run', '--reason', '--include-ledgers', '--runtime-id', 'rt-missing'],
                  ['--dispose-retained-evidence', '--dry-run', '--reason', 'r', '--runtime-id', '--transport'],
                  ['--dry-run', '--reason', 'r'], ['--dry-run', '--runtime-id', 'rt-x'], ['--dry-run', '--reason', ''],
                  ['--scope', '--dry-run'], ['--scope', '--yes', '--status', 'stale', '--older-than', '1s'],
                  ['--transport', 'bogus'], ['--runtime-ids-file', 'x', '--include-ledgers', '--dry-run'],
                  ['--dry-run', 'extra'], ['--yes']):
        if extra == ['--yes']:
            extra = ['--yes', '--scope', OTHER_SCOPE]
        runner.case(prune + extra)
    for extra in (['--yes', '--scope', OTHER_SCOPE, '--json'], ['--yes', '--status', 'stale', '--older-than', '1s', '--scope', OTHER_SCOPE],
                  ['--yes', '--transport', 'headless', '--status', 'stale', '--older-than', '1s', '--json']):
        runner.case(prune + extra)

    # doctor: node checks, target checks, strictness and exit codes.
    for target in ([], [handle], [scope], ['tabularasa@hrc-runtime:other-task'], ['nobody@hrc-runtime:x'],
                   ['Bad Handle!'], [handle + '+bogus'], [handle + '+model=x+model=y'], [''], [handle + '~lane2'],
                   ['tabularasa'], ['--', '-x'], ['--', '--x'], ['agent:tabularasa:project:hrc-runtime:task:'], ['a', 'b']):
        for flags in ([], ['--json'], ['--strict'], ['--strict', '--json']):
            runner.case(['doctor'] + target + flags)
    runner.case(['doctor', 'tabularasa@hrc-runtime'], name='doctor caller task from HRC_SESSION_REF',
                env=with_env(HRC_SESSION_REF=session_ref))
    runner.case(['doctor', 'tabularasa@hrc-runtime', '--json'], name='doctor caller task from HRC_SESSION_REF --json',
                env=with_env(HRC_SESSION_REF=session_ref))
    runner.case(['doctor', 'tabularasa'], name='doctor bare agent with ASP_PROJECT',
                env=with_env(ASP_PROJECT='hrc-runtime', ASP_DEFAULT_TASK='n5b-11821-acceptance'))
    runner.case(['doctor', '--bogus'])

    # info: views, flag conflicts, and the THIS NODE federation summary.
    fed = scratch / 'fed'
    fed.mkdir()
    names = write_configs(fed)
    for extra in ([], ['--agent'], ['--human'], ['--json'], ['--agent', '--json'], ['--human', '--json'],
                  ['--output', 'json'], ['--agent', '--human'], ['extra'], ['--bogus']):
        runner.case(['info'] + extra, env=with_env(HRC_PEER_CONFIG_FILE=str(fed / 'absent.json')))
    runner.case(['--human', 'info'], env=with_env(HRC_PEER_CONFIG_FILE=str(fed / 'absent.json')))
    runner.case(['info'], name='info agent identity env', env=with_env(HRC_PEER_CONFIG_FILE=str(fed / 'absent.json'), AGENT_ID='x'))
    runner.case(['info', '--json'], name='info default config path (state root)')
    runner.case(['info', '--json'], name='info blank HRC_PEER_CONFIG_FILE', env=with_env(HRC_PEER_CONFIG_FILE='   '))
    for name in names:
        config = with_env(HRC_PEER_CONFIG_FILE=str(fed / name))
        runner.case(['info', '--json'], name=f'info --json config {name}', env=config)
        runner.case(['info', '--human'], name=f'info --human config {name}', env=config)
    runner.case(['info'], name='info padded config path', env=with_env(HRC_PEER_CONFIG_FILE=f'  {fed / "single.json"}  '))


if __name__ == '__main__':
    raise SystemExit(main())
