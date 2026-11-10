#!/usr/bin/env python3
"""`hrc admin metrics report|routes`: native against a frozen, Bun-verified golden.

The Bun implementation was deleted in T-13047. Its last differential is frozen
in fixtures/metrics-golden.json: `--record` re-runs it (it needs a checkout
that still has the Bun CLI, or a Bun --oracle) and refuses to write unless
native equals Bun on every case except the two declared deltas below.

Failure modes: rollups drift on JS number semantics (percentile ranks, toFixed
ties, Math.round halves, float parsing, Number() limits, Date range); files
outside the day window are read; malformed records are counted; route sort
ties break differently; another writer's day files (`rusthrc-server-*`,
`script-*`) are not read, read twice, or their other kinds counted; a torn last
line (the daemon appending mid-read) fails the report.

Declared deltas from Bun (T-13047): every writer's day files are read, so
`filesScanned` counts them all; `--idle` names the routes only rusthrc serves
(admin/route-inventory.json).

Times: the fixture is anchored at a whole UTC minute, and every timestamp in
the output is rewritten as its offset from that anchor, so the golden holds at
any wall-clock time.
"""
import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import time
from datetime import datetime, timedelta, timezone

from metrics_isolation import isolated_suite

ROOT = Path(__file__).resolve().parents[3]
GOLDEN = Path(__file__).resolve().parent / 'fixtures/metrics-golden.json'
CUTOFF = [
    (r'(Request metrics since )-?\+?\d{4,6}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z', r'\1<cutoff>'),
    (r'("since": ")-?\+?\d{4,6}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z(")', r'\1<cutoff>\2'),
]
ISO = re.compile(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z')
MINUTE = re.compile(r'\d{4}-\d\d-\d\dT\d\d:\d\d(?![:\d])')
FILES = re.compile(r'(files=|filesScanned=|"filesScanned": ?)\d+')

REPORT_FLAGS = [[], ['--json'], ['--ndjson'], ['--output', 'json'], ['--since', '1d'], ['--since', '2d', '--json'],
                ['--since', '30d'], ['--since', '1.5h'], ['--since', '0s'], ['--since', '10000000d', '--json'],
                ['--since', ' 3d '], ['--since', 'bogus'], ['--since', 'bogus', '--output', 'json'], ['--since', '-1d'],
                ['--since', '999999999999d'], ['--since', '9' * 400 + 'd'], ['--since', ''],
                ['--slowest', '0'], ['--slowest', '2', '--json'], ['--slowest', '1.5'], ['--slowest', '-1'],
                ['--slowest', 'abc'], ['--slowest', ''], ['--slowest', '0x3'], ['--slowest', ' 4 '], ['--slowest', '1e1'],
                ['--slowest', 'Infinity'], ['--slowest', '9007199254740993'], ['--largest', '3', '--ndjson'],
                ['--largest', '-0'], ['--json', '--ndjson'], ['--ndjson', '--output', 'json']]
ROUTE_FLAGS = [[], ['--json'], ['--by', 'client'], ['--by', 'route,client', '--json'], ['--by', 'client, route'],
               ['--by', 'route,route'], ['--by', ''], ['--by', 'foo'], ['--by', 'route,'], ['--listener', 'main'],
               ['--listener', 'ingest', '--json'], ['--listener', 'peer'], ['--listener', 'registry'], ['--listener', 'nope'],
               ['--idle'], ['--idle', '--listener', 'peer'], ['--idle', '--json'], ['--idle', '--by', 'client'],
               ['--since', '2d'], ['--since', '1h'], ['--since', 'bogus'], ['--since', '999999999999d'],
               ['--since', '100000000d', '--json'], ['--output', 'json']]
EDGE_ARGS = [['report'], ['report', '--json'], ['report', '--since', '999999999999d'], ['routes'], ['routes', '--json', '--idle']]


def iso(t):
    return t.astimezone(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.') + f'{t.microsecond // 1000:03d}Z'


# -- metrics fixture --------------------------------------------------------------

def metrics_fixture(root, now):
    """Day files around a 7d window, with every record shape the readers judge."""
    day = lambda d: (now - timedelta(days=d)).strftime('%Y-%m-%d')
    ts = lambda **kw: iso(now - timedelta(**kw))
    cli = lambda cmd, dur, out, rpc=(), bin='hrc', at=None: dict(v=1, kind='cli', ts=at or ts(hours=1), bin=bin, cmd=cmd, durMs=dur, stdoutBytes=out, rpc=list(rpc))
    rpc = lambda i, ms, path='/v1/runtimes', status=200, nbytes=10: dict(id=i, path=path, method='GET', ms=ms, status=status, bytes=nbytes)
    srv = lambda route, ms, status=200, **kw: dict(v=1, kind='server', ts=kw.pop('at', ts(hours=2)), route=route, method=kw.pop('method', 'GET'), ms=ms, status=status, **kw)
    files = {}
    files[f'cli-{day(0)}.ndjson'] = [
        cli('monitor events', 19.944208, 140553, [rpc('r1', 3.25), rpc('r2', 1.5)]),
        cli('monitor events', 63.659125, 1200, [rpc('r3', 10)]),
        cli('monitor events', 5, 0),
        cli('monitor Events', 7.5, 33),
        cli('a-b', 1, 1), cli('a_b', 2, 2), cli('ab', 3, 3), cli('a.b', 4, 4), cli('A b', 5, 5),
        cli('send', 65.739667, 1355, bin='hrcchat'),
        cli('server status', 0.1 + 0.2, 7),
        dict(v=1.0, kind='cli', ts=ts(hours=3), bin='hrc', cmd='float version', durMs=2, stdoutBytes=2, rpc=[]),
        cli('bad rpc', 1, 1, [dict(id='x', path='/p', method='GET', ms=-1, status=200, bytes=1)]),
        dict(v=1, kind='cli', ts=ts(hours=1), bin='other', cmd='skip', durMs=1, stdoutBytes=1, rpc=[]),
        dict(v=1, kind='cli', ts=ts(hours=1), bin='hrc', cmd='neg', durMs=-1, stdoutBytes=1, rpc=[]),
        dict(v=1, kind='cli', ts='not a date', bin='hrc', cmd='bad ts', durMs=1, stdoutBytes=1, rpc=[]),
        dict(v=1, kind='launch', ts=ts(hours=1), bin='hrc', cmd='start', startupMs=812.5,
             phases=[dict(phase='resolve', ms=10), dict(phase='attach', ms=700.25)]),
        dict(v=1, kind='launch', ts=ts(hours=1), bin='hrc', cmd='start', startupMs=901,
             phases=[dict(phase='resolve', ms=12), dict(phase='attach', ms=650)]),
        dict(v=1, kind='launch', ts=ts(hours=1), bin='hrcchat', cmd='run', startupMs=44, phases=[dict(phase='resolve', ms=10)]),
        dict(v=1, kind='launch', ts=ts(hours=1), bin='hrc', cmd='bad phases', startupMs=1, phases=[dict(phase=3, ms=1)]),
    ]
    files[f'cli-{day(2)}.ndjson'] = [cli(f'monitor stats', i * 1.25, i * 100, at=ts(days=2, hours=1)) for i in range(1, 22)]
    # Name inside the window, records on both sides of the cutoff.
    files[f'cli-{day(7)}.ndjson'] = [
        cli('edge in', 9, 9, at=ts(days=7, hours=-2)),
        cli('edge out', 9, 9, at=ts(days=7, hours=2)),
    ]
    files[f'cli-{day(9)}.ndjson'] = [cli('old file', 1, 1, at=ts(hours=1))]
    files[f'server-{day(0)}.ndjson'] = [
        srv('/v1/runtimes', 27.48674999998184, bytes=9659, reqId='r1', client='hrc-cli/1'),
        srv('/v1/runtimes', 0.25, bytes=10, reqId='r2', client='hrc-cli/1', at=ts(hours=5)),
        srv('/v1/runtimes', 0.15, status=503, bytes=20, client='hrc-cli/2'),
        srv('/v1/runtimes', 0.05, stream=True, bytes=99999, client='hrc-cli/2'),
        srv('/v1/sessions/by-host/:hostSessionId', 1.0, bytes=5, sampleWeight=31),
        srv('/v1/sessions/by-host/:hostSessionId', 4.0, status=404, bytes=5),
        srv('/v1/status', 8.877666000000033, sampleWeight=3, bytes=2003, reqId='r3'),
        srv('/v1/ingest', 2.5, method='POST', listener='ingest', bytes=12, client='hrc-server/0.5'),
        srv('/v1/runs', 1.2, listener='peer', bytes=77, client='peer-x'),
        srv('/v1/runs', 3.3, bytes=78),
        srv('/v1/bindings', 0.75, listener='registry'),
        srv('/v1/skip', 1, listener='bogus'),
        srv('/v1/skip', 1, sampleWeight=1.5),
        srv('/v1/skip', 1, stream=False),
        srv('/v1/skip', 1, reqId=7),
        dict(v=1, kind='counter', ts=ts(hours=1), name='ledger.blob_miss', value=2),
        dict(v=1, kind='counter', ts=ts(hours=1), name='ledger.blob_miss', value=0.5),
        dict(v=1, kind='counter', ts=ts(hours=1), name='metrics.dropped', value=7),
        dict(v=1, kind='counter', ts=ts(hours=1), name='other', value=7),
        dict(v=1, kind='launch_span', ts=ts(hours=1), phase='broker-start-total', runtimeId='rt-1', ms=966.4),
        dict(v=1, kind='launch_span', ts=ts(hours=1), phase='broker-start-total', transport='headless', runtimeId='rt-2', ms=120),
        dict(v=1, kind='launch_span', ts=ts(hours=1), phase='precompile', transport='interactive', runtimeId='rt-3', ms=120),
        dict(v=1, kind='launch_span', ts=ts(hours=1), phase='bad', transport='tcp', runtimeId='rt-4', ms=1),
    ]
    files[f'server-{day(1)}.ndjson'] = [
        srv('/v1/runtimes', 36.21704200000386, bytes=1883, client='hrc-cli/1', at=ts(days=1)),
        srv('/v1/events', 0.95, bytes=1, at=ts(days=1, hours=1)),
    ]
    raw = {name: '\n'.join(json.dumps(r, separators=(',', ':')) for r in rows) + '\n' for name, rows in files.items()}
    raw[f'cli-{day(0)}.ndjson'] += '\nnot json\n   \n[1,2]\nnull\n{"v":1,"kind":"cli"}\r\n'
    raw[f'server-{day(1)}.ndjson'] = raw[f'server-{day(1)}.ndjson'].replace('\n', '\r\n')
    full = root / 'full' / 'metrics'
    full.mkdir(parents=True)
    for name, text in raw.items():
        (full / name).write_text(text)
    (full / 'cli-2026-1-1.ndjson').write_text(raw[f'cli-{day(0)}.ndjson'])
    (full / 'notes.txt').write_text('ignored\n')
    (full / f'server-{day(3)}.ndjson').mkdir()  # selected and counted, unreadable
    (root / 'empty' / 'metrics').mkdir(parents=True)
    (root / 'nodir').mkdir(parents=True)
    (root / 'file').mkdir(parents=True)
    (root / 'file' / 'metrics').write_text('not a directory\n')


def writers_variant(root):
    """`full` as the native daemon writes it: the server day files become
    rusthrc-server-* (with the native-only members), plus a script-* writer,
    kinds no report reads, and a torn last line. Must read exactly as `full`."""
    full, out = root / 'full' / 'metrics', root / 'writers' / 'metrics'
    out.mkdir(parents=True)
    for path in sorted(full.iterdir()):
        if not path.name.startswith('server-'):
            shutil.copy2(path, out / path.name) if path.is_file() else (out / path.name).mkdir()
            continue
        target = out / ('rusthrc-' + path.name)
        if path.is_dir():
            target.mkdir()
            continue
        lines = []
        for line in path.read_bytes().split(b'\n'):
            if line.startswith(b'{"v":1,"kind":"server"'):
                line = b'{"v":1,"kind":"server","servedBy":"native","caller":"fixture",' + line[len(b'{"v":1,"kind":"server",'):]
            lines.append(line)
        target.write_bytes(b'\n'.join(lines))
    day0 = sorted(p.name for p in out.glob('rusthrc-server-*.ndjson') if p.is_file())[-1]
    with (out / day0).open('a') as f:
        f.write('{"v":1,"kind":"sqlite_slow_statement","ts":"%s","callerTag":"x","sql":"SELECT 1","ms":900}\n' % iso(datetime.now(timezone.utc)))
        f.write('{"v":1,"kind":"server","servedBy":"native","ts":"20')  # torn: the daemon is mid-append
    (out / day0.replace('rusthrc-server-', 'script-')).write_text(
        '{"v":1,"kind":"script","ts":"%s","script":"reap","cmd":"-y","exitCode":0,"durMs":256}\n' % iso(datetime.now(timezone.utc)))


def normalize(text, anchor):
    for pattern, replacement in CUTOFF:
        text = re.sub(pattern, replacement, text)
    ms = lambda m: int((anchor - datetime.strptime(m.group(0), '%Y-%m-%dT%H:%M:%S.%fZ').replace(tzinfo=timezone.utc)).total_seconds() * 1000)
    text = ISO.sub(lambda m: f'<t-{ms(m)}ms>', text)
    minutes = lambda m: int((anchor - datetime.strptime(m.group(0), '%Y-%m-%dT%H:%M').replace(tzinfo=timezone.utc)).total_seconds() // 60)
    return MINUTE.sub(lambda m: f'<m-{minutes(m)}>', text)


def cases():
    out = [('full', ['admin', 'metrics', 'report'] + f) for f in REPORT_FLAGS]
    out += [('full', ['admin', 'metrics', 'routes'] + f) for f in ROUTE_FLAGS]
    out += [(v, ['admin', 'metrics'] + a) for v in ('empty', 'nodir', 'file') for a in EDGE_ARGS]
    return out


@isolated_suite
def main():
    p = argparse.ArgumentParser()
    p.add_argument('--binary', type=Path, required=True)
    p.add_argument('--artifacts', type=Path, required=True)
    p.add_argument('--record', action='store_true', help='re-verify against Bun and rewrite the golden')
    p.add_argument('--oracle', type=Path, default=ROOT / 'packages/hrc-cli/bin/hrc.js')
    args = p.parse_args()
    args.artifacts.mkdir(parents=True, exist_ok=True)
    # Anchor at a whole minute, never within two minutes of UTC midnight (day files).
    while (time.time() % 86400) > 86400 - 180 or time.time() % 60 > 50:
        time.sleep(1)
    anchor = datetime.fromtimestamp(time.time() // 60 * 60, timezone.utc)
    time.sleep(max(0, anchor.timestamp() + 1 - time.time()))
    fix = Path(tempfile.mkdtemp(prefix='hrc-metrics-report-', dir='/tmp')).resolve()
    metrics_fixture(fix / 'metrics', anchor)
    writers_variant(fix / 'metrics')
    state = fix / 'state'
    env = {k: v for k, v in os.environ.items() if not k.startswith(('ASP_', 'HRC_', 'WRKQ', 'AGENT_ID'))}
    env.update(HRC_RUNTIME_DIR=str(fix / 'run'), HRC_STATE_DIR=str(state), HRC_METRICS='0', NO_COLOR='1', FORCE_COLOR='0')
    if not args.record:
        bin_dir = fix / 'no-bun'
        bin_dir.mkdir()
        env['PATH'] = f'{bin_dir}:/usr/bin:/bin'  # no `bun`: every case must be native

    def observe(command, variant, argv):
        shutil.rmtree(state, ignore_errors=True)
        shutil.copytree(fix / 'metrics' / variant, state, symlinks=True)
        c = subprocess.run(command + argv, env=env, cwd=fix, capture_output=True, text=True, timeout=120)
        return dict(exit=c.returncode, stdout=normalize(c.stdout, anchor), stderr=normalize(c.stderr, anchor))

    results = []
    if args.record:
        inventory = {(e['listener'], e['method'], e['route']) for e in json.loads((ROOT / 'crates/hrc-cli/src/admin/route-inventory.json').read_text())['inventory']}
        bun_inventory = (json.loads(subprocess.run(['bun', '-e', "import {listRequestRouteInventory} from './packages/hrc-server/src/request-route-inventory.ts'; console.log(JSON.stringify(listRequestRouteInventory().map(e => [e.listener, e.method, e.route])))"], cwd=ROOT, capture_output=True, text=True, check=True).stdout))
        bun_inventory = {tuple(e) for e in bun_inventory}
    golden = {} if args.record else json.loads(GOLDEN.read_text())['cases']
    for variant, argv in cases():
        key = f'[{variant}] ' + ' '.join(argv)
        subject = observe([str(args.binary.resolve())], variant, argv)
        if args.record:
            oracle = observe(['bun', str(args.oracle.resolve())], variant, argv)
            # The declared deltas: files of every writer, and native-only idle routes.
            def bun_view(item):
                item = dict(item, stdout=FILES.sub(r'\g<1>0', item['stdout']))
                if '--idle' in argv and item['exit'] == 0 and item['stdout'].lstrip().startswith('{'):
                    report = json.loads(item['stdout'])
                    report['idle'] = [e for e in report['idle'] if (e['listener'], e['method'], e['route']) in bun_inventory]
                    item['stdout'] = json.dumps(report, indent=2) + '\n'
                elif '--idle' in argv and item['exit'] == 0:
                    lines = item['stdout'].split('\n')
                    kept = [l for l in lines if not (l.startswith('  ') and tuple(l.split()) in inventory and tuple(l.split()) not in bun_inventory)]
                    item['stdout'] = re.sub(r'Idle routes \(no request in window\): \d+', 'Idle routes', '\n'.join(kept))
                return item
            # `report` read every file Bun read here (cli-*, server-*): exact.
            same = bun_view(oracle) == bun_view(subject) if 'routes' in argv else oracle == subject
            results.append(dict(case=key, **{'pass': same}, oracle=oracle, subject=subject))
            golden[key] = subject
        else:
            results.append(dict(case=key, **{'pass': subject == golden.get(key)}, expected=golden.get(key), subject=subject))
    # Every writer's day files read once: `writers` reads exactly as `full`,
    # with one more file scanned (script-*).
    for argv in [['admin', 'metrics', 'report'] + f for f in REPORT_FLAGS] + [['admin', 'metrics', 'routes'] + f for f in ROUTE_FLAGS]:
        full, writers = observe([str(args.binary.resolve())], 'full', argv), observe([str(args.binary.resolve())], 'writers', argv)
        counts = lambda item: [int(n) for n in re.findall(r'(?:files=|filesScanned=|"filesScanned": ?)(\d+)', item['stdout'])]
        strip = lambda item: dict(item, stdout=FILES.sub(r'\g<1>0', item['stdout']))
        good = strip(full) == strip(writers) and [n + 1 for n in counts(full)] == counts(writers)
        results.append(dict(case='[writers = full] ' + ' '.join(argv), **{'pass': good}, full=full, writers=writers))
    if args.record and all(r['pass'] for r in results):
        GOLDEN.parent.mkdir(exist_ok=True)
        GOLDEN.write_text(json.dumps(dict(recordedFrom='native, verified equal to Bun but for the declared deltas', cases=golden), indent=1, ensure_ascii=False) + '\n')
    failed = [r['case'] for r in results if not r['pass']]
    (args.artifacts / 'results.json').write_text(json.dumps(dict(cases=len(results), failed=failed, results=results), indent=2) + '\n')
    print(json.dumps(dict(cases=len(results), failed=len(failed))))
    for case in failed:
        print('FAIL', case)
    shutil.rmtree(fix)
    return 1 if failed else 0


if __name__ == '__main__':
    raise SystemExit(main())
