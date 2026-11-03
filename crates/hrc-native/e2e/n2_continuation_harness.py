#!/usr/bin/env python3
"""A respawn resumes a conversation on the harness that produced it (T-12419).

Birth 1 runs under a project target that selects codex-hrcpty, so the session
applies provision harness codex-hrcpty and stores a codex thread continuation.
The lease is then killed out from under the seat, and the target is rewritten to
claude-hrcpty: the profile drifted mid-conversation. Birth 2 (`hrc start -p` on
the dead seat) must compile with the session's applied harness pinned as a
summon directive, launch codex-hrcpty and recall birth 1's word from the
resumed thread. Before T-12419 it launched claude-code with
`--resume <codex key>` and never produced a first turn.

The lease is killed again, and an explicit claude-hrcpty selection on the
codex continuation must be refused (409 continuation_harness_mismatch) before
any runtime operation is recorded. A Codex key is never handed to claude-code.
Every compile request goes through a logging proxy in front of the real aspd.
"""
import argparse
import json
import os
from pathlib import Path
import secrets
import signal
import subprocess
import time

from n2_aspd_proxy import AspdProxy
from n2_scratch import Scratch

CODEX = '''schema = 2

[targets.tabularasa]
compose_mode = "merge"
compose = []

  [targets.tabularasa.provisioning]
  harness = "codex-hrcpty"
  model = "gpt-6.1-sol"
  reasoning_effort = "medium"
'''

CLAUDE = CODEX.replace('codex-hrcpty', 'claude-hrcpty').replace('gpt-6.1-sol', 'opus').replace(
    '"medium"', '"high"')


def kill_lease(s, required=True):
    """Kill every hrc-pty supervisor and harness broker under the scratch run root."""
    markers = {str(s.root / 'run'), str((s.root / 'run').resolve())}
    out = subprocess.run(['ps', '-axo', 'pid=,ppid=,command='], capture_output=True, text=True).stdout
    procs = []
    for line in out.splitlines():
        parts = line.split(None, 2)
        if len(parts) == 3:
            procs.append((int(parts[0]), int(parts[1]), parts[2]))
    roots = {pid for pid, _, cmd in procs
             if any(m in cmd for m in markers) and ('hrc-pty serve' in cmd or 'harness-broker' in cmd)}
    doomed, grew = set(roots), True
    while grew:
        grew = False
        for pid, ppid, _ in procs:
            if ppid in doomed and pid not in doomed:
                doomed.add(pid)
                grew = True
    for pid in doomed:
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    s.steps.append({'name': 'kill-lease', 'pids': sorted(doomed)})
    assert roots or not required, 'no lease process found under ' + ' or '.join(sorted(markers))
    if roots:
        time.sleep(2)


def selection(s, started):
    rows = s.rows('SELECT runtime_state_json FROM runtimes WHERE runtime_id=?', (started['runtime']['runtimeId'],))
    return json.loads(rows[0]['runtime_state_json']).get('selection') if rows else None


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--binary', type=Path, required=True)
    p.add_argument('--installed-release', type=Path, required=True)
    p.add_argument('--aspd-socket', type=Path, required=True)
    p.add_argument('--scratch-root', type=Path, required=True)
    p.add_argument('--artifacts', type=Path, required=True)
    args = p.parse_args()
    args.artifacts.mkdir(parents=True, exist_ok=True)
    log = args.artifacts / 'aspd-requests.ndjson'
    log.unlink(missing_ok=True)
    proxy = AspdProxy(Path(str(args.scratch_root) + '-aspd.sock'), args.aspd_socket, log)
    s = Scratch(args.scratch_root, args.installed_release, Path(proxy.listen), args.binary, args.artifacts,
                project_id='n2-t12419')
    prefix = 'agent:tabularasa:project:n2-t12419:task:'
    scope = prefix + 'respawn-harness'
    word = 'ZEBRA' + secrets.token_hex(3).upper()
    targets = s.project / 'asp-targets.toml'
    result = {'scope': scope, 'word': word, 'scratchRoot': str(s.root)}
    try:
        s.init_substrate()
        targets.write_text(CODEX)
        s.up('native', 'respawn-harness')
        start = ['hrc', 'start', scope, '--project-id', s.project_id, '--project-root', s.project,
                 '--cwd', s.project, '--json', '-p']
        first = s.command('birth-1', start + [f'Remember the code word {word}. Reply with exactly OK and nothing else. No tools.'])
        s.wait_completed(first['runtime']['runId'])
        s.wait(lambda: s.rows("SELECT continuation_json FROM sessions WHERE continuation_json IS NOT NULL"), 60, 'stored continuation')
        session = s.rows('SELECT * FROM sessions')[0]
        result['birth1'] = {'continuation': json.loads(session['continuation_json']),
                            'appliedProvision': json.loads(session['last_applied_intent_json']).get('provision'),
                            'selection': selection(s, first)}
        assert result['birth1']['selection']['harness'] == 'codex-hrcpty', result['birth1']
        assert result['birth1']['appliedProvision']['harness'] == 'codex-hrcpty', result['birth1']
        assert result['birth1']['continuation']['provider'] in ('codex', 'openai', 'openai-codex'), result['birth1']

        kill_lease(s)
        targets.write_text(CLAUDE)
        second = s.command('birth-2', start + ['What code word did I ask you to remember? Reply with only the code word. No tools.'],
                           timeout=240)
        s.wait_completed(second['runtime']['runId'], timeout=240)
        time.sleep(2)
        reply = [json.loads(e['payload_json'])['message']['content'] for e in s.rows(
            "SELECT payload_json FROM hrc_events WHERE run_id=? AND event_kind='turn.message'", (second['runtime']['runId'],))]
        compiles = proxy.requests('aspc.compileHarnessInvocation')
        respawn = compiles[-1]['params']['compileRequest']
        result['birth2'] = {'reply': reply, 'recalled': any(word in r for r in reply),
                            'summonDirectives': (respawn.get('selectionContext') or {}).get('summonDirectives'),
                            'continuation': respawn.get('continuation', {}).get('hrc'),
                            'selection': selection(s, second)}
        assert result['birth2']['summonDirectives']['harness'] == 'codex-hrcpty', result['birth2']
        assert result['birth2']['continuation']['provider'] == 'openai', result['birth2']
        assert result['birth2']['selection']['harness'] == 'codex-hrcpty', result['birth2']
        assert result['birth2']['recalled'], reply

        # An explicit harness on another provider cannot take the codex key.
        kill_lease(s)
        session = s.rows('SELECT * FROM sessions ORDER BY generation DESC LIMIT 1')[0]
        intent = json.loads(session['last_applied_intent_json'])
        intent.pop('summonDirectives', None)
        intent['selection'] = {'harness': 'claude-hrcpty', 'model': 'opus'}
        operations = len(s.rows('SELECT operation_id FROM runtime_operations'))
        status, body = s.http('POST', '/v1/runtimes/start', {'hostSessionId': session['host_session_id'], 'intent': intent})
        result['gate'] = {'status': status, 'body': body,
                          'newOperations': len(s.rows('SELECT operation_id FROM runtime_operations')) - operations}
        error = body.get('error', body) if isinstance(body, dict) else {}
        assert status == 409, result['gate']
        assert error.get('code') == 'continuation_harness_mismatch', result['gate']
        assert result['gate']['newOperations'] == 0, result['gate']
        result['ok'] = True
        print(json.dumps({'ok': True, 'recalled': True, 'gate': error.get('code')}))
    finally:
        result['compiles'] = [c['params'] for c in proxy.requests('aspc.compileHarnessInvocation')]
        (args.artifacts / 'result.json').write_text(json.dumps(result, indent=1) + '\n')
        (args.artifacts / 'steps.json').write_text(json.dumps(s.steps, indent=1) + '\n')
        # Scratch.cleanup kills tmux servers only; an hrc-pty seat outlives a failed run.
        kill_lease(s, required=False)
        s.cleanup(prefix)
        proxy.close()


if __name__ == '__main__':
    main()
