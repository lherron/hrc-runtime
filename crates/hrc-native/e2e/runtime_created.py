#!/usr/bin/env python3
"""Real owner birth: durable wake and keyed starting row before broker reply.
Failure cases: no promptless creation wake; event delayed to ready; missing
starting presentation; replay changes identity/sequence; startup never completes.
Uses kernel_fold's isolated owner and a scratch-only held broker copy.
"""
import argparse
import json
import shutil
import signal
import subprocess
import tempfile
import threading
from pathlib import Path
from urllib.parse import urlencode
from kernel_fold import substrate, wire
from hrcpty_substrate import AGENT, PROJECT
from n2_scratch import UnixHTTP


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--binary', type=Path, required=True)
    p.add_argument('--artifacts', type=Path, required=True)
    args = p.parse_args()
    out = args.artifacts.resolve()
    out.mkdir(parents=True, exist_ok=True)
    root = Path(tempfile.mkdtemp(prefix='rc-', dir='/tmp'))
    r, aspd, _ = substrate(root, out, args.binary.resolve())
    stub = root / 'release/bin/stub-broker'
    source = stub.read_text()
    marker, release = root / 'start-held', root / 'start-release'
    # Only this disposable copied broker holds invocation.start. No product flag.
    source = source.replace("        start = params['startRequest']", "        Path(" + repr(str(marker)) + ").write_text('held')\n        while not Path(" + repr(str(release)) + ").exists():\n            time.sleep(.01)\n        start = params['startRequest']", 1)
    stub.write_text(source)
    failure = None
    stream = None
    result = {}
    birth = None
    try:
        r.up('creation')
        _, page = r.http('GET', '/v1/events/page?afterSeq=0&limit=1')
        head = r.rows('SELECT coalesce(max(hrc_seq),0) AS h FROM hrc_events')[0]['h']
        query = urlencode(dict(follow='true', ledgerIncarnationId=page['ledgerIncarnationId'], afterSeq=head, eventKind='runtime.created'))
        stream = UnixHTTP(r.socket, 10)
        stream.request('GET', '/v1/events/bounded-stream?' + query)
        response = stream.getresponse()
        ready = json.loads(response.readline())
        assert ready['type'] == 'ready', ready
        result['ready'] = ready
        ref = f'agent:{AGENT}:project:{PROJECT}:task:pty-created/lane:main'
        def summon():
            result['summon'] = wire(root / 'run/hrc-kernel.sock', 'seat.summon', dict(session_ref=ref, request_id='runtime-created'))
        birth = threading.Thread(target=summon, daemon=True)
        birth.start()
        r.wait(marker.exists, 20, 'broker invocation.start held')
        rows = r.rows('SELECT * FROM runtimes')
        assert len(rows) == 1, rows
        rid = rows[0]['runtime_id']
        r.check('starting-before-broker-reply', rows[0]['status'] == 'starting' and birth.is_alive(), runtime=rid)
        events = r.events(rid, 'runtime.created')
        r.check('creation-durable-before-broker-reply', len(events) == 1, events=events)
        # A missing event is the pre-fix discriminator; avoid waiting for keepalive.
        assert len(events) == 1, 'missing runtime.created while invocation.start held'
        record = json.loads(response.readline())
        r.check('already-open-stream-wakes', record.get('type') == 'event' and record['event']['runtimeId'] == rid, record=record)
        result['streamEvent'] = record
        status, presentation = r.http('POST', '/v1/presentation/seats/read', {'sessionRefs':[ref], 'runtimeIds':[rid]})
        result['startingPresentation'] = presentation
        selected = [row for row in presentation.get('runtimes', []) if row['runtimeId'] == rid]
        owner = rows[0]
        r.check('keyed-starting-presentation', status == 200 and len(selected) == 1
                and all(selected[0].get(k) == owner[col] for k, col in
                        [('runtimeId','runtime_id'),('hostSessionId','host_session_id'),
                         ('generation','generation'),('status','status')])
                and any(row['hostSessionId'] == owner['host_session_id']
                        and row['generation'] == owner['generation']
                        for row in presentation.get('sessions', [])), presentation=presentation)
        r.check('no-presentation-event-before-start-reply', not r.events(rid, 'runtime.presentation'))
        _, replay = r.http('GET', '/v1/events/page?' + urlencode(dict(afterSeq=head, limit=500)))
        found = [e for e in replay['rows'] if e['eventKind'] == 'runtime.created' and e['runtimeId'] == rid]
        r.check('replay-same-durable-sequence', len(found) == 1 and found[0]['hrcSeq'] == record['event']['hrcSeq'], rows=found)
        reconnect = UnixHTTP(r.socket, 10)
        try:
            reconnect.request('GET', '/v1/events/bounded-stream?' + query)
            replay_response = reconnect.getresponse()
            replay_records = [json.loads(replay_response.readline()) for _ in range(2)]
            replay_events = [v['event'] for v in replay_records if v['type'] == 'event']
            r.check('reconnected-stream-replays-same-event', replay_events == [record['event']], records=replay_records)
        finally:
            reconnect.close()
        release.touch()
        birth.join(timeout=30)
        r.check('startup-completes', not birth.is_alive() and result.get('summon', {}).get('ok'), result=result.get('summon'))
        r.check('no-second-creation-after-ready', len(r.events(rid, 'runtime.created')) == 1)
    except Exception as error:
        failure = repr(error)
        r.check('exception', False, error=failure)
    finally:
        release.touch()
        if birth:
            birth.join(timeout=30)
        if stream:
            stream.close()
        for row in r.rows('SELECT runtime_id FROM runtimes'):
            try:
                r.http('POST', '/v1/runtimes/terminate', {'runtimeId':row['runtime_id']})
            except Exception:
                pass
        for proc in reversed(r.owners):
            if proc.poll() is None:
                proc.send_signal(signal.SIGTERM)
                try:
                    proc.wait(timeout=30)
                except subprocess.TimeoutExpired:
                    proc.kill()
        subprocess.run(['pkill','-f',str(root)+'/'], check=False)
        aspd.close()
        for log in r.logs:
            log.close()
        passed = bool(r.checks) and all(c['pass'] for c in r.checks)
        (out/'summary.json').write_text(json.dumps(dict(passed=passed, failure=failure, checks=r.checks, result=result), indent=2)+'\n')
        shutil.rmtree(root, ignore_errors=True)
    raise SystemExit(0 if passed else 1)


if __name__ == '__main__':
    main()
