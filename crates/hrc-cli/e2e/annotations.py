#!/usr/bin/env python3
"""Seat annotations Gates 1, 2 and 3 (T-12186, T-12187, T-12188, T-12194;
seat-annotations r1.1 §4, §5, §7 claims 1 and 2).

`rusthrc session annotation list|put|delete|act` against ONE isolated scratch
rusthrc: a Bun-created schema, a fake aspd and the stub broker release
(hrcpty_substrate.py's substrate), so an hrcpty seat births and runs a real
turn without a model. Never the live daemon, ledger or kernel.

Product claims, each a check:
  put-list       put then list returns the stored body
  stale-update   a put carrying a superseded --expect-updated-at refuses
                 stale_annotation (the current one is admitted)
  body-cap       a 65,537-byte serialized body refuses annotation_invalid
                 (65,536 is admitted: the boundary, not just a big body)
  stale-attn     the seat's live attention lights at A1 on the turn's open
                 question; a put fenced on A1 is admitted; the turn is answered
                 and completes, the owner's HTTP attention moves off A1,
                 and the same A1 fence now refuses stale_attention
  http-attention (T-12212) GET /v1/sessions/attention answers the owner's
                 lit attention (at == A1) while the question is open and null
                 once the answered turn completes, runtimeLive true throughout
  delete         delete with the current --expect-updated-at succeeds and the
                 row is gone
  act            act appends session.annotation.action {key, action,
                 attributes} at the returned hrcSeq and leaves the row as it was
  ledger         session.annotation.changed rows in the scratch hrc_events are
                 exactly the admitted puts/deletes, in order, without bodies;
                 refused writes appended nothing
  sdk            hrc-sdk putSessionAnnotation/listSessionAnnotations against the
                 same daemon; the principalRef lands as updatedBy

The former Gate 2 projection lineage checks belong to the praesidium kernel
campaign suite (T-12361). This suite retains owner CLI rotation and annotation
scope checks. Gate 3 sends annotation put/act/delete operations through the
ops-only socket and verifies owner CLI state and the durable event ledger.

Failure modes guarded: attention must light before the control put, then clear
before the stale fence is checked; compact JSON measures the body cap exactly;
ledger assertions read hrc_events, never CLI output.
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import urllib.parse
import uuid

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
sys.path.insert(0, str(REPO / 'crates/hrc-native/e2e'))
from hrcpty_substrate import FakeAspd, Run, AGENT, PROJECT, LEAK, descendants_of  # noqa: E402
from kernel_fold import wire  # noqa: E402
from metrics_isolation import isolated_suite  # noqa: E402

LIVE_STATE = Path.home() / 'praesidium/var'


def compact(value):
    return json.dumps(value, separators=(',', ':'), ensure_ascii=True)


def body_of_size(size):
    """An object whose compact serialization is exactly `size` bytes."""
    overhead = len(compact({'pad': ''}))
    body = {'pad': 'x' * (size - overhead)}
    assert len(compact(body)) == size
    return body


@isolated_suite
def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--binary', type=Path, default=REPO / 'crates/target/debug/rusthrc')
    p.add_argument('--root', type=Path, default=Path(f'/tmp/hann-{os.getpid()}'))
    p.add_argument('--artifacts', type=Path, required=True)
    p.add_argument('--keep', action='store_true', help='leave the scratch root (processes still stop)')
    a = p.parse_args()
    binary = a.binary.resolve()
    assert (binary.parent / 'hrc-pty').is_file(), 'build hrc-pty beside rusthrc: cargo build -p hrc-native -p hrc-pty'
    root = a.root.absolute()
    root.mkdir(parents=True)  # refuse a reused root
    assert not str(root).startswith(str(LIVE_STATE))
    a.artifacts.mkdir(parents=True, exist_ok=True)
    for stale in ('results.json', 'cli.ndjson', 'ledger.json', 'fake-aspd.ndjson', 'daemon-1.log', 'http-attention.json',
                  'rotation.json', 'kernel-ops.json'):
        (a.artifacts / stale).unlink(missing_ok=True)
    r = Run(root, a.artifacts, binary)
    transcript = (a.artifacts / 'cli.ndjson').open('w')

    # -- substrate (hrcpty_substrate.main's shape, without federation) --------
    release_root = root / 'release'
    (release_root / 'bin').mkdir(parents=True)
    stub = release_root / 'bin/stub-broker'
    shutil.copy(REPO / 'crates/hrc-native/e2e/hrcpty_stub_broker.py', stub)
    stub.chmod(0o755)
    release = {'releaseId': 'stub-broker-t12186', 'sourceCommit': '1' * 40, 'builtAt': '2026-10-31T00:00:00.000Z',
               'releaseRoot': str(release_root),
               'worker': {'protocol': 'harness-broker/0.2', 'executable': str(stub), 'argvPrefix': [],
                          'hostedDrivers': ['claude-code-hrcpty', 'claude-code-tmux']}}
    (release_root / 'release.json').write_text(json.dumps({**{k: release[k] for k in ('releaseId', 'sourceCommit', 'builtAt')},
                                                           'protocol': 'harness-broker/0.2',
                                                           'hostedDrivers': release['worker']['hostedDrivers']}))
    for d in ('run', 'state', PROJECT):
        (root / d).mkdir()
    clean = {k: v for k, v in os.environ.items() if not k.startswith(LEAK)}
    subprocess.run(['git', 'init', '-q'], cwd=root / PROJECT, check=True, env=clean)
    subprocess.run(['bun', '-e', 'import {openHrcDatabase} from "./packages/hrc-store-sqlite/src/database.ts";'
                    'openHrcDatabase(process.argv[1]).close()', str(r.db_path)],
                   cwd=REPO, check=True, capture_output=True, env=clean)
    aspd_socket = root / 'aspd.sock'
    aspd = FakeAspd(aspd_socket, release, a.artifacts / 'fake-aspd.ndjson')
    env = dict(clean)
    env.update(HRC_RUNTIME_DIR=str(root / 'run'), HRC_STATE_DIR=str(root / 'state'), HRC_ASPD_SOCKET=str(aspd_socket),
               ASP_PROJECT_ROOT_OVERRIDE=str(root / PROJECT), HRC_PROJECT_SEARCH_ROOTS=str(root / PROJECT),
               HRC_WRKQ_DB=str(root / 'wrkq.db'), WRKQ_DB=str(root / 'wrkq.db'), HRC_WRKQD_TOKEN_FILE='',
               WRKQD_TOKEN_FILE='', WRKQD_TOKEN='', HRC_PEER_CONFIG_FILE=str(root / 'absent-federation.json'),
               HRC_EVENT_INGEST_SOCKET=str(root / 'run/ingest.sock'), HRC_ACP_WEBHOOK_URL='',
               HRC_BROKER_DURABLE_IPC_ENABLED='1', HRC_CLAUDE_CODE_TMUX_BROKER_ENABLED='1', ASP_HOME=str(root / 'asp-home'),
               NO_COLOR='1')
    r.env = env
    kernel = root / 'run/hrc-kernel.sock'

    def cli(*argv, stdin=None):
        child = subprocess.run([str(binary), 'session', 'annotation', *argv], env=env, cwd=root / PROJECT,
                               input=stdin, text=True, capture_output=True, timeout=60)
        out = None
        if child.returncode == 0:
            out = json.loads(child.stdout)
        transcript.write(compact({'argv': list(argv), 'stdinBytes': len(stdin or ''), 'exit': child.returncode,
                                  'stdout': out if out is not None else child.stdout, 'stderr': child.stderr}) + '\n')
        transcript.flush()
        return child.returncode, out, child.stderr

    def refused(result, code):
        status, out, err = result
        return status == 1 and out is None and err.startswith(f'hrc: [{code}] ')

    def ledger(scope, kinds):
        out = r.rows('SELECT hrc_seq,event_kind,host_session_id,generation,payload_json FROM hrc_events '
                     'WHERE scope_ref=? AND event_kind IN (%s) ORDER BY hrc_seq' % ','.join('?' * len(kinds)),
                     (scope, *kinds))
        for e in out:
            e['payload'] = json.loads(e.pop('payload_json'))
        return out

    def attention_state(path, predicate):
        status, body = r.http('GET', path)
        return (status, body) if status == 200 and 'attention' in body and predicate(body['attention']) else None

    failure = None
    try:
        r.up('1')
        task = 'pty-' + uuid.uuid4().hex[:8]
        scope = f'agent:{AGENT}:project:{PROJECT}:task:{task}'
        ref = scope + '/lane:main'
        status, session = r.http('POST', '/v1/sessions/resolve', {'sessionRef': ref, 'create': True, 'summonIntent': 'explicit_local'})
        assert status == 200, (status, session)
        host = session['hostSessionId']
        key = ['--ns', 'e2e', '--kind', 'card']

        # == put-list ==========================================================
        first = {'title': 'one', 'n': 1}
        put1 = cli('put', ref, *key, '--id', 'c1', '--body-file', '-', '--expect-updated-at', 'null', stdin=compact(first))
        listed = cli('list', ref)
        row1 = (put1[1] or {}).get('annotation', {})
        rows = (listed[1] or {}).get('annotations', [])
        r.check('put-list', put1[0] == 0 and put1[1]['created'] is True and row1['body'] == first
                and row1['subject'] == 'seat' and row1['hostSessionId'] == '' and row1['generation'] is None
                and row1['fence'] == {'updatedAt': None}
                and [x['body'] for x in rows if x['id'] == 'c1'] == [first], put=put1, list=listed)
        absent_again = cli('put', ref, *key, '--id', 'c1', '--body-file', '-', '--expect-updated-at', 'null', stdin=compact(first))
        r.check('put-null-fence-refuses-existing', refused(absent_again, 'stale_annotation'), result=absent_again)

        # == stale-update =========================================================
        u1 = row1['updatedAt']
        second = {'title': 'two', 'n': 2}
        put2 = cli('put', ref, *key, '--id', 'c1', '--body-file', '-', '--expect-updated-at', u1, stdin=compact(second))
        u2 = (put2[1] or {}).get('annotation', {}).get('updatedAt')
        stale = cli('put', ref, *key, '--id', 'c1', '--body-file', '-', '--expect-updated-at', u1, stdin=compact({'title': 'lost'}))
        after = cli('list', ref, '--ns', 'e2e', '--kind', 'card')
        r.check('stale-update', put2[0] == 0 and put2[1]['created'] is False and u2 and u2 != u1
                and refused(stale, 'stale_annotation')
                and [x['body'] for x in after[1]['annotations'] if x['id'] == 'c1'] == [second],
                current=put2, stale=stale, after=after)

        # == body-cap ==============================================================
        body_file = root / 'body.json'
        body_file.write_text(compact(body_of_size(65_536)))
        at_cap = cli('put', ref, *key, '--id', 'cap', '--body-file', str(body_file))
        body_file.write_text(compact(body_of_size(65_537)))
        over = cli('put', ref, *key, '--id', 'cap-over', '--body-file', str(body_file))
        r.check('body-cap', at_cap[0] == 0 and refused(over, 'annotation_invalid') and '65537 bytes' in over[2]
                and not any(x['id'] == 'cap-over' for x in cli('list', ref)[1]['annotations']),
                atCap={'exit': at_cap[0]}, over=over)

        # == generation subject ======================================================
        gen = cli('put', ref, *key, '--id', 'g1', '--subject', 'generation', '--generation', '1', '--body-file', '-', stdin='{"g":1}')
        nogen = cli('put', ref, *key, '--id', 'g9', '--subject', 'generation', '--generation', '99', '--body-file', '-', stdin='{}')
        gen_rows = cli('list', ref, '--subject', 'generation', '--generation', '1')
        r.check('generation-subject', gen[0] == 0 and gen[1]['annotation']['hostSessionId'] == host
                and gen[1]['annotation']['generation'] == 1 and refused(nogen, 'unknown_generation')
                and [x['id'] for x in gen_rows[1]['annotations']] == ['g1'], gen=gen, nogen=nogen, list=gen_rows)

        # == stale-attn ===============================================================
        intent = {'placement': {'agentRoot': str(root / PROJECT), 'projectRoot': str(root / PROJECT), 'cwd': str(root / PROJECT),
                                'runMode': 'task', 'bundle': {'kind': 'compose', 'compose': []}, 'dryRun': False},
                  'harness': {'provider': 'anthropic', 'interactive': True}}
        status, born = r.http('POST', '/v1/turns', {'hostSessionId': host, 'prompt': 'annotation e2e turn', 'runtimeIntent': intent})
        assert status in (200, 202), ('birth', status, born)
        rt, run = born['runtimeId'], born['runId']
        r.wait(lambda: r.rows("SELECT 1 FROM hrc_events WHERE run_id=? AND event_kind='turn.awaiting_input'", (run,)), 60, 'open question')
        attention_path = '/v1/sessions/attention?' + urllib.parse.urlencode({'scopeRef': scope})
        http_lit = r.wait(lambda: attention_state(attention_path, lambda value: value is not None),
                          20, 'lit owner attention')
        lit = http_lit[1]['attention']
        a1 = lit['at']
        awaiting = r.rows("SELECT ts FROM hrc_events WHERE run_id=? AND event_kind='turn.awaiting_input'", (run,))
        control = cli('put', ref, *key, '--id', 'attn', '--body-file', '-', '--expect-attention-at', a1, stdin='{"state":"draft"}')
        status, contrib = r.http('POST', '/v1/active-run-contributions', {
            'inputApplicationId': 'app-' + uuid.uuid4().hex, 'inputAttemptId': 'att-' + uuid.uuid4().hex,
            'prompt': 'E2E-ANSWER', 'selector': {'runtimeId': rt}})
        r.wait(lambda: r.rows("SELECT 1 FROM runs WHERE run_id=? AND status='completed'", (run,)), 60, 'answered turn completed')
        http_moved = r.wait(lambda: attention_state(attention_path, lambda value: value is None),
                            20, 'owner attention cleared')
        moved = http_moved[1]['attention']
        stale_attn = cli('put', ref, *key, '--id', 'attn', '--body-file', '-', '--expect-attention-at', a1, stdin='{"state":"sent"}')
        stored = [x for x in cli('list', ref, '--ns', 'e2e')[1]['annotations'] if x['id'] == 'attn']
        (a.artifacts / 'http-attention.json').write_text(json.dumps({'lit': http_lit, 'moved': http_moved}, indent=1) + '\n')
        r.check('stale-attn', [x['ts'] for x in awaiting] == [a1] and control[0] == 0
                and control[1]['annotation']['fence'] == {'attentionAt': a1}
                and status == 200 and contrib.get('status') == 'accepted'
                and refused(stale_attn, 'stale_attention')
                and [x['body'] for x in stored] == [{'state': 'draft'}],
                a1=a1, awaitingTs=awaiting, control=control, answer=contrib, movedAttention=moved, refusal=stale_attn)
        seat_fields = {'scopeRef': scope, 'laneRef': 'main', 'hostSessionId': host, 'generation': 1, 'runtimeLive': True}
        r.check('http-attention', http_lit[0] == 200 and http_lit[1] == {**seat_fields, 'attention': lit}
                and lit['at'] == a1 and moved is None
                and http_moved[0] == 200 and http_moved[1] == {**seat_fields, 'attention': None},
                lit=http_lit, moved=http_moved, ownerLit=lit)

        # == delete ===================================================================
        current = next(x for x in cli('list', ref)[1]['annotations'] if x['id'] == 'c1')['updatedAt']
        stale_delete = cli('delete', ref, *key, '--id', 'c1', '--expect-updated-at', u1)
        deleted = cli('delete', ref, *key, '--id', 'c1', '--expect-updated-at', current)
        again = cli('delete', ref, *key, '--id', 'c1')
        r.check('delete', refused(stale_delete, 'stale_annotation') and deleted[0] == 0 and deleted[1] == {'deleted': True}
                and again[1] == {'deleted': False} and not any(x['id'] == 'c1' for x in cli('list', ref)[1]['annotations']),
                stale=stale_delete, deleted=deleted, again=again)

        # == act ======================================================================
        before = next(x for x in cli('list', ref)[1]['annotations'] if x['id'] == 'attn')
        acted = cli('act', ref, *key, '--id', 'attn', '--action', 'sent', '--attributes', '{"ok":true,"edited":false}')
        gone = cli('act', ref, *key, '--id', 'c1', '--action', 'sent')
        after_act = next(x for x in cli('list', ref)[1]['annotations'] if x['id'] == 'attn')
        action_rows = ledger(scope, ['session.annotation.action'])
        r.check('act', acted[0] == 0 and [e['hrc_seq'] for e in action_rows] == [acted[1]['hrcSeq']]
                and action_rows[0]['payload'] == {'scopeRef': scope, 'laneRef': 'main', 'subject': 'seat', 'generation': None,
                                                  'ns': 'e2e', 'kind': 'card', 'id': 'attn', 'action': 'sent',
                                                  'attributes': {'ok': True, 'edited': False}}
                and refused(gone, 'unknown_annotation') and after_act == before,
                acted=acted, actionRows=action_rows, unknown=gone)

        # == sdk ======================================================================
        sdk = subprocess.run(['bun', '-e', '''
import { HrcClient } from "./packages/hrc-sdk/src/index.ts"
const [socketPath, scopeRef] = process.argv.slice(1)
const client = new HrcClient(socketPath)
const key = { scopeRef, subject: "seat", ns: "e2e", kind: "sdk", id: "s1" } as const
const put = await client.putSessionAnnotation({ ...key, body: { via: "sdk" }, expect: { updatedAt: null } }, { principalRef: "agent:e2e-sdk" })
const listed = await client.listSessionAnnotations({ scopeRef, kind: "sdk" })
let refusal = null
try { await client.deleteSessionAnnotation({ ...key, expect: { updatedAt: "1999-01-01T00:00:00.000Z" } }) } catch (e) { refusal = e.code }
const acted = await client.actOnSessionAnnotation({ ...key, action: "probe" })
const attention = await client.getSessionAttention({ scopeRef })
console.log(JSON.stringify({ put, listed, refusal, acted, attention }))
''', str(r.socket), scope], cwd=REPO, env=clean, capture_output=True, text=True, timeout=60)
        sdk_out = json.loads(sdk.stdout) if sdk.returncode == 0 else None
        r.check('sdk', sdk_out is not None and sdk_out['put']['annotation']['updatedBy'] == 'agent:e2e-sdk'
                and [x['body'] for x in sdk_out['listed']['annotations']] == [{'via': 'sdk'}]
                and sdk_out['refusal'] == 'stale_annotation' and isinstance(sdk_out['acted']['hrcSeq'], int)
                and row1['updatedBy'] == 'unknown'
                and sdk_out['attention']['hostSessionId'] == host and sdk_out['attention']['runtimeLive'] is True,
                exit=sdk.returncode, out=sdk_out, stderr=sdk.stderr[-2000:])

        # == ledger ===================================================================
        changed = ledger(scope, ['session.annotation.changed'])
        observed = [(e['payload']['id'], e['payload']['op'], e['payload']['subject']) for e in changed]
        expected = [('c1', 'put', 'seat'), ('c1', 'put', 'seat'), ('cap', 'put', 'seat'), ('g1', 'put', 'generation'),
                    ('attn', 'put', 'seat'), ('c1', 'delete', 'seat'), ('s1', 'put', 'seat')]
        bodies = [e for e in changed if 'body' in e['payload']]
        hosts = {(e['payload']['id'], e['host_session_id'], e['generation']) for e in changed}
        (a.artifacts / 'ledger.json').write_text(json.dumps({'changed': changed, 'action': ledger(scope, ['session.annotation.action'])}, indent=1) + '\n')
        r.check('ledger', observed == expected and not bodies and ('g1', host, 1) in hosts
                and all(e['payload']['updatedBy'] == ('agent:e2e-sdk' if e['payload']['id'] == 's1' else 'unknown') for e in changed)
                and all(set(e['payload']) == {'scopeRef', 'laneRef', 'subject', 'generation', 'ns', 'kind', 'id', 'op', 'updatedBy'} for e in changed),
                observed=observed, expected=expected)

        # Projection lineage is tested by the praesidium kernel campaign (T-12361).
        # Retain the owner CLI rotation and generation scope contract here.
        child = subprocess.run([str(binary), 'session', 'rotate', host, '--relaunch'], env=env, cwd=root / PROJECT,
                               text=True, capture_output=True, timeout=60)
        transcript.write(compact({'argv': ['session', 'rotate', host, '--relaunch'], 'exit': child.returncode,
                                  'stdout': child.stdout, 'stderr': child.stderr}) + '\n')
        transcript.flush()
        rotated = json.loads(child.stdout) if child.returncode == 0 else {}
        new_host = rotated.get('hostSessionId')
        rotated_rows = cli('list', ref, '--subject', 'generation', '--generation', '1')
        r.check('owner-rotate', child.returncode == 0 and rotated.get('generation') == 2
                and rotated.get('priorHostSessionId') == host and new_host and new_host != host
                and rotated_rows[0] == 0
                and [(x['id'], x['hostSessionId'], x['generation'])
                     for x in rotated_rows[1]['annotations']] == [('g1', host, 1)],
                rotate=rotated, stderr=child.stderr, priorGenerationAnnotations=rotated_rows)
        (a.artifacts / 'rotation.json').write_text(json.dumps({
            'rotate': rotated, 'priorGenerationAnnotations': rotated_rows}, indent=1) + '\n')

        # == Gate 3: the kernel ops and CLI --as (T-12188) ==========================
        def op(name, **args):
            reply = wire(kernel, name, args)
            transcript.write(compact({'wire': name, 'args': args, 'reply': reply}) + '\n')
            transcript.flush()
            return reply

        def annotation(id_, subject='seat', generation=None, kind='op'):
            args = ['list', ref, '--ns', 'e2e', '--kind', kind, '--subject', subject]
            if generation is not None:
                args += ['--generation', str(generation)]
            result = cli(*args)
            assert result[0] == 0, result
            return next((row for row in result[1]['annotations'] if row['id'] == id_), None)

        okey = dict(session_ref=ref, subject='seat', ns='e2e', kind='op')
        o1 = op('seat.annotation.put', **okey, id='o1', body={'via': 'op'}, expect={'updatedAt': None})
        o1_row = annotation('o1')
        o1_replay = op('seat.annotation.put', **okey, id='o1', body={'via': 'lost'}, expect={'updatedAt': None})
        og = op('seat.annotation.put', **{**okey, 'subject': 'generation'}, generation=2, id='og', body={'g': 2})
        og_row = annotation('og', subject='generation', generation=2)
        r.check('op-put', o1.get('ok') is True and o1['result']['created'] is True
                and o1_row is not None and o1_row['body'] == {'via': 'op'} and o1_row['updatedAt'] == o1['result']['updated_at']
                and o1_row['updatedBy'] == 'system:hrc-kernel'
                and o1_replay.get('ok') is False and o1_replay['error']['code'] == 'stale_annotation'
                and annotation('o1') == o1_row
                and og.get('ok') is True and og_row is not None and og_row['hostSessionId'] == new_host
                and og_row['generation'] == 2,
                put=o1, annotation=o1_row, replay=o1_replay, generationPut=og, generationAnnotation=og_row)

        acted_op = op('seat.annotation.act', **okey, id='o1', action='sent', attributes={'ok': True, 'runId': 'r-op'})
        absent_op = op('seat.annotation.act', **okey, id='o-absent', action='sent')
        op_actions = [e for e in ledger(scope, ['session.annotation.action']) if e['payload']['id'] == 'o1']
        r.check('op-act', acted_op.get('ok') is True
                and [e['hrc_seq'] for e in op_actions] == [acted_op['result']['hrc_seq']]
                and op_actions[0]['payload']['action'] == 'sent'
                and op_actions[0]['payload']['attributes'] == {'ok': True, 'runId': 'r-op'}
                and annotation('o1') == o1_row
                and absent_op.get('ok') is False and absent_op['error']['code'] == 'unknown_annotation',
                acted=acted_op, actionRows=op_actions, unknown=absent_op)

        dkey = dict(okey, kind='opdel', id='od')
        od1 = op('seat.annotation.put', **dkey, body={'n': 1}, expect={'updatedAt': None})
        od2 = op('seat.annotation.put', **dkey, body={'n': 2}, expect={'updatedAt': od1['result']['updated_at']})
        od_row = annotation('od', kind='opdel')
        od_stale = op('seat.annotation.delete', **dkey, expect={'updatedAt': od1['result']['updated_at']})
        od_kept = annotation('od', kind='opdel')
        od_deleted = op('seat.annotation.delete', **dkey, expect={'updatedAt': od2['result']['updated_at']})
        od_gone = annotation('od', kind='opdel') is None and annotation('o1') is not None
        od_rows = [(e['payload']['op'], e['payload']['updatedBy'], e['hrc_seq'])
                   for e in ledger(scope, ['session.annotation.changed']) if e['payload']['kind'] == 'opdel']
        r.check('op-delete', od1.get('ok') is True and od2.get('ok') is True and od_row is not None
                and od_row['body'] == {'n': 2} and od_row['updatedAt'] == od2['result']['updated_at']
                and od_stale.get('ok') is False and od_stale['error']['code'] == 'stale_annotation' and od_kept == od_row
                and od_deleted.get('ok') is True and od_deleted['result'] == {'deleted': True} and od_gone
                and [(o, by) for o, by, _ in od_rows] == [('put', 'system:hrc-kernel'), ('put', 'system:hrc-kernel'),
                                                          ('delete', 'system:hrc-kernel')],
                stale=od_stale, deleted=od_deleted, annotation=od_row, ledger=od_rows)

        as_put = cli('put', ref, '--ns', 'e2e', '--kind', 'as', '--id', 'a1', '--as', 'agent:e2e-cli', '--body-file', '-', stdin='{"by":"cli"}')
        blank_put = cli('put', ref, '--ns', 'e2e', '--kind', 'as', '--id', 'a2', '--as', ' ', '--body-file', '-', stdin='{}')
        as_delete = cli('delete', ref, '--ns', 'e2e', '--kind', 'as', '--id', 'a2', '--as', 'agent:e2e-cli')
        as_listed = cli('list', ref, '--kind', 'as')
        as_rows = [(e['payload']['id'], e['payload']['op'], e['payload']['updatedBy'])
                   for e in ledger(scope, ['session.annotation.changed']) if e['payload']['kind'] == 'as']
        op_rows = [(e['payload']['id'], e['payload']['updatedBy'])
                   for e in ledger(scope, ['session.annotation.changed']) if e['payload']['kind'] == 'op']
        (a.artifacts / 'kernel-ops.json').write_text(json.dumps({
            'opPut': o1, 'opAnnotation': o1_row, 'opReplay': o1_replay, 'opGenerationAnnotation': og_row,
            'opAct': acted_op, 'opActionRows': op_actions, 'opUnknown': absent_op,
            'opDelete': od_deleted, 'opDeleteStale': od_stale, 'opDeleteLedger': od_rows,
            'cliAsPut': as_put[1], 'cliAsLedger': as_rows, 'opLedger': op_rows}, indent=1) + '\n')
        r.check('cli-as', as_put[0] == 0 and as_put[1]['annotation']['updatedBy'] == 'agent:e2e-cli'
                and [x['updatedBy'] for x in as_listed[1]['annotations']] == ['agent:e2e-cli']
                and blank_put[0] == 0 and blank_put[1]['annotation']['updatedBy'] == 'unknown'
                and as_delete[1] == {'deleted': True}
                and as_rows == [('a1', 'put', 'agent:e2e-cli'), ('a2', 'put', 'unknown'), ('a2', 'delete', 'agent:e2e-cli')]
                and op_rows == [('o1', 'system:hrc-kernel'), ('og', 'system:hrc-kernel')],
                put=as_put, blank=blank_put, delete=as_delete, ledger=as_rows, opLedger=op_rows)
    except Exception as e:  # recorded, then re-raised after cleanup
        failure = e
        r.check('no-exception', False, error=repr(e))
    finally:
        transcript.close()
        for proc in r.owners:
            if proc.poll() is None:
                r.down(proc)
        aspd.close()
        for log in r.logs:
            log.close()
        # Seat processes (hrc-pty supervisor, stub broker, child) by root path.
        for pid, _ in descendants_of([str(root), root.name]):
            if pid != os.getpid():
                try:
                    os.kill(pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
        report = {'root': str(root), 'binary': str(binary), 'pass': sum(c['pass'] for c in r.checks),
                  'fail': sum(not c['pass'] for c in r.checks), 'checks': r.checks}
        (a.artifacts / 'results.json').write_text(json.dumps(report, indent=1, default=str) + '\n')
        print(json.dumps({k: report[k] for k in ('pass', 'fail')}))
        if not a.keep:
            shutil.rmtree(root, ignore_errors=True)
    if failure:
        raise failure
    return int(bool(report['fail']))


if __name__ == '__main__':
    raise SystemExit(main())
