"""Reconstruct every required assertion from raw receipts and independent persisted rows."""
import json
from pathlib import Path
from urllib.parse import urlparse
from assertions import require, EvidenceError, export_evidence, capture_evidence, archive_evidence, prune_report, legacy_rows_evidence
from harness import rows, digest
from requirements import REQUIRED


def rederive(out, selected):
    out = Path(out)
    proven = {}
    for case in selected:
        commands = []
        for path in sorted((out / case).glob('*.json')):
            record = json.loads(path.read_text())
            if isinstance(record, dict) and 'argv' in record:
                commands.append((path, record))
        proven[case] = set()
        def read(name):
            return json.loads((out / case / name).read_text())
        def records(name):
            return [r for p, r in commands if (p.stem.split('-', 1)[1] if p.stem.split('-', 1)[0].isdigit() else p.stem) == name]
        def record(name):
            found = records(name)
            require(len(found) == 1, 'required raw command missing/duplicated: ' + case + '/' + name)
            return found[0]
        def body(name, code=0):
            r = record(name)
            require(r['exit'] == code and not r.get('timeout'), 'exact command exit: ' + name)
            parsed = json.loads(r['stdout'])
            if 'body' in r:
                require(r['body'] == parsed, 'raw/parsed disagreement')
            return parsed
        def refusal(name, reason, code=None):
            r = record(name)
            require(r['exit'] == code if code is not None else r['exit'] in (1, 2), 'actual refusal exit: ' + name)
            require(reason.lower() in (r['stdout'] + r['stderr']).lower(), 'actual refusal reason: ' + name)
        def mark(name):
            proven[case].add(name)
        def unchanged(name):
            proof = read(name + '-rows.json')
            require(proof['before'] == proof['after'] and bool(proof['before']), 'exact unchanged nonempty rows: ' + name)
            return proof
        def equal_rows(a, b):
            return sorted(json.dumps(x, sort_keys=True) for x in a) == sorted(json.dumps(x, sort_keys=True) for x in b)
        if case == 'C01':
            native = body('native-history'); snap = read('native-history-rows.json')
            run = next(r for r in snap['runs'] if r['run_id'] == native['runId'])
            selected_rows = [r for r in snap['hrc_events'] if r['run_id'] == native['runId']]
            head = max(r['hrc_seq'] for r in snap['hrc_events'])
            for name in ('exact-export', 'runtime-export', 'host-export'):
                export_evidence(body(name), run, selected_rows, head)
            mark('nonempty-exact-and-latest-exports')
            empty = body('empty-export')
            require(empty['cursors'] == {'eventHighWaterSeq': 0, 'eventsFromSeq': 1}, 'empty export source semantics')
            db = out / case / 'databases/no-run-events/state/state.sqlite'
            require(not rows(db, 'SELECT * FROM hrc_events WHERE run_id=?', (native['runId'],)), 'zero-work control rows')
            try:
                export_evidence(empty, run, [], head)
            except EvidenceError:
                mark('zero-work-export-rejected-externally')
            for name, reason in [('absent-run', 'run'), ('absent-selector', 'run'), ('invalid-format', 'format')]:
                refusal(name, reason); mark(name)
        elif case == 'C02':
            a = {'attemptRef': 'p1:a', 'taskId': 'p1:t', 'invocationNodeId': 'p1:node', 'workflowInstanceId': 'p1:w'}
            b = {'attemptRef': 'p1:b'}
            for name, status, value, assertion in [('written', 'written', a, 'written'), ('unchanged', 'unchanged', a, 'reordered-unchanged'), ('replaced', 'replaced', b, 'replace-drops-old-keys')]:
                result = body(name); proof = read(name + '-rows.json')
                require(result['runId'] == proof['after']['run_id'] == 'p1-app', 'annotation run identity')
                require(result['status'] == status and result['correlation'] == value and json.loads(proof['after']['correlation_json']) == value, 'persisted whole-document: ' + name)
                if name == 'written':
                    require(proof['before']['correlation_json'] is None, 'initial annotation unassigned')
                elif name == 'unchanged':
                    require(proof['before'] == proof['after'], 'idempotent repeat row')
                else:
                    require('taskId' not in json.loads(proof['after']['correlation_json']), 'replace dropped keys')
                mark(assertion)
            require(body('conflict', 1)['error']['code'] == 'correlation_conflict', 'conflict code')
            unchanged('conflict'); mark('conflict-exit1-no-mutation')
            loaded = body('native-reload')
            require(loaded['run']['runId'] == 'p1-app' and json.loads(loaded['correlationJson']) == b, 'typed native reload')
            mark('native-typed-reload')
            require(body('annotation-export')['correlation'] == b, 'export exact replacement'); mark('export-replacement')
            for name, reason in [('invalid-json', 'valid json'), ('nonobject', 'json object'), ('unknown-key', 'unknown field'), ('nonstring', 'must be a string'), ('empty', 'at least one'), ('absent-run', 'run')]:
                refusal(name, reason); unchanged(name); mark(name + '-no-mutation')
        elif case == 'C03':
            native = body('native-history'); snap = read('native-history-rows.json')
            invocation = next(r for r in snap['broker_invocations'] if r['invocation_id'] == native['invocationId'])
            events = [r for r in snap['broker_invocation_events'] if r['invocation_id'] == native['invocationId']]
            lifecycle = [r for r in snap['hrc_events'] if r['run_id'] == native['runId']]
            candidates = [r for r in body('candidates')['candidates'] if r['invocationId'] == native['invocationId']]
            require(len(candidates) == 1 and candidates[0]['eventCount'] == len(events) > 0, 'exact nonempty candidates')
            capture_evidence(body('capture-auto-artifact'), invocation, events, lifecycle)
            explicit = body('capture-explicit-jsonl'); capture_evidence(explicit, invocation, events, lifecycle, False)
            require('transcriptArtifact' not in explicit and bool(explicit['providerMatches']), 'explicit jsonl bypass')
            mark('nonempty-capture-auto-and-explicit')
            for name, code, exit in [('all-mirrors-absent', 'raw_mirror_unavailable', 0), ('individual-mirror-missing', 'raw_mirror_seq_missing', 1),
                                      ('divergent-mirror', 'raw_mirror_mismatch', 1), ('failed-projection', 'projection_not_applied', 1),
                                      ('sequence-hole', 'seq_hole', 1), ('missing-lifecycle', 'lifecycle_projection_missing', 0)]:
                report = body(name, exit); state = read(name + '-rows.json')
                require(any(f['code'] == code for f in report['findings']), 'specific capture negative finding: ' + name)
                actual_events = [r for r in state['broker_invocation_events'] if r['invocation_id'] == native['invocationId']]
                actual_lifecycle = [r for r in state['hrc_events'] if r['run_id'] == native['runId']]
                require(bool(actual_events), 'negative must select actual raw records')
                if name == 'missing-lifecycle':
                    require(not actual_lifecycle and report['status'] == 'inconclusive' and report['ok'] is True, 'missing lifecycle semantics')
                if name == 'all-mirrors-absent':
                    require(all(r['hrc_event_seq'] is None for r in actual_events) and report['rawMirror']['checked'] == 0, 'all missing actual links')
                if name == 'individual-mirror-missing':
                    require(any(r['hrc_event_seq'] is None for r in actual_events) and any(r['hrc_event_seq'] is not None for r in actual_events), 'one missing actual link')
                if name == 'divergent-mirror':
                    mirrors = {r['seq']: r for r in state['events']}
                    require(any(json.loads(mirrors[r['hrc_event_seq']]['event_json']).get('payload') != json.loads(r['broker_event_json']) for r in actual_events if r['hrc_event_seq'] in mirrors), 'actual divergent raw mirror payload')
                if name == 'failed-projection':
                    require(any(r['projection_status'] == 'failed' for r in actual_events), 'actual failed projection')
                if name == 'sequence-hole':
                    seqs = sorted(r['seq'] for r in actual_events)
                    require(any(b > a + 1 for a, b in zip(seqs, seqs[1:])), 'actual interior sequence hole')
                try:
                    capture_evidence(report, invocation, actual_events, actual_lifecycle)
                except (EvidenceError, KeyError):
                    mark(name)
            require(any(f['code'] == 'invocation_not_found' for f in body('missing-invocation', 1)['findings']), 'absent invocation refusal'); mark('missing-invocation')
            for name, hashstate, code in [('wrong-artifact', 'mismatched', 'transcript_artifact_hash_mismatch'), ('unreadable-artifact', 'unreadable', 'transcript_artifact_unreadable')]:
                report = body(name)
                require(report['transcriptArtifact']['hashStatus'] == hashstate and any(f['code'] == code and f['severity'] == 'warning' for f in report['findings']), 'unchanged artifact warning')
                try:
                    capture_evidence(report, invocation, events, lifecycle)
                except EvidenceError:
                    mark(name)
            expected = native['expectedLifecycle']
            require(len(lifecycle) == len(expected) > 0, 'initial exact lifecycle count')
            for item in expected:
                matches = [r for r in lifecycle if r['event_kind'] == item['eventKind']]
                require(len(matches) == 1 and json.loads(matches[0]['payload_json']) == item['payload'], 'initial exact lifecycle payload')
            for name in ('duplicate-lifecycle', 'wrong-lifecycle-payload'):
                require(body(name)['ok'] is True, 'presence-only verifier characterization')
                actual = [r for r in read(name + '-rows.json')['hrc_events'] if r['run_id'] == native['runId']]
                if name.startswith('duplicate'):
                    require(len(actual) == len(expected) + 1, 'actual duplicate lifecycle cardinality')
                else:
                    require(any(json.loads(r['payload_json']) == {'wrong': True} for r in actual), 'actual wrong lifecycle payload')
            mark('lifecycle-exact-payload-and-duplicate-controls')
        elif case == 'C04':
            profile = read('monitor-profile.json'); status = read('real-socket-status.json'); monitor = body('real-monitor-show')
            scratch = Path(profile['scratchRoot']).resolve()
            for field in ('dbPath', 'runtimeRoot', 'stateRoot', 'publicSocket', 'agentsRoot', 'agentRoot', 'projectRoot', 'peerConfig', 'wrkqDbPath'):
                require(Path(profile[field]).resolve().is_relative_to(scratch), 'isolated actual destination: ' + field)
            env = profile['env']; locator = urlparse(profile['wrkqLocator'])
            require(locator.hostname == '127.0.0.1' and locator.port == profile['wrkqPort'] >= 30000 and env['HRC_WRKQ_DB'] == env['WRKQ_DB'] == profile['wrkqLocator'], 'both actual authority locators')
            require(env['HRC_WRKQD_TOKEN_FILE'] == env['WRKQD_TOKEN_FILE'] and Path(env['WRKQD_TOKEN_FILE']).resolve().is_relative_to(scratch), 'fresh isolated credential paths')
            require(env['HRC_ACP_WEBHOOK_URL'] == '' and not any(env.get(k) for k in ('WRKQD_UNIX', 'WRKQD_NODE_TOKENS', 'WRKQD_NODE_TOKENS_FILE', 'WRKQ_DB_PATH', 'WRKQ_DB_PATH_FILE')), 'no inherited authority/publication aliases')
            declaration = read('asp-resolution.json')
            require(declaration['status'] == 200 and declaration['body']['declaration']['release']['releaseId'], 'real ASP release')
            require(Path(declaration['body']['declaration']['agentSources']['agentsRoot']).resolve() == Path(profile['agentsRoot']).resolve(), 'actual ASP agent root')
            require(Path(declaration['body']['intent']['placement']['projectRoot']).resolve() == Path(profile['projectRoot']).resolve(), 'actual ASP project root')
            actual = status['body']
            require(status['status'] == 200 and actual['dbPath'] == body('real-cli-status')['api']['dbPath'] == profile['dbPath'], 'real CLI/socket exact DB')
            for wire, field in [('runtimeRoot', 'runtimeRoot'), ('stateRoot', 'stateRoot'), ('socketPath', 'publicSocket')]:
                require(Path(actual[wire]).resolve() == Path(profile[field]).resolve(), 'actual status root: ' + wire)
            require(actual['node']['peerCount'] == 0 and actual['node']['nodeId'].startswith('p0-'), 'actual isolated peer config')
            ids = body('native-monitor-history')
            require(monitor['kind'] == 'monitor.snapshot' and monitor['session']['hostSessionId'] == ids['hostSessionId'] and monitor['runtime']['runtimeId'] == ids['runtimeId'], 'nonempty selected native history')
            require(monitor['session']['scopeRef'] == ids['scopeRef'] and monitor['session']['laneRef'] == 'main' and monitor['session']['generation'] == 1, 'exact selected session fields')
            db = out / case / 'monitor-state.sqlite'
            head = rows(db, "SELECT seq FROM sqlite_sequence WHERE name='hrc_events'")[0]['seq']
            observed = read('after-startup.json')
            sequence = [r for r in observed['store']['sqlite_sequence'] if r['name'] == 'hrc_events']
            require(len(sequence) == 1 and monitor['eventLog']['highWaterSeq'] == observed['allocatedHead'] == sequence[0]['seq'] > 0 and head >= sequence[0]['seq'], 'exact retained monitor highwater; shutdown may append')
            require(record('native-monitor-history')['endedAt'] <= record('ghostmux-foreground')['startedAt'], 'native exited before real Bun starts')
            cleanup = read('foreground-cleanup.json')
            require(cleanup['socketAbsent'] and cleanup['observedAt'] <= record('native-after-Bun-exit')['startedAt'], 'Bun cleanup before native reopen')
            for actor in ('foreground', 'authority'):
                require(record(actor + '-pid-gone')['exit'] == 1 and not record(actor + '-pid-gone')['stdout'].strip(), 'actual owned PID absent')
                cleaned = read(actor + '-cleanup.json')
                pid = cleaned['pid']
                require(str(pid) in record(actor + '-pid-gone')['argv'], 'cleanup exact owned PID')
            require(body('native-after-Bun-exit')['run']['runId'] == ids['runId'], 'same history native reopen')
            mark('real-isolated-monitor-status-cleanup-native-reopen')
        elif case == 'C05':
            derive_maintenance(out / case, commands, proven[case])
        elif case == 'C06':
            expected = read('archive-input.json'); db = out / case / 'databases/seed/state/state.sqlite'
            archive_evidence(expected['eligible'], rows(db, 'SELECT * FROM events_legacy'))
            require(equal_rows(rows(db, 'SELECT * FROM events'), expected['active']) and bool(expected['active']), 'active sources retained')
            for name in ('archive-status', 'archive-copy', 'archive-repeat-copy', 'archive-delete', 'archive-repeat-delete'):
                require(record(name)['exit'] == 0, 'actual archive phase completion')
            native = body('native-archive-reopen')
            require(native['streamHighWater'] == rows(db, 'SELECT next_seq-1 AS head FROM event_stream_cursor WHERE id=1')[0]['head'] > 0, 'archive allocated highwater unchanged')
            legacy_rows_evidence(native['events'], expected['active']); mark('full-row-copy-delete-repeat-native-reopen')
            refusal('delete-before-copy', 'ABORT', 1)
            before_copy_db = out / case / 'databases/delete-before-copy/state/state.sqlite'
            require(equal_rows(rows(before_copy_db, 'SELECT * FROM events'), expected['eligible'] + expected['active']), 'refusal all rows unchanged'); mark('delete-before-copy-refusal')
            for name in ('wrong-archive-copy', 'wrong-archive-repeat', 'wrong-archive-source-verify'):
                require(record(name)['exit'] == 0, 'seq-only source tool acceptance')
            wrong_db = out / case / 'databases/same-seq-wrong-archive/state/state.sqlite'
            require(any(r['event_json'] == '{"wrong":true}' for r in rows(wrong_db, 'SELECT * FROM events_legacy')), 'actual wrong archived payload')
            try:
                archive_evidence(expected['eligible'], rows(wrong_db, 'SELECT * FROM events_legacy'))
            except EvidenceError:
                mark('seq-only-weakness-rejected-by-full-row-oracle')
            for phase in ('copy', 'delete'):
                interrupted = read('archive-' + phase + '-killed.json'); partial = read('archive-' + phase + '-killed-before-resume.json')
                require(interrupted['exit'] < 0 and interrupted['cleanup'] is True, 'actual archive signal/exit')
                count = len(partial['events_legacy']) if phase == 'copy' else len([r for r in partial['events'] if r['source'] not in ('broker', 'tmux')])
                require(0 < count < len(expected['eligible']), 'actual partial committed archive rows')
                require(record('archive-' + phase + '-resumed')['exit'] == 0, 'actual resumed archive phase')
                appended = body('native-during-archive-' + phase)['row']
                require(any(r['hrc_seq'] == appended['hrcSeq'] and json.loads(r['payload_json']) == appended['payload'] for r in partial['hrc_events']), 'actual concurrent native archive append committed')
                require(interrupted['startedAt'] <= record('native-during-archive-' + phase)['startedAt'] <= interrupted['endedAt'], 'archive concurrent native process timing')
            mark('actual-copy-delete-kill-resume')
        elif case == 'C07':
            source = read('placement-source.json'); active = {r['scope_ref']: r['home_node_id'] for r in source if r['state'] == 'active'}
            require(bool(active) and any(r['state'] == 'retired' for r in source), 'native active and retired ledger')
            rebuilt = body('registry-rebuild'); result = read('registry-output-rows.json')
            require(rebuilt['ok'] and rebuilt['inserted'] == rebuilt['duplicates'] == len(active) and rebuilt['sourceRows'] == len(source) * 2 and rebuilt['sourceLedgers'] == 2, 'exact registry source/counts')
            require({r['scope_ref']: r['home_node_id'] for r in result} == active, 'exact active registry rows')
            require({r['scopeRef']: r['homeNodeId'] for r in body('native-registry-read')['bindings']} == active, 'typed registry reload')
            require({r['scopeRef']: r['homeNodeId'] for r in body('bun-registry-read')} == active, 'unchanged Bun registry read')
            require(read('source-logical-before.json') == read('source-logical-after.json'), 'all source tables/schema/sequence passivity'); mark('active-rebuild-duplicate-and-native-read')
            refusal('existing-output-refused', 'refusing to overwrite existing rebuild target', 2)
            db = out / case / 'databases/seed/registry.sqlite'
            require(equal_rows(rows(db, 'SELECT * FROM binding_registry ORDER BY scope_ref'), result), 'existing registry unchanged'); mark('existing-output-exit2-no-overwrite')
            refusal('missing-input-refused', 'node ledger does not exist', 2); mark('missing-input-refusal')
            refusal('conflicting-home-refused', 'conflict', 1)
            conflict_db = out / case / 'databases/seed/conflict.sqlite'
            require(not rows(conflict_db, 'SELECT * FROM binding_registry'), 'no partial conflicting registry')
            other = rows(out / case / 'databases/other-home/state/state.sqlite', 'SELECT * FROM placement_ledger')
            require(any(r['scope_ref'] in active and r['home_node_id'] != active[r['scope_ref']] for r in other if r['state'] == 'active'), 'actual conflicting home source'); mark('conflicting-home-no-partial-insertion')
        require(proven[case] == set(REQUIRED[case]), 'semantic evidence missing for: ' + repr(set(REQUIRED[case]) - proven[case]))
    return {id: sorted(values) for id, values in proven.items()}


def derive_maintenance(out, commands, proven):
    def read(name):
        return json.loads((out / name).read_text())
    def records(name):
        return [r for p, r in commands if (p.stem.split('-', 1)[1] if p.stem.split('-', 1)[0].isdigit() else p.stem) == name]
    def record(name):
        result = records(name); require(len(result) == 1, 'missing/duplicate maintenance command: ' + name)
        return result[0]
    def body(r):
        require(r['exit'] == 0 and not r.get('timeout'), 'actual typed maintenance read exit')
        return json.loads(r['stdout'])
    def stage(name):
        report = prune_report(record(name)); proof = read(name + '-rows.json')
        require(report['dbPath'] == proof['dbPath'] == record(name)['environment']['HRC_DB_PATH'], 'maintenance DB identity')
        return report, proof['before'], proof['after']
    def by(rows, key):
        return {r[key]: r for r in rows}
    def equal(a, b):
        return sorted(json.dumps(r, sort_keys=True) for r in a) == sorted(json.dumps(r, sort_keys=True) for r in b)
    def require_drained(report):
        require(report['stopReason'] == 'complete', 'busy/deadline maintenance not drained')
    def hydration(db, prefix):
        native_records = [r for r in records('native-maintenance-read') if r['environment']['HRC_DB_PATH'] == db]
        bun_records = [r for r in records('bun-hydrate') if r['environment']['HRC_DB_PATH'] == db]
        require(len(native_records) == len(bun_records) == 1, 'required actual Bun and native hydration command')
        native, bun = body(native_records[0]), body(bun_records[0])['expected']
        historical = [r for p, r in commands if '-historical-' in p.name and r.get('environment', {}).get('HRC_DB_PATH') == db]
        require(len(historical) == 1, 'canonical historical input evidence')
        expected = body(historical[0])['expected']
        names = list(expected) if prefix == 'spill' else ['consumer-restub-valid']
        for id in names:
            expected_broker, expected_lifecycle = expected[id]['broker'], expected[id]['lifecycle']
            require(bool(expected_broker) and bool(expected_lifecycle), 'nonempty full hydration expectations')
            events, lifecycle = native[id]['brokerEvents'], native[id]['lifecycle']
            require(len(events) == len(lifecycle) == 1 and events[0]['invocationId'] == id and events[0]['seq'] == 1, 'nonempty exact native hydration identities')
            require(json.loads(events[0]['brokerEventJson'])['result'] == bun[id]['result'] == expected_broker, 'exact native/Bun/full broker hydration')
            bun_lifecycle = [r for r in bun['lifecycle'] if r.get('runtimeId') == id]
            require(len(bun_lifecycle) == 1 and lifecycle[0]['runtimeId'] == id, 'nonempty exact lifecycle hydration identity')
            require(lifecycle[0]['payload']['result'] == bun_lifecycle[0]['payload']['result'] == expected_lifecycle, 'exact native/Bun/full lifecycle hydration')
    spill, before, after = stage('spill-apply')
    dry, dry_before, dry_after = stage('spill-dry')
    require(dry_before == dry_after and dry['brokerInvocationEvents']['candidates'] == dry['hrcEvents']['candidates'] == 2, 'spill dry candidates and unchanged full state')
    require_drained(spill)
    require(spill['brokerInvocationEvents']['stubbed'] == spill['hrcEvents']['stubbed'] == 2 and spill['blobs']['sharedBrokerRaw'] == spill['blobs']['lifecycleCanonical'] == spill['equalityCheckMisses'] == 1, 'exact spill effects/blob sharing')
    blobs = by(after['tool_result_blobs'], 'blob_id')
    require(len(blobs) == 3 and all(b['complete'] == 1 and len(b['result_json'].encode()) == b['bytes'] for b in blobs.values()), 'complete exact spill blob bytes')
    for table, key, column in [('broker_invocation_events', 'id', 'broker_event_json'), ('hrc_events', 'hrc_seq', 'payload_json')]:
        old, new = by(before[table], key), by(after[table], key)
        require(set(old) == set(new), 'spill preserves row identities')
        for id, initial in old.items():
            final = new[id]
            payload = json.loads(initial[column]); result = payload.get('result')
            if initial.get('invocation_id', initial.get('runtime_id')) in ('consumer-maint-shared', 'consumer-maint-different'):
                require({k:v for k,v in initial.items() if k != column} == {k:v for k,v in final.items() if k != column}, 'spill nonresult columns preserved')
                descriptor = json.loads(final[column])['result']['details']['spill']
                blob = blobs[descriptor['blobId']]
                require(blob['kind'] == descriptor['kind'] and blob['bytes'] == descriptor['bytes'], 'spill descriptor/blob fidelity')
                require(payload.keys() == json.loads(final[column]).keys(), 'spill payload shape preserved')
            else:
                require(initial == final, 'spill small/noncandidate fully preserved')
    repeat, _, _ = stage('spill-repeat')
    require_drained(repeat); require(repeat['brokerInvocationEvents']['stubbed'] == repeat['hrcEvents']['stubbed'] == 0, 'spill repeat drained')
    hydration(record('spill-apply')['environment']['HRC_DB_PATH'], 'spill')
    proven.update(['spill-positive-dry-repeat-full-hydration', 'spill-native-and-Bun-hydration'])
    restub, before, after = stage('restub-apply'); dry, d0, d1 = stage('restub-dry')
    require(d0 == d1, 'restub dry preserves all rows')
    require_drained(restub)
    require(before['tool_result_blobs'] == after['tool_result_blobs'], 'restub blob authority unchanged')
    for ledger in ('brokerInvocationEvents', 'hrcEvents'):
        require(dry[ledger]['candidates'] == 5 and dry[ledger]['rewritten'] == 0, 'restub dry exact candidates')
        item = restub[ledger]
        require(item['rewritten'] == 1 and item['bytesAfter'] < item['bytesBefore'], 'actual bounded restub effect')
        require(item['skipped'] == {'invalidDescriptor':1, 'missingBlob':1, 'incompleteBlob':1, 'kindMismatch':1, 'updateConflict':0}, 'exact restub skip buckets')
    for table, key, column, identity in [('broker_invocation_events', 'id', 'broker_event_json', 'invocation_id'), ('hrc_events', 'hrc_seq', 'payload_json', 'runtime_id')]:
        old, new = by(before[table], key), by(after[table], key)
        require(set(old) == set(new), 'restub row identity preservation')
        for id, initial in old.items():
            final = new[id]
            if initial.get(identity) != 'consumer-restub-valid':
                require(initial == final, 'unsafe/noncandidate restub row fully unchanged')
            else:
                require(len(final[column].encode()) < len(initial[column].encode()), 'independent restub bytes shrink')
                require(json.loads(initial[column])['result']['details']['spill'] == json.loads(final[column])['result']['details']['spill'], 'restub descriptor unchanged')
                require({k:v for k,v in initial.items() if k != column} == {k:v for k,v in final.items() if k != column}, 'restub nonresult columns unchanged')
    repeat, _, _ = stage('restub-repeat'); require_drained(repeat)
    require(repeat['brokerInvocationEvents']['rewritten'] == repeat['hrcEvents']['rewritten'] == 0, 'restub repeat no effect')
    hydration(record('restub-apply')['environment']['HRC_DB_PATH'], 'restub')
    proven.update(['restub-native-and-Bun-hydration', 'restub-exact-skips-bytes-repeat-hydration'])
    strip, before, after = stage('strip-apply'); dry, d0, d1 = stage('strip-dry')
    require(d0 == d1 and dry['eligibleCount'] == 2, 'strip dry real unchanged candidates'); require_drained(strip)
    require(strip['stripped'] == 2, 'payload and null envelope stripping')
    old, new = by(before['broker_invocation_events'], 'id'), by(after['broker_invocation_events'], 'id')
    require(set(old) == set(new), 'strip row identity')
    for id, initial in old.items():
        final = new[id]
        require(initial['broker_event_json'] == final['broker_event_json'], 'strip authoritative broker bytes unchanged')
        if initial['invocation_id'].startswith('consumer-strip-'):
            envelope = json.loads(initial['broker_envelope_json']); envelope.pop('payload', None)
            require(json.loads(final['broker_envelope_json']) == envelope, 'strip exactly payload field')
        else:
            require(initial == final, 'strip unselected row unchanged')
    repeat, _, _ = stage('strip-repeat'); require_drained(repeat); require(repeat['stripped'] == 0, 'strip repeat zero')
    native = body(record('native-strip-read'))
    for id in ('consumer-strip-payload', 'consumer-strip-null', 'consumer-strip-stripped'):
        values = native[id]['brokerEvents']; require(len(values) == 1 and values[0]['invocationId'] == id, 'native nonempty stripped row')
        expected_row = next(r for r in after['broker_invocation_events'] if r['invocation_id'] == id)
        require(json.loads(values[0]['brokerEventJson']) == json.loads(expected_row['broker_event_json']), 'native exact stripped authority')
        require(json.loads(values[0]['brokerEnvelopeJson'])['payload'] == json.loads(values[0]['brokerEventJson']), 'native envelope reconstruction')
    proven.add('strip-null-authority-preservation-repeat')
    retention, before, after = stage('buffers-apply'); dry, d0, d1 = stage('buffers-dry')
    require(d0 == d1 and dry['tables']['runtime_buffers']['eligibleCount'] == 1, 'buffer dry exact candidate and unchanged rows')
    require_drained(retention); require(retention['tables']['runtime_buffers']['deleted'] == 1, 'exact default buffer deletion')
    expected_buffers = [r for r in before['runtime_buffers'] if r['runtime_id'] != 'consumer-buffer-old']
    require(equal(expected_buffers, after['runtime_buffers']) and len(expected_buffers) == 4, 'all recent/nonterminal/active controls preserved')
    for table in ('events', 'hrc_events', 'broker_invocation_events'):
        require(retention['tables'][table]['stopReason'] == 'skipped' and before[table] == after[table], 'default canonical ledger preservation')
    native = body(record('native-buffer-read'))
    for name in ('old', 'recent', 'live-run', 'live-runtime', 'active-run'):
        id = 'consumer-buffer-' + name; actual = native[id]['buffers']
        expected = [r for r in after['runtime_buffers'] if r['runtime_id'] == id]
        require(len(actual) == len(expected), 'native exact retained buffer count')
        for a, e in zip(actual, expected):
            require(a['runtimeId'] == e['runtime_id'] and a['runId'] == e['run_id'] and a['text'] == e['text'] and a['chunkSeq'] == e['chunk_seq'], 'native full retained buffer values')
    proven.add('default-retention-exact-eligibility-preservation')
    busy, b0, b1 = stage('strip-real-busy'); require(b0 == b1 and busy['stopReason'] == 'busy' and busy['stripped'] == 0, 'real busy leaves all rows unchanged')
    for phase in ('strip', 'spill', 'restub', 'buffers'):
        name = phase + '-actual-partial-killed'
        process = read(name + '.json'); partial = read(name + '-before-resume.json')
        require(process['exit'] < 0 and process['cleanup'] and process['endedAt'] >= process['startedAt'], 'real signaled partial process')
        report, resumed_before, resumed_after = stage(phase + '-resumed'); require_drained(report)
        require(partial == resumed_before, 'retained committed state must be exact resume input')
        if phase == 'strip':
            candidates = [r for r in partial['broker_invocation_events'] if r['invocation_id'].startswith('consumer-strip-')]
            require(sum('payload' in json.loads(r['broker_envelope_json']) for r in candidates) == 1 and report['stripped'] == 1, 'actual strip partial row and resume effect')
        elif phase == 'spill':
            candidates = [r for r in partial['broker_invocation_events'] if r['invocation_id'].startswith('consumer-maint-') and not r['invocation_id'].endswith('small')]
            require(sum('spill' in json.loads(r['broker_event_json'])['result'].get('details', {}) for r in candidates) == 1, 'actual partial spill rows')
            for row in candidates:
                descriptor = json.loads(row['broker_event_json'])['result'].get('details', {}).get('spill')
                if descriptor:
                    blob = next(b for b in partial['tool_result_blobs'] if b['blob_id'] == descriptor['blobId'])
                    require(blob['complete'] == 1 and blob['kind'] == descriptor['kind'] and len(blob['result_json'].encode()) == blob['bytes'] == descriptor['bytes'], 'committed spill has complete matching blob before resume')
            hydration(record(phase + '-resumed')['environment']['HRC_DB_PATH'], phase)
        elif phase == 'restub':
            broker = next(r for r in partial['broker_invocation_events'] if r['invocation_id'] == 'consumer-restub-valid')
            lifecycle = next(r for r in partial['hrc_events'] if r['runtime_id'] == 'consumer-restub-valid')
            require(len(broker['broker_event_json'].encode()) < 8000 and len(lifecycle['payload_json'].encode()) > 32768, 'actual partial restub ledgers')
            hydration(record(phase + '-resumed')['environment']['HRC_DB_PATH'], phase)
        else:
            old = [r for r in partial['runtime_buffers'] if r['runtime_id'] == 'consumer-buffer-old']
            require(0 < len(old) < 101 and len(resumed_after['runtime_buffers']) == 4, 'actual partial/resumed buffer rows')
            native = body(record('native-resumed-buffers'))
            require(not native['consumer-buffer-old']['buffers'] and all(len(native['consumer-buffer-' + n]['buffers']) == 1 for n in ('recent','live-run','live-runtime','active-run')), 'native post-resume preservation')
        if phase != 'strip':
            native_process = record('native-during-' + phase)
            require(process['startedAt'] <= native_process['startedAt'] <= native_process['endedAt'] <= process['endedAt'], 'native append interval must be inside interrupted ' + phase + ' process interval')
            appended = body(native_process)['row']
            require(any(r['hrc_seq'] == appended['hrcSeq'] and json.loads(r['payload_json']) == appended['payload'] for r in resumed_after['hrc_events']), 'actual concurrent append retained')
            proven.add(phase + '-kill-resume-concurrent-append')
    concurrent = read('concurrent-strip-process.json'); require_drained(prune_report(concurrent))
    appended = body(record('native-concurrent-append'))['row']; final = read('concurrent-strip-after.json')
    require(concurrent['startedAt'] <= record('native-concurrent-append')['startedAt'] <= record('native-concurrent-append')['endedAt'] <= concurrent['endedAt'], 'native append during real tool process')
    require(any(r['hrc_seq'] == appended['hrcSeq'] and json.loads(r['payload_json']) == appended['payload'] for r in final['hrc_events']), 'native concurrent append exact stored row')
    proven.add('bounded-busy-interruption-resume-concurrent-native-append')
