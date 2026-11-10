#!/usr/bin/env python3
"""N4 project-root placement on a native owner, judged against the fixture layout.

A private wrkqd holds the project registry and ASP_PROJECT_ROOT_OVERRIDE is
unset, so an explicit project resolves through HRC policy: wrkq registry,
marker scan, sibling fallback, then task-worktree refinement. Each scope is
read through POST /v1/placements/resolve and POST /v1/declarations/resolve,
ensured with the declared intent through POST /v1/targets/ensure, and the
registered, worktree and marker cases are cold-born with `hrc start` on
hrcpty; the cwd (lsof) of the processes under the seat's hrc-pty supervisor
is the proof of where the seat landed.

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
    """(command, cwd) of every process under the seat's supervisor."""
    pids, frontier = [], [root_pid] if root_pid else []
    while frontier:
        pid = frontier.pop()
        pids.append(pid)
        frontier += subprocess.run(['pgrep', '-P', pid], capture_output=True, text=True).stdout.split()
    found = []
    for pid in pids[1:]:  # the processes under the root, not the root itself
        out = subprocess.run(['lsof', '-a', '-d', 'cwd', '-p', pid, '-Fcn'], capture_output=True, text=True).stdout
        fields = {line[0]: line[1:] for line in out.splitlines() if line[:1] in ('c', 'n')}
        if 'n' in fields:
            found.append([fields.get('c', '?'), fields['n']])
    return sorted(found)


def supervisor(runtime):
    """The seat's hrc-pty supervisor pid (as n2_startup.kill_tree finds it)."""
    out = subprocess.run(['/bin/ps', '-axo', 'pid=,command='], capture_output=True, text=True).stdout
    pids = [l.split(None, 1)[0] for l in out.splitlines() if 'hrc-pty serve' in l and runtime in l]
    assert len(pids) == 1, ('one hrc-pty supervisor per seat', runtime, pids)
    return pids[0]


FAILED = []


# case -> (resolution source, project root under <root>, projectId); None = refused
EXPECT = {
    'registered': ('wrkq-registry', '<root>/' + PROJECT, PROJECT),
    'worktree': ('task-worktree', '<root>/wt-' + TASK, PROJECT),
    'worktree-subtask': ('task-worktree', '<root>/wt-' + TASK, PROJECT),
    'marker': ('marker-scan', '<root>/search/n4-unreg', 'n4-unreg'),
    'sibling': ('sibling-fallback', '<root>/' + PROJECT + '/n4-sib', 'n4-sib'),
    'unknown': None,
    'linked-registered': ('wrkq-registry', '<root>/wt-' + TASK, 'n4-linked'),
    'projectless': ('inferred', '<root>/' + PROJECT, PROJECT),
}
REFUSAL = 'project root unknown for n4-none; register it with: wrkq set n4-none --root <path>'


def judge(o, births, artifacts):
    """Each case's literal placement, from the fixture layout built in main()."""
    checks = []
    def check(name, passed, reason, got=None):
        checks.append({'id': name, 'pass': bool(passed), 'reason': reason, 'got': got})
    def refused(name):
        v = o[name]
        return v['status'] == 422 and v['body']['error']['code'] == 'declaration_invalid' and v['body']['error']['message'] == REFUSAL
    for case, want in EXPECT.items():
        for door in ('placements', 'placements-advisory', 'declarations'):
            name = f'{door}:{case}'
            v = o[name]
            if want is None:
                check(name, refused(name) and f'ensure:{case}' not in o, 'an unknown project is refused, not guessed', v)
                continue
            source, root, project = want
            if door == 'declarations':
                placement = v['body']['intent']['placement'] if v['status'] == 200 else {}
                check(name, v['status'] == 200 and placement.get('projectRoot') == root and placement.get('cwd') == root,
                      'the declared intent carries the resolved root as projectRoot and cwd', placement)
                continue
            r = v['body'].get('resolution', {})
            ok = (v['status'] == 200 and v['body']['projectRoot'] == root and v['body']['cwd'] == root
                  and r.get('source') == source and r.get('projectId') == project)
            if source == 'task-worktree':
                ok = ok and r.get('branch') == 'n4-' + TASK and r.get('canonicalRoot') == root
            check(name, ok, f'resolved by {source} to {root}', [v['status'], v['body'].get('projectRoot'), r])
        if want is not None:
            e = o[f'ensure:{case}']
            check(f'ensure:{case}', e['status'] == 200 and e['body']['lastAppliedIntentJson']['placement']['projectRoot'] == want[1],
                  'ensure applies the declared placement', e['status'])
    check('placements:unknown-nogit', refused('placements:unknown-nogit'), 'no repository above cwd: still refused')
    m = o['placements:marker-nogit']
    check('placements:marker-nogit', m['status'] == 200 and m['body']['resolution']['source'] == 'marker-scan'
          and m['body']['projectRoot'] == EXPECT['marker'][1], 'marker scan does not depend on cwd', m['body'].get('resolution'))
    if births:
        for case in ('registered', 'worktree', 'marker'):
            b = o[f'birth:{case}']['body']
            # The broker runs where the owner started it; the harness (Claude's
            # binary is named by its version) and its children run in the seat's root.
            harness = sorted({cwd for command, cwd in b['processCwds'] if command != 'harness-broker'})
            check(f'birth:{case}', b['projectRoot'] == EXPECT[case][1] and b['cwd'] == EXPECT[case][1] and harness == [EXPECT[case][1]],
                  'the born seat\'s harness process runs in the resolved root', b)
    (artifacts / 'checks.json').write_text(json.dumps(checks, indent=1) + '\n')
    FAILED.extend(c for c in checks if not c['pass'])
    return FAILED


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--binary', type=Path, required=True)
    p.add_argument('--installed-release', type=Path)
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
        s.command('wrkq-linked', [str(Path.home() / ".local/bin/wrkq"), 'mkdir', '/n4-linked', '--kind', 'project', '--json'])
        s.command('wrkq-linked-root', [str(Path.home() / ".local/bin/wrkq"), 'set', '/n4-linked', '--root', worktree, '--json'])
        s.up('native', 'placement')

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
                # The harness processes' own cwd (lsof) under the seat's hrc-pty supervisor.
                observations[f'birth:{name}'] = {'status': 0, 'body': {
                    'projectRoot': placement.get('projectRoot'), 'cwd': placement.get('cwd'),
                    'processCwds': descendant_cwds(supervisor(out['runtime']['runtimeId']))}}
        normalized = json.loads(json.dumps(observations).replace(str(root.resolve()), '<root>')
                                .replace(str(root), '<root>'))
        (args.artifacts / 'placement.json').write_text(json.dumps(normalized, indent=1) + '\n')
        failed = judge(normalized, not args.no_birth, args.artifacts)
        print(json.dumps({'suite': 'n4_placement', 'cases': len(observations), 'failed': failed[:20]}, indent=1))
    finally:
        (args.artifacts / 'steps.json').write_text(json.dumps(s.steps, indent=1) + '\n')
        s.cleanup('agent:tabularasa')


if __name__ == '__main__':
    main()
    if FAILED:
        raise SystemExit(1)
