#!/usr/bin/env python3
"""Workflow checks against a Bun-created scratch store, never production state.

Failure modes: missing/extra migration must not write; an existing owner must
not lose its socket; native session creation must survive a Bun store read;
unknown routes must retain Bun's 404; shutdown must leave durable rows intact.
"""
import argparse
import http.client
import json
import os
from pathlib import Path
import socket
import sqlite3
import subprocess
import tempfile
import time


class UnixHTTP(http.client.HTTPConnection):
    def __init__(self, path):
        super().__init__('localhost', timeout=10)
        self.path = path

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX)
        self.sock.settimeout(self.timeout)
        self.sock.connect(str(self.path))


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--binary', type=Path, required=True)
    p.add_argument('--schema-db', type=Path)
    p.add_argument('--artifacts', type=Path, required=True)
    args = p.parse_args()
    args.artifacts.mkdir(parents=True, exist_ok=True)
    binary = args.binary.resolve()
    results = []
    with tempfile.TemporaryDirectory(prefix='hrcn1-') as tmp:
        root = Path(tmp)
        schema_db = args.schema_db
        if schema_db is None:
            schema_db = root / 'source.sqlite'
            # Bun owns even scratch schema creation. No daemon is started here.
            repo = Path(__file__).resolve().parents[3]
            subprocess.run(['bun', '-e',
                'import {openHrcDatabase} from "./packages/hrc-store-sqlite/src/database.ts"; openHrcDatabase(process.argv[1]).close()',
                str(schema_db)], cwd=repo, check=True, capture_output=True)
        source = sqlite3.connect(f'file:{schema_db.resolve()}?mode=ro', uri=True)
        for variant in ('extra', 'missing', 'current'):
            subject = root / variant
            (subject / 'state').mkdir(parents=True)
            (subject / 'run').mkdir()
            db = subject / 'state/state.sqlite'
            with sqlite3.connect(db) as c:
                source.backup(c)
                if variant == 'extra':
                    c.execute("INSERT INTO hrc_migrations VALUES ('9999_unknown', 'now')")
                if variant == 'missing':
                    c.execute('DELETE FROM hrc_migrations WHERE id=(SELECT MIN(id) FROM hrc_migrations)')
            env = dict(os.environ, HRC_RUNTIME_DIR=str(subject / 'run'), HRC_STATE_DIR=str(subject / 'state'))
            env.pop('HRC_PEER_CONFIG_FILE', None)
            if variant != 'current':
                before = (db.stat().st_mtime_ns, db.read_bytes())
                proc = subprocess.run([binary, 'server'], env=env, capture_output=True, timeout=10)
                assert proc.returncode != 0, (variant, proc.stdout, proc.stderr)
                assert 'schema' in proc.stderr.decode().lower(), proc.stderr
                assert before == (db.stat().st_mtime_ns, db.read_bytes()), variant
                results.append({'case': variant, 'exit': proc.returncode, 'stderr': proc.stderr.decode(), 'noWrites': True})
                continue
            log = (args.artifacts / 'serve.log').open('w')
            proc = subprocess.Popen([binary, 'server'], env=env, stdout=log, stderr=log)
            sock = subject / 'run/hrc.sock'
            def request(method, path, body=None):
                c = UnixHTTP(sock)
                c.request(method, path, json.dumps(body) if body is not None else None,
                          {'Content-Type': 'application/json'})
                r = c.getresponse()
                raw = r.read().decode()
                c.close()
                return r.status, raw
            try:
                for _ in range(100):
                    if proc.poll() is not None:
                        raise AssertionError('daemon exited: ' + (args.artifacts / 'serve.log').read_text())
                    if sock.exists():
                        break
                    time.sleep(.05)
                assert request('GET', '/v1/health') == (200, '{"ok":true}')
                status, raw = request('POST', '/v1/turns', {})
                assert status == 400 and json.loads(raw) == {'error': {'code': 'malformed_request', 'message': 'hostSessionId is required', 'detail': {'field': 'hostSessionId'}}}
                assert request('GET', '/v1/nonexistent') == (404, 'Not Found')
                status, raw = request('POST', '/v1/sessions/resolve', {})
                assert status == 400 and json.loads(raw) == {'error': {'code': 'malformed_request', 'message': 'sessionRef is required', 'detail': {'field': 'sessionRef'}}}
                ref = 'agent:tabularasa:project:hrc-runtime:task:native-foundation/lane:main'
                status, raw = request('POST', '/v1/sessions/resolve', {'sessionRef': ref, 'create': True, 'summonIntent': 'explicit_local'})
                created = json.loads(raw)
                assert status == 200 and created['created'] is True, (status, created)
                host = created['hostSessionId']
                assert created['identity'] == {'kind': 'project-task', 'agentId': 'tabularasa', 'projectId': 'hrc-runtime', 'taskId': 'native-foundation'}
                status, raw = request('POST', '/v1/sessions/resolve', {'sessionRef': ref, 'create': True, 'summonIntent': 'explicit_local'})
                assert status == 200 and json.loads(raw)['created'] is False and json.loads(raw)['hostSessionId'] == host
                status, raw = request('GET', '/v1/sessions?scopeRef=' + ref.split('/')[0])
                assert status == 200 and len(json.loads(raw)) == 1
                status, raw = request('GET', '/v1/sessions/by-host/' + host)
                assert status == 200 and json.loads(raw)['hostSessionId'] == host
                rival = subprocess.run([binary, 'server'], env=env, capture_output=True, timeout=10)
                assert rival.returncode != 0
                assert request('GET', '/v1/health') == (200, '{"ok":true}')
                with sqlite3.connect(db) as c:
                    assert c.execute('SELECT active_host_session_id FROM continuities WHERE scope_ref=?', (ref.split('/')[0],)).fetchone()[0] == host
                    assert c.execute("SELECT COUNT(*) FROM hrc_events WHERE host_session_id=? AND event_kind='session.created'", (host,)).fetchone()[0] == 1
                results.append({'case': 'session-lifecycle', 'hostSessionId': host, 'created': created, 'rivalExit': rival.returncode})
            finally:
                proc.terminate()
                proc.wait(timeout=10)
                log.close()
            assert not sock.exists()
            assert (subject / 'state/state.sqlite').exists()
            results.append({'case': 'shutdown', 'exit': proc.returncode})
    (args.artifacts / 'results.json').write_text(json.dumps(results, indent=2) + '\n')
    print(json.dumps({'pass': len(results), 'results': str(args.artifacts / 'results.json')}))


if __name__ == '__main__':
    main()
