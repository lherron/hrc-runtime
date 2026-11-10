#!/usr/bin/env python3
"""N2 turn workflow on rusthrc, checked against the seat's own broker ledger.

Cold birth, then a warm `hrc start -p` turn that invokes a Skill tool
(foundry's skill-lifecycle reads those broker_invocation_events rows), then
the N2 reads. Checks: every mirrored broker row equals the broker's own ledger
envelope and payload, no *.delta rows, all applied, one disposition per seq,
the durable cursor at the ledger head; one turn.message per broker message and
no T-11837 fallback duplicate; Skill tool rows with a run on both the broker
and lifecycle side; both runs completed; every read answers 200.

The tmux-only human-typed phase is gone: an hrcpty seat has no tmux pane, and
non-empty literal input on a broker runtime is buffered for a turn, not typed.
"""
import argparse
import collections
import json
from pathlib import Path
import re
import time

from n2_scratch import Scratch

SKILL = """---
name: n2-ping
description: Answers a ping for the N2 workflow. Use when asked to run n2-ping.
---
Reply with exactly the word PONG and nothing else.
"""
FALLBACK = re.compile(r'^turn_.+_final$')


def ledger_problems(d):
    """Mirrored broker rows against the broker's own durable ledger."""
    ledger = {e['seq']: e for e in d['brokerLedger']}
    rows = d['broker_invocation_events']
    problems = {}
    if len([r for r in rows if not r['type'].endswith('.delta')]) <= 10:
        problems['nonempty'] = len(rows)
    bad = []
    for r in rows:
        e = ledger.get(r['seq'])
        envelope = dict(e or {})
        payload = envelope.pop('payload', None)
        stored = json.loads(r['broker_event_json'])
        if isinstance(stored, dict) and isinstance(stored.get('result'), dict) and 'spill' in stored['result'].get('details', {}):
            stored = payload  # spilled rows live in tool_result_blobs
        if e is None or stored != payload or json.loads(r['broker_envelope_json']) != envelope or r['type'] != e['type']:
            bad.append(r['seq'])
    if bad:
        problems['ledgerEqual'] = bad[:8]
    if [r for r in rows if r['type'].endswith('.delta')]:
        problems['deltas'] = True
    if not all(r['projection_status'] == 'applied' for r in rows):
        problems['applied'] = sorted({r['projection_status'] for r in rows})
    dispositions = {(x['invocation_id'], x['seq']) for x in d['broker_projection_dispositions']}
    if dispositions != {(r['invocation_id'], r['seq']) for r in rows}:
        problems['dispositions'] = len(dispositions)
    inv = d['broker_invocations'][0]
    if inv['last_projected_seq'] != max(ledger):
        problems['cursor'] = [inv['last_projected_seq'], max(ledger)]
    if inv['last_event_seq'] != max(r['seq'] for r in rows):
        problems['lastEventSeq'] = inv['last_event_seq']
    by_run = collections.defaultdict(list)
    for r in rows:
        if r['type'] == 'assistant.message.completed':
            by_run[r['run_id']].append(json.loads(r['broker_event_json']).get('messageId') or '')
    messages = sum(len(v) for v in by_run.values())
    replies = len([e for e in d['hrc_events'] if e['event_kind'] == 'turn.message'])
    if messages != replies or not messages:
        problems['replyRows'] = [replies, messages]
    dups = [(run, m) for run, ids in by_run.items() if any(not FALLBACK.match(i) for i in ids) for m in ids if FALLBACK.match(m)]
    if dups:
        problems['fallbackDuplicates'] = dups
    return problems


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--binary', type=Path, required=True)
    p.add_argument('--installed-release', type=Path, required=True)
    p.add_argument('--aspd-socket', type=Path, required=True)
    p.add_argument('--scratch-root', type=Path, required=True)
    p.add_argument('--artifacts', type=Path, required=True)
    p.add_argument('--phases', default='cold,warm,reads')
    args = p.parse_args()
    phases = set(args.phases.split(','))
    s = Scratch(args.scratch_root, args.installed_release, args.aspd_socket, args.binary, args.artifacts)
    scope_prefix = 'agent:tabularasa:project:n2-t11823:task:'
    scope = scope_prefix + 'turns-' + str(time.time_ns())
    marks, cases = {}, {}
    try:
        s.init_substrate()
        skills = s.project / '.claude/skills/n2-ping'
        skills.mkdir(parents=True)
        (skills / 'SKILL.md').write_text(SKILL)
        owner = s.up('native', 'workflow')
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
        d = s.dump('turns', {'marks': marks, 'cases': cases, 'scope': scope, 'runtimeId': runtime,
                             'runIds': [run1, run2], 'steps': s.steps})
        problems = ledger_problems(d)
        assert not problems, ('broker ledger checks', problems)
        runs = {r['run_id']: r['status'] for r in d['runs']}
        assert all(runs.get(r) == 'completed' for r in (run1, run2) if r), runs
        if 'warm' in phases:
            skill = [r for r in d['broker_invocation_events'] if r['type'].startswith('tool.call.')
                     and json.loads(r['broker_event_json']).get('name') == 'Skill']
            assert skill and all(r['run_id'] == run2 for r in skill), ('Skill broker rows', skill)
            lifecycle = [e for e in d['hrc_events'] if e['event_kind'] in ('turn.tool_call', 'turn.tool_result')
                         and json.loads(e['payload_json']).get('toolName') == 'Skill']
            assert {e['event_kind'] for e in lifecycle} == {'turn.tool_call', 'turn.tool_result'} and all(e['run_id'] == run2 for e in lifecycle), lifecycle
        failed = {k: v[0] for k, v in reads.items() if v[0] != 200}
        assert not failed, ('reads', failed)
        print(json.dumps({'pass': True, 'runtimeId': runtime, 'marks': marks,
                          'artifacts': str(args.artifacts)}))
    finally:
        (args.artifacts / 'steps.json').write_text(json.dumps(s.steps, indent=1) + '\n')
        s.cleanup(scope_prefix)


if __name__ == '__main__':
    main()
