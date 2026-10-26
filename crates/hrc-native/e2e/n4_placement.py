#!/usr/bin/env python3
"""N4 project-root placement on one owner (bun or native), recorded for a compare.

A private wrkqd holds the project registry and ASP_PROJECT_ROOT_OVERRIDE is
unset, so an explicit project resolves through HRC policy: wrkq registry,
marker scan, sibling fallback, then task-worktree refinement. Each scope is
read through POST /v1/placements/resolve and POST /v1/declarations/resolve,
ensured with the declared intent through POST /v1/targets/ensure, and the
registered, worktree and marker cases are cold-born with `hrc start`, whose
tmux pane cwd is the proof of where the seat landed.

Failure modes: a registered project placed by guess instead of its registry
root; a task worktree not refined (or refined with no branch); an unregistered
project that skips marker scan or sibling fallback; a refusal with another
message or detail; and a born seat whose pane opens somewhere else.
"""
import argparse
import json
from pathlib import Path
import subprocess

from n3_scratch import Scratch

PROMPT = 'Reply with exactly the word OK and nothing else. No tools.'
PROJECT = 'n4-t11872p'
TASK = 'T-12345'


def git(env, *argv):
    subprocess.run(['git', *map(str, argv)], env=env, check=True, capture_output=True)


def descendant_cwds(root_pid):
    """Distinct cwds of every process under the pane's shell."""
    pids, frontier = [], [root_pid] if root_pid else []
    while frontier:
        pid = frontier.pop()
        pids.append(pid)
        frontier += subprocess.run(['pgrep', '-P', pid], capture_output=True, text=True).stdout.split()
    cwds = set()
    for pid in pids[1:]:
        out = subprocess.run(['lsof', '-a', '-d', 'cwd', '-p', pid, '-Fn'], capture_output=True, text=True).stdout
        cwds.update(line[1:] for line in out.splitlines() if line.startswith('n'))
    return sorted(cwds)


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--owner', choices=['bun', 'native'], required=True)
    p.add_argument('--binary', type=Path, required=True)
    p.add_argument('--installed-release', type=Path, required=True)
    p.add_argument('--aspd-socket', type=Path, required=True)
    p.add_argument('--scratch-root', type=Path, required=True)
    p.add_argument('--artifacts', type=Path, required=True)
    p.add_argument('--no-birth', action='store_true')
    args = p.parse_args()
    s = Scratch(args.scratch_root, args.installed_release, args.aspd_socket, args.binary, args.artifacts,
                project_id=PROJECT)
    root = s.root
    observations = {}
    try:
        s.init_substrate()
        # Placement must come from policy, not the scratch override.
        del s.env['ASP_PROJECT_ROOT_OVERRIDE']
        search = root / 'search'
        s.env['HRC_PROJECT_SEARCH_ROOTS'] = str(search)
        genv = {**s.env, 'GIT_AUTHOR_NAME': 'n4', 'GIT_AUTHOR_EMAIL': 'n4@example.invalid',
                'GIT_COMMITTER_NAME': 'n4', 'GIT_COMMITTER_EMAIL': 'n4@example.invalid'}
        git(genv, '-C', s.project, 'commit', '-q', '--allow-empty', '-m', 'n4 fixture')
        worktree = root / f'wt-{TASK}'
        git(genv, '-C', s.project, 'worktree', 'add', '-q', '-b', f'n4-{TASK}', worktree)
        # (c) an unregistered canonical checkout under a search root.
        (search / 'n4-unreg').mkdir(parents=True)
        git(genv, 'init', '-q', search / 'n4-unreg')
        # Sibling fallback: a checkout beside the daemon's cwd (the scratch project).
        git(genv, 'init', '-q', s.project / 'n4-sib')
        # A cwd under no git repository, so nothing is found by walking up.
        (root / 'nogit').mkdir()
        # A registered root that is itself a linked worktree.
        s.command('wrkq-linked', ['wrkq', 'mkdir', '/n4-linked', '--kind', 'project', '--json'])
        s.command('wrkq-linked-root', ['wrkq', 'set', '/n4-linked', '--root', worktree, '--json'])
        s.up(args.owner, 'placement')

        def scope(project, task=None):
            return f'agent:tabularasa:project:{project}' + (f':task:{task}' if task else '')

        cases = {
            'registered': scope(PROJECT, 'plain'),
            'worktree': scope(PROJECT, TASK),
            'worktree-subtask': scope(PROJECT, TASK + '.render'),
            'marker': scope('n4-unreg', 'm1'),
            'sibling': scope('n4-sib', 's1'),
            'unknown': scope('n4-none', 'x1'),
            'linked-registered': scope('n4-linked', 'l1'),
            'projectless': 'agent:tabularasa',
        }
        for name, ref in cases.items():
            for door, body in [('placements', {'scopeRef': ref}),
                               ('placements-advisory', {'scopeRef': ref, 'taskWorktreeAssociation': 'advisory'}),
                               ('declarations', {'scopeRef': ref, 'runMode': 'task'})]:
                path = '/v1/placements/resolve' if door.startswith('placements') else '/v1/declarations/resolve'
                status, value = s.http('POST', path, body)
                observations[f'{door}:{name}'] = {'status': status, 'body': value}
            declared = observations[f'declarations:{name}']
            if declared['status'] == 200:
                status, value = s.http('POST', '/v1/targets/ensure', {
                    'sessionRef': ref + '/lane:main', 'runtimeIntent': declared['body']['intent']})
                observations[f'ensure:{name}'] = {'status': status, 'body': value}
        # With no repository above cwd, sibling fallback finds nothing and the
        # explicit project is refused instead of guessed.
        for name, ref in [('unknown-nogit', cases['unknown']), ('marker-nogit', cases['marker'])]:
            status, value = s.http('POST', '/v1/placements/resolve', {'scopeRef': ref, 'cwd': str(root / 'nogit')})
            observations[f'placements:{name}'] = {'status': status, 'body': value}
        if not args.no_birth:
            for name in ('registered', 'worktree', 'marker'):
                # No --project-id: that flag makes the CLI send cwd as an
                # explicit root override, which bypasses registry resolution.
                ref = cases[name].replace(':task:plain', ':task:born') if name == 'registered' else cases[name]
                out = s.command('start:' + name, ['hrc', 'start', ref, '--json', '-p', PROMPT])
                s.wait_completed(out['runtime']['runId'])
                intent = s.rows('SELECT last_applied_intent_json FROM sessions WHERE host_session_id=?',
                                (out['runtime']['hostSessionId'],))[0]['last_applied_intent_json']
                placement = json.loads(intent or '{}').get('placement', {})
                state = json.loads(s.rows('SELECT runtime_state_json FROM runtimes WHERE runtime_id=?',
                                          (out['runtime']['runtimeId'],))[0]['runtime_state_json'] or '{}')
                tmux = state.get('tmux', {})
                # The harness process's own cwd (lsof), not tmux's pane start dir.
                pane_pid = subprocess.run(['tmux', '-S', tmux.get('socketPath', ''), 'display-message', '-p', '-t',
                                           tmux.get('paneId', ''), '#{pane_pid}'],
                                          capture_output=True, text=True).stdout.strip()
                observations[f'birth:{name}'] = {'status': 0, 'body': {
                    'projectRoot': placement.get('projectRoot'), 'cwd': placement.get('cwd'),
                    'processCwds': descendant_cwds(pane_pid)}}
        normalized = json.loads(json.dumps(observations).replace(str(root.resolve()), '<root>')
                                .replace(str(root), '<root>'))
        (args.artifacts / args.owner).mkdir(exist_ok=True)
        (args.artifacts / args.owner / 'placement.json').write_text(json.dumps(normalized, indent=1) + '\n')
        print(json.dumps({'owner': args.owner, 'cases': len(observations)}))
    finally:
        (args.artifacts / f'{args.owner}-steps.json').write_text(json.dumps(s.steps, indent=1) + '\n')
        s.cleanup('agent:tabularasa')


if __name__ == '__main__':
    main()
