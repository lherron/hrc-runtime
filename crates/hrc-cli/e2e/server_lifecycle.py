#!/usr/bin/env python3
"""Native CLI parsing and authorization precedence against a private owner.

These CLI timeout/duplicate-option refusals supplement the HTTP checks in
native lifecycle_credentials; no granted lifecycle request is issued.
"""
from native_seat import suite, report


def expected_refusal(action, flags):
    if '--output' in flags:
        return 2, "--output json is not supported by '" + action + "'"
    if '--background' in flags:
        return 2, 'unknown option: --background'
    if action == 'stop' and '--drain' in flags:
        return 2, 'unknown option: --drain'
    if '--drain' in flags and '--wait' in flags:
        return 2, '--drain and --wait are mutually exclusive'
    if action == 'stop' and '--drain-timeout-ms' in flags:
        return 2, 'unknown option: --drain-timeout-ms'
    if action == 'start' and '--daemon' in flags and '--foreground' in flags:
        return 1, 'choose either --foreground or --daemon/--background, not both'
    for flag in ('--timeout-ms', '--proof-timeout-ms', '--wait-timeout-ms', '--drain-timeout-ms'):
        positions = [i for i, value in enumerate(flags) if value == flag]
        # The last duplicate wins; these cases exercise the native parseInt
        # contract, including accepted numeric prefixes (1.5, 1e2, 2x).
        if positions and flags[positions[-1] + 1] in ('0', '-1', 'x'):
            return 2, flag + ' must be an integer >= 1'
    if action == 'start':
        return 2, 'daemon already running'
    return 1, '[server_lifecycle_refused] only mable@<project>:primary or Lance may ' + action


@suite
def main(f, a):
    seat = f.birth()
    own = dict(HRC_SESSION_REF=seat['sessionRef'], HRC_RUNTIME_ID=seat['runtimeId'])
    before = f.call('/v1/status')
    owner = f.s.owners[-1]
    pid_file = f.root / 'run/server.pid'
    assert int(pid_file.read_text()) == owner.pid
    facts = f.s.rows("SELECT * FROM hrc_events WHERE scope_ref='server:hrc'")
    results = []
    for action in ('start', 'stop', 'restart'):
        flags = [[], ['extra'], ['--output', 'json']]
        if action == 'start':
            flags += [['--daemon'], ['--foreground'], ['--daemon', '--foreground'], ['--background', '--foreground']]
            flags += [['--timeout-ms', v] for v in ('0', '-1', 'x', '1.5', '1e2', ' 2 ', '2x')]
        else:
            flags += [['--wait', '--drain'], ['--reason', 'owned refusal'], ['--force'], ['--node', 'absent-n5-node']]
            flags += [[flag, v] for flag in ('--proof-timeout-ms', '--wait-timeout-ms', '--drain-timeout-ms') for v in ('0', '-1', 'x', '1.5', '1e2')]
            flags += [['--proof-timeout-ms', '0', '--proof-timeout-ms', '2'], ['--proof-timeout-ms', '2', '--proof-timeout-ms', '0']]
        for values in flags:
            argv = ['server', action, *values]
            out = f.run(argv, extra=own)
            code, message = expected_refusal(action, values)
            assert out['exit'] == code and message in out['stdout'] + out['stderr'], (argv, code, message, out)
            assert owner.poll() is None and int(pid_file.read_text()) == owner.pid, (argv, out)
            assert f.call('/v1/status')['startedAt'] == before['startedAt']
            assert f.s.rows("SELECT * FROM hrc_events WHERE scope_ref='server:hrc'") == facts
            results.append(dict(argv=argv, subject=out, **{'pass': True}))
    return report(a, results)


if __name__ == '__main__':
    raise SystemExit(main())
