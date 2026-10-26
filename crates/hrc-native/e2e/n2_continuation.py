#!/usr/bin/env python3
"""A seat re-born on a scope with a stored continuation compiles with it and continues.

Birth 1 stores a provider continuation (continuation.updated). The lease is
then killed out from under the seat (broker and harness gone, as after a
reboot). The next `hrc start -p` reconciles the dead seat stale and births
again on the same session. Its aspc.compileHarnessInvocation must carry the
session continuation, and the re-born harness must recall birth 1's word.
Every compile request goes through a logging proxy in front of the real aspd,
so Bun's and rusthrc's requests can be compared field for field.
"""
import argparse
import json
from pathlib import Path
import secrets
import subprocess
import time

from n2_aspd_proxy import AspdProxy
from n2_scratch import Scratch


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--owner', choices=['bun', 'native'], required=True)
    p.add_argument('--binary', type=Path, required=True)
    p.add_argument('--installed-release', type=Path, required=True)
    p.add_argument('--aspd-socket', type=Path, required=True)
    p.add_argument('--scratch-root', type=Path, required=True)
    p.add_argument('--artifacts', type=Path, required=True)
    args = p.parse_args()
    args.artifacts.mkdir(parents=True, exist_ok=True)
    log = args.artifacts / f'{args.owner}-aspd-requests.ndjson'
    log.unlink(missing_ok=True)
    proxy = AspdProxy(Path(str(args.scratch_root) + '-aspd.sock'), args.aspd_socket, log)
    s = Scratch(args.scratch_root, args.installed_release, Path(proxy.listen), args.binary, args.artifacts)
    prefix = 'agent:tabularasa:project:n2-t11823:task:'
    scope = prefix + 'continuation-' + args.owner
    word = 'ZEBRA' + secrets.token_hex(3).upper()
    result = {}
    try:
        s.init_substrate()
        s.up(args.owner, 'continuation')
        start = ['hrc', 'start', scope, '--project-id', s.project_id, '--project-root', s.project,
                 '--cwd', s.project, '--json', '-p']
        first = s.command('birth-1', start + [f'Remember the code word {word}. Reply with exactly OK and nothing else. No tools.'])
        s.wait_completed(first['runtime']['runId'])
        s.wait(lambda: s.rows("SELECT continuation_json FROM sessions WHERE continuation_json IS NOT NULL"), 60, 'stored continuation')
        session = s.rows('SELECT * FROM sessions')[0]
        state = json.loads(s.rows('SELECT runtime_state_json FROM runtimes')[0]['runtime_state_json'])
        subprocess.run(['tmux', '-S', state['tmux']['socketPath'], 'kill-server'], capture_output=True)
        time.sleep(2)
        second = s.command('birth-2', start + ['What code word did I ask you to remember? Reply with only the code word. No tools.'])
        s.wait_completed(second['runtime']['runId'])
        time.sleep(2)
        reply = [json.loads(e['payload_json'])['message']['content'] for e in s.rows(
            "SELECT payload_json FROM hrc_events WHERE run_id=? AND event_kind='turn.message'", (second['runtime']['runId'],))]
        compiles = proxy.requests('aspc.compileHarnessInvocation')
        runtimes = s.rows('SELECT runtime_id, status, generation FROM runtimes ORDER BY created_at')
        result = {'owner': args.owner, 'word': word, 'reply': reply, 'recalled': any(word in r for r in reply),
                  'sessionContinuation': json.loads(session['continuation_json']),
                  'runtimes': runtimes, 'compileCount': len(compiles),
                  'compiles': [c['params'] for c in compiles], 'scratchRoot': str(s.root), 'scope': scope}
        (args.artifacts / f'{args.owner}.json').write_text(json.dumps(result, indent=1) + '\n')
        assert len(compiles) == 2, len(compiles)
        assert 'continuation' not in compiles[0]['params']['compileRequest'], 'birth 1 had no stored continuation'
        assert compiles[1]['params']['compileRequest']['continuation']['hrc']['key'] == result['sessionContinuation']['key']
        assert result['recalled'], reply
        print(json.dumps({'owner': args.owner, 'recalled': True, 'continuationKey': result['sessionContinuation']['key']}))
    finally:
        (args.artifacts / f'{args.owner}-steps.json').write_text(json.dumps(s.steps, indent=1) + '\n')
        s.cleanup(prefix)
        proxy.close()


if __name__ == '__main__':
    main()
