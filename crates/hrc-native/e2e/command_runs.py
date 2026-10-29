#!/usr/bin/env python3
"""Configured command HTTP regression, on private native state.

Failure modes: untrusted argv/env accepted; unknown target mints state; duplicate
requests execute twice; env/stdin/cwd lost; spawn/nonzero exits leave running rows;
stderr backpressure wedges the process; terminal events or runtime cleanup lost.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import time
from foundation import UnixHTTP


def main():
    p = argparse.ArgumentParser()
    for k in ('binary', 'scratch-root', 'artifacts'):
        p.add_argument('--' + k, type=Path, required=True)
    a = p.parse_args()
    root = a.scratch_root.resolve()
    root.mkdir(parents=True, exist_ok=False)
    a.artifacts.mkdir(parents=True, exist_ok=True)
    state, run = root / 'state', root / 'run'
    state.mkdir(); run.mkdir()
    repo = Path(__file__).resolve().parents[3]
    dbpath = state / 'state.sqlite'
    subprocess.run(['bun', '-e', 'import {openHrcDatabase} from "./packages/hrc-store-sqlite/src/database.ts"; openHrcDatabase(process.argv[1]).close()', str(dbpath)], cwd=repo, check=True, capture_output=True)
    script = root / 'job.py'
    script.write_text('import json,os,sys\nfrom pathlib import Path\np=Path("calls")\np.write_text(p.read_text()+"x" if p.exists() else "x")\nPath("observed.json").write_text(json.dumps({"stdin":json.load(sys.stdin),"binding":os.environ["WRKF_TASK_ID"],"env":os.environ["CONFIG_ENV"],"unset":os.environ.get("REMOVE_ME"),"path":os.environ["PATH"]}))\nsys.stderr.write("z"*100000)\n')
    config = root / 'targets.json'
    config.write_text(json.dumps({
        'ok': {'argv': [sys.executable, str(script)], 'cwd': str(root), 'env': {'CONFIG_ENV': 'set'}, 'unsetEnv': ['REMOVE_ME'], 'pathPrepend': ['/test/bin']},
        'fail': {'argv': ['/bin/sh', '-c', 'echo failed >&2; exit 7']},
        'missing': {'argv': ['/nonexistent/t12060']},
    }))
    env = {k: v for k, v in os.environ.items() if not k.startswith(('HRC_', 'WRKQ_', 'ACP_'))}
    env.update(HRC_STATE_DIR=str(state), HRC_RUNTIME_DIR=str(run), HRC_COMMAND_RUN_TARGETS_FILE=str(config), REMOVE_ME='gone')
    log = (a.artifacts / 'server.log').open('w')
    proc = subprocess.Popen([str(a.binary.resolve()), 'server'], env=env, stdout=log, stderr=log)
    observations = []

    def http(body):
        h = UnixHTTP(run / 'hrc.sock')
        h.request('POST', '/v1/command-runs/launch', json.dumps(body), {'Content-Type': 'application/json'})
        r = h.getresponse(); raw = r.read(); h.close()
        try: value = json.loads(raw)
        except ValueError: value = raw.decode()
        observations.append({'request': body, 'status': r.status, 'body': value})
        return r.status, value

    binding = {k: 'test' for k in ('WRKF_TASK_ID', 'WRKF_ACTION_RUN_ID', 'WRKF_RUN_ID', 'WRKF_ACTION', 'WRKF_ROLE', 'ASP_PROJECT', 'HRC_SESSION_REF', 'HRC_LANE')}
    body = dict(configuredTargetId='ok', sessionRef='agent:tabularasa/project:hrc-runtime/task:command-test/lane:main', idempotencyKey='command-test', binding=binding, stdinJson={'hello': 'world'})
    try:
        for _ in range(150):
            if (run / 'hrc.sock').exists(): break
            assert proc.poll() is None, 'daemon exited'
            time.sleep(.1)
        for field in ('argv', 'env', 'cwd', 'command'):
            assert http(dict(body, **{field: None}))[0] == 400
        assert http(dict(body, sessionRef='bad'))[0] == 400
        assert http(dict(body, configuredTargetId='unknown'))[0] == 404
        with sqlite3.connect(dbpath) as db:
            assert db.execute('SELECT COUNT(*) FROM sessions').fetchone()[0] == 0
        with ThreadPoolExecutor(2) as pool:
            responses = list(pool.map(http, [body, body]))
        assert all(s == 200 for s, _ in responses), responses
        first, replay = sorted((r for _, r in responses), key=lambda r: r['replayed'])
        assert first['replayed'] is False and replay == dict(first, replayed=True)
        assert first['runId'] == 'run-' + hashlib.sha256(b'command-test').hexdigest()[:32]
        for target in ('fail', 'missing'):
            assert http(dict(body, configuredTargetId=target, idempotencyKey=target))[0] == 200
        for _ in range(200):
            with sqlite3.connect(dbpath) as db:
                db.row_factory = sqlite3.Row
                rows = [dict(r) for r in db.execute('SELECT run_id,status,error_message FROM runs ORDER BY run_id')]
            if len(rows) == 3 and all(r['status'] in ('completed', 'failed') for r in rows): break
            time.sleep(.05)
        assert sorted(r['status'] for r in rows) == ['completed', 'failed', 'failed'], rows
        assert (root / 'calls').read_text() == 'x'
        observed = json.loads((root / 'observed.json').read_text())
        assert observed == dict(stdin={'hello': 'world'}, binding='test', env='set', unset=None, path='/test/bin:' + env['PATH']), observed
        with sqlite3.connect(dbpath) as db:
            assert db.execute("SELECT COUNT(*) FROM runtimes WHERE status='terminated' AND active_run_id IS NULL").fetchone()[0] == 3
            assert db.execute("SELECT COUNT(*) FROM hrc_events WHERE event_kind='command_run.started'").fetchone()[0] == 3
            assert db.execute("SELECT COUNT(*) FROM hrc_events WHERE event_kind='command_run.exited'").fetchone()[0] == 3
        assert http(body)[1] == replay
        (a.artifacts / 'result.json').write_text(json.dumps(dict(passed=True, runs=rows, observed=observed), indent=2))
    finally:
        (a.artifacts / 'http.json').write_text(json.dumps(observations, indent=2))
        proc.terminate(); proc.wait(timeout=20); log.close()


if __name__ == '__main__':
    main()
