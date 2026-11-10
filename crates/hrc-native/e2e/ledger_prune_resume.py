#!/usr/bin/env python3
"""Mark-gated runtime prune (T-12855), prune contract gate 5: a pruned seat resumes.

On a scratch rusthrc daemon (real aspd behind the n2 logging proxy, a real
model turn), a seat with one finished turn and a pending handoff has its
runtime terminated (continuation kept). A prune mark is written from this
store's incarnation and two ledger rows above everything the seat wrote, and
`rusthrc runtime prune-window --window 1s --yes` deletes every runtime of the
seat through the mark-gated task. The seat is then started again on the same
scope: its compile request must carry the stored continuation, the model must
recall the first turn's word, and its handoff and session record must read
back intact.

Usage: ledger_prune_resume.py --binary <rusthrc with hrc-pty beside it>
  --installed-release <bun release> --scratch-root /tmp/<fresh> --out <dir>
Needs the real aspd and model credentials (one live turn per birth).
"""
import argparse
import datetime as dt
import json
import secrets
import sqlite3
import sys
import time
from pathlib import Path



def iso_now():
    return dt.datetime.now(dt.timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.%f')[:-3] + 'Z'


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--binary', type=Path, required=True)
    p.add_argument('--installed-release', type=Path, required=True)
    p.add_argument('--aspd-socket', type=Path, default=Path.home() / 'praesidium/var/aspd/run/aspd.sock')
    p.add_argument('--scratch-root', type=Path, required=True)
    p.add_argument('--out', type=Path, required=True)
    a = p.parse_args()
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from n2_aspd_proxy import AspdProxy
    from n2_scratch import Scratch

    a.out.mkdir(parents=True, exist_ok=True)
    log = a.out / 'aspd-requests.ndjson'
    log.unlink(missing_ok=True)
    proxy = AspdProxy(Path(str(a.scratch_root) + '-aspd.sock'), a.aspd_socket, log)
    s = Scratch(a.scratch_root, a.installed_release, Path(proxy.listen), a.binary, a.out, project_id='t12855')
    prefix = 'agent:tabularasa:project:t12855:task:'
    scope = prefix + 'gate5'
    word = 'ZEBRA' + secrets.token_hex(3).upper()
    hrc = str(a.binary)
    result = {'scope': scope, 'word': word, 'scratchRoot': str(s.root)}
    try:
        s.init_substrate()
        s.up('native', 'gate5')
        start = [hrc, 'start', scope, '--project-id', s.project_id, '--project-root', s.project,
                 '--cwd', s.project, '--json', '-p']
        first = s.command('birth-1', start + [f'Remember the code word {word}. Reply with exactly OK and nothing else. No tools.'])
        s.wait_completed(first['runtime']['runId'])
        s.wait(lambda: s.rows('SELECT continuation_json FROM sessions WHERE scope_ref=? AND continuation_json IS NOT NULL', (scope,)),
               90, 'stored continuation')
        handoff = s.command('handoff-create', [hrc, 'handoff', 'create', '--scope', scope, '-t', 'gate5 successor',
                                               '--body-file', '-', '--json'], stdin='GATE5_HANDOFF_BODY')
        runtimes = [r['runtime_id'] for r in s.rows('SELECT runtime_id FROM runtimes WHERE scope_ref=?', (scope,))]
        for rid in runtimes:
            s.command('terminate-' + rid, [hrc, 'runtime', 'terminate', rid, '--no-drop-continuation',
                                           '--reason', 'T-12855 gate 5', '--json'], check=False)
        s.wait(lambda: all(r['status'] in ('terminated', 'dead', 'stale', 'crashed', 'detached')
                           for r in s.rows('SELECT status FROM runtimes WHERE scope_ref=?', (scope,))), 90, 'terminal runtimes')
        time.sleep(2)
        # Two anchor rows above everything the seat wrote: a session-level
        # hrc_events row (the sweep summary has no runtime) and a broker row
        # of a runtime that does not exist.
        status, sweep = s.http('POST', '/v1/runtimes/sweep', {'scope': 'agent:nobody:project:none', 'dryRun': False})
        assert status == 200, sweep
        hk, hts = s.rows('SELECT hrc_seq, ts FROM hrc_events WHERE runtime_id IS NULL ORDER BY hrc_seq DESC LIMIT 1')[0].values()
        now = iso_now()
        with sqlite3.connect(s.db_path, timeout=30) as db:
            db.execute("INSERT INTO broker_invocation_events(invocation_id,seq,time,type,runtime_id,broker_event_json,created_at) "
                       "VALUES ('inv-t12855-anchor',1,?,'t12855.anchor','rt-t12855-anchor','{}',?)", (now, now))
        bk, bts = s.rows('SELECT id, time FROM broker_invocation_events ORDER BY id DESC LIMIT 1')[0].values()
        time.sleep(1)
        incarnation = s.rows('SELECT ledger_incarnation_id FROM hrc_event_ledger_metadata')[0]['ledger_incarnation_id']
        mark = {'version': 1, 'node': 'gate5-scratch', 'hrc_ledger_incarnation_id': incarnation, 'reconciled_at': iso_now(),
                'anchors': {'hrc_events': {'key': hk, 'created': hts}, 'broker_invocation_events': {'key': bk, 'created': bts}}}
        (s.root / 'state/prune-mark.json').write_text(json.dumps(mark, indent=2))
        result['mark'] = mark
        session_before = s.rows('SELECT * FROM sessions WHERE scope_ref=?', (scope,))
        result['before'] = {
            'runtimes': s.rows('SELECT runtime_id,status,updated_at FROM runtimes WHERE scope_ref=?', (scope,)),
            'hrcEvents': s.rows('SELECT COUNT(*) n FROM hrc_events WHERE runtime_id IN (SELECT value FROM json_each(?))', (json.dumps(runtimes),))[0]['n'],
            'brokerEvents': s.rows('SELECT COUNT(*) n FROM broker_invocation_events WHERE runtime_id IN (SELECT value FROM json_each(?))', (json.dumps(runtimes),))[0]['n'],
        }
        report = s.command('prune', [hrc, 'runtime', 'prune-window', '--window', '1s', '--yes', '--json'])
        result['prune'] = {k: v for k, v in report.items()}
        left = s.rows('SELECT runtime_id FROM runtimes WHERE scope_ref=?', (scope,))
        result['after'] = {
            'runtimes': left,
            'hrcEvents': s.rows('SELECT COUNT(*) n FROM hrc_events WHERE runtime_id IN (SELECT value FROM json_each(?))', (json.dumps(runtimes),))[0]['n'],
            'brokerEvents': s.rows('SELECT COUNT(*) n FROM broker_invocation_events WHERE runtime_id IN (SELECT value FROM json_each(?))', (json.dumps(runtimes),))[0]['n'],
            'runs': s.rows('SELECT COUNT(*) n FROM runs WHERE runtime_id IN (SELECT value FROM json_each(?))', (json.dumps(runtimes),))[0]['n'],
        }
        session_after = s.rows('SELECT * FROM sessions WHERE scope_ref=?', (scope,))
        handoff_after = s.command('handoff-get', [hrc, 'handoff', 'get', handoff['id'], '--json'])
        result['handoff'] = {'before': handoff, 'after': handoff_after}
        result['sessionIntact'] = session_before == session_after
        pruned_all = (report['stopReason'] == 'complete' and set(runtimes) <= set(report['deletedRuntimeIds'])
                      and not left and result['after']['hrcEvents'] == 0 and result['after']['brokerEvents'] == 0
                      and result['after']['runs'] == 0)
        result['prunedAll'] = pruned_all
        assert pruned_all, json.dumps(result, indent=1, default=str)
        second = s.command('birth-2', start + ['What code word did I ask you to remember? Reply with only the code word. No tools.'])
        s.wait_completed(second['runtime']['runId'])
        time.sleep(2)
        reply = [json.loads(e['payload_json'])['message']['content'] for e in s.rows(
            "SELECT payload_json FROM hrc_events WHERE run_id=? AND event_kind='turn.message'", (second['runtime']['runId'],))]
        compiles = proxy.requests('aspc.compileHarnessInvocation')
        continuation = json.loads(session_before[0]['continuation_json'])
        result.update(reply=reply, recalled=any(word in str(r) for r in reply), continuationKey=continuation.get('key'),
                      compiles=[c['params'] for c in compiles])
        carried = compiles[-1]['params']['compileRequest'].get('continuation', {}).get('hrc', {}).get('key')
        result['continuationCarried'] = carried == continuation.get('key')
        ok = (result['sessionIntact'] and handoff_after['body'] == 'GATE5_HANDOFF_BODY' and handoff_after['state'] == 'pending'
              and result['continuationCarried'] and result['recalled'])
        result['pass'] = ok
        print(json.dumps({'pass': ok, 'recalled': result['recalled'], 'continuationCarried': result['continuationCarried'],
                          'deleted': report['deleted'], 'handoff': handoff_after['state']}))
        if not ok:
            sys.exit(1)
    finally:
        (a.out / 'result.json').write_text(json.dumps(result, indent=1, default=str) + '\n')
        # Stop the reborn seat's lease (hrc-pty, broker, harness) before the owner goes.
        try:
            for r in s.rows("SELECT runtime_id FROM runtimes WHERE status NOT IN ('terminated','dead','stale','crashed','detached')"):
                s.command('teardown-' + r['runtime_id'], [hrc, 'runtime', 'terminate', r['runtime_id'], '--json'], check=False)
        except Exception as e:  # teardown must not hide the result
            print('teardown:', e, file=sys.stderr)
        (a.out / 'steps.json').write_text(json.dumps(s.steps, indent=1) + '\n')
        s.cleanup(prefix)
        proxy.close()


if __name__ == '__main__':
    main()
