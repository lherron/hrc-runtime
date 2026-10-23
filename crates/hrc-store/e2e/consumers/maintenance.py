"""Unchanged tools over real canonical scratch; historical setup provenance is explicit."""
import json
import sqlite3
from assertions import require, drained, prune_report
from harness import Gap, save
from cases import dbpath, table
from pathlib import Path


def run_maintenance(c):
    def setup(mode):
        root = c.subject(mode + '-' + str(c.counter))
        c.native_call('native-before-' + mode, 'execution-contract', root)
        helper = Path(__file__).with_name('maintenance_setup.ts')
        expected = c.command('historical-' + mode, [c.bun, helper, c.release, dbpath(root), mode], root)
        save(c.caseout / (mode + '-before.json'), {'broker': table(root, 'broker_invocation_events'),
                                                'lifecycle': table(root, 'hrc_events'), 'expected': expected})
        return root, expected['expected']

    def command(root, name, mode, apply=True, extra=()):
        args = [c.bun, c.release / 'scripts/prune-hrc-event-deltas.ts', '--db', dbpath(root),
                '--runtime-root', root / 'run', '--batch-size', '1', '--pace-millis', '1',
                '--max-write-hold-millis', '500', '--max-duty-cycle', '0.25', '--no-checkpoint',
                '--count-eligible', '--incremental-vacuum-pages', '0']
        args += ['--tables', 'runtime_buffers'] if mode == 'buffers' else ['--' + mode + '-tool-results'] if mode in ('spill', 'restub') else ['--strip-envelope-payloads']
        if apply:
            args.append('--apply')
        return prune_report(c.command(name, [*args, *extra], root, parse=False))

    def hydration(root, expected, prefixes):
        helper = Path(__file__).with_name('maintenance_setup.ts')
        bun = c.command('bun-hydrate', [c.bun, helper, c.release, dbpath(root), 'hydrate'], root)['expected']
        for id in prefixes:
            require(bun[id]['result'] == expected[id]['broker'], 'unchanged Bun full hydrated result: ' + id)
            matched = [r for r in bun['lifecycle'] if r.get('runtimeId') == id]
            require(len(matched) == 1 and matched[0]['payload']['result'] == expected[id]['lifecycle'], 'Bun lifecycle hydration: ' + id)
        native = c.native_call('native-maintenance-read', 'consumer-maintenance-read', root)
        # Parent fixed read returns typed records, never mere success booleans.
        for id in prefixes:
            records = native[id]['brokerEvents']
            matched = [r for r in records if r['invocationId'] == id and r['seq'] == 1]
            require(len(matched) == 1 and json.loads(matched[0]['brokerEventJson'])['result'] == expected[id]['broker'], 'native full hydrated result: ' + id)
            mapped = native[id]['lifecycle']
            require(len(mapped) == 1 and mapped[0]['payload']['result'] == expected[id]['lifecycle'], 'native lifecycle hydrated result: ' + id)

    def spill():
        root, expected = setup('spill')
        before = table(root, 'broker_invocation_events')
        small_lifecycle = table(root, 'hrc_events', 'runtime_id=?', ('consumer-maint-small',))
        dry = command(root, 'spill-dry', 'spill', False)
        require(dry['brokerInvocationEvents']['candidates'] == dry['hrcEvents']['candidates'] == 2, 'historical spill positive candidates')
        require(table(root, 'broker_invocation_events') == before, 'spill dry preserves rows')
        applied = command(root, 'spill-apply', 'spill')
        drained(applied, applied['brokerInvocationEvents']['stubbed'])
        require(applied['brokerInvocationEvents']['stubbed'] == applied['hrcEvents']['stubbed'] == 2, 'both ledgers spill')
        require(applied['blobs']['sharedBrokerRaw'] == applied['blobs']['lifecycleCanonical'] == applied['equalityCheckMisses'] == 1, 'shared versus canonical mismatch')
        blobs = table(root, 'tool_result_blobs')
        require(len(blobs) == 3 and all(b['complete'] == 1 and len(b['result_json'].encode()) == b['bytes'] for b in blobs), 'complete exact-byte blobs')
        after = table(root, 'broker_invocation_events')
        for old in before:
            new = next(r for r in after if r['id'] == old['id'])
            if old['invocation_id'] == 'consumer-maint-small':
                require(new == old, 'small noncandidate unchanged')
            elif old['invocation_id'] in expected:
                require({k:v for k,v in old.items() if k!='broker_event_json'} == {k:v for k,v in new.items() if k!='broker_event_json'}, 'nonresult columns unchanged')
                require(json.loads(old['broker_event_json'])['toolCallId'] == json.loads(new['broker_event_json'])['toolCallId'], 'tool identity preserved')
        require(table(root, 'hrc_events', 'runtime_id=?', ('consumer-maint-small',)) == small_lifecycle and bool(small_lifecycle), 'small lifecycle result preserved')
        repeat = command(root, 'spill-repeat', 'spill')
        require(repeat['brokerInvocationEvents']['stubbed'] == repeat['hrcEvents']['stubbed'] == 0, 'spill drained repeat')
        c.check('spill-native-and-Bun-hydration', lambda: hydration(root, expected, list(expected)))
    c.check('spill-positive-dry-repeat-full-hydration', spill)

    def restub():
        root, expected = setup('restub')
        before = table(root, 'broker_invocation_events')
        before_lifecycle = table(root, 'hrc_events')
        before_blobs = table(root, 'tool_result_blobs')
        dry = command(root, 'restub-dry', 'restub', False)
        for ledger in ('brokerInvocationEvents', 'hrcEvents'):
            require(dry[ledger]['candidates'] == 5 and dry[ledger]['rewritten'] == 0, 'restub dry candidates')
        applied = command(root, 'restub-apply', 'restub')
        for ledger in ('brokerInvocationEvents', 'hrcEvents'):
            drained(applied, applied[ledger]['rewritten'])
            require(applied[ledger]['rewritten'] == 1 and applied[ledger]['bytesAfter'] < applied[ledger]['bytesBefore'], 'bounded restub')
            for bucket in ('invalidDescriptor', 'missingBlob', 'incompleteBlob', 'kindMismatch'):
                require(applied[ledger]['skipped'][bucket] == 1, 'exact restub skip: ' + bucket)
        after = table(root, 'broker_invocation_events')
        for old in before:
            new = next(r for r in after if r['id'] == old['id'])
            if old['invocation_id'] != 'consumer-restub-valid':
                require(new == old, 'unsafe/noncandidate broker row unchanged')
            else:
                payload = json.loads(new['broker_event_json'])
                require(payload['result']['details']['spill'] == expected['consumer-restub-valid']['descriptor'], 'spill descriptor unchanged')
                require(len(new['broker_event_json'].encode()) < len(old['broker_event_json'].encode()), 'actual bytes shrunk')
        require(table(root, 'tool_result_blobs') == before_blobs, 'restub complete blob rows unchanged')
        after_lifecycle = table(root, 'hrc_events')
        for old in before_lifecycle:
            new = next(r for r in after_lifecycle if r['hrc_seq'] == old['hrc_seq'])
            if old['runtime_id'] != 'consumer-restub-valid':
                require(new == old, 'unsafe/noncandidate lifecycle row unchanged')
            else:
                descriptor = json.loads(new['payload_json'])['result']['details']['spill']
                require(descriptor == expected['consumer-restub-valid']['descriptor'], 'lifecycle descriptor unchanged')
        repeat = command(root, 'restub-repeat', 'restub')
        require(repeat['brokerInvocationEvents']['rewritten'] == repeat['hrcEvents']['rewritten'] == 0, 'restub repeat no rewrite')
        c.check('restub-native-and-Bun-hydration', lambda: hydration(root, expected, ['consumer-restub-valid']))
    c.check('restub-exact-skips-bytes-repeat-hydration', restub)

    def strip():
        root, expected = setup('strip')
        before = table(root, 'broker_invocation_events')
        dry = command(root, 'strip-dry', 'strip', False)
        require(dry['eligibleCount'] == 2 and table(root, 'broker_invocation_events') == before, 'strip dry candidates/preservation')
        applied = command(root, 'strip-apply', 'strip')
        drained(applied, applied['stripped'])
        require(applied['stripped'] == 2, 'payload and null payload stripped')
        after = table(root, 'broker_invocation_events')
        for old in before:
            new = next(r for r in after if r['id'] == old['id'])
            require(old['broker_event_json'] == new['broker_event_json'], 'authoritative payload unchanged')
            if old['invocation_id'] in expected:
                a = json.loads(old['broker_envelope_json']); a.pop('payload', None)
                require(json.loads(new['broker_envelope_json']) == a, 'only envelope payload removed')
            else:
                require(old == new, 'unselected strip row unchanged')
        require(command(root, 'strip-repeat', 'strip')['stripped'] == 0, 'strip repeat zero')
        native = c.native_call('native-strip-read', 'consumer-maintenance-read', root)
        for id in expected:
            require(len(native[id]['brokerEvents']) == 1, 'native stripped nonempty row')
            record = native[id]['brokerEvents'][0]
            require(json.loads(record['brokerEventJson']) == json.loads(next(r['broker_event_json'] for r in after if r['invocation_id'] == id)), 'native strip authoritative payload')
            envelope = json.loads(record['brokerEnvelopeJson'])
            require(envelope['payload'] == json.loads(record['brokerEventJson']), 'native reconstructs stripped envelope payload')
    c.check('strip-null-authority-preservation-repeat', strip)

    def retention():
        root, expected = setup('buffers')
        before = table(root, 'runtime_buffers')
        dry = command(root, 'buffers-dry', 'buffers', False)
        require(dry['tables']['runtime_buffers']['eligibleCount'] == 1, 'exact buffer eligible count')
        require(table(root, 'runtime_buffers') == before, 'retention dry preserves')
        applied = command(root, 'buffers-apply', 'buffers')
        drained(applied, applied['tables']['runtime_buffers']['deleted'])
        require(applied['tables']['runtime_buffers']['deleted'] == 1, 'exact default retention delete')
        after = table(root, 'runtime_buffers')
        require(after == [r for r in before if r['runtime_id'] != 'consumer-buffer-old'], 'recent/nonterminal/active controls retained')
        require(all(applied['tables'][t]['stopReason'] == 'skipped' for t in ('events', 'hrc_events', 'broker_invocation_events')), 'canonical ledgers unselected')
        native = c.native_call('native-buffer-read', 'consumer-maintenance-read', root)
        for id, action in expected.items():
            actual = native[id]['buffers']
            require(len(actual) == (0 if action == 'delete' else 1), 'native exact buffer retention outcome: ' + id)
            if actual:
                require(actual[0]['runtimeId'] == id and actual[0]['runId'] == id, 'native buffer identities')
    c.check('default-retention-exact-eligibility-preservation', retention)

    from process_controls import maintenance_resume
    c.check('bounded-busy-interruption-resume-concurrent-native-append', lambda: maintenance_resume(c, setup, command))

    from process_controls import phase_resume
    for phase in ('spill', 'restub', 'buffers'):
        c.check(phase + '-kill-resume-concurrent-append', lambda phase=phase: phase_resume(c, setup, command, phase, hydration))
