#!/usr/bin/env python3
"""Restart parity on disposable scratch scopes, never an existing agent seat.
Failure modes: wrong scope, missing generation fence, refusal rotates anyway,
lost launch failure, wrong JSON/exit, old broker retained, silent Bun exec.
Each binary gets a fresh host; IDs normalize only after effects are asserted.
"""
import argparse, json, os, shutil, subprocess, sys, uuid
from pathlib import Path
from metrics_isolation import isolated_suite
from runtime import ROOT
sys.path.insert(0, str(ROOT / 'crates/hrc-native/e2e'))
from foundation import UnixHTTP


@isolated_suite
def main():
    p = argparse.ArgumentParser()
    for name in ('binary', 'oracle', 'runtime-root', 'state-root', 'seat', 'artifacts'):
        p.add_argument('--' + name, type=Path, required=True)
    p.add_argument('--lifecycle', action='store_true')
    a = p.parse_args()
    a.artifacts.mkdir(parents=True, exist_ok=True)
    assert all(root.resolve().is_relative_to(Path('/tmp').resolve()) for root in (a.runtime_root, a.state_root))
    seat = json.loads(a.seat.read_text())
    env = {k: v for k, v in os.environ.items() if not k.startswith(('ASP_', 'HRC_', 'WRKQ'))}
    env.update(HRC_RUNTIME_DIR=str(a.runtime_root), HRC_STATE_DIR=str(a.state_root), NO_COLOR='1', FORCE_COLOR='0')
    commands = [('oracle', [shutil.which('bun'), str(a.oracle.resolve())]), ('subject', [str(a.binary.resolve())])]
    results = []
    native = next(row for row in json.loads((ROOT / 'crates/hrc-cli/command-scope.json').read_text())['commands'] if row['command'] == 'restart')['implementation'] == 'native'

    def run(label, cmd, argv):
        c = subprocess.run(cmd + argv, cwd=a.runtime_root.parent / 'project', env=env if label == 'oracle' else dict(env, PATH=str(a.artifacts / 'no-bun')), capture_output=True, text=True, timeout=60)
        return dict(exit=c.returncode, stdout=c.stdout, stderr=c.stderr)

    def call(path, body=None):
        h = UnixHTTP(a.runtime_root / 'hrc.sock')
        h.request('POST' if body is not None else 'GET', path, json.dumps(body) if body is not None else None, {'Content-Type': 'application/json'})
        response = h.getresponse()
        value = json.loads(response.read())
        h.close()
        assert response.status == 200, value
        return value

    # Observe the real wire shape before constructing any lifecycle fixture.
    missing = call('/v1/sessions/resolve', {'sessionRef': 'agent:tabularasa:project:n5-t11819:task:absent-' + uuid.uuid4().hex + '/lane:main'})
    assert missing['found'] is False, missing
    for argv in (['restart'], ['restart', 'bad:scope'], ['restart', 'tabularasa@n5-t11819:missing-' + uuid.uuid4().hex], ['restart', 'tabularasa@n5-t11819:missing-' + uuid.uuid4().hex, '--json'], ['restart', 'bad:scope', '--output', 'json']):
        records = [run(label, cmd, argv) for label, cmd in commands]
        results.append(dict(argv=argv, oracle=records[0], subject=records[1], **{'pass': records[0] == records[1]}))

    for live in ([False, True] if a.lifecycle else [False]):
        for flags in ([], ['--json'], ['--force', '--json']):
            records, effects, raw = [], [], []
            for label, cmd in commands:
                task = 'n5-restart-' + uuid.uuid4().hex
                target = 'tabularasa@n5-t11819:' + task
                ref = 'agent:tabularasa:project:n5-t11819:task:' + task + '/lane:main'
                intent = dict(seat['intent'])
                intent.pop('initialPrompt', None)
                before = call('/v1/sessions/resolve', dict(sessionRef=ref, create=True, summonIntent='explicit_local', **({'runtimeIntent': intent} if live else {})))
                old_runtime = None
                if live:
                    old_runtime = call('/v1/runtimes/start', {'hostSessionId': before['hostSessionId'], 'intent': intent})['runtimeId']
                after = None
                try:
                    out = run(label, cmd, ['restart', target] + flags)
                    raw.append(dict(out))
                    after = call('/v1/sessions/resolve', {'sessionRef': ref})
                    evidence = dict(before=before, after=after, oldRuntimeId=old_runtime)
                    if label == 'oracle' or native:
                        assert after['generation'] == before['generation'] + int(live), (out, evidence)
                        assert (after['hostSessionId'] != before['hostSessionId']) is live, evidence
                        assert out['exit'] == (0 if live else 1), out
                        if '--json' in flags:
                            value = json.loads(out['stdout'])
                            if live:
                                assert value['hostSessionId'] == after['hostSessionId'] and value['generation'] == after['generation'], value
                                assert value['ok'] is True and value['launch']['status'] == 'started', value
                            else:
                                assert value['ok'] is False and value['code'] == 'missing_runtime_intent', value
                        if old_runtime:
                            evidence['oldRuntime'] = call('/v1/runtimes/inspect', {'runtimeId': old_runtime})
                            assert evidence['oldRuntime']['status'] == 'terminated', evidence
                    effects.append(evidence)
                    for key in ('stdout', 'stderr'):
                        out[key] = out[key].replace(target, '<owned-target>')
                        for host in (before['hostSessionId'], after['hostSessionId']):
                            out[key] = out[key].replace(host, '<owned-host>')
                        if '--json' in flags and out['stdout'].strip() and (label == 'oracle' or native):
                            value = json.loads(out['stdout'])
                            rid = value.get('launch', {}).get('runtimeId')
                            if rid:
                                out[key] = out[key].replace(rid, '<owned-runtime>')
                        elif live and key == 'stdout' and '  launched ' in out[key]:
                            out[key] = out[key].split('  launched ')[0] + '  launched <owned-runtime>\n'
                    records.append(out)
                finally:
                    hosts = {before['hostSessionId']}
                    if after:
                        hosts.add(after['hostSessionId'])
                    for host in hosts:
                        rows = call('/v1/runtimes?hostSessionId=' + host)
                        assert isinstance(rows, list), rows
                        for row in rows:
                            assert row['hostSessionId'] == host, row
                            if row['status'] != 'terminated':
                                call('/v1/terminate', {'runtimeId': row['runtimeId'], 'reason': 'owned N5 restart test cleanup'})
                            assert call('/v1/runtimes/inspect', {'runtimeId': row['runtimeId']})['status'] == 'terminated'
            results.append(dict(argv=['restart', '<fresh-owned-live>' if live else '<fresh-owned-no-intent>'] + flags, oracle=records[0], subject=records[1], oracleRaw=raw[0], subjectRaw=raw[1], effects=effects, **{'pass': records[0] == records[1]}))
    report = dict(cases=results, **{'pass': sum(r['pass'] for r in results), 'fail': sum(not r['pass'] for r in results)})
    (a.artifacts / 'results.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({k: report[k] for k in ('pass', 'fail')}))
    return int(bool(report['fail']))


if __name__ == '__main__':
    raise SystemExit(main())
