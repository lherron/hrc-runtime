"""Real unchanged consumers and independent SQLite/effect assertions."""
import json
import sqlite3
from pathlib import Path
from assertions import require, EvidenceError, export_evidence, capture_evidence, archive_evidence, legacy_rows_evidence
from harness import Gap, InfraError, rows, backup, save


def dbpath(root):
    return root / 'state/state.sqlite'


def mutate(root, statements):
    # Deliberate scratch corruption/historical controls, never native producer evidence.
    with sqlite3.connect(dbpath(root)) as db:
        for sql, params in statements:
            db.execute(sql, params)


def table(root, name, where='', params=()):
    require(name in {'runs', 'events', 'events_legacy', 'hrc_events', 'broker_invocations',
                     'broker_invocation_events', 'runtime_artifacts', 'placement_ledger', 'binding_registry',
                     'runtime_buffers', 'tool_result_blobs'}, 'fixed evidence table only')
    return rows(dbpath(root), 'SELECT * FROM ' + name + (' WHERE ' + where if where else ''), params)


def snapshot(c, root, name):
    result = {t: table(root, t) for t in ('runs', 'events', 'hrc_events', 'broker_invocations',
                                        'broker_invocation_events', 'runtime_artifacts')}
    save(c.caseout / (name + '.json'), result)
    return result


def history(c):
    root = c.subject('seed')
    ids = c.native_call('native-history', 'consumer-history-contract', root)
    for key in ('runId', 'runtimeId', 'hostSessionId', 'invocationId', 'scopeRef', 'artifactPath'):
        require(isinstance(ids.get(key), str) and ids[key], 'native history identity missing: ' + key)
    snap = snapshot(c, root, 'native-history-rows')
    artifact = Path(ids['artifactPath'])
    require(artifact.resolve().is_relative_to(c.root.resolve()), 'native artifact outside scratch')
    (c.caseout / 'provider-transcript.jsonl').write_bytes(artifact.read_bytes())
    require(any(r['run_id'] == ids['runId'] for r in snap['runs']), 'native run absent')
    return root, ids


def c01(c):
    root, ids = history(c)
    run = table(root, 'runs', 'run_id=?', (ids['runId'],))[0]
    selected = table(root, 'hrc_events', 'run_id=?', (ids['runId'],))
    head = max(r['hrc_seq'] for r in table(root, 'hrc_events'))
    def positive():
        body = c.cli_call('exact-export', ['run', 'export', ids['runId'], '--format', 'invocation-exposure', '--json'], root)
        export_evidence(body, run, selected, head)
        for kind, value in [('runtime', ids['runtimeId']), ('host', ids['hostSessionId'])]:
            latest = c.cli_call(kind + '-export', ['run', 'export', kind + ':' + value, '--json'], root)
            # Seed contract deliberately makes this the latest selected run.
            export_evidence(latest, run, selected, head)
    c.check('nonempty-exact-and-latest-exports', positive)
    def empty_control():
        fork = c.fork(root, 'no-run-events')
        mutate(fork, [('DELETE FROM hrc_events WHERE run_id=?', (ids['runId'],))])
        body = c.cli_call('empty-export', ['run', 'export', ids['runId'], '--json'], fork)
        require(body['cursors'] == {'eventHighWaterSeq': 0, 'eventsFromSeq': 1}, 'unchanged empty export characterization')
        try:
            export_evidence(body, run, [], head)
        except EvidenceError:
            return
        raise EvidenceError('empty positive accepted')
    c.check('zero-work-export-rejected-externally', empty_control)
    for name, args, reason in [('absent-run', ['absent-consumer-run'], 'run'),
                               ('absent-selector', ['host:absent-consumer-host'], 'run'),
                               ('invalid-format', [ids['runId'], '--format', 'invalid'], 'format')]:
        def negative(name=name, args=args, reason=reason):
            result = c.cli_call(name, ['run', 'export', *args, '--json'], root, exits=(1, 2), parse=False)
            require(reason in (result['stdout'] + result['stderr']).lower(), 'expected export refusal reason')
        c.check(name, negative)


def c02(c):
    root = c.subject('seed')
    require(not table(root, 'runs', 'run_id=?', ('p1-app',)), 'run must be absent before native writes')
    c.native_call('native-execution', 'execution-contract', root)
    def runrow():
        found = table(root, 'runs', 'run_id=?', ('p1-app',))
        require(len(found) == 1, 'exact nonempty native-created run')
        return found[0]
    created = runrow()
    require(created['correlation_json'] is None, 'annotation starts unassigned')
    a = {'attemptRef': 'p1:a', 'taskId': 'p1:t', 'invocationNodeId': 'p1:node', 'workflowInstanceId': 'p1:w'}
    b = {'attemptRef': 'p1:b'}
    def annotation(name, value, expected, replace=False, exit=0):
        before = runrow()
        result = c.cli_call(name, ['run', 'annotate', 'p1-app', '--correlation', json.dumps(value),
                                 *(['--replace'] if replace else []), '--json'], root, exits=(exit,))
        after = runrow()
        save(c.caseout / (name + '-rows.json'), {'before': before, 'after': after})
        if exit:
            require(result['error']['code'] == 'correlation_conflict' and before == after, 'conflict must preserve full row')
        else:
            require(result['runId'] == 'p1-app' and result['status'] == expected, 'annotation result')
            require(result['correlation'] == value and json.loads(after['correlation_json']) == value, 'persisted whole document')
    c.check('written', lambda: annotation('written', a, 'written'))
    c.check('reordered-unchanged', lambda: annotation('unchanged', dict(reversed(list(a.items()))), 'unchanged'))
    c.check('conflict-exit1-no-mutation', lambda: annotation('conflict', b, None, exit=1))
    c.check('replace-drops-old-keys', lambda: annotation('replaced', b, 'replaced', replace=True))
    def reload():
        loaded = c.native_call('native-reload', 'consumer-reload', root)
        require(loaded['run'] and loaded['run']['runId'] == 'p1-app', 'typed native run identity')
        require(json.loads(loaded['correlationJson']) == b, 'native typed whole-document reload')
    c.check('native-typed-reload', reload)
    def exported():
        body = c.cli_call('annotation-export', ['run', 'export', 'p1-app', '--json'], root)
        require(body['run']['runId'] == 'p1-app' and body['correlation'] == b, 'annotation export identity/document')
        require('taskId' not in body['correlation'], 'replace must drop old fields')
    c.check('export-replacement', exported)
    for name, raw, reason in [('invalid-json', '{', 'valid json'), ('nonobject', '[]', 'json object'),
                               ('unknown-key', '{"nope":"x"}', 'unknown field'),
                               ('nonstring', '{"taskId":42}', 'must be a string'), ('empty', '{}', 'at least one')]:
        def negative(name=name, raw=raw, reason=reason):
            before = runrow()
            result = c.cli_call(name, ['run', 'annotate', 'p1-app', '--correlation', raw, '--json'], root,
                                exits=(1, 2), parse=False)
            require(reason in (result['stdout'] + result['stderr']).lower(), 'specific correlation refusal')
            after = runrow()
            save(c.caseout / (name + '-rows.json'), {'before': before, 'after': after})
            require(after == before, 'invalid annotation mutated run')
        c.check(name + '-no-mutation', negative)
    def absent():
        before = table(root, 'runs')
        result = c.cli_call('absent-run', ['run', 'annotate', 'consumer-absent', '--correlation', json.dumps(a), '--json'], root,
                            exits=(1, 2), parse=False)
        require('run' in (result['stdout'] + result['stderr']).lower(), 'absent run refusal')
        after = table(root, 'runs')
        save(c.caseout / 'absent-run-rows.json', {'before': before, 'after': after})
        require(after == before, 'absent run mutation')
    c.check('absent-run-no-mutation', absent)


def c03(c):
    root, ids = history(c)
    invocation = table(root, 'broker_invocations', 'invocation_id=?', (ids['invocationId'],))[0]
    events = table(root, 'broker_invocation_events', 'invocation_id=?', (ids['invocationId'],))
    lifecycle = table(root, 'hrc_events', 'run_id=?', (ids['runId'],))
    require(len(events) >= 3, '>=3 events needed for interior sequence-hole control')
    args = ['admin', 'broker-verify', 'run', '--invocation', ids['invocationId'], '--json']
    def verify(subject, label, exits=(0,)):
        return c.cli_call(label, args, subject, exits=exits)
    def positive():
        candidates = c.cli_call('candidates', ['admin', 'broker-verify', 'candidates', ids['scopeRef'], '--json'], root)
        chosen = [x for x in candidates['candidates'] if x['invocationId'] == ids['invocationId']]
        require(len(chosen) == 1 and chosen[0]['eventCount'] == len(events) > 0, 'exact nonempty capture candidate')
        capture_evidence(verify(root, 'capture-auto-artifact'), invocation, events, lifecycle)
        explicit = c.cli_call('capture-explicit-jsonl', args + ['--jsonl', ids['artifactPath'], '--strict-text'], root)
        capture_evidence(explicit, invocation, events, lifecycle, artifact=False)
        require('transcriptArtifact' not in explicit and bool(explicit['providerMatches']), 'explicit jsonl bypass characterization')
    c.check('nonempty-capture-auto-and-explicit', positive)
    first = sorted(events, key=lambda r: r['seq'])[0]
    middle = sorted(events, key=lambda r: r['seq'])[1]
    negatives = [
        ('all-mirrors-absent', [('UPDATE broker_invocation_events SET hrc_event_seq=NULL WHERE invocation_id=?', (ids['invocationId'],))], 'raw_mirror_unavailable', 0),
        ('individual-mirror-missing', [('UPDATE broker_invocation_events SET hrc_event_seq=NULL WHERE invocation_id=? AND seq=?', (ids['invocationId'], first['seq']))], 'raw_mirror_seq_missing', 1),
        ('divergent-mirror', [('UPDATE events SET event_json=? WHERE seq=?', ('{}', first['hrc_event_seq']))], 'raw_mirror_mismatch', 1),
        ('failed-projection', [('UPDATE broker_invocation_events SET projection_status=? WHERE invocation_id=? AND seq=?', ('failed', ids['invocationId'], first['seq']))], 'projection_not_applied', 1),
        ('sequence-hole', [('DELETE FROM broker_invocation_events WHERE invocation_id=? AND seq=?', (ids['invocationId'], middle['seq']))], 'seq_hole', 1),
        ('missing-lifecycle', [('DELETE FROM hrc_events WHERE run_id=?', (ids['runId'],))], 'lifecycle_projection_missing', 0),
    ]
    for name, statements, code, exit in negatives:
        def negative(name=name, statements=statements, code=code, exit=exit):
            fork = c.fork(root, name)
            mutate(fork, statements)
            snapshot(c, fork, name + '-rows')
            body = verify(fork, name, exits=(exit,))
            require(any(f['code'] == code for f in body['findings']), 'specific capture finding: ' + code)
            if name == 'missing-lifecycle':
                require(body['status'] == 'inconclusive' and body['ok'] is True, 'unchanged inconclusive exit0 semantics')
            try:
                capture_evidence(body, invocation, table(fork, 'broker_invocation_events', 'invocation_id=?', (ids['invocationId'],)),
                                 table(fork, 'hrc_events', 'run_id=?', (ids['runId'],)))
            except (EvidenceError, KeyError):
                return
            raise EvidenceError('inadequate capture accepted externally')
        c.check(name, negative)
    def missing_invocation():
        body = c.cli_call('missing-invocation', ['admin', 'broker-verify', 'run', '--invocation', 'consumer-absent', '--json'], root, exits=(1,))
        require(any(f['code'] == 'invocation_not_found' for f in body['findings']), 'missing invocation error')
    c.check('missing-invocation', missing_invocation)
    # Mutate only the owned provider bytes, restoring in finally for independent cases.
    path = Path(ids['artifactPath'])
    require(path.resolve().is_relative_to(c.root.resolve()), 'artifact must be scratch-owned')
    original = path.read_bytes()
    for name, hashstate, code in [('wrong-artifact', 'mismatched', 'transcript_artifact_hash_mismatch'),
                                   ('unreadable-artifact', 'unreadable', 'transcript_artifact_unreadable')]:
        def negative(name=name, hashstate=hashstate, code=code):
            try:
                if hashstate == 'mismatched':
                    path.write_bytes(original + b'\n')
                else:
                    path.unlink()
                body = verify(root, name, exits=(0,))
                require(body['transcriptArtifact']['hashStatus'] == hashstate, 'artifact state')
                require(any(f['code'] == code and f['severity'] == 'warning' for f in body['findings']), 'unchanged artifact warning')
                try:
                    capture_evidence(body, invocation, events, lifecycle)
                except EvidenceError:
                    return
                raise EvidenceError('bad artifact accepted externally')
            finally:
                path.write_bytes(original)
        c.check(name, negative)
    def lifecycle_fidelity():
        expected = ids['expectedLifecycle']
        require(bool(expected), 'native exact lifecycle expectations required')
        def exact(subject):
            actual = table(subject, 'hrc_events', 'run_id=?', (ids['runId'],))
            require(len(actual) == len(expected), 'exact lifecycle cardinality')
            for item in expected:
                matching = [r for r in actual if r['event_kind'] == item['eventKind']]
                require(len(matching) == 1 and json.loads(matching[0]['payload_json']) == item['payload'], 'exact lifecycle payload')
        exact(root)
        for name in ('duplicate-lifecycle', 'wrong-lifecycle-payload'):
            fork = c.fork(root, name)
            if name == 'wrong-lifecycle-payload':
                mutate(fork, [('UPDATE hrc_events SET payload_json=? WHERE hrc_seq=?', ('{"wrong":true}', expected[0]['hrcSeq']))])
            else:
                original = dict(lifecycle[0])
                original['hrc_seq'] = max(r['hrc_seq'] for r in table(fork, 'hrc_events')) + 1
                original['stream_seq'] = max(r['stream_seq'] for r in table(fork, 'hrc_events')) + 100
                columns = list(original)
                mutate(fork, [('INSERT INTO hrc_events (' + ','.join(columns) + ') VALUES (' + ','.join('?' for _ in columns) + ')', tuple(original.values()))])
            body = verify(fork, name)
            require(body['ok'] is True, 'presence-only lifecycle checker characterization')
            snapshot(c, fork, name + '-rows')
            try:
                exact(fork)
            except EvidenceError:
                continue
            raise EvidenceError('external lifecycle oracle accepted corruption')
    c.check('lifecycle-exact-payload-and-duplicate-controls', lifecycle_fidelity)


def c04(c):
    from monitor import run_monitor
    c.check('real-isolated-monitor-status-cleanup-native-reopen', lambda: run_monitor(c))


def c05(c):
    from maintenance import run_maintenance
    run_maintenance(c)


def c06(c):
    root = c.subject('seed')
    c.native_call('native-archive-history', 'consumer-archive-history', root)
    allrows = table(root, 'events')
    eligible = [r for r in allrows if r['source'] not in ('broker', 'tmux')]
    active = [r for r in allrows if r['source'] in ('broker', 'tmux')]
    require(len(eligible) >= 2 and {r['source'] for r in active} == {'broker', 'tmux'}, 'nonempty legacy and active-source controls')
    save(c.caseout / 'archive-input.json', {'eligible': eligible, 'active': active})
    before_head = rows(dbpath(root), 'SELECT next_seq-1 AS head FROM event_stream_cursor WHERE id=1')[0]['head']
    script = [c.bun, c.release / 'scripts/archive-legacy-events.ts']
    def tool(subject, name, phase, exits=(0,)):
        return c.command(name, script + [phase, '--step=1', '--sleep=1'], subject, parse=False, exits=exits)
    def refusal():
        fork = c.fork(root, 'delete-before-copy')
        result = tool(fork, 'delete-before-copy', '--delete', exits=(1,))
        require('ABORT' in result['stderr'] and table(fork, 'events') == allrows, 'delete-before-copy refusal/data preserved')
    c.check('delete-before-copy-refusal', refusal)
    def copy_delete():
        status = tool(root, 'archive-status', '--status')
        require(json.loads(status['stdout'])['legacy_still_in_events'] == len(eligible), 'status count')
        tool(root, 'archive-copy', '--copy')
        archive_evidence(eligible, table(root, 'events_legacy'))
        require(table(root, 'events') == allrows, 'copy preserves all sources')
        tool(root, 'archive-repeat-copy', '--copy')
        archive_evidence(eligible, table(root, 'events_legacy'))
        tool(root, 'archive-delete', '--delete')
        archive_evidence(eligible, table(root, 'events_legacy'))
        require(table(root, 'events') == active, 'only legacy rows deleted')
        tool(root, 'archive-repeat-delete', '--delete')
        require(table(root, 'events') == active, 'repeat delete stable')
        reopened = c.native_call('native-archive-reopen', 'consumer-archive-read', root)
        require(reopened['streamHighWater'] == before_head, 'native shared stream allocation must not rewind')
        legacy_rows_evidence(reopened['events'], active)
    # Fork before the positive deletion to retain the payload-weakness counterexample.
    wrong = c.fork(root, 'same-seq-wrong-archive')
    c.check('full-row-copy-delete-repeat-native-reopen', copy_delete)
    def payload_control():
        tool(wrong, 'wrong-archive-copy', '--copy')
        mutate(wrong, [('UPDATE events_legacy SET event_json=? WHERE seq=?', ('{"wrong":true}', eligible[0]['seq']))])
        tool(wrong, 'wrong-archive-repeat', '--copy')
        result = tool(wrong, 'wrong-archive-source-verify', '--delete')
        require('not-yet-archived=0' in result['stdout'], 'source seq-only verification characterization')
        try:
            archive_evidence(eligible, table(wrong, 'events_legacy'))
        except EvidenceError:
            return
        raise EvidenceError('seq-only archive accepted wrong payload')
    c.check('seq-only-weakness-rejected-by-full-row-oracle', payload_control)
    from process_controls import archive_resume
    c.check('actual-copy-delete-kill-resume', lambda: archive_resume(c, root, eligible, active))


def logical_state(path):
    """All persisted source table values and schema, including sequence allocation."""
    import hashlib
    objects = rows(path, "SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name")
    result = {'schema': objects, 'tables': {}}
    for item in objects:
        if item['type'] != 'table':
            continue
        name = item['name']
        records = rows(path, 'SELECT * FROM "' + name.replace('"', '""') + '"')
        encoded = sorted(json.dumps(r, sort_keys=True, default=lambda v: {'bytesHex': v.hex()}) for r in records)
        result['tables'][name] = {'rowCount': len(records), 'sha256': hashlib.sha256(('\n'.join(encoded)).encode()).hexdigest()}
    return result


def c07(c):
    root = c.subject('seed')
    c.command('placement-init', [c.bun, Path(__file__).with_name('setup.ts'), c.release, dbpath(root), 'placement'], root)
    c.native_call('native-active-and-retired', 'consumer-placement-active', root)
    source = table(root, 'placement_ledger')
    source_state = logical_state(dbpath(root))
    save(c.caseout / 'source-logical-before.json', source_state)
    active = {r['scope_ref']: r for r in source if r['state'] == 'active'}
    require(bool(active) and any(r['state'] == 'retired' for r in source), 'nonempty native active plus retired')
    save(c.caseout / 'placement-source.json', source)
    target = root / 'registry.sqlite'
    argv = [c.bun, c.release / 'scripts/rebuild-binding-registry.ts', target, dbpath(root), dbpath(root)]
    def positive():
        body = c.command('registry-rebuild', argv, root)
        require(body['ok'] is True and body['sourceLedgers'] == 2 and body['sourceRows'] == len(source) * 2, 'actual registry source counts')
        require(body['inserted'] == len(active) > 0 and body['duplicates'] == len(active), 'unique active/same-home duplicates')
        result = rows(target, 'SELECT * FROM binding_registry ORDER BY scope_ref')
        require({r['scope_ref']: r['home_node_id'] for r in result} == {k: r['home_node_id'] for k, r in active.items()}, 'exact active scope/home bindings')
        save(c.caseout / 'registry-output-rows.json', result)
        c.command('bun-registry-read', [c.bun, Path(__file__).with_name('setup.ts'), c.release, target, 'registry-read'], root)
        native = c.native_call('native-registry-read', 'consumer-registry-read', root, extra=['--registry', target])
        bindings = native['bindings']
        require({r['scopeRef']: r['homeNodeId'] for r in bindings} == {k: r['home_node_id'] for k, r in active.items()}, 'typed native output read')
        require(logical_state(dbpath(root)) == source_state, 'all source tables/schema/sequence logically unchanged')
        save(c.caseout / 'source-logical-after.json', logical_state(dbpath(root)))
    c.check('active-rebuild-duplicate-and-native-read', positive)
    def exists():
        before = rows(target, 'SELECT * FROM binding_registry ORDER BY scope_ref')
        result = c.command('existing-output-refused', argv, root, exits=(2,), parse=False)
        require('refusing to overwrite existing rebuild target' in result['stderr'], 'existing target reason')
        require(rows(target, 'SELECT * FROM binding_registry ORDER BY scope_ref') == before, 'existing output unchanged')
    c.check('existing-output-exit2-no-overwrite', exists)
    def missing():
        result = c.command('missing-input-refused', [*argv[:2], root / 'absent-target.sqlite', root / 'absent.sqlite'], root, exits=(2,), parse=False)
        require('node ledger does not exist' in result['stderr'], 'missing source reason')
        require(not (root / 'absent-target.sqlite').exists(), 'missing input created output')
    c.check('missing-input-refusal', missing)
    def conflict():
        fork = c.subject('other-home')
        c.command('other-placement-init', [c.bun, Path(__file__).with_name('setup.ts'), c.release, dbpath(fork), 'placement'], fork)
        c.native_call('native-other-home', 'consumer-placement-conflict', fork)
        before = table(fork, 'placement_ledger')
        other_state = logical_state(dbpath(fork))
        conflict_target = root / 'conflict.sqlite'
        result = c.command('conflicting-home-refused', [c.bun, argv[1], conflict_target, dbpath(root), dbpath(fork)], root, exits=(1,), parse=False)
        require('conflict' in (result['stdout'] + result['stderr']).lower(), 'home conflict reason')
        if conflict_target.exists():
            require(not rows(conflict_target, 'SELECT * FROM binding_registry'), 'partial selected registry insertion')
        require(logical_state(dbpath(root)) == source_state and logical_state(dbpath(fork)) == other_state, 'all conflict source tables/schema/sequence unchanged')
    c.check('conflicting-home-no-partial-insertion', conflict)


CASES = {'C01': c01, 'C02': c02, 'C03': c03, 'C04': c04, 'C05': c05, 'C06': c06, 'C07': c07}
