#!/usr/bin/env python3
"""T-12151: real hrcpty birth and startup retention on a private native owner.

Failure modes: a scratch owner writes production logs; broad permissions;
IPC default leaks through; pruning follows links or deletes a quiet live log;
startup fails to run retention. Uses live aspd and a real Claude broker, with
private state/wrkqd. The installed release is copied only to supply the CLI
and schema; the tested native binaries come from --binary's directory.
"""
import argparse
import json
import os
from pathlib import Path
import signal
import stat
import subprocess
import time
import uuid

from n3_scratch import Scratch

PROJECT = 'logs-t12151'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for key in ('binary', 'installed-release', 'aspd-socket', 'scratch-root', 'artifacts'):
        parser.add_argument('--' + key, type=Path, required=True)
    args = parser.parse_args()
    live = Path.home() / 'praesidium/var/logs/hrc-runtime/hrcpty'
    snapshot = lambda: sorted(p.name for p in live.iterdir()) if live.exists() else []
    before = snapshot()
    s = Scratch(args.scratch_root, args.installed_release, args.aspd_socket,
                args.binary, args.artifacts, project_id=PROJECT)
    scope = f'agent:tabularasa:project:{PROJECT}:task:logs'
    result = {'realLogBefore': before, 'realLogCountBefore': len(before)}
    rt = None
    passed = False
    try:
        s.init_substrate()
        daemon = s.up('native', 'birth')
        status, declared = s.http('POST', '/v1/declarations/resolve', {
            'scopeRef': scope, 'runMode': 'task', 'interactive': True, 'preferredMode': 'headless'})
        result['declaration'] = [status, declared]
        assert status == 200, declared
        intent = declared['intent']
        intent['harness'] = {'id': 'claude-hrcpty', 'interactive': True}
        intent['selection'] = {'harness': 'claude-hrcpty', 'presentation': True}
        intent.pop('summonDirectives', None)
        status, session = s.http('POST', '/v1/sessions/resolve', {
            'sessionRef': scope + '/lane:main', 'runtimeIntent': intent,
            'create': True, 'summonIntent': 'explicit_local'})
        assert status == 200, session
        status, birth = s.http('POST', '/v1/turns', {
            'hostSessionId': session['hostSessionId'], 'runtimeIntent': intent,
            'prompt': 'Reply with exactly the word OK and nothing else. No tools.'})
        result['birth'] = [status, birth]
        assert status in (200, 202), birth
        rt = birth['runtimeId']
        s.wait_completed(birth['runId'])
        s.wait(lambda: s.rows("SELECT 1 FROM runtimes WHERE runtime_id=? AND status='ready'", (rt,)))
        status, inspected = s.http('POST', '/v1/runtimes/inspect', {'runtimeId': rt})
        result['inspect'] = [status, inspected]
        row = s.rows('SELECT * FROM runtimes WHERE runtime_id=?', (rt,))[0]
        state = json.loads(row['runtime_state_json'])
        substrate = state['broker']['substrate']
        assert row['transport'] == 'hrcpty' and substrate['kind'] == 'leased-hrcpty', row
        log_dir = s.root / 'run/logs/hrcpty'
        log = log_dir / (rt + '.log')
        bipc = Path(substrate['socketPath']).parent
        assert bipc.is_relative_to(s.root / 'run/bipc'), bipc
        result['location'] = {'log': str(log), 'mode': oct(stat.S_IMODE(log.stat().st_mode)),
                              'dirMode': oct(stat.S_IMODE(log_dir.stat().st_mode)),
                              'bipcFiles': sorted(p.name for p in bipc.iterdir())}
        assert stat.S_IMODE(log.stat().st_mode) == 0o600
        assert stat.S_IMODE(log_dir.stat().st_mode) == 0o700
        assert not (bipc / 'hrcpty.log').exists()
        # Retention: the actual live supervisor survives this scratch owner stop.
        assert s.down(daemon) == 0
        dead = log_dir / f'rt-{uuid.uuid4()}.log'
        fresh = log_dir / f'rt-{uuid.uuid4()}.log'
        link = log_dir / f'rt-{uuid.uuid4()}.log'
        target = s.root / 'symlink-target'
        ignored = log_dir / 'unrelated.log'
        nested = log_dir / 'nested'
        nested.mkdir()
        nested_log = nested / f'rt-{uuid.uuid4()}.log'
        for path in (dead, fresh, target, ignored, nested_log):
            path.write_text('retain diagnostic evidence\n')
        link.symlink_to(target)
        old = time.time() - 8 * 24 * 60 * 60
        for path in (dead, log, target, link, ignored, nested_log):
            os.utime(path, (old, old), follow_symlinks=False)
        target_before = (target.read_bytes(), target.stat().st_mtime_ns)
        link_before = (os.readlink(link), link.lstat().st_mtime_ns)
        log_before = log.stat().st_ino
        result['liveRowBeforePrune'] = s.rows('SELECT runtime_id,status FROM runtimes WHERE runtime_id=?', (rt,))
        daemon = s.up('native', 'prune')
        def summary():
            lines = (args.artifacts / 'native-prune.log').read_text().splitlines()
            records = []
            for line in lines:
                try:
                    record = json.loads(line)
                except ValueError:
                    continue
                if record.get('event') == 'broker.hrcpty_log_sweep':
                    records.append(record)
            return records
        records = s.wait(summary, 30, 'retention summary')
        result['prune'] = {'summary': records, 'deadExists': dead.exists(), 'freshExists': fresh.exists(),
                           'liveExists': log.exists(), 'linkIsSymlink': link.is_symlink()}
        assert not dead.exists()
        assert fresh.is_file() and log.is_file() and log.stat().st_ino == log_before
        assert link.is_symlink() and (os.readlink(link), link.lstat().st_mtime_ns) == link_before
        assert (target.read_bytes(), target.stat().st_mtime_ns) == target_before
        assert ignored.is_file() and nested_log.is_file()
        assert records[-1]['data'] == {'removed': 1, 'keptLive': 1, 'skipped': 4}, records
        # Standalone fallback must also create its log 0600 with a permissive umask.
        standalone = s.root / 'standalone'
        standalone.mkdir()
        spawned = subprocess.run([str(s.binary.parent / 'hrc-pty'), 'serve', '--socket',
                                  str(standalone / 'hrcpty.sock'), '--broker-argv', '/bin/sleep', '30'],
                                 env=s.env, capture_output=True, text=True, umask=0, check=True)
        pid = int(spawned.stdout)
        try:
            result['standaloneMode'] = oct(stat.S_IMODE((standalone / 'hrcpty.log').stat().st_mode))
            assert result['standaloneMode'] == '0o600'
        finally:
            os.kill(pid, signal.SIGTERM)
        passed = True
    finally:
        if rt and s.owners and s.owners[-1].poll() is None:
            result['terminate'] = s.http('POST', '/v1/terminate', {'runtimeId': rt})
        s.dump('ledger')
        s.cleanup(scope)
        after = snapshot()
        result.update(realLogAfter=after, realLogCountAfter=len(after), passAll=passed and before == after)
        (args.artifacts / 'result.json').write_text(json.dumps(result, indent=2) + '\n')
        print(json.dumps(result, indent=2))
        assert before == after, 'production hrcpty directory changed during isolated E2E'
    assert passed


if __name__ == '__main__':
    main()
