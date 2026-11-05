#!/usr/bin/env python3
"""T-12587: latest-per-pair latency and mutex isolation on a VACUUM INTO copy.

Failure modes: missing historical pairs/generations; changed payload/order;
full-index GROUP BY; a slow filtered latest read queues page reads behind the
store mutex; a separate WAL reader blocks a writer. Front mode prevents any
owner recovery, reconciliation or runtime births against the copied real DB.
The socket stub satisfies front boot only; every measured HTTP route is native.
Use --baseline for the installed pre-fix binary, then --binary for the subject.
The supplied database must be a scratch VACUUM INTO copy, never the live store.
"""
from foundation import daemon_env
import argparse
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import socket
import shutil
import sqlite3
import subprocess
import tempfile
import threading
import time

from n2_scratch import LEAK_PREFIXES, UnixHTTP

OLD = '''SELECT e.* FROM hrc_events e INNER JOIN
(SELECT MAX(hrc_seq) AS max_hrc_seq FROM hrc_events GROUP BY host_session_id,generation)
latest ON latest.max_hrc_seq=e.hrc_seq ORDER BY e.hrc_seq DESC'''


def drive(binary, database, artifacts, tag):
    with tempfile.TemporaryDirectory(prefix='hrc-latest-') as tmp:
        root = Path(tmp)
        (root / 'run').mkdir()
        (root / 'state').mkdir()
        (root / 'state/state.sqlite').symlink_to(database)
        # Always run an unmanaged scratch copy, including the installed baseline.
        copied_binary = root / 'rusthrc'
        shutil.copy2(binary, copied_binary)
        stub = socket.socket(socket.AF_UNIX)
        stub.bind(str(root / 'backend.sock'))
        stub.listen()
        stub.settimeout(.1)
        stopped = threading.Event()

        def accept():
            while not stopped.is_set():
                try:
                    conn, _ = stub.accept()
                    conn.close()
                except TimeoutError:
                    pass
        thread = threading.Thread(target=accept)
        thread.start()
        env = {k: v for k, v in os.environ.items() if not k.startswith(LEAK_PREFIXES)}
        env.update(HRC_RUNTIME_DIR=str(root / 'run'), HRC_STATE_DIR=str(root / 'state'),
                   HRC_WRKQ_DB=str(root / 'private-wrkq.db'),
                   HRC_PEER_CONFIG_FILE=str(root / 'absent-federation.json'),
                   HRC_LAUNCHD_LABEL='latest.scratch', HRC_ACP_WEBHOOK_URL='')

        def http(path):
            start = time.perf_counter()
            c = UnixHTTP(root / 'run/hrc.sock', 120)
            c.request('GET', path)
            response = c.getresponse()
            body = json.loads(response.read())
            c.close()
            assert response.status == 200, (path, response.status, body)
            return {'ms': (time.perf_counter() - start) * 1000, 'body': body}

        log = (artifacts / f'{tag}-http.log').open('w')
        proc = subprocess.Popen([str(copied_binary), 'server', '--front', '--bun-socket',
                                 str(root / 'backend.sock')], env=daemon_env(env), stdout=log, stderr=log)
        try:
            for _ in range(300):
                assert proc.poll() is None, (artifacts / f'{tag}-http.log').read_text()[-4000:]
                if (root / 'run/hrc.sock').exists():
                    try:
                        http('/v1/events/page?afterSeq=0&limit=1')
                        break
                    except OSError:
                        pass
                time.sleep(.1)
            else:
                raise AssertionError('front did not answer')
            latest = [http('/v1/events/latest-by-session') for _ in range(3)]
            assert latest[0]['body'], 'real-size copy returned no groups'
            assert all(r['body'] == latest[0]['body'] for r in latest)
            result = {'latestMs': [r['ms'] for r in latest], 'groups': len(latest[0]['body'])}
            # Intentionally retain the old filtered grouping shape to hold the
            # reader busy. generation=1 walks the real-size index without stat1.
            with ThreadPoolExecutor(max_workers=2) as pool:
                slow = pool.submit(http, '/v1/events/latest-by-session?generation=1')
                time.sleep(.15)
                assert not slow.done(), 'slow-read control was too fast to test contention'
                page = http('/v1/events/page?afterSeq=0&limit=1')
                # A committed writer transaction while the HTTP reader is busy.
                start = time.perf_counter()
                with sqlite3.connect(database, timeout=5) as db:
                    db.execute('BEGIN IMMEDIATE')
                    db.execute('UPDATE event_stream_cursor SET next_seq=next_seq WHERE id=1')
                    db.commit()
                writer_ms = (time.perf_counter() - start) * 1000
                was_running = not slow.done()
                busy = slow.result()
            result.update(slowLatestMs=busy['ms'], pageDuringSlowMs=page['ms'],
                          writerDuringSlowMs=writer_ms, slowStillRunningAfterPage=was_running)
            (artifacts / f'{tag}-result.json').write_text(json.dumps(result, indent=2))
            return result, latest[0]['body']
        finally:
            proc.terminate()
            proc.wait(timeout=30)
            log.close()
            stopped.set()
            thread.join(timeout=2)
            stub.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary', type=Path, required=True)
    parser.add_argument('--baseline', type=Path, required=True)
    parser.add_argument('--database', type=Path, required=True)
    parser.add_argument('--artifacts', type=Path, required=True)
    args = parser.parse_args()
    db_path = args.database.resolve()
    assert 'scratch' in str(db_path) or str(db_path).startswith('/tmp/'), db_path
    args.artifacts.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(db_path) as db:
        db.execute('PRAGMA journal_mode=WAL')
        assert not db.execute("SELECT 1 FROM sqlite_master WHERE name='sqlite_stat1'").fetchone()
        started = time.perf_counter()
        expected = [r[0] for r in db.execute(OLD)]
        before_sql_ms = (time.perf_counter() - started) * 1000
    before, before_rows = drive(args.baseline.resolve(), db_path, args.artifacts, 'before')
    after, after_rows = drive(args.binary.resolve(), db_path, args.artifacts, 'after')
    for rows in (before_rows, after_rows):
        assert [r['hrcSeq'] for r in rows] == expected
    assert before_rows == after_rows, 'wire rows changed'
    result = {'beforeSqlMs': before_sql_ms, 'before': before, 'after': after, 'identicalWireRows': True}
    (args.artifacts / 'result.json').write_text(json.dumps(result, indent=2))
    assert before['pageDuringSlowMs'] > 1000, before
    assert after['pageDuringSlowMs'] < 100, after
    assert after['writerDuringSlowMs'] < 100, after
    assert after['slowStillRunningAfterPage'], after
    print(json.dumps(result))


if __name__ == '__main__':
    main()
