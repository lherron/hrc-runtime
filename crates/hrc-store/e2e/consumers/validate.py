#!/usr/bin/env python3
"""Revalidate saved raw evidence for the parent P0 adapter; missing data fails closed."""
import argparse
import json
import math
from pathlib import Path
import sys
from assertions import require, export_evidence, capture_evidence, archive_evidence, prune_report
from harness import rows, digest
from requirements import REQUIRED


def validate(directory, allow_subset=False):
    out = Path(directory)
    summary = json.loads((out / 'summary.json').read_text())
    require(summary['complete'] is True and summary['status'] == 'PASS' and summary['exitCode'] == 0, 'incomplete or nonpassing run')
    require(summary['nativeHashStable'] is True and summary['sourceFilesStable'] is True and summary['scratchRemoved'] is True, 'native drift/cleanup failure')
    require(summary['installedNativeAcceptance'] is False and summary['fullParityQualified'] is False and summary['fullP1Qualified'] is False, 'source consumers must not claim installed/full parity')
    require(summary['held'] == ['D01-D09', 'LD01-LD05'], 'downstream/held gaps erased')
    cases = {x['id']: x for x in summary['cases']}
    require(len(cases) == len(summary['cases']) > 0, 'duplicate/empty cases')
    if not allow_subset:
        require(set(cases) == set(REQUIRED), 'missing mandatory consumer case')
    identity = json.loads((out / 'identity.json').read_text())
    require(len(identity['nativeHashBefore']) == 64 and identity['nativeOrigin'], 'native executable identity required')
    traces = {}
    for id, case in cases.items():
        require(id in REQUIRED and case['status'] == 'PASS', 'case nonpassing')
        assertions = {x['id']: x['status'] for x in case['assertions']}
        require(len(assertions) == len(case['assertions']), 'duplicate assertion')
        require(all(assertions.get(x) == 'PASS' for x in REQUIRED[id]), 'missing/nonpassing required assertion: ' + id)
        require(case['requiredAssertions'] == REQUIRED[id], 'required assertion coverage drift')
        require(summary['coverage'][id] == {x: 'PASS' for x in REQUIRED[id]}, 'coverage drift')
        case_result = json.loads((out / id / 'result.json').read_text())
        require(case_result == case, 'case/summary disagreement')
        commands = {}
        for path in sorted((out / id).glob('*.json')):
            data = json.loads(path.read_text())
            if not isinstance(data, dict) or 'argv' not in data:
                continue
            require(isinstance(data.get('exit'), int) and not data.get('timeout'), 'timeout/missing process exit')
            require(all(type(data[k]) in (int, float) and math.isfinite(data[k]) for k in ('startedAt', 'endedAt')), 'command timestamps must be finite numeric evidence')
            require(data['endedAt'] >= data['startedAt'], 'command time evidence')
            if 'body' in data:
                require(json.loads(data['stdout']) == data['body'], 'malformed/stale parsed output')
            command_name = path.stem.split('-', 1)[1] if path.stem.split('-', 1)[0].isdigit() else path.stem
            if command_name.startswith('native-'):
                require(data['argv'][0] == identity['nativeRealpath'] and data['nativeHash'] == identity['nativeHashBefore'], 'wrong native binary')
            commands[path.name.split('-', 1)[1].removesuffix('.json')] = data
        require(bool(commands), 'missing actual commands')
        traces[id] = commands
    def body(id, name):
        record = traces[id][name]
        require(record['exit'] == 0, 'positive command exit')
        return json.loads(record['stdout'])
    def read(id, name):
        return json.loads((out / id / name).read_text())
    if 'C01' in cases:
        snapshot = read('C01', 'native-history-rows.json')
        native = body('C01', 'native-history')
        run = next(r for r in snapshot['runs'] if r['run_id'] == native['runId'])
        selected = [r for r in snapshot['hrc_events'] if r['run_id'] == native['runId']]
        head = max(r['hrc_seq'] for r in snapshot['hrc_events'])
        for name in ('exact-export', 'runtime-export', 'host-export'):
            export_evidence(body('C01', name), run, selected, head)
        require(body('C01', 'empty-export')['cursors'] == {'eventHighWaterSeq': 0, 'eventsFromSeq': 1}, 'empty control missing')
    if 'C02' in cases:
        replacement = {'attemptRef': 'p1:b'}
        native = body('C02', 'native-reload')
        require(native['run']['runId'] == 'p1-app' and json.loads(native['correlationJson']) == replacement, 'native correlation readback')
        require(body('C02', 'written')['status'] == 'written' and body('C02', 'unchanged')['status'] == 'unchanged', 'whole-document initial/repeat')
        require(traces['C02']['conflict']['exit'] == 1 and json.loads(traces['C02']['conflict']['stdout'])['error']['code'] == 'correlation_conflict', 'conflict refusal')
        conflict = read('C02', 'conflict-rows.json')
        require(conflict['before'] == conflict['after'], 'conflict changed full row')
        require(body('C02', 'replaced')['correlation'] == replacement, 'replacement full document')
    if 'C03' in cases:
        snapshot = read('C03', 'native-history-rows.json')
        native = body('C03', 'native-history')
        invocation = next(r for r in snapshot['broker_invocations'] if r['invocation_id'] == native['invocationId'])
        events = [r for r in snapshot['broker_invocation_events'] if r['invocation_id'] == native['invocationId']]
        lifecycle = [r for r in snapshot['hrc_events'] if r['run_id'] == native['runId']]
        report = body('C03', 'capture-auto-artifact')
        capture_evidence(report, invocation, events, lifecycle)
        require(report['transcriptArtifact']['currentHash'] == 'sha256:' + digest(out / 'C03/provider-transcript.jsonl'), 'retained provider artifact bytes')
        for name, status in [('all-mirrors-absent', 'pass'), ('missing-lifecycle', 'inconclusive'), ('wrong-artifact', 'pass'), ('unreadable-artifact', 'pass')]:
            actual = body('C03', name)
            require(actual['status'] == status and actual['ok'] is True, 'warning/inconclusive CLI semantics changed')
    if 'C04' in cases:
        profile = read('C04', 'monitor-profile.json')
        status = read('C04', 'real-socket-status.json')
        monitor = body('C04', 'real-monitor-show')
        require(status['status'] == 200 and status['body']['dbPath'] == profile['dbPath'], 'actual status exact isolated db')
        require(monitor['kind'] == 'monitor.snapshot' and monitor['session']['hostSessionId'] == 'consumer-host' and monitor['runtime']['runtimeId'] == 'consumer-runtime', 'nonempty native monitor identity')
        require(monitor['eventLog']['highWaterSeq'] > 0, 'nonempty monitor highwater')
        require(read('C04', 'foreground-cleanup.json')['socketAbsent'] is True and read('C04', 'authority-cleanup.json')['stopped'] is True, 'owned cleanup missing')
        require(all(x['pass'] for x in read('C04', 'isolation-admitted.json')), 'P0 isolation not admitted')
        require(body('C04', 'native-after-Bun-exit')['run']['runId'] == 'consumer-run', 'native reopen absent')
    if 'C05' in cases:
        for name, ledger, effect in [('spill-apply', 'brokerInvocationEvents', 'stubbed'), ('restub-apply', 'brokerInvocationEvents', 'rewritten'),
                                     ('strip-apply', None, 'stripped'), ('buffers-apply', 'tables', None)]:
            report = prune_report(traces['C05'][name])
            require(report['stopReason'] == 'complete', 'partial maintenance report')
            if ledger == 'tables':
                require(report['tables']['runtime_buffers']['deleted'] > 0, 'zero buffer deletion')
            else:
                require((report[ledger] if ledger else report)[effect] > 0, 'zero maintenance effect')
        for phase in ('strip', 'spill', 'restub', 'buffers'):
            name = 'strip-actual-partial-killed.json' if phase == 'strip' else phase + '-actual-partial-killed.json'
            record = read('C05', name)
            require(bool(record['reachedState']) and record['exit'] != 0 and record['cleanup'] is True, 'no actual partial interruption evidence')
        busy = prune_report(traces['C05']['strip-real-busy'])
        require(busy['stopReason'] == 'busy' and busy['stripped'] == 0, 'busy control absent')
    if 'C06' in cases:
        inputs = read('C06', 'archive-input.json')
        db = out / 'C06/databases/seed/state/state.sqlite'
        archive_evidence(inputs['eligible'], rows(db, 'SELECT * FROM events_legacy'))
        require(rows(db, 'SELECT * FROM events') == inputs['active'] and bool(inputs['active']), 'archive active preservation')
        require(body('C06', 'native-archive-reopen')['streamHighWater'] > 0, 'native archive highwater')
        for phase in ('copy', 'delete'):
            record = read('C06', 'archive-' + phase + '-killed.json')
            require(bool(record['reachedState']) and record['exit'] != 0 and record['cleanup'], 'archive interruption evidence')
    if 'C07' in cases:
        source = read('C07', 'placement-source.json')
        active = {r['scope_ref']: r['home_node_id'] for r in source if r['state'] == 'active'}
        output = read('C07', 'registry-output-rows.json')
        require(bool(active) and {r['scope_ref']: r['home_node_id'] for r in output} == active, 'registry nonempty active bindings')
        rebuilt = body('C07', 'registry-rebuild')
        require(rebuilt['inserted'] == rebuilt['duplicates'] == len(active) and rebuilt['sourceRows'] == len(source) * 2, 'registry exact counts')
        native = body('C07', 'native-registry-read')
        require({r['scopeRef']: r['homeNodeId'] for r in native['bindings']} == active, 'native registry reload')
        require(traces['C07']['conflicting-home-refused']['exit'] == 1, 'conflict refusal evidence')
    from rederive import rederive
    derived = rederive(out, cases)
    require(set(derived) == set(cases), 'required semantic reconstruction missing')
    # Artifact integrity is additional to semantic checks, never a product checksum protocol.
    manifest = out / 'SHA256SUMS'
    require(manifest.is_file(), 'missing artifact manifest')
    for line in manifest.read_text().splitlines():
        expected, relative = line.split('  ', 1)
        path = out / relative
        require(path.resolve().is_relative_to(out.resolve()) and path.is_file(), 'missing/escaping artifact')
        require(digest(path) == expected, 'artifact changed: ' + relative)
    return {'status': 'PASS', 'claim': 'source-native-with-installed-Bun-consumers', 'cases': sorted(cases), 'installedNativeAcceptance': False, 'rederivedAssertions': derived}


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__); p.add_argument('evidence'); p.add_argument('--allow-subset', action='store_true')
    args = p.parse_args()
    try:
        print(json.dumps(validate(args.evidence, args.allow_subset)))
    except Exception as error:
        print(json.dumps({'status': 'FAIL', 'reason': str(error)}))
        sys.exit(1)
