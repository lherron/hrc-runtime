#!/usr/bin/env python3
"""Reconstruct finite-read assertions from raw receipts; no serialized PASS dependency."""
import argparse
import hashlib
import json
from pathlib import Path
import finite_reads_e2e as contract

PHASES = ('initial', 'deleted-highest', 'incarnation-replaced', 'malformed-payload', 'all-deleted')
EXPECTED_METHODS = {
    'HrcLifecycleEventRepository.' + name for name in (
        'ledgerIncarnationId', 'allocatedHrcSeq', 'maxHrcSeq', 'page', 'tail',
        'listFromHrcSeq', 'listFromStreamSeq', 'listByRun', 'listByLaunch',
        'listByKind', 'listByScope', 'findLatestByKind', 'findLatestBySession',
        'findLatestLocalInScope', 'listLatestPerSession', 'scanReplayNewestFirst')
} | {
    'RuntimeRepository.' + name for name in (
        'count', 'getByRuntimeId', 'getLatestByHostSessionId', 'listByHostSessionId',
        'listByScopeRef', 'listAll', 'listAvailable', 'listByStatus',
        'listLiveSessionRefs', 'listLiveSessionRefRows', 'update', 'updateStatus',
        'updateActivity', 'updateRunId')
} | {
    'RunRepository.' + name for name in (
        'getByRunId', 'getByDispatchIdempotencyKey', 'getByDispatchedInputId',
        'getByBrokerSubmissionId', 'getByTurnKey', 'listByRuntimeId',
        'listCorrelatedByInvocationId', 'listQueuedByHostSessionId', 'listRuns',
        'getLatestForSession', 'update', 'updateStatus')
}


def load(path):
    return json.loads(path.read_text())


def verify(root):
    root = Path(root)
    identity = load(root / 'identity-input.json')
    native = identity['native']
    assert native['sourceHead'] and native['sourceTreeSha256']
    assert identity['bun']['sourceCommit'] == 'fbc32e43be56885b30a81df5128d2186fe32376d'
    assert contract.digest(native['path']) == native['sha256']
    before = load(root / 'sources-before.json')
    contract.same(before, load(root / 'sources-after.json'), '/sources')
    for relative, sha in before.items():
        assert contract.digest(root / 'source' / relative) == sha, relative
    manifest = load(root / 'build/native-source-manifest.json')
    assert hashlib.sha256(json.dumps(manifest, sort_keys=True, separators=(',', ':')).encode()).hexdigest() == native['sourceTreeSha256']
    key = 'crates/hrc-store/src/qualification_reads.rs'
    assert manifest[key] == before[key], 'scenario did not come from frozen build'
    contract.same(manifest, load(root / 'build/native-source-after.json'))
    for relative, sha in manifest.items():
        assert contract.digest(root / 'build/source' / relative) == sha, relative
    mapping = load(root / 'source/crates/hrc-store/e2e/finite_reads/method-map.json')
    methods = [r['methodId'] for r in mapping['methods']]
    assert len(methods) == len(set(methods)) and set(methods) == EXPECTED_METHODS
    for method in mapping['methods']:
        assert method['p0']['landedCaseIds'] and method['slots'] and method['original']['sourceHash']
    capture = load(root / 'capture.json')
    contract.same(identity, capture['identity'], '/capture/identity')
    legs = {leg['receipt']: leg for leg in capture['legs']}
    consumed = set()

    def observation(label):
        raw = load(root / (label + '.json'))
        receipt_path = raw['capture']
        assert receipt_path in legs and receipt_path not in consumed, label
        consumed.add(receipt_path)
        receipt = load(root / receipt_path)
        assert receipt['captureComplete'] is True and receipt['pid'] > 0
        assert receipt['startedAt'] <= receipt['completedAt']
        assert receipt['stdin'] == {'present': False, 'bytes': 0,
                                    'sha256': hashlib.sha256(b'').hexdigest(), 'literalNewlineCount': 0}
        for key in ('nativeBefore', 'nativeAfter'):
            assert receipt[key] == {key: native[key] for key in ('path', 'sha256')}
        contract.same(raw['argv'], receipt['argv'])
        assert receipt['command'] == receipt['argv']
        assert raw['exit'] == receipt['exit'] == 0
        assert raw['stdout'] == receipt['stdout'] and raw['stderr'] == receipt['stderr']
        assert receipt['executable']['path'] and len(receipt['executable']['sha256']) == 64
        if '-native' in label:
            assert receipt['executable'] == {key: native[key] for key in ('path', 'sha256')}
            expected_scenario = 'finite-mutations-contract' if label == 'mutation-native' else 'finite-reads-contract'
            assert receipt['argv'][:3] == [native['path'], expected_scenario, '--db']
            assert len(receipt['argv']) == 4
            assert receipt['environment']['PATH'] == '/usr/bin:/bin'
        else:
            assert len(receipt['argv']) == 5
            assert receipt['argv'][0] == 'bun' and receipt['argv'][1].endswith('/finite_reads/oracle.ts')
            assert receipt['argv'][2] == identity['bun']['release']
            expected_mode = 'seed' if label == 'seed' else 'activity-control' if label == 'activity-passivity-control' else 'mutate' if label == 'mutation-bun' else 'observe'
            assert receipt['argv'][4] == expected_mode
        parsed = json.loads(raw['stdout'])
        return parsed.get('result', parsed)

    observation('seed')
    activity = observation('activity-passivity-control')
    assert activity['runtimeId'] == 'finite-a' and activity['lastActivityAt'] == '2026-10-23T02:00:00.000Z'
    assert load(root / 'activity-passivity-control-before.json') != load(root / 'activity-passivity-control-after.json')
    outputs = {}
    for phase in PHASES:
        for side in ('bun', 'native'):
            label = phase + '-' + side
            outputs[(phase, side)] = observation(label)
            contract.same(load(root / (label + '-before.json')), load(root / (label + '-after.json')), label + '/passivity')
            contract.discriminate(outputs[(phase, side)], 'deleted-highest' if phase in ('incarnation-replaced', 'malformed-payload') else phase)
        contract.compare_pair(outputs[(phase, 'bun')], outputs[(phase, 'native')], phase)
    assert outputs[('incarnation-replaced','native')]['lifecycle']['incarnation'] == 'finite-successor'
    for side in ('bun', 'native'):
        malformed = outputs[('malformed-payload', side)]['lifecycle']['all']
        assert 'payload' not in next(row for row in malformed if row['hrcSeq'] == 6)
    mutation = {}
    for side in ('bun', 'native'):
        label = 'mutation-' + side
        mutation[side] = observation(label)
        contract.mutation_checks(mutation[side])
        before = load(root / (label + '-before.json'))
        after = load(root / (label + '-after.json'))
        assert before != after
        contract.same(after, contract.logical(root / (label + '.sqlite')), label + '/backup')
    contract.same(mutation['bun'], mutation['native'], '/mutations')
    contract.same(load(root / 'mutation-bun-after.json'), load(root / 'mutation-native-after.json'))
    assert consumed == set(legs), 'unbound or missing actual command receipt'
    return {'scope': 'FINITE_SOURCE_SUBSET_ONLY', 'methodIds': sorted(EXPECTED_METHODS),
            'phases': list(PHASES), 'actualCommands': sorted(consumed),
            'negativeControls': contract.controls(outputs[('initial','native')]),
            'remaining': mapping['gaps']}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('artifacts')
    args = parser.parse_args()
    print(json.dumps(verify(args.artifacts), indent=2))
