#!/usr/bin/env python3
"""Strict target materialization, on unique scratch project/scopes only.
Failure modes: advisory drift on a birth, wrong intent mode/caller task,
lost directives, duplicate sessions, human/JSON drift, silent Bun fallback.
"""
import argparse, json, os, shutil, subprocess, sys, uuid
from pathlib import Path
from metrics_isolation import isolated_suite
from runtime import ROOT, normalize
sys.path.insert(0, str(ROOT / 'crates/hrc-native/e2e'))
from foundation import UnixHTTP


@isolated_suite
def main():
    p = argparse.ArgumentParser()
    for name in ('binary', 'oracle', 'runtime-root', 'state-root', 'artifacts'):
        p.add_argument('--' + name, type=Path, required=True)
    a = p.parse_args()
    a.artifacts.mkdir(parents=True, exist_ok=True)
    assert all(root.resolve().is_relative_to(Path('/tmp').resolve()) for root in (a.runtime_root, a.state_root))
    env = {k: v for k, v in os.environ.items() if not k.startswith(('ASP_', 'HRC_', 'WRKQ'))}
    env.update(HRC_RUNTIME_DIR=str(a.runtime_root), HRC_STATE_DIR=str(a.state_root), NO_COLOR='1', FORCE_COLOR='0')
    commands = [('oracle', [shutil.which('bun'), str(a.oracle.resolve())]), ('subject', [str(a.binary.resolve())])]
    native = next(row for row in json.loads((ROOT / 'crates/hrc-cli/command-scope.json').read_text())['commands'] if row['command'] == 'summon')['implementation'] == 'native'
    results = []

    def run(label, cmd, argv, extra=None):
        child_env = dict(env, **(extra or {}))
        if label == 'subject':
            child_env['PATH'] = str(a.artifacts / 'no-bun')
        c = subprocess.run(cmd + argv, cwd=a.runtime_root.parent / 'project', env=child_env, capture_output=True, text=True, timeout=60)
        return dict(exit=c.returncode, stdout=c.stdout, stderr=c.stderr)

    def call(path, body=None):
        h = UnixHTTP(a.runtime_root / 'hrc.sock')
        h.request('POST' if body is not None else 'GET', path, json.dumps(body) if body is not None else None, {'Content-Type': 'application/json'})
        response = h.getresponse()
        value = json.loads(response.read())
        h.close()
        assert response.status == 200, value
        return value

    # Inspect the real daemon before declaring any materialization fixture.
    assert isinstance(call('/v1/runtimes'), list)
    for argv in (['summon'], ['summon', ''], ['summon', 'bad:scope'], ['summon', 'n5-missing-agent@n5-t11819:missing'], ['summon', 'tabularasa@n5-t11819:missing+yolo=true'], ['summon', 'tabularasa@n5-t11819:missing+nope=value']):
        for flags in ([], ['--output', 'json']):
            records = [run(label, cmd, argv + flags) for label, cmd in commands]
            results.append(dict(argv=argv + flags, oracle=records[0], subject=records[1], **{'pass': records[0] == records[1]}))
    for flags, bare in (([], False), (['--json'], False), (['--json'], True)):
        records, raw, effects = [], [], []
        for label, cmd in commands:
            task = 'n5-summon-' + uuid.uuid4().hex
            ref = 'agent:tabularasa:project:n5-t11819:task:' + task + '/lane:main'
            target = 'tabularasa' if bare else 'tabularasa@n5-t11819:' + task + '+remote=false'
            extra = dict(ASP_PROJECT='n5-t11819', HRC_SESSION_REF='agent:cody:project:n5-t11819:task:' + task + '/lane:main') if bare else {}
            out = run(label, cmd, ['summon', target] + flags, extra)
            raw.append(dict(out))
            resolved = call('/v1/sessions/resolve', {'sessionRef': ref})
            rows = []
            try:
                if label == 'oracle' or native:
                    assert out['exit'] == 0 and resolved['found'] is True, (out, resolved)
                    assert resolved['identity']['taskId'] == task, resolved
                    host = resolved['hostSessionId']
                    rows = call('/v1/runtimes?hostSessionId=' + host)
                    assert all(row['hostSessionId'] == host for row in rows), rows
                    if '--json' in flags:
                        value = json.loads(out['stdout'])
                        assert value['sessionRef'] == ref and value['activeHostSessionId'] == host and value['generation'] == 1, value
                    for key in ('stdout', 'stderr'):
                        out[key] = out[key].replace(ref, '<owned-session>').replace(host, '<owned-host>')
                        for row in rows:
                            out[key] = out[key].replace(row['runtimeId'], '<owned-runtime>')
                        out[key] = out[key].replace(task, '<owned-task>')
                effects.append(dict(resolved=resolved, runtimes=rows))
                records.append(normalize(out))
            finally:
                for row in rows:
                    if row['status'] != 'terminated':
                        call('/v1/terminate', {'runtimeId': row['runtimeId'], 'reason': 'owned N5 summon test cleanup'})
                    assert call('/v1/runtimes/inspect', {'runtimeId': row['runtimeId']})['status'] == 'terminated'
        results.append(dict(argv=['summon', '<caller-task>' if bare else '<fresh-owned-scope>'] + flags, oracle=records[0], subject=records[1], oracleRaw=raw[0], subjectRaw=raw[1], effects=effects, **{'pass': records[0] == records[1]}))
    report = dict(cases=results, **{'pass': sum(r['pass'] for r in results), 'fail': sum(not r['pass'] for r in results)})
    (a.artifacts / 'results.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({k: report[k] for k in ('pass', 'fail')}))
    return int(bool(report['fail']))


if __name__ == '__main__':
    raise SystemExit(main())
