#!/usr/bin/env python3
"""Seat annotations Gates 1, 2 and 3 (T-12186, T-12187, T-12188;
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
                 and completes, the kernel's hrc.seat attention moves off A1,
                 and the same A1 fence now refuses stale_attention
  delete         delete with the current --expect-updated-at succeeds and the
                 row is gone
  act            act appends session.annotation.action {key, action,
                 attributes} at the returned hrcSeq and leaves the row as it was
  ledger         session.annotation.changed rows in the scratch hrc_events are
                 exactly the admitted puts/deletes, in order, without bodies;
                 refused writes appended nothing
  sdk            hrc-sdk putSessionAnnotation/listSessionAnnotations against the
                 same daemon; the principalRef lands as updatedBy

Gate 2, the embedded kernel (T-12187), on the same daemon after Gate 1:
  kernel-annotation  a generation-scoped put appears as hrc.annotation with the
                 put's updatedAt; a fenced rewrite reaches the same node at a
                 higher revision, each within one ingest wake (seconds)
  kernel-before  hrc.seat.activeGeneration == generation == 1; hrc.generation
                 for generation 1 is active and lives as long as the seat
  kernel-rotate  `rusthrc session rotate --relaunch`: hrc.seat.activeGeneration moves to
                 2; generation 1's hrc.generation is archived with a finite
                 live_until; generation 2's is active and, with its relaunched
                 runtime, live (null) like the seat; the generation-scoped
                 annotations stay under generation 1's hostSessionId and live
                 exactly as long as it; seat-scoped ones stay under the seat;
                 no annotation names generation 2

Gate 3, the kernel ops and CLI attribution (T-12188), after Gate 2:
  op-put         seat.annotation.put dispatched on the kernel wire is admitted
                 (created), appears as an hrc.annotation node with its body and
                 updatedBy system:hrc-kernel, and a generation-scoped op put
                 lands under generation 2; a replay of the absent fence refuses
                 stale_annotation with the store's code
  op-act         seat.annotation.act returns hrc_seq, which is the
                 session.annotation.action row in hrc_events with the op's
                 action and attributes; an absent id refuses unknown_annotation
  cli-as         `put --as agent:e2e-cli` reads back updatedBy agent:e2e-cli and
                 its session.annotation.changed row names it; `delete --as`
                 names it on the delete row; a blank --as records unknown

Failure modes guarded: a vacuous stale_attention (attention never moved, or
refused for another reason) — the A1 control put must be admitted first and
the kernel row must show the move; an off-by-N body cap measured on spaced
JSON — bodies are built from serde's compact serialization; ledger assertions
read hrc_events, never CLI output.
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import time
import uuid

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
sys.path.insert(0, str(REPO / 'crates/hrc-native/e2e'))
from hrcpty_substrate import FakeAspd, Run, AGENT, PROJECT, LEAK, descendants_of  # noqa: E402
from kernel_fold import rows as kernel_rows, wire  # noqa: E402
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
    for stale in ('results.json', 'cli.ndjson', 'ledger.json', 'fake-aspd.ndjson', 'daemon-1.log', 'kernel-seat.json',
                  'kernel-lineage.json', 'kernel-ops.json'):
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

    def seat_attention(ref):
        seat = next((x for x in kernel_rows(kernel, 'hrc.seat') if x['payload'].get('sessionRef') == ref), None)
        return seat, (seat or {}).get('payload', {}).get('attention')

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
        lit_seat, lit = r.wait(lambda: (lambda s: s if s[1] else None)(seat_attention(ref)), 20, 'lit kernel attention')
        a1 = lit['at']
        awaiting = r.rows("SELECT ts FROM hrc_events WHERE run_id=? AND event_kind='turn.awaiting_input'", (run,))
        control = cli('put', ref, *key, '--id', 'attn', '--body-file', '-', '--expect-attention-at', a1, stdin='{"state":"draft"}')
        status, contrib = r.http('POST', '/v1/active-run-contributions', {
            'inputApplicationId': 'app-' + uuid.uuid4().hex, 'inputAttemptId': 'att-' + uuid.uuid4().hex,
            'prompt': 'E2E-ANSWER', 'selector': {'runtimeId': rt}})
        r.wait(lambda: r.rows("SELECT 1 FROM runs WHERE run_id=? AND status='completed'", (run,)), 60, 'answered turn completed')
        moved_seat, moved = r.wait(lambda: (lambda s: s if (s[1] or {}).get('at') != a1 else None)(seat_attention(ref)), 20, 'attention moved')
        stale_attn = cli('put', ref, *key, '--id', 'attn', '--body-file', '-', '--expect-attention-at', a1, stdin='{"state":"sent"}')
        stored = [x for x in cli('list', ref, '--ns', 'e2e')[1]['annotations'] if x['id'] == 'attn']
        (a.artifacts / 'kernel-seat.json').write_text(json.dumps({'lit': lit_seat, 'moved': moved_seat}, indent=1) + '\n')
        r.check('stale-attn', [x['ts'] for x in awaiting] == [a1] and control[0] == 0
                and control[1]['annotation']['fence'] == {'attentionAt': a1}
                and status == 200 and contrib.get('status') == 'accepted'
                and refused(stale_attn, 'stale_attention')
                and [x['body'] for x in stored] == [{'state': 'draft'}],
                a1=a1, awaitingTs=awaiting, control=control, answer=contrib, movedAttention=moved, refusal=stale_attn)

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
console.log(JSON.stringify({ put, listed, refusal, acted }))
''', str(r.socket), scope], cwd=REPO, env=clean, capture_output=True, text=True, timeout=60)
        sdk_out = json.loads(sdk.stdout) if sdk.returncode == 0 else None
        r.check('sdk', sdk_out is not None and sdk_out['put']['annotation']['updatedBy'] == 'agent:e2e-sdk'
                and [x['body'] for x in sdk_out['listed']['annotations']] == [{'via': 'sdk'}]
                and sdk_out['refusal'] == 'stale_annotation' and isinstance(sdk_out['acted']['hrcSeq'], int)
                and row1['updatedBy'] == 'unknown',
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

        # == Gate 2: the kernel's lineage nodes (T-12187) =============================
        def node(kind, **payload):
            return next((x for x in kernel_rows(kernel, kind)
                         if all(x['payload'].get(k) == v for k, v in payload.items())), None)

        def ingest():
            reply = wire(kernel, 'ingest.status', {'document_id': 'hrc'})
            return reply.get('result', reply)

        def visible(id_, updated_at):
            started = time.monotonic()
            seen = r.wait(lambda: (lambda n: n if n and n['payload']['updatedAt'] == updated_at else None)(
                node('hrc.annotation', sessionRef=ref, id=id_)), 10, f'{id_} at {updated_at} in the kernel')
            return seen, round(time.monotonic() - started, 3)

        ingest_before = ingest()
        k1 = cli('put', ref, *key, '--id', 'k1', '--subject', 'generation', '--generation', '1', '--body-file', '-', stdin='{"v":1}')
        u_k1 = k1[1]['annotation']['updatedAt']
        seen1, lag1 = visible('k1', u_k1)
        k2 = cli('put', ref, *key, '--id', 'k1', '--subject', 'generation', '--generation', '1', '--body-file', '-',
                 '--expect-updated-at', u_k1, stdin='{"v":2}')
        u_k2 = k2[1]['annotation']['updatedAt']
        seen2, lag2 = visible('k1', u_k2)
        r.check('kernel-annotation', k1[0] == 0 and k2[0] == 0 and u_k2 != u_k1
                and seen1['payload']['body'] == {'v': 1} and seen2['payload']['body'] == {'v': 2}
                and seen1['id'] == seen2['id'] and seen2['revision'] > seen1['revision']
                and seen2['payload']['hostSessionId'] == host and seen2['payload']['generation'] == 1
                and seen2['payload']['subject'] == 'generation' and seen2['payload']['fence'] == {'updatedAt': u_k1}
                and lag1 < 5 and lag2 < 5,
                first=seen1, second=seen2, lagSeconds=[lag1, lag2], ingestBefore=ingest_before, ingestAfter=ingest())

        seat0 = node('hrc.seat', sessionRef=ref)
        gen0 = node('hrc.generation', hostSessionId=host)
        pinned0 = node('hrc.annotation', sessionRef=ref, id='attn')
        r.check('kernel-before', seat0['payload']['activeGeneration'] == seat0['payload']['generation'] == 1
                and gen0['payload']['status'] == 'active' and gen0['payload']['sessionRef'] == ref
                and gen0['payload']['generation'] == 1
                and gen0['domain']['live_until'] == seat0['domain']['live_until']
                and pinned0 is not None and pinned0['payload']['hostSessionId'] == '',
                seat=seat0, generation=gen0, seatAnnotation=pinned0)

        child = subprocess.run([str(binary), 'session', 'rotate', host, '--relaunch'], env=env, cwd=root / PROJECT,
                               text=True, capture_output=True, timeout=60)
        transcript.write(compact({'argv': ['session', 'rotate', host, '--relaunch'], 'exit': child.returncode,
                                  'stdout': child.stdout, 'stderr': child.stderr}) + '\n')
        transcript.flush()
        rotated = json.loads(child.stdout) if child.returncode == 0 else {}
        new_host = rotated.get('hostSessionId')
        seat1 = r.wait(lambda: (lambda n: n if n and n['payload'].get('activeGeneration') == 2
                                and n['domain']['live_until'] is None else None)(
            node('hrc.seat', sessionRef=ref)), 30, 'seat activeGeneration 2 with its relaunched runtime')
        gen1 = r.wait(lambda: (lambda n: n if n and n['payload']['status'] == 'archived' else None)(
            node('hrc.generation', hostSessionId=host)), 20, 'generation 1 archived')
        gen2 = node('hrc.generation', hostSessionId=new_host)
        annotations = [x for x in kernel_rows(kernel, 'hrc.annotation') if x['payload']['sessionRef'] == ref]
        by_id = {x['payload']['id']: x for x in annotations}
        generation_scoped = [x for x in annotations if x['payload']['subject'] == 'generation']
        seat_scoped = [x for x in annotations if x['payload']['subject'] == 'seat']
        (a.artifacts / 'kernel-lineage.json').write_text(json.dumps({
            'before': {'seat': seat0, 'generation': gen0, 'seatAnnotation': pinned0},
            'kernelAnnotation': {'first': seen1, 'second': seen2},
            'rotate': rotated,
            'after': {'seat': seat1, 'archived': gen1, 'new': gen2, 'annotations': annotations}}, indent=1) + '\n')
        r.check('kernel-rotate', child.returncode == 0 and rotated.get('generation') == 2
                and rotated.get('priorHostSessionId') == host
                and seat1['payload']['generation'] == 2 and seat1['payload']['hostSessionId'] == new_host
                and gen1['payload']['status'] == 'archived' and isinstance(gen1['domain']['live_until'], str)
                and gen2 is not None and gen2['payload']['status'] == 'active' and gen2['payload']['generation'] == 2
                # The relaunched runtime keeps the seat and generation 2 live (null)
                # while generation 1 expires, so the two subjects' lifetimes differ.
                and seat1['domain']['live_until'] is None and gen2['domain']['live_until'] is None
                and {'k1', 'g1'} <= {x['payload']['id'] for x in generation_scoped}
                and all(x['payload']['hostSessionId'] == host
                        and x['domain']['live_until'] == gen1['domain']['live_until'] for x in generation_scoped)
                and by_id['k1']['payload']['updatedAt'] == u_k2
                and {'attn', 'cap', 's1'} <= {x['payload']['id'] for x in seat_scoped}
                and all(x['payload']['hostSessionId'] == ''
                        and x['domain']['live_until'] == seat1['domain']['live_until'] for x in seat_scoped)
                and not any(x['payload']['hostSessionId'] == new_host for x in annotations),
                rotate=rotated, stderr=child.stderr, seat=seat1, archived=gen1, new=gen2,
                annotations=sorted((x['payload']['id'], x['payload']['hostSessionId']) for x in annotations))

        # == Gate 3: the kernel ops and CLI --as (T-12188) ==========================
        def op(name, **args):
            reply = wire(kernel, name, args)
            transcript.write(compact({'wire': name, 'args': args, 'reply': reply}) + '\n')
            transcript.flush()
            return reply

        okey = dict(session_ref=ref, subject='seat', ns='e2e', kind='op')
        o1 = op('seat.annotation.put', **okey, id='o1', body={'via': 'op'}, expect={'updatedAt': None})
        o1_node = r.wait(lambda: node('hrc.annotation', sessionRef=ref, id='o1'), 10, 'o1 in the kernel')
        o1_replay = op('seat.annotation.put', **okey, id='o1', body={'via': 'lost'}, expect={'updatedAt': None})
        og = op('seat.annotation.put', **{**okey, 'subject': 'generation'}, generation=2, id='og', body={'g': 2})
        og_node = r.wait(lambda: node('hrc.annotation', sessionRef=ref, id='og'), 10, 'og in the kernel')
        r.check('op-put', o1.get('ok') is True and o1['result']['created'] is True
                and o1_node['payload']['body'] == {'via': 'op'} and o1_node['payload']['updatedAt'] == o1['result']['updated_at']
                and o1_node['payload']['updatedBy'] == 'system:hrc-kernel'
                and o1_replay.get('ok') is False and o1_replay['error']['code'] == 'stale_annotation'
                and og.get('ok') is True and og_node['payload']['hostSessionId'] == new_host
                and og_node['payload']['generation'] == 2,
                put=o1, node=o1_node, replay=o1_replay, generationPut=og, generationNode=og_node)

        acted_op = op('seat.annotation.act', **okey, id='o1', action='sent', attributes={'ok': True, 'runId': 'r-op'})
        absent_op = op('seat.annotation.act', **okey, id='o-absent', action='sent')
        op_actions = [e for e in ledger(scope, ['session.annotation.action']) if e['payload']['id'] == 'o1']
        r.check('op-act', acted_op.get('ok') is True
                and [e['hrc_seq'] for e in op_actions] == [acted_op['result']['hrc_seq']]
                and op_actions[0]['payload']['action'] == 'sent'
                and op_actions[0]['payload']['attributes'] == {'ok': True, 'runId': 'r-op'}
                and absent_op.get('ok') is False and absent_op['error']['code'] == 'unknown_annotation',
                acted=acted_op, actionRows=op_actions, unknown=absent_op)

        as_put = cli('put', ref, '--ns', 'e2e', '--kind', 'as', '--id', 'a1', '--as', 'agent:e2e-cli', '--body-file', '-', stdin='{"by":"cli"}')
        blank_put = cli('put', ref, '--ns', 'e2e', '--kind', 'as', '--id', 'a2', '--as', ' ', '--body-file', '-', stdin='{}')
        as_delete = cli('delete', ref, '--ns', 'e2e', '--kind', 'as', '--id', 'a2', '--as', 'agent:e2e-cli')
        as_listed = cli('list', ref, '--kind', 'as')
        as_rows = [(e['payload']['id'], e['payload']['op'], e['payload']['updatedBy'])
                   for e in ledger(scope, ['session.annotation.changed']) if e['payload']['kind'] == 'as']
        op_rows = [(e['payload']['id'], e['payload']['updatedBy'])
                   for e in ledger(scope, ['session.annotation.changed']) if e['payload']['kind'] == 'op']
        (a.artifacts / 'kernel-ops.json').write_text(json.dumps({
            'opPut': o1, 'opNode': o1_node, 'opReplay': o1_replay, 'opGenerationNode': og_node,
            'opAct': acted_op, 'opActionRows': op_actions, 'opUnknown': absent_op,
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
