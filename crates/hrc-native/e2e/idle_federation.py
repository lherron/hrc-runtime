#!/usr/bin/env python3
"""Idle history fixture daemon, with a counting authority transport.

Failure modes: no startup checkpoint, quiet checkpoint spam, missing message
wake, failed deliveries never retried, missing 300 s catch-up safety renewal.
The authority speaks the existing history checkpoint/replication contracts;
all node state and subprocesses stay under --scratch-root, never installed.
"""
import argparse
from collections import Counter
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import socket
import sqlite3
import threading
import time

from n4_federation import Node, local_tailnet_address


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--binary', type=Path, required=True)
    p.add_argument('--installed-release', type=Path, required=True)
    p.add_argument('--aspd-socket', type=Path, required=True)
    p.add_argument('--scratch-root', type=Path, required=True)
    p.add_argument('--artifacts', type=Path, required=True)
    p.add_argument('--baseline', action='store_true')
    p.add_argument('--quiet-seconds', type=float, default=6)
    p.add_argument('--unbound-runtimes', type=int, default=0)
    p.add_argument('--sql-telemetry', action='store_true')
    p.add_argument('--messages', type=int, default=1)
    a = p.parse_args()
    a.artifacts.mkdir(parents=True, exist_ok=True)
    counts = Counter()
    checkpoints = []
    class Authority(BaseHTTPRequestHandler):
        protocol_version = 'HTTP/1.1'
        def setup(self):
            super().setup()
            self.connection.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        def log_message(self, *_):
            pass
        def reply(self, v):
            raw = json.dumps(v).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)
        def do_POST(self):
            counts[self.path] += 1
            body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            if self.path.endswith('/checkpoint'):
                checkpoints.append(body['checkpoint'])
            if self.path.endswith('/replicate') and counts[self.path] == 1 and not a.baseline:
                self.reply({'ack': {'outcome': 'retry'}})
                return
            self.reply({'ack': {'outcome': 'accepted', 'nodeId': 'idle-fixture',
                                'messageId': body.get('record', {}).get('messageId')}})
    host = local_tailnet_address()
    authority = ThreadingHTTPServer((host, 0), Authority)
    threading.Thread(target=authority.serve_forever, daemon=True).start()
    node = Node(a.scratch_root, a.installed_release, a.aspd_socket, a.artifacts, 'idle')
    node.write_config({'nodeId': 'idle-fixture', 'peers': {'svc': {
        'endpoint': f'http://{host}:{authority.server_port}', 'token': 'private-fixture-token'}},
        'gate': {'mode': 'off'}})
    if a.unbound_runtimes:
        with sqlite3.connect(node.db) as db:
            db.execute("INSERT INTO sessions(host_session_id,scope_ref,lane_ref,generation,status,created_at,updated_at) VALUES('hs-idle','server:hrc','main',1,'active','now','now')")
            db.executemany("INSERT INTO runtimes(runtime_id,host_session_id,scope_ref,lane_ref,generation,transport,status,status_changed_at,supports_inflight_input,controller_kind,runtime_state_json,created_at,updated_at) VALUES(?,'hs-idle','server:hrc','main',1,'headless','terminated','2026-01-01T00:00:00Z',0,'harness-broker','{}','2026-01-01T00:00:00Z','now')", [(f'idle-{i}',) for i in range(a.unbound_runtimes)])
    if a.sql_telemetry:
        node.env['HRC_SQLITE_SLOW_STATEMENT_MS'] = '0'
    def sql_counts():
        out = Counter(historyTail=0, policyDiscovery=0, credentialReconcile=0)
        path = a.artifacts / 'idle-native-idle.log'
        for line in path.read_text().splitlines():
            try:
                entry = json.loads(line)
            except ValueError:
                continue
            if entry.get('event') != 'sqlite.slow_statement':
                continue
            sql = entry['data']['sql']
            if 'FROM messages' in sql and 'message_seq>' in sql:
                out['historyTail'] += 1
            if 'FROM continuities WHERE agent_id IS NOT NULL' in sql:
                out['policyDiscovery'] += 1
            if sql.startswith('SELECT runtime_id,scope_ref,generation,status FROM runtimes WHERE status IN'):
                out['credentialReconcile'] += 1
        return out
    def maintenance_wakes():
        # The existing seat-retirement producer notifies the shared ledger
        # even when its pass retires zero rows. Its 300 s cadence is outside
        # this task; followers must still honor that push notification.
        total = 0
        for line in (a.artifacts / 'idle-native-idle.log').read_text().splitlines():
            try:
                total += json.loads(line).get('event') == 'runtime.seat_retirement_complete'
            except ValueError:
                pass
        return total
    result = {}
    def wait_for(key, previous):
        end = time.monotonic() + 60
        while time.monotonic() < end:
            if counts[key] > previous:
                return
            time.sleep(.05)
        raise AssertionError((key, dict(counts), previous))
    proc = None
    try:
        proc = node.up('native', a.binary, 'idle')
        checkpoint = '/v1/federation/history/checkpoint'
        wait_for(checkpoint, 0)
        time.sleep(.3)
        before = counts.copy()
        sql_before = sql_counts() if a.sql_telemetry else Counter()
        wakes_before = maintenance_wakes()
        time.sleep(a.quiet_seconds)
        result['quietSeconds'] = a.quiet_seconds
        result['quietRequests'] = dict(counts - before)
        result['startup'] = dict(before)
        if a.sql_telemetry:
            sql_after = sql_counts()
            result['quietSql'] = {k: sql_after[k] - sql_before[k] for k in sql_before}
            result['startupSql'] = dict(sql_before)
            assert all(n > 0 for n in sql_before.values()), ('missing startup discriminator', sql_before)
            if not a.baseline:
                renewals = int(a.quiet_seconds // 300)
                wakes = maintenance_wakes() - wakes_before
                result['backgroundMaintenanceWakes'] = wakes
                measured = result['quietSql']
                assert measured['policyDiscovery'] == wakes, result
                assert measured['credentialReconcile'] == renewals, result
                # Timer and push may coalesce into one drain if simultaneous.
                assert max(renewals, wakes) <= measured['historyTail'] <= renewals + wakes, result
        if not a.baseline:
            quiet_checkpoints = counts[checkpoint] - before[checkpoint]
            assert quiet_checkpoints == int(a.quiet_seconds // 300), result
            result['safetyRenewals'] = quiet_checkpoints
            previous = counts[checkpoint]
            # Exercise existing native message observation through an explicit
            # query after the fixture writes (request commits also wake ledger).
            with sqlite3.connect(node.db) as db:
                db.executemany("INSERT INTO messages(message_id,kind,phase,from_kind,from_ref,to_kind,to_ref,root_message_id,body,body_format,execution_state,created_at) VALUES(?,'system','oneway','entity','system','entity','human',?,'fixture','text/plain','completed','2026-11-04T00:00:00Z')", [(f'idle-message-{i}', f'idle-message-{i}') for i in range(a.messages)])
            node.http('POST', '/v1/fixture-ledger-wake', {})
            wait_for('/v1/federation/history/replicate', a.messages)
            wait_for(checkpoint, previous + 1 + (a.messages - 1) // 100)
            transitions = [c['pendingReplicationCount'] for c in checkpoints[previous:]]
            assert transitions[0] == a.messages and transitions[-1] == 0, transitions
            result['pendingTransitions'] = transitions
            result['changedMessageReplications'] = counts['/v1/federation/history/replicate']
        logs = [json.loads(line) for line in (a.artifacts / 'idle-native-idle.log').read_text().splitlines() if line.startswith('{')]
        result['retainedPasses'] = [v['data'] for v in logs if v.get('event') == 'retained_evidence.pass_complete']
        if not a.baseline and a.unbound_runtimes and a.quiet_seconds >= 305:
            assert len(result['retainedPasses']) == 1, result['retainedPasses']
        result['pass'] = True
    finally:
        for child in node.procs:
            if child.poll() is None:
                node.down(child)
        for log in node.logs:
            log.close()
        authority.shutdown()
        (a.artifacts / 'result.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result))


if __name__ == '__main__':
    main()
