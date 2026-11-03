#!/usr/bin/env python3
"""Embedded kernel read failures and recovery on a private real-schema ledger.

Failure modes: malformed activity kills rusthrc; ingest hides an error; recovery
loses the prior projection; moved wire probe no longer works. Only scratch state
is mutated. No installed release or live service is changed.
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import signal
import sqlite3
import subprocess
import sys

from kernel_fold import substrate, wire, rows, placement_hint, REPO, HERE, AGENT, PROJECT


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--binary', type=Path, default=REPO / 'crates/target/debug/rusthrc')
    p.add_argument('--root', type=Path, default=Path(f'/tmp/hkp-{os.getpid()}'))
    p.add_argument('--artifacts', type=Path, required=True)
    a = p.parse_args()
    root = a.root.absolute()
    root.mkdir()  # Refuse a reused or live root.
    a.artifacts.mkdir(parents=True, exist_ok=True)
    r, aspd, clean = substrate(root, a.artifacts, a.binary.resolve())
    kernel = root / 'run/hrc-kernel.sock'
    failure = None
    try:
        daemon = r.up('healthy')
        ref = f'agent:{AGENT}:project:{PROJECT}:task:audit/lane:main'
        code, created = r.http('POST', '/v1/sessions/resolve',
                               {'sessionRef': ref, 'create': True, 'summonIntent': 'explicit_local',
                                'runtimeIntent': placement_hint(root)})
        assert code == 200, created
        prior = r.wait(lambda: next((s for s in rows(kernel, 'hrc.seat')
                                     if s['payload']['sessionRef'] == ref), None), 30, 'initial seat')
        r.check('healthy-seat', bool(prior))
        r.check('stop-before-ledger-mutation', r.down(daemon) == 0)
        with sqlite3.connect(r.db_path) as db:
            db.execute("UPDATE sessions SET updated_at='+262142-12-31' WHERE scope_ref=?",
                       (ref.split('/lane:')[0],))
            db.execute("UPDATE hrc_events SET ts='+262142-12-31' WHERE scope_ref=?",
                       (ref.split('/lane:')[0],))
        daemon = r.up('bad-activity')

        def binding():
            reply = wire(kernel, 'ingest.status', {'document_id': 'hrc'})
            assert reply['ok'], reply
            return reply['result']['bindings'][0]

        errored = r.wait(lambda: (b if (b := binding()).get('last_error') else None), 30, 'ingest error')
        (a.artifacts / 'ingest-error.json').write_text(json.dumps(errored, indent=2) + '\n')
        r.check('expiry-error-visible', 'expiry is out of range' in json.dumps(errored), binding=errored)
        r.check('daemon-survived-bad-row', daemon.poll() is None and r.http('GET', '/v1/status')[0] == 200)
        with sqlite3.connect(r.db_path) as db:
            db.execute('UPDATE sessions SET updated_at=created_at WHERE scope_ref=?',
                       (ref.split('/lane:')[0],))
            db.execute("UPDATE hrc_events SET ts=(SELECT created_at FROM sessions WHERE scope_ref=? LIMIT 1) WHERE scope_ref=?",
                       (ref.split('/lane:')[0], ref.split('/lane:')[0]))
        recovered = r.wait(lambda: (b if (b := binding()).get('caught_up') and not b.get('last_error') else None),
                           35, 'ingest recovery')
        current = r.wait(lambda: next((s for s in rows(kernel, 'hrc.seat')
                                       if s['payload']['sessionRef'] == ref), None), 10, 'recovered seat')
        r.check('recovered-stable-seat', current['id'] == prior['id'], binding=recovered)
        probe = subprocess.run([sys.executable, str(HERE / 'live_probe.py'), '--socket', str(kernel),
                                '--artifacts', str(a.artifacts / 'wire-probe')], env=clean,
                               capture_output=True, text=True, timeout=60)
        (a.artifacts / 'wire-probe.log').write_text(probe.stdout + probe.stderr)
        r.check('moved-wire-probe', probe.returncode == 0, output=probe.stdout, error=probe.stderr)
    except BaseException as error:
        failure = repr(error)
    finally:
        for proc in r.owners:
            if proc.poll() is None:
                proc.send_signal(signal.SIGTERM)
                try:
                    proc.wait(timeout=30)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait(timeout=5)
        subprocess.run(['pkill', '-f', str(root) + '/'], check=False)
        aspd.close()
        for log in r.logs:
            log.close()
        report = {'pass': failure is None and all(c['pass'] for c in r.checks),
                  'failure': failure, 'checks': r.checks}
        (a.artifacts / 'summary.json').write_text(json.dumps(report, indent=2) + '\n')
        shutil.rmtree(root)
    print(json.dumps(report))
    return 0 if report['pass'] else 1


if __name__ == '__main__':
    sys.exit(main())
