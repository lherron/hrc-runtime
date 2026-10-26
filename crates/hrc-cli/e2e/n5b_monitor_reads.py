#!/usr/bin/env python3
"""monitor events/transcript/stats/show/session-report against a real owned seat.

Failure modes: invocation seq and hrcSeq get mixed, a selector resolves a wrong
generation, --previous picks a live runtime or the wrong order, tail/kind/type
filters drift, clipping counts bytes instead of UTF-16 units, provenance is
hidden, not-found errors become success, and flag conflicts change precedence.
"""
import argparse
import json
from pathlib import Path

from metrics_isolation import isolated_suite
from n5b_common import Runner, scratch_env

NORMALIZATION = {
    'timestamp': (r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z', '<timestamp>'),
    'uptime_json': (r'("uptime": )\d+', r'\1<uptime>'),
}


@isolated_suite
def main():
    p = argparse.ArgumentParser()
    for flag in ('binary', 'oracle', 'runtime-root', 'state-root', 'seat', 'artifacts'):
        p.add_argument('--' + flag, type=Path, required=True)
    args = p.parse_args()
    seat = json.loads(args.seat.read_text())
    rid, host, scope = seat['start']['runtimeId'], seat['start']['hostSessionId'], seat['scope']
    handle = seat['handle']
    runner = Runner(args.binary, args.oracle, args.artifacts,
                    scratch_env(args.runtime_root, args.state_root), NORMALIZATION)
    for command in ('events', 'transcript', 'stats'):
        for target in (rid, 'runtime:' + rid, handle, 'scope:' + scope, scope, 'runtime:rt-missing', 'rt-missing', 'wat:foo', 'inv-missing'):
            for flags in ([], ['--json']):
                runner.case(['monitor', command, target] + flags)
        for extra in ([], ['--latest', '--previous'], ['--previous'], ['--previous', '2'], ['--previous=0'],
                      ['--source-ref', 'missing-ref'], ['--previous', '--source-ref', 'x']):
            runner.case(['monitor', command, handle] + extra)
        runner.case(['monitor', command])
        runner.case(['monitor', command, '--source-ref', 'missing-ref', '--json'])
        runner.case(['monitor', command, '--previous', '--json'])
        runner.case(['monitor', command, 'runtime:' + rid, '--previous'])
    for extra in (['--ndjson'], ['--provenance'], ['--type', 'turn.started,user.message'], ['--type', ''],
                  ['--seq', '1..10', '--json'], ['--seq', '5..'], ['--seq', '..3'], ['--seq', 'bogus'], ['--seq', '..'],
                  ['--seq', '9..2'], ['--seq', '99999999999999999..'], ['--json', '--ndjson'], ['--ndjson', '--type', 'nope']):
        runner.case(['monitor', 'events', rid] + extra)
    for extra in (['--tail', '2'], ['--tail', '1', '--json'], ['--full'], ['--kinds', 'user'], ['--kinds', 'cot,notice'],
                  ['--kinds', 'bogus,user,x'], ['--kinds', ''], ['--tail', '0'], ['--tail', 'abc'], ['--seq', '1..9'], ['--seq', 'x']):
        runner.case(['monitor', 'transcript', rid] + extra)
    role_scope = scope + ':role:reviewer'
    for selector in (None, rid, 'runtime:' + rid, 'host:' + host, 'scope:' + scope, scope, handle, handle + '~main', handle + '~other',
                     'session:' + seat['sessionRef'], 'scope:' + role_scope, 'runtime:rt-missing', 'host:hsid-missing',
                     'scope:agent:nobody:project:hrc-runtime:task:none', 'nobody@hrc-runtime:none', 'msg:missing', 'seq:1', 'seq:99999999999999999',
                     'seq:x', 'wat:foo', 'runtime:', 'scope:bad', 'session:bad', 'session:' + scope + '/lane:', 'Bad Handle', 'alice:t1', 'a@b~c d', ''):
        for flags in ([], ['--json']):
            runner.case(['monitor', 'show'] + ([] if selector is None else [selector]) + flags)
    runner.case(['monitor', 'show', 'a', 'b'])
    sr = ['monitor', 'session-report']
    for extra in (['--runtime', rid], ['--runtime', rid, '--json'], ['--runtime', 'runtime:' + rid, '--scope', 'label', '--json'],
                  ['--runtime', handle], ['--runtime', handle, '--scope', 'x y', '--json'], ['--runtime', 'runtime:rt-missing'],
                  ['--runtime', 'runtime:rt-missing', '--json'], ['--runtime', 'wat:foo', '--json'], ['--scope', 'only-scope', '--json'],
                  ['--json'], [], ['--wait-key', '--wait-timeout', '1'], ['--runtime', rid, '--wait-key', '--wait-timeout', '0.4'],
                  ['--runtime', rid, '--wait-key', '--wait-timeout', 'x', '--json'], ['--wait-timeout', '1', '--json']):
        runner.case(sr + extra)
    return runner.finish(seat=rid, execution='native-required; Bun absent from subject PATH')


if __name__ == '__main__':
    raise SystemExit(main())
