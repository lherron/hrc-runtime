#!/usr/bin/env python3
"""Native store ownership and boot migration (T-12840 r3 gate 3, T-12854).

Failure modes: a fresh state directory must need no init step and no Bun; a
second daemon with its own runtime directory and the same state directory
must not migrate (or write) a store a running daemon owns; the scratch verb
must refuse the same store; the lock must go with its owner.

Every directory is scratch under /tmp, including HOME, so no default derived
from HOME can reach live state. PATH carries no bun.
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
import tempfile
import time

PATH = '/usr/bin:/bin:/usr/sbin:/sbin'


def env_for(root, run):
    return {
        'HOME': str(root / 'home'), 'PATH': PATH,
        'HRC_RUNTIME_DIR': str(run), 'HRC_STATE_DIR': str(root / 'state'),
        'HRC_PEER_CONFIG_FILE': str(root / 'absent.json'), 'HRC_ACP_WEBHOOK_URL': '',
        'HRC_WRKQ_DB': str(root / 'wrkq.db'), 'WRKQ_DB': str(root / 'wrkq.db'),
    }


def ids(db):
    c = sqlite3.connect(f'file:{db}?mode=ro', uri=True)
    try:
        return sorted(r[0] for r in c.execute('SELECT id FROM hrc_migrations'))
    finally:
        c.close()


def migrated_rows(db):
    c = sqlite3.connect(f'file:{db}?mode=ro', uri=True)
    try:
        return c.execute("SELECT count(*) FROM hrc_events WHERE event_kind='store.migrated'").fetchone()[0]
    finally:
        c.close()


def lines(text):
    out = []
    for line in text.splitlines():
        try:
            out.append(json.loads(line))
        except ValueError:
            pass
    return out


def start(binary, env, log):
    proc = subprocess.Popen([binary, 'server', 'serve'], env=env, stdout=log, stderr=log)
    sock = Path(env['HRC_RUNTIME_DIR']) / 'hrc.sock'
    for _ in range(400):
        if proc.poll() is not None:
            raise AssertionError(f'daemon exited {proc.returncode}: {Path(log.name).read_text()}')
        if sock.exists():
            return proc
        time.sleep(.05)
    raise AssertionError('no socket: ' + Path(log.name).read_text())


def boot_lines(path):
    """The boot log once it holds `server.listening`.

    `start` returns when the socket file exists, and the daemon logs
    `server.listening` just after binding, so a read straight after `start`
    can miss the line (seen as an IndexError in the push gate, 2026-11-10).
    """
    for _ in range(200):
        boot = lines(path.read_text())
        if any(l.get('event') == 'server.listening' for l in boot):
            return boot
        time.sleep(.05)
    raise AssertionError('no server.listening line: ' + path.read_text())


def stop(proc):
    proc.send_signal(signal.SIGTERM)
    proc.wait(timeout=30)


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--binary', type=Path, required=True)
    p.add_argument('--artifacts', type=Path, required=True)
    args = p.parse_args()
    args.artifacts.mkdir(parents=True, exist_ok=True)
    binary = str(args.binary.resolve())
    assert shutil.which('bun', path=PATH) is None, 'bun must be absent from the daemon PATH'
    results = []
    root = Path(tempfile.mkdtemp(prefix='hrc-store-migration-', dir='/tmp'))
    try:
        for d in ('home', 'state', 'a-run', 'b-run'):
            (root / d).mkdir()
        db = root / 'state/state.sqlite'
        a_env, b_env = env_for(root, root / 'a-run'), env_for(root, root / 'b-run')

        # A fresh, empty state directory: the owner creates the store at boot.
        a_log = (args.artifacts / 'a-serve.log').open('w')
        a = start(binary, a_env, a_log)
        try:
            boot = boot_lines(args.artifacts / 'a-serve.log')
            created = [l for l in boot if l.get('event') == 'store.created']
            assert len(created) == 1, boot
            listening = [l for l in boot if l.get('event') == 'server.listening']
            assert boot.index(created[0]) < boot.index(listening[0]), 'migration precedes binding'
            status = subprocess.run([binary, 'server', 'status', '--json'], env=a_env,
                                    capture_output=True, text=True, timeout=30)
            assert status.returncode == 0, status
            body = json.loads(status.stdout)
            schema = body['schema']
            assert body['running'] is True and schema['readable'] is True, body
            assert schema['pending'] == [] and schema['schemaAhead'] is False, schema
            assert schema['storeVersion'] == schema['releaseVersion'] == '0134_participant_hrc_launched_owner', schema
            store_ids = ids(db)
            assert len(store_ids) == 112
            results.append({'case': 'fresh_state_dir_no_bun', 'pass': True, 'created': created[0],
                            'statusSchema': schema, 'pathHasBun': False})

            # The verb takes no options: `--help` and an unknown flag are usage,
            # never a path (it once created a store named `--help`).
            flagdir = root / 'flags'
            flagdir.mkdir()
            for flag, code in (('--help', 0), ('-h', 0), ('--bogus', 2)):
                out = subprocess.run([binary, 'store', 'migrate', flag], env=a_env, cwd=flagdir,
                                     capture_output=True, text=True, timeout=30)
                assert out.returncode == code and 'usage:' in out.stdout + out.stderr, (flag, out)
            assert list(flagdir.iterdir()) == [], list(flagdir.iterdir())
            results.append({'case': 'verb_flags_are_usage', 'pass': True})

            # A second daemon: its own runtime dir, the same state dir.
            b = subprocess.run([binary, 'server', 'serve'], env=b_env,
                               capture_output=True, text=True, timeout=30)
            exit_line = [l for l in lines(b.stderr) if l.get('event') == 'server.exit']
            assert b.returncode != 0 and exit_line, b
            message = exit_line[0]['data']['error']
            assert message.startswith('store_owned') and f'pid {a.pid}' in message, message
            assert not (root / 'b-run/hrc.sock').exists(), 'second daemon bound no socket'
            assert not any(l.get('event', '').startswith('store.migrat') for l in lines(b.stderr)), b.stderr
            assert ids(db) == store_ids and migrated_rows(db) == 0
            results.append({'case': 'second_daemon_store_owned', 'pass': True,
                            'exit': b.returncode, 'error': message, 'ownerPid': a.pid})

            # The scratch verb refuses the owned store too.
            verb = subprocess.run([binary, 'store', 'migrate', str(db)], env=b_env,
                                  capture_output=True, text=True, timeout=30)
            refusal = json.loads(verb.stderr)
            assert verb.returncode == 1 and refusal['error']['code'] == 'store_owned', verb
            assert f'pid {a.pid}' in refusal['error']['message']
            results.append({'case': 'verb_store_owned', 'pass': True, 'refusal': refusal})
        finally:
            stop(a)
            a_log.close()

        # The lock went with its owner: the verb now admits the current store.
        verb = subprocess.run([binary, 'store', 'migrate', str(db)], env=b_env,
                              capture_output=True, text=True, timeout=30)
        assert verb.returncode == 0 and json.loads(verb.stdout)['outcome'] == 'current', verb
        # A restarted owner on a current store migrates nothing.
        a2_log = (args.artifacts / 'a2-serve.log').open('w')
        a2 = start(binary, a_env, a2_log)
        stop(a2)
        a2_log.close()
        reboot = lines((args.artifacts / 'a2-serve.log').read_text())
        assert not any(l.get('event', '').startswith('store.') for l in reboot), reboot
        assert ids(db) == store_ids and migrated_rows(db) == 0
        results.append({'case': 'lock_released_and_current_reboot', 'pass': True})
    finally:
        (args.artifacts / 'results.json').write_text(json.dumps(results, indent=2))
        shutil.rmtree(root, ignore_errors=True)
    for r in results:
        print('PASS', r['case'])
    print(f'store_migration: {len(results)} cases -> {args.artifacts}/results.json')


if __name__ == '__main__':
    sys.exit(main())
