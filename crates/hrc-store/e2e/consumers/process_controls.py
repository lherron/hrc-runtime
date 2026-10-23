"""Owned child process controls with real SQLite reached-state barriers."""
import subprocess
import time
import sqlite3
from assertions import require, archive_evidence, prune_report
from harness import InfraError, save, store_snapshot
from cases import dbpath, table


def interrupt_at(c, root, name, argv, predicate):
    start = time.time()
    process = subprocess.Popen(list(map(str, argv)), env=c.env(root), stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    reached = None
    try:
        deadline = time.monotonic() + 12
        while time.monotonic() < deadline and process.poll() is None:
            reached = predicate()
            if reached:
                break
            time.sleep(.02)
        require(bool(reached) and process.poll() is None, 'real partial committed state not observed: ' + name)
        # Only this child is signaled. A timeout is never evidence of partial progress.
        process.terminate()
        stdout, stderr = process.communicate(timeout=5)
        save(c.caseout / (name + '-before-resume.json'), store_snapshot(dbpath(root)))
    finally:
        if process.poll() is None:
            process.kill()
            stdout, stderr = process.communicate(timeout=5)
        save(c.caseout / (name + '.json'), {'argv': list(map(str, argv)), 'pid': process.pid,
             'startedAt': start, 'endedAt': time.time(), 'exit': process.returncode,
             'stdout': locals().get('stdout', ''), 'stderr': locals().get('stderr', ''),
             'reachedState': reached, 'cleanup': process.poll() is not None})
    return reached


def archive_resume(c, unused, eligible, active):
    root = c.subject('archive-interrupted')
    c.native_call('native-archive-interrupted', 'consumer-archive-history', root)
    expected = [r for r in table(root, 'events') if r['source'] not in ('broker', 'tmux')]
    preserved = [r for r in table(root, 'events') if r['source'] in ('broker', 'tmux')]
    require(len(expected) >= 2, 'nonempty interruption seed')
    base = [c.bun, c.release / 'scripts/archive-legacy-events.ts']
    c.command('archive-status-interrupted', [*base, '--status'], root)
    def partial_copy():
        count = len(table(root, 'events_legacy'))
        if 0 < count < len(expected):
            appended = c.native_call('native-during-archive-copy', 'consumer-append-control', root)
            return {'copied': count, 'expected': len(expected), 'nativeAppend': appended}
        return None
    interrupt_at(c, root, 'archive-copy-killed', [*base, '--copy', '--step=1', '--sleep=250'], partial_copy)
    c.command('archive-copy-resumed', [*base, '--copy', '--step=1', '--sleep=1'], root, parse=False)
    archive_evidence(expected, table(root, 'events_legacy'))
    def partial_delete():
        count = len([r for r in table(root, 'events') if r['source'] not in ('broker', 'tmux')])
        if 0 < count < len(expected):
            appended = c.native_call('native-during-archive-delete', 'consumer-append-control', root)
            return {'remaining': count, 'expected': len(expected), 'nativeAppend': appended}
        return None
    interrupt_at(c, root, 'archive-delete-killed', [*base, '--delete', '--step=1', '--sleep=250'], partial_delete)
    c.command('archive-delete-resumed', [*base, '--delete', '--step=1', '--sleep=1'], root, parse=False)
    require(table(root, 'events') == preserved, 'active sources survived partial delete/resume')
    archive_evidence(expected, table(root, 'events_legacy'))
    c.native_call('native-archive-after-resume', 'consumer-archive-read', root)


def maintenance_resume(c, setup, command):
    root, _ = setup('strip')
    before = table(root, 'broker_invocation_events')
    # A genuine second SQLite writer owns the same DB, bounded tool must give up.
    with sqlite3.connect(dbpath(root)) as blocker:
        blocker.execute('BEGIN IMMEDIATE')
        report = command(root, 'strip-real-busy', 'strip', extra=['--busy-max-retries', '0'])
        require(report['stopReason'] == 'busy' and report['stripped'] == 0, 'bounded real busy is partial, not success')
        blocker.rollback()
    require(table(root, 'broker_invocation_events') == before, 'busy must preserve rows')
    argv = [c.bun, c.release / 'scripts/prune-hrc-event-deltas.ts', '--db', dbpath(root),
            '--runtime-root', root / 'run', '--strip-envelope-payloads', '--apply', '--batch-size', '1',
            '--pace-millis', '500', '--max-write-hold-millis', '500', '--max-duty-cycle', '.25',
            '--incremental-vacuum-pages', '0', '--no-checkpoint']
    def partial():
        source = [r for r in table(root, 'broker_invocation_events') if r['invocation_id'].startswith('consumer-strip-')]
        count = sum('payload' in __import__('json').loads(r['broker_envelope_json']) for r in source)
        return {'remainingPayloads': count, 'rows': len(source)} if count == 1 else None
    interrupt_at(c, root, 'strip-actual-partial-killed', argv, partial)
    resumed = command(root, 'strip-resumed', 'strip')
    require(resumed['stopReason'] == 'complete' and resumed['stripped'] == 1, 'resume remaining committed work')
    # Launch a fresh paced historical strip pass and append through a real native process while alive.
    concurrent = c.subject('concurrent-strip')
    c.native_call('native-before-concurrent', 'execution-contract', concurrent)
    from pathlib import Path
    c.command('historical-concurrent', [c.bun, Path(__file__).with_name('maintenance_setup.ts'), c.release, dbpath(concurrent), 'strip'], concurrent)
    argv = [dbpath(concurrent) if x == dbpath(root) else concurrent / 'run' if x == root / 'run' else x for x in argv]
    concurrent_started = time.time()
    process = subprocess.Popen(list(map(str, argv)), env=c.env(concurrent), stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            source = table(concurrent, 'broker_invocation_events')
            count = sum('payload' in __import__('json').loads(r['broker_envelope_json']) for r in source if r['invocation_id'].startswith('consumer-strip-'))
            if count == 1:
                break
            require(process.poll() is None, 'tool exited before concurrent append barrier')
            time.sleep(.02)
        require(count == 1 and process.poll() is None, 'partial concurrent barrier')
        appended = c.native_call('native-concurrent-append', 'consumer-append-control', concurrent)
        stdout, stderr = process.communicate(timeout=10)
        record = {'argv': list(map(str, argv)), 'pid': process.pid, 'exit': process.returncode, 'stdout': stdout, 'stderr': stderr, 'startedAt': concurrent_started, 'endedAt': time.time()}
        save(c.caseout / 'concurrent-strip-process.json', record)
        save(c.caseout / 'concurrent-strip-after.json', store_snapshot(dbpath(concurrent)))
        require(prune_report(record)['stopReason'] == 'complete', 'concurrent strip complete')
        require(isinstance(appended['row']['hrcSeq'], int) and appended['row']['hrcSeq'] > 0, 'native appended identity')
        require(any(r['hrc_seq'] == appended['row']['hrcSeq'] for r in table(concurrent, 'hrc_events')), 'concurrent native append retained')
    finally:
        if process.poll() is None:
            process.terminate()
            process.communicate(timeout=5)


def phase_resume(c, setup, command, phase, hydrate):
    """Interrupt each maintenance family after a committed batch, append, resume."""
    import json
    from assertions import drained
    root, expected = setup(phase)
    if phase == 'buffers':
        # Historical positive set large enough to span the tool's min batch of25.
        with sqlite3.connect(dbpath(root)) as db:
            for seq in range(2, 102):
                db.execute("INSERT INTO runtime_buffers SELECT runtime_id,run_id,?,text,created_at FROM runtime_buffers WHERE runtime_id='consumer-buffer-old' AND chunk_seq=1", (seq,))
    flag = ['--tables', 'runtime_buffers'] if phase == 'buffers' else ['--' + phase + '-tool-results']
    argv = [c.bun, c.release / 'scripts/prune-hrc-event-deltas.ts', '--db', dbpath(root), '--runtime-root', root / 'run',
            *flag, '--apply', '--batch-size', '1', '--pace-millis', '500', '--max-write-hold-millis', '500',
            '--max-duty-cycle', '.25', '--incremental-vacuum-pages', '0', '--no-checkpoint']
    appended = None
    def barrier():
        nonlocal appended
        if phase == 'spill':
            selected = [r for r in table(root, 'broker_invocation_events') if r['invocation_id'] in expected]
            done = sum('spill' in json.loads(r['broker_event_json'])['result'].get('details', {}) for r in selected)
            partial = done == 1
        elif phase == 'restub':
            selected = [r for r in table(root, 'broker_invocation_events') if r['invocation_id'] == 'consumer-restub-valid']
            canonical = [r for r in table(root, 'hrc_events') if r['runtime_id'] == 'consumer-restub-valid']
            require(len(selected) == len(canonical) == 1, 'restub partial control nonempty')
            partial = len(selected[0]['broker_event_json'].encode()) < 8000 and len(canonical[0]['payload_json'].encode()) > 32768
            done = int(partial)
        else:
            remaining = len([r for r in table(root, 'runtime_buffers') if r['runtime_id'] == 'consumer-buffer-old'])
            partial = 0 < remaining < 101
            done = 101 - remaining
        if partial:
            appended = c.native_call('native-during-' + phase, 'consumer-append-control', root)
            return {'committedEffects': done, 'concurrentNativeAppend': appended}
        return None
    interrupt_at(c, root, phase + '-actual-partial-killed', argv, barrier)
    require(appended and appended['row']['hrcSeq'] > 0, 'actual concurrent native appended row')
    # Every committed stub must already resolve to complete matching bytes after the kill.
    for row in table(root, 'broker_invocation_events'):
        payload = json.loads(row['broker_event_json'])
        descriptor = payload.get('result', {}).get('details', {}).get('spill') if isinstance(payload.get('result'), dict) else None
        if descriptor and phase == 'spill':
            matches = [b for b in table(root, 'tool_result_blobs') if b['blob_id'] == descriptor['blobId']]
            require(len(matches) == 1 and matches[0]['complete'] == 1 and matches[0]['kind'] == descriptor['kind'], 'no committed dangling spill')
            require(len(matches[0]['result_json'].encode()) == matches[0]['bytes'] == descriptor['bytes'], 'committed blob complete bytes')
    report = command(root, phase + '-resumed', phase)
    require(report['stopReason'] == 'complete', 'resumed maintenance fully drained')
    require(any(r['hrc_seq'] == appended['row']['hrcSeq'] for r in table(root, 'hrc_events')), 'concurrent native append survived resume')
    if phase == 'spill':
        hydrate(root, expected, list(expected))
    elif phase == 'restub':
        hydrate(root, expected, ['consumer-restub-valid'])
    else:
        remaining = table(root, 'runtime_buffers')
        require(len(remaining) == 4 and all(r['runtime_id'] != 'consumer-buffer-old' for r in remaining), 'retention resumed/preserved controls')
        native = c.native_call('native-resumed-buffers', 'consumer-maintenance-read', root)
        require(not native['consumer-buffer-old']['buffers'], 'deleted native buffer absent')
        require(all(len(native['consumer-buffer-' + name]['buffers']) == 1 for name in ('recent', 'live-run', 'live-runtime', 'active-run')), 'native preserved buffers nonempty')
