#!/usr/bin/env python3
"""Projection failure is owner degradation, transport EOF is broker death.

Failure modes: a failed SQLite write crash-marks/revokes a live seat; retry
loses or duplicates the envelope, spins, never reports degradation, or never
recovers; an actual broker exit fails to crash-mark. All processes, sockets
and SQLite writes are private, using kernel_fold's isolated harness substrate.
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import signal
import sqlite3
import subprocess
import tempfile
import time

from kernel_fold import substrate, placement_hint
from hrcpty_substrate import AGENT, PROJECT, REPO, broker_call, ops


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--binary', type=Path, default=REPO / 'crates/target/debug/rusthrc')
    p.add_argument('--artifacts', type=Path, required=True)
    args = p.parse_args()
    args.artifacts.mkdir(parents=True, exist_ok=True)
    root = Path(tempfile.mkdtemp(prefix='h12169-', dir='/tmp'))
    r = aspd = None
    rid = None
    try:
        r, aspd, _ = substrate(root, args.artifacts, args.binary.resolve())
        r.up('projection')
        ref = f'agent:{AGENT}:project:{PROJECT}:task:pty-projection/lane:main'
        code, session = r.http('POST', '/v1/sessions/resolve',
                               {'sessionRef': ref, 'create': True, 'summonIntent': 'explicit_local', 'runtimeIntent': placement_hint(root)})
        assert code == 200, session
        code, born = r.http('POST', '/v1/turns', {'hostSessionId': session['hostSessionId'],
                           'prompt': 'projection probe', 'runtimeIntent': placement_hint(root)})
        assert code in (200, 202), born
        rid = born['runtimeId']
        row = r.runtime(rid)
        broker = row['state']['broker']
        endpoint = broker['endpoint']['socketPath']
        sub = broker['substrate']
        status = ops(Path(sub['socketPath']), Path(sub['socketPath']).parent / 'attach.token', 'status')
        assert status['status']['broker']['state'] == 'running', status
        # Real broker wire first: the fixture's emitted shape is observed before fault injection.
        broker_call(endpoint, 'stub.usage', {'turnId': 'baseline', 'usedTokens': 11, 'windowTokens': 200000})
        r.wait(lambda: r.rows("SELECT 1 FROM hrc_events WHERE runtime_id=? AND event_kind='runtime.context.updated' AND json_extract(payload_json,'$.turnId')='baseline'", (rid,)), what='baseline wire projected')
        credential = root / 'run/lifecycle' / f'{rid}.credential'
        r.wait(credential.exists, what='lifecycle credential')
        credentials = credential.read_bytes()
        assert credentials, 'credential must exist before fault'
        with sqlite3.connect(r.db_path) as db:
            db.execute("CREATE TRIGGER projection_fault BEFORE INSERT ON broker_invocation_events WHEN NEW.type='usage.updated' BEGIN SELECT RAISE(ABORT, 'T-12169 injected projection failure'); END")
        sent = broker_call(endpoint, 'stub.usage', {'turnId': 'recover', 'usedTokens': 22, 'windowTokens': 200000})
        print('fault envelope', sent, flush=True)
        r.wait(lambda: any('T-12169 injected projection failure' in json.dumps(e) for e in r.daemon_log('projection')), 15, 'projection failure logged')
        # Hold past the retry bound to exercise operator-visible degradation.
        time.sleep(10)
        assert not r.events(rid, 'runtime.crashed'), r.events(rid)
        assert r.runtime(rid)['status'] != 'crashed'
        assert credential.read_bytes() == credentials
        assert any(e.get('event') == 'broker.projection.degraded' for e in r.daemon_log('projection'))
        print('PASS projection failure preserves runtime and credential, reports degradation', flush=True)
        with sqlite3.connect(r.db_path) as db:
            db.execute('DROP TRIGGER projection_fault')
        sql = "SELECT * FROM hrc_events WHERE runtime_id=? AND event_kind='runtime.context.updated' AND json_extract(payload_json,'$.turnId')='recover'"
        r.wait(lambda: r.rows(sql, (rid,)), 20, 'failed envelope retried')
        assert len(r.rows(sql, (rid,))) == 1
        r.wait(lambda: any(e.get('event') == 'broker.projection.recovered' for e in r.daemon_log('projection')), 10, 'recovery logged')
        broker_call(endpoint, 'stub.usage', {'turnId': 'after', 'usedTokens': 33, 'windowTokens': 200000})
        r.wait(lambda: r.rows("SELECT 1 FROM broker_invocation_events WHERE json_extract(broker_envelope_json,'$.turnId')='after'"), what='subsequent envelope persisted')
        assert not r.events(rid, 'runtime.crashed')
        assert credential.read_bytes() == credentials
        print('PASS projection recovered exactly once, subsequent events consumed', flush=True)
        os.kill(broker['brokerPid'], signal.SIGKILL)
        r.wait(lambda: r.events(rid, 'runtime.crashed'), 20, 'real broker close crash-marked')
        assert r.runtime(rid)['status'] == 'crashed'
        crashed = r.events(rid, 'runtime.crashed')
        assert crashed[-1]['payload']['reason'] == 'broker_process_closed', crashed
        print('PASS control: real broker close crash-marks', flush=True)
        # A second real hrc-pty lease keeps its broker running while only
        # the event transport closes. The shared supervisor predicate must
        # avert condemnation here, unlike the dead-broker control above.
        ref2 = ref.replace('pty-projection', 'pty-live-close')
        code, session2 = r.http('POST', '/v1/sessions/resolve',
                               {'sessionRef': ref2, 'create': True, 'summonIntent': 'explicit_local',
                                'runtimeIntent': placement_hint(root)})
        assert code == 200, session2
        code, born2 = r.http('POST', '/v1/turns', {'hostSessionId': session2['hostSessionId'],
                            'prompt': 'live close probe', 'runtimeIntent': placement_hint(root)})
        assert code in (200, 202), born2
        live = born2['runtimeId']
        b2 = r.runtime(live)['state']['broker']
        broker_call(b2['endpoint']['socketPath'], 'stub.closeController')
        r.wait(lambda: any(e.get('event') == 'runtime.condemnation_averted'
                          and e.get('data', {}).get('runtimeId') == live
                          for e in r.daemon_log('projection')), 15, 'hrcpty live close averted')
        assert not r.events(live, 'runtime.crashed')
        assert r.runtime(live)['status'] != 'crashed'
        assert (root / 'run/lifecycle' / f'{live}.credential').exists()
        print('PASS hrc-pty running broker averts condemnation on transport-only close', flush=True)
        (args.artifacts / 'result.json').write_text(json.dumps({'pass': True, 'runtimeId': rid, 'events': r.events(rid)}, indent=2) + '\n')
    finally:
        if r:
            if rid:
                try:
                    r.http('POST', '/v1/runtimes/terminate', {'runtimeId': rid}, timeout=10)
                except Exception:
                    pass
            for proc in reversed(r.owners):
                if proc.poll() is None:
                    proc.send_signal(signal.SIGTERM)
                    proc.wait(timeout=30)
            for log in r.logs:
                log.close()
        if aspd:
            aspd.close()
        subprocess.run(['pkill', '-f', str(root) + '/'], check=False)
        shutil.rmtree(root)


if __name__ == '__main__':
    main()
