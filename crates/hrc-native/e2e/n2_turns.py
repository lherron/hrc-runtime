#!/usr/bin/env python3
"""N2 turn workflow on one owner (bun or native), dumped for per-case compare.

Cold birth, a warm `hrc start -p` turn that invokes a Skill tool (foundry's
skill-lifecycle reads those broker_invocation_events rows), a human-typed turn
in the seat's pane with no run row, then the N2 reads. The same driver runs the
named Bun copy (baseline) and rusthrc (subject) on separate fresh roots.
"""
import argparse
import json
from pathlib import Path
import subprocess
import time

from n2_scratch import Scratch

SKILL = """---
name: n2-ping
description: Answers a ping for the N2 workflow. Use when asked to run n2-ping.
---
Reply with exactly the word PONG and nothing else.
"""


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--owner', choices=['bun', 'native'], required=True)
    p.add_argument('--binary', type=Path, required=True)
    p.add_argument('--installed-release', type=Path, required=True)
    p.add_argument('--aspd-socket', type=Path, required=True)
    p.add_argument('--scratch-root', type=Path, required=True)
    p.add_argument('--artifacts', type=Path, required=True)
    p.add_argument('--phases', default='cold,warm,human,reads')
    args = p.parse_args()
    phases = set(args.phases.split(','))
    s = Scratch(args.scratch_root, args.installed_release, args.aspd_socket, args.binary, args.artifacts)
    scope_prefix = 'agent:tabularasa:project:n2-t11823:task:'
    scope = scope_prefix + args.owner + '-' + str(time.time_ns())
    marks, cases = {}, {}
    try:
        s.init_substrate()
        skills = s.project / '.claude/skills/n2-ping'
        skills.mkdir(parents=True)
        (skills / 'SKILL.md').write_text(SKILL)
        owner = s.up(args.owner, 'workflow')
        start = ['hrc', 'start', scope, '--project-id', s.project_id, '--project-root', s.project,
                 '--cwd', s.project, '--json', '-p']
        cold = s.command('cold-start', start + ['Reply with exactly the word OK and nothing else. No tools.'])
        run1, runtime = cold['runtime']['runId'], cold['runtime']['runtimeId']
        s.wait_completed(run1)
        marks['afterCold'] = s.rows('SELECT MAX(hrc_seq) AS m FROM hrc_events')[0]['m']
        run2 = None
        if 'warm' in phases:
            warm = s.command('warm-start-skill', start + [
                'Invoke the Skill tool with skill "n2-ping" exactly once, then reply with exactly the word OK.'])
            run2 = warm['runtime']['runId']
            cases['warmStart'] = warm
            s.wait_completed(run2)
            marks['afterWarm'] = s.rows('SELECT MAX(hrc_seq) AS m FROM hrc_events')[0]['m']
        state = json.loads(s.rows('SELECT runtime_state_json FROM runtimes WHERE runtime_id=?', (runtime,))[0]['runtime_state_json'])
        tmux = state['tmux']
        if 'human' not in phases:
            tmux = None
        before = len(s.rows("SELECT hrc_seq FROM hrc_events WHERE runtime_id=? AND event_kind='turn.completed'", (runtime,)))
        if tmux: subprocess.run(['tmux', '-S', tmux['socketPath'], 'send-keys', '-t', tmux['paneId'], '-l',
                        'Reply with exactly the word HUMAN and nothing else. No tools.'], check=True)
        if tmux:
          time.sleep(.5)
          subprocess.run(['tmux', '-S', tmux['socketPath'], 'send-keys', '-t', tmux['paneId'], 'Enter'], check=True)
          s.wait(lambda: len(s.rows("SELECT hrc_seq FROM hrc_events WHERE runtime_id=? AND event_kind='turn.completed'", (runtime,))) > before,
               300, 'human-typed turn.completed')
        marks['afterHuman'] = s.rows('SELECT MAX(hrc_seq) AS m FROM hrc_events')[0]['m']
        time.sleep(2)
        host = cold['runtime'].get('hostSessionId') or s.rows('SELECT host_session_id FROM runtimes WHERE runtime_id=?', (runtime,))[0]['host_session_id']
        reads = {}
        for path in [] if 'reads' not in phases else ['/v1/runs', f'/v1/runs?runtimeId={runtime}', f'/v1/runs?hostSessionId={host}',
                     f'/v1/runs?runId={run1}', f'/v1/runs?status=completed', '/v1/runs?limit=1',
                     f'/v1/attach?runtimeId={runtime}', f'/v1/capture?runtimeId={runtime}']:
            reads['GET ' + path] = s.http('GET', path)
        for path, body in [] if 'reads' not in phases else [('/v1/runtimes/broker/inspect', {'runtimeId': runtime}),
                           ('/v1/runtimes/capture/status', {'runtimeId': runtime}),
                           ('/v1/capture/by-selector', {'selector': {'sessionRef': scope + '/lane:main'}})]:
            reads['POST ' + path] = s.http('POST', path, body)
        cases['reads'] = reads
        s.dump(args.owner, {'marks': marks, 'cases': cases, 'scope': scope, 'runtimeId': runtime,
                            'runIds': [run1, run2], 'steps': s.steps})
        print(json.dumps({'owner': args.owner, 'runtimeId': runtime, 'marks': marks,
                          'artifacts': str(args.artifacts)}))
    finally:
        (args.artifacts / f'{args.owner}-steps.json').write_text(json.dumps(s.steps, indent=1) + '\n')
        s.cleanup(scope_prefix)


if __name__ == '__main__':
    main()
