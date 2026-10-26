#!/usr/bin/env python3
"""Managed launch grammar and previews against an explicit scratch daemon.

Failure modes: dry-run launches or mutates continuity, prompt/cwd flags drift,
intent authority moves into the CLI, non-TTY run bypasses its guard, scope and
JSON errors differ. No real launch/attach here; those require the PTY drive.
"""
import argparse
import json
import os
import re
from pathlib import Path
import shutil
import subprocess
import sys

from metrics_isolation import isolated_suite
from runtime import normalize as normalize_runtime, ROOT
sys.path.insert(0, str(ROOT / 'conformance/hrc-parity'))
from key_order import cli_orders

# These fields incorporate the daemon preview's fresh dry-run identities.
# Every preview is compared to TWO Bun invocations before this normalization
# is accepted. Facts such as selection, hosting, argv flags, paths, prompt zones,
# release, env, presentation and hashes of static prompt files remain exact.
PROFILE_KEYS = {'profileId', 'profileHash', 'compatibilityHash', 'startRequestHash'}
ID_KEYS = {'requestId', 'operationId', 'runtimeId', 'invocationId', 'traceId', 'compileId', 'runId', 'initialInputId', 'planHash'}

def normalize(item):
    result = normalize_runtime(item)
    def walk(value, path=()):
        if isinstance(value, dict):
            out = {}
            for key, child in value.items():
                if key == 'ms' and 'phases' in path:
                    assert isinstance(child, (int, float)) and child >= 0
                    out[key] = '<duration>'
                elif (path and path[-1] == 'profile' and key in PROFILE_KEYS) or (path and path[-1] == 'ids' and key in ID_KEYS) or (path == ('preview',) and key in {'compileId', 'planHash', 'specHash', 'startRequestHash'}):
                    assert isinstance(child, str) and child
                    out[key] = '<generated:' + key + '>'
                else:
                    out[key] = walk(child, path + (key,))
            return out
        if isinstance(value, list):
            out = [walk(v, path) for v in value]
            if path == ('preview', 'process', 'args'):
                for i, flag in enumerate(value[:-1]):
                    if flag == '--session-id':
                        assert re.fullmatch(r'[0-9a-f-]{36}', value[i+1])
                        out[i+1] = '<provider-session-id>'
                    if flag in ('--name', '--remote-control-session-name-prefix'):
                        assert re.search(r'-[a-z0-9]{4}$', value[i+1])
                        out[i+1] = value[i+1][:-4] + '<name-suffix>'
            return out
        return value
    for stream in ('stdout', 'stderr'):
        try:
            result[stream] = json.dumps(walk(json.loads(item[stream])), sort_keys=True)
        except json.JSONDecodeError:
            result[stream] = re.sub(r'(?m)^(  (?:profileId|profileHash|compatibilityHash|compileId|planHash|specHash|requestHash): +)\S+$', r'\1<generated>', result[stream])
            result[stream] = re.sub(r'(?<=--session-id )[0-9a-f-]{36}', '<provider-session-id>', result[stream])
            result[stream] = re.sub(r'(--(?:name|remote-control-session-name-prefix) [^ \n]+-)[a-z0-9]{4}(?= |$)', r'\1<name-suffix>', result[stream])
            result[stream] = re.sub(r'(?m)^ready in [^\n]+ — -v for timeline$', 'ready in <duration> (compile <duration>, prompt <duration>) — -v for timeline', result[stream])
            # Verbose stderr has the same generated IDs as the JSON envelope.
            # Restrict substitutions to diagnostic lines, preserving prompt text.
            if stream == 'stderr':
                lines = []
                for line in result[stream].splitlines(keepends=True):
                    if line.startswith('  ids '):
                        line = re.sub(r'dry-(?:req|op|rt|inv|trace|run|input)-[0-9a-f-]{36}', '<dry-id>', line)
                        line = re.sub(r'compile_[0-9a-f]{32}', '<compile-id>', line)
                        line = re.sub(r'(?<=plan hash )[0-9a-f]{64}', '<plan-hash>', line)
                    line = re.sub(r'^([ ]+(?:[✓✗⚠–·] .*?|total|ready))  \d+(?:\.\d+)?(?:ms|s)(?= |$)', r'\1  <duration>', line)
                    lines.append(line)
                result[stream] = ''.join(lines)

    return result


@isolated_suite
def main():
    p = argparse.ArgumentParser()
    for flag in ('binary', 'oracle', 'runtime-root', 'state-root', 'scope', 'artifacts'):
        p.add_argument('--' + flag, type=Path if flag != 'scope' else str, required=True)
    p.add_argument("--only-verbose", action="store_true")
    p.add_argument("--only-edges", action="store_true")
    args = p.parse_args()
    assert not str(args.runtime_root.resolve()).startswith(str(Path.home() / 'praesidium/var'))
    args.artifacts.mkdir(parents=True, exist_ok=True)
    env = {k: v for k, v in os.environ.items() if not k.startswith(('ASP_', 'HRC_', 'WRKQ'))}
    env.update(HRC_RUNTIME_DIR=str(args.runtime_root), HRC_STATE_DIR=str(args.state_root), NO_COLOR='1', FORCE_COLOR='0')
    prompt = args.artifacts / 'prompt.txt'
    prompt.write_text('Reply with OK. No tools.\n')
    cases = []
    for command in ('start', 'run'):
        for flags in ([], ['--json'], ['--json', '-p', 'Reply with OK. No tools.'], ['--json', '--prompt-file', str(prompt)], ['--json', '--debug'], ['--json', '--force-restart'], ['--json', '--cwd', '/path/that/does/not/exist']):
            cases.append([command, args.scope, '--dry-run'] + flags)
    for flags in (['--no-viewer'], ['--app-server-viewer'], ['--viewer-window', 'n5-proof'], ['--no-viewer', '--viewer-window', 'n5-proof'], ['--no-viewer', '--app-server-viewer'], ['--on-conflict', 'bad']):
        cases.append(['start', args.scope, '--dry-run', '--json'] + flags)
    cases.extend([['run', args.scope], ['run', args.scope, '--json'], ['start', 'bad handle', '--dry-run', '--json'], ['run', 'bad handle', '--dry-run', '--json']])
    for command in ('start', 'run', 'attach'):
        cases.append([command])
    for flags in (['--dry-run'], ['--dry-run', '--json']):
        cases.append(['attach', args.scope] + flags)
    cases.extend([['attach', 'rt-missing', '--dry-run'], ['attach', 'rt-missing', '--json']])
    for command in ('start', 'run'):
        for target in ('agent-n5-does-not-exist@hrc-runtime:n5-11819-acceptance', args.scope + '+yolo=true', args.scope + '+model=sonnet', args.scope + '+remote=false', args.scope + '+bogus=x'):
            cases.append([command, target, '--dry-run', '--json'])
        for flags in (['--project-id', 'hrc-runtime'], ['--project-root', str(args.runtime_root.parent / 'project')], ['-p', 'one', '--prompt-file', str(prompt)]):
            cases.append([command, args.scope, '--dry-run', '--json'] + flags)
    cases.extend([['start', args.scope, '--dry-run', '--wait', 'bad'], ['start', args.scope, '--dry-run', '--wait', 'true'], ['start', args.scope, '--dry-run', '--wait']])
    cases.extend([['run', args.scope, '--dry-run', '--verbose'], ['run', args.scope, '--dry-run', '--verbose', '--json']])
    invalid_utf8 = args.artifacts / 'lossy-prompt.txt'
    invalid_utf8.write_bytes(b'Reply with OK. No tools.\xff')
    for command in ('start', 'run'):
        cases.append([command, args.scope, 'one', 'two', '--dry-run', '--json'])
        cases.append([command, args.scope, '--prompt-file', str(invalid_utf8), '--dry-run', '--json'])
    if args.only_edges:
        cases = cases[-4:]
    if args.only_verbose:
        cases = [case for case in cases if '--verbose' in case]
    bun = shutil.which('bun')
    def structure():
        rows = {}
        for path in ('runtimes', 'sessions'):
            command = ['curl', '--silent', '--show-error', '--unix-socket', str(args.runtime_root / 'hrc.sock'), 'http://localhost/v1/' + path + ('?all=true' if path == 'sessions' else '')]
            rows[path] = sorted((r.get('runtimeId', ''), r.get('hostSessionId', ''), r.get('generation', 0)) for r in json.loads(subprocess.check_output(command, env=env)))
        return rows
    before = structure()
    results = []
    for argv in cases:
        observed = []
        for label, command in (('oracle', [bun, str(args.oracle.resolve())]), ('oracle-repeat', [bun, str(args.oracle.resolve())]), ('subject', [str(args.binary.resolve())])):
            child_env = env if label.startswith('oracle') else dict(env, PATH=str(args.artifacts / 'no-bun'))
            c = subprocess.run(command + argv, env=child_env, cwd=ROOT, capture_output=True, text=True, timeout=90)
            observed.append(dict(exit=c.returncode, stdout=c.stdout, stderr=c.stderr))
        results.append(dict(argv=argv, oracle=observed[0], oracleRepeat=observed[1], subject=observed[2], oracleStable=normalize(observed[0]) == normalize(observed[1]), **{'pass': normalize(observed[0]) == normalize(observed[1]) == normalize(observed[2])}))
        results[-1]['keyOrder'] = cli_orders(observed[0], observed[2])
        results[-1]['oracleRepeatKeyOrder'] = cli_orders(observed[0], observed[1])
        results[-1]['pass'] = (results[-1]['pass'] and results[-1]['keyOrder']['pass']
                               and results[-1]['oracleRepeatKeyOrder']['pass'])
    after = structure()
    assert before == after, 'previews must not create or rotate runtime/session generations'
    report = dict(before=before, after=after, cases=results, **{'pass': sum(r['pass'] for r in results), 'fail': sum(not r['pass'] for r in results)})
    (args.artifacts / 'results.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({k: report[k] for k in ('pass', 'fail')}))
    return int(bool(report['fail']))


if __name__ == '__main__':
    raise SystemExit(main())
