#!/usr/bin/env python3
"""Fixed source-native finite-read scenarios against unchanged immutable Bun."""
import argparse
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[4]
HERE = Path(__file__).resolve().parent
SCOPE = 'agent:tabularasa:project:hrc-runtime:task:finite_%'


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, ensure_ascii=True) + '\n')


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def logical(path):
    """Coherent transaction; every table including schema, sequences and FTS rows."""
    with sqlite3.connect('file:' + str(path) + '?mode=ro', uri=True) as db:
        db.execute('BEGIN')
        return list(db.iterdump())


def backup(source, target):
    with sqlite3.connect('file:' + str(source) + '?mode=ro', uri=True) as src:
        with sqlite3.connect(target) as dst:
            src.backup(dst)


def same(left, right, path=''):
    assert type(left) is type(right), (path, type(left).__name__, type(right).__name__)
    if isinstance(left, dict):
        assert left.keys() == right.keys(), (path, sorted(left.keys() - right.keys()), sorted(right.keys() - left.keys()))
        for key in left:
            same(left[key], right[key], path + '/' + key)
    elif isinstance(left, list):
        assert len(left) == len(right), (path, len(left), len(right))
        for i, (a, b) in enumerate(zip(left, right)):
            same(a, b, path + '/' + str(i))
    else:
        assert left == right, (path, left, right)


def compare_pair(bun, native, path=''):
    expected = {name: {'rejected': True, 'code': 'malformed_request'} for name in
                ('pageZero','pageLarge','pageNegativeAfter','tailZero','tailLarge')}
    same(native['nativeBoundedRefusals'], expected, path + '/bounded-observation-contract')
    assert set(native) == set(bun) | {'nativeBoundedRefusals'}
    same(bun, {key: native[key] for key in bun}, path + '/unchanged-repository-contract')


def ids(rows, field):
    return [row[field] for row in rows]


def discriminate(value, phase):
    """Independent expected identities; comparing two empty/wrong sides is insufficient."""
    e, r, n = value['lifecycle'], value['runtime'], value['run']
    assert r['count'] == 6
    assert ids(r['all'], 'runtimeId') == ['finite-' + c for c in 'abcdef']
    assert ids(r['scope'], 'runtimeId') == ['finite-' + c for c in 'abcde']
    assert ids(r['host'], 'runtimeId') == ['finite-' + c for c in 'abcde']
    assert r['latest']['runtimeId'] == 'finite-e'
    assert ids(r['available'], 'runtimeId') == ['finite-a', 'finite-b', 'finite-e']
    assert ids(r['statuses'], 'runtimeId') == ['finite-a', 'finite-b']
    assert r['emptyStatuses'] == [] and r['wrongHost'] == [] and r['missing'] is None
    assert r['one']['generation'] == 1 and r['one']['status'] == 'ready'
    assert r['live'] == [SCOPE + '/lane:main']
    assert ids(r['liveRows'], 'runtimeId') == ['finite-a', 'finite-b', 'finite-e']
    assert ids(n['all'], 'runId') == ['finite-f', 'finite-e', 'finite-d', 'finite-c', 'finite-b', 'finite-app', 'finite-a']
    assert ids(n['filtered'], 'runId') == ['finite-b', 'finite-app']
    assert ids(n['queue'], 'runId') == ['finite-c', 'finite-app', 'finite-b', 'finite-a']
    assert ids(n['correlated'], 'runId') == ['finite-b', 'finite-d']
    for key, expected in [('one', 'a'), ('dispatch', 'b'), ('input', 'c'), ('submission', 'd'), ('turn', 'e')]:
        assert n[key]['runId'] == 'finite-' + expected
    assert n['latest']['runId'] == 'finite-e' and n['latestGeneration']['runId'] == 'finite-b'
    assert n['wrongGeneration'] is None and n['wrongDispatch'] is None and n['missing'] is None
    assert n['wrongQueue'] == [] and n['zero'] == []
    assert [ids(rows, 'runId') for rows in n['selectors']] == [['finite-c'], ['finite-a'], ['finite-d'], [], [], [], []]
    same(n['all'], n['emptyStatuses'])
    assert e['allocated'] == 10
    assert e['pageShort']['head'] == 10
    assert e['pageAhead']['rows'] == [] and e['pageAhead']['head'] == 10 and e['pageAhead']['scannedThrough'] == 10
    assert e['tailWrong']['events'] == [] and e['latestWrong'] is None and e['zero'] == []
    for key in ['pageMismatch', 'tailMismatch', 'replayMismatch']:
        assert e[key] == {'rejected': True, 'expected': 'wrong', 'actual': e['incarnation']}
    if e['incarnation'] == 'finite-original':
        assert e['originalFence'] == {'rejected': False}
    else:
        assert e['originalFence'] == {'rejected': True, 'expected': 'finite-original', 'actual': e['incarnation']}
    seqs_matrix = [] if phase == 'all-deleted' else [1,3,4,5,6,7,8,9] if phase != 'deleted-highest' else [1,3,4,5,6,7,8]
    matching_matrix = [seq for seq in seqs_matrix if seq != 7]
    assert [item['limit'] for item in e['repositoryPages']] == [0,-1,-2,10001]
    assert [item['limit'] for item in e['repositoryTails']] == [0,-1,-2,10001]
    for item in e['repositoryPages']:
        assert ids(item['value']['rows'],'hrcSeq') == ([] if item['limit'] == 0 else seqs_matrix)
        assert item['value']['head'] == item['value']['scannedThrough'] == 10
    for item in e['repositoryTails']:
        expected = [] if item['limit'] in (0,-1) else matching_matrix[1:] if item['limit'] == -2 else matching_matrix
        assert ids(item['value']['events'],'hrcSeq') == expected
        assert item['value']['truncated'] == (True if item['limit'] < 0 else bool(matching_matrix) if item['limit'] == 0 else False)
    assert ids(e['repositoryAfterNegative']['rows'],'hrcSeq') == seqs_matrix[:2]
    assert ids(e['repositoryTailNegativeBefore']['events'],'hrcSeq') == [seq for seq in matching_matrix if seq < 7][1:]
    same(e['repositoryStale'],e['originalFence'])
    if phase == 'all-deleted':
        assert e['max'] == 0 and e['all'] == [] and e['latestGroups'] == []
        assert e['pageShort']['head'] == 10 and e['pageShort']['scannedThrough'] == 10
        assert e['tail']['headHrcSeq'] == 0
        return
    seqs = [1, 3, 4, 5, 6, 7, 8, 9] if phase != 'deleted-highest' else [1, 3, 4, 5, 6, 7, 8]
    assert ids(e['all'], 'hrcSeq') == seqs
    assert e['max'] == seqs[-1] and e['tail']['headHrcSeq'] == seqs[-1]
    assert ids(e['page1']['rows'], 'hrcSeq') == [1] and e['page1']['scannedThrough'] == 1
    assert ids(e['page2']['rows'], 'hrcSeq') == [3, 4] and e['page2']['scannedThrough'] == 4
    assert ids(e['pageShort']['rows'], 'hrcSeq') == seqs and e['pageShort']['scannedThrough'] == 10
    assert ids(e['imported'], 'hrcSeq') == [4] and ids(e['emptySource'], 'hrcSeq') == [5]
    assert ids(e['local'], 'hrcSeq') == [s for s in seqs if s not in (4, 5)]
    assert ids(e['tailBefore']['events'], 'hrcSeq') == [5, 6]
    assert e['tailBefore']['truncated'] is True and e['tail']['truncated'] is True
    assert e['latestLocal']['hrcSeq'] == 8 and e['latestLocalBefore']['hrcSeq'] == 3
    assert ids(e['latestGroups'], 'hrcSeq') == ([9, 8] if phase != 'deleted-highest' else [8, 3])
    assert e['latestSession']['hrcSeq'] == (9 if phase != 'deleted-highest' else 3)
    assert e['replay']['complete'] is True and e['replayBytes']['complete'] is False
    assert ids(e['replay']['accepted'], 'hrcSeq') == [s for s in reversed(seqs) if s != 7]
    assert len(e['replayBytes']['visited']) == len(e['replayBytes']['accepted']) + 1
    assert e['replayBytes']['bytes'] <= 700 and len(e['replayBytes']['accepted']) > 0


def controls(value):
    """Fail each intended assertion from a passing baseline, including both-empty."""
    discriminate(value, 'initial')
    recipes = [
        ('omit-newest', lambda v: v['lifecycle']['all'].pop()),
        ('swap-generation', lambda v: v['run']['filtered'].__setitem__(0, v['run']['one'])),
        ('change-order', lambda v: v['runtime']['all'].reverse()),
        ('missing-field', lambda v: v['runtime']['one'].pop('status')),
        ('zero-effect', lambda v: v['runtime'].__setitem__('all', [])),
        ('retained-max-head', lambda v: v['lifecycle']['pageShort'].__setitem__('head', 9)),
        ('empty-source-as-null', lambda v: v['lifecycle'].__setitem__('emptySource', v['lifecycle']['local'])),
    ]
    results = []
    for name, mutate in recipes:
        altered = copy.deepcopy(value)
        mutate(altered)
        parity_rejected = expected_rejected = False
        try:
            same(value, altered)
        except AssertionError:
            parity_rejected = True
        try:
            discriminate(altered, 'initial')
        except (AssertionError, KeyError):
            expected_rejected = True
        assert parity_rejected and expected_rejected, name
        results.append({'name': name, 'parityRejected': parity_rejected, 'expectedIdentityRejected': expected_rejected})
    return results


def mutation_checks(value):
    assert value['empty'] == value['before']['runtime']
    assert value['patch']['presentation'] == {'label': 'finite'}
    assert value['patch']['runtimeStateJson'] == {'stage': 1}
    assert value['clear']['presentation'] is None and value['clear']['runtimeStateJson'] is None
    assert value['sameStatus'].get('statusChangedAt') == value['before']['runtime'].get('statusChangedAt')
    assert value['status']['status'] == 'busy' and value['status']['statusChangedAt'] == '2026-10-23T01:00:00.000Z'
    assert value['activity']['lastActivityAt'] == '2026-10-23T02:00:00.000Z'
    assert value['runId']['activeRunId'] == 'finite-a' and 'activeRunId' not in value['clearRunId']
    assert value['ownership'] == {'rejected': True, 'code': 'run_mismatch'}
    same(value['clearRunId'], value['ownershipAfter'])
    assert value['absent'] is None and value['runAbsent'] is None
    assert value['runEmpty'] == value['before']['run']
    assert value['runMonotonic']['status'] == 'completed' and 'startedAt' not in value['runMonotonic']
    assert value['runResurrect']['status'] == 'running' and 'completedAt' not in value['runResurrect']
    assert value['runStatus']['status'] == 'failed'
    assert 'errorCode' not in value['runClear']


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary')
    parser.add_argument('--release')
    parser.add_argument('--identity')
    parser.add_argument('--artifacts', required=True)
    args = parser.parse_args()
    identity_path = Path(args.identity) if args.identity else Path(args.binary).parent / 'identity.json'
    identity = json.loads(identity_path.read_text())
    binary, release = identity['native']['path'], identity['bun']['release']
    if args.binary:
        assert Path(args.binary).resolve() == Path(binary).resolve()
    if args.release:
        assert Path(args.release).resolve() == Path(release).resolve()
    assert digest(binary) == identity['native']['sha256']
    out = Path(args.artifacts).resolve()
    out.mkdir(parents=True, exist_ok=False)
    recorder_path = ROOT / 'conformance/hrc-parity/native_capture.py'
    spec = importlib.util.spec_from_file_location('finite_native_capture', recorder_path)
    recorder_module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(recorder_module)
    sources = [Path(__file__).resolve(), HERE / 'oracle.ts', HERE / 'method-map.json', HERE / 'inputs.json', HERE / 'verify.py', HERE / 'controls.py', ROOT / 'crates/hrc-store/src/qualification_reads.rs', recorder_path]
    hashes = {str(p.relative_to(ROOT)): digest(p) for p in sources}
    write(out / 'sources-before.json', hashes)
    for source in sources:
        target = out / 'source' / source.relative_to(ROOT)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
    write(out / 'identity-input.json', identity)
    (out / 'build').mkdir()
    for source in identity_path.parent.glob('*.json'):
        shutil.copyfile(source, out / 'build' / source.name)
    if (identity_path.parent / 'source').exists():
        shutil.copytree(identity_path.parent / 'source', out / 'build/source')
    manifest = Path(release) / 'praesidium-release.json'
    if manifest.exists():
        shutil.copyfile(manifest, out / 'bun-release.json')
    summary = {'scope': 'SOURCE_SUBSET_ONLY', 'complete': False, 'gaps': json.loads((HERE / 'method-map.json').read_text())['gaps'] + [{'id':'scope','reason':'No installed-native or full P1 qualification'}]}
    write(out / 'summary.json', summary)
    records = []
    try:
        with recorder_module.ProcessRecorder(out, 'finite_reads', identity) as recorder:
            with tempfile.TemporaryDirectory(prefix='hrcp1-finite-', dir='/tmp') as tmp:
                root = Path(tmp)
                db = root / 'state.sqlite'
                def command(label, argv, target, passive):
                    before = logical(target) if target.exists() else None
                    write(out / (label + '-before.json'), before)
                    result = subprocess.run(argv, capture_output=True, text=True,
                        env={**os.environ, **({'PATH': '/usr/bin:/bin'} if argv[0] == binary else {}), 'HRC_SOCKET_PATH': str(root / 'absent.sock')})
                    receipt = {'argv': argv, 'exit': result.returncode, 'stdout': result.stdout, 'stderr': result.stderr,
                               'capture': recorder.legs[-1]['receipt'] if recorder.legs and 'receipt' in recorder.legs[-1] else None}
                    write(out / (label + '.json'), receipt)
                    after = logical(target) if target.exists() else None
                    write(out / (label + '-after.json'), after)
                    assert result.returncode == 0, (label, result.stdout, result.stderr)
                    if passive:
                        same(before, after, label + '/passivity')
                    value = json.loads(result.stdout)
                    return value.get('result', value), before, after

                command('seed', ['bun', str(HERE / 'oracle.ts'), release, str(root), 'seed'], db, False)
                backup(db, out / 'fixture.sqlite')
                seed = logical(db)
                write(out / 'fixture-logical.json', seed)
                controlroot = root / 'activity-control'
                controlroot.mkdir()
                controlpath = controlroot / 'state.sqlite'
                backup(db, controlpath)
                try:
                    command('activity-passivity-control', ['bun', str(HERE / 'oracle.ts'), release, str(controlroot), 'activity-control'], controlpath, True)
                except AssertionError as error:
                    assert 'passivity' in str(error), error
                else:
                    raise AssertionError('real updateActivity was not detected')
                initial = None
                for phase in ['initial', 'deleted-highest', 'incarnation-replaced', 'malformed-payload', 'all-deleted']:
                    if phase != 'initial':
                        with sqlite3.connect(db) as writer:
                            if phase == 'deleted-highest':
                                writer.execute('DELETE FROM hrc_events WHERE hrc_seq=9')
                            elif phase == 'incarnation-replaced':
                                writer.execute("UPDATE hrc_event_ledger_metadata SET ledger_incarnation_id='finite-successor' WHERE id=1")
                            elif phase == 'malformed-payload':
                                writer.execute("UPDATE hrc_events SET payload_json='{' WHERE hrc_seq=6")
                            elif phase == 'all-deleted':
                                writer.execute('DELETE FROM hrc_events')
                    bun, _, _ = command(phase + '-bun', ['bun', str(HERE / 'oracle.ts'), release, str(root), 'observe'], db, True)
                    native, _, _ = command(phase + '-native', [binary, 'finite-reads-contract', '--db', str(db)], db, True)
                    compare_pair(bun, native, phase)
                    # After deletion persists through subsequent incarnation/corruption phases.
                    discriminate(native, 'deleted-highest' if phase in ('incarnation-replaced', 'malformed-payload') else phase)
                    if phase == 'initial':
                        initial = native
                    if phase == 'incarnation-replaced':
                        assert native['lifecycle']['incarnation'] == 'finite-successor'
                    if phase == 'malformed-payload':
                        assert 'payload' not in next(row for row in native['lifecycle']['all'] if row['hrcSeq'] == 6)
                    records.append({'phase': phase, 'bun': phase + '-bun.json#/stdout/result', 'native': phase + '-native.json#/stdout/result',
                                    'beforeAfter': [phase + '-' + side + suffix + '.json' for side in ('bun','native') for suffix in ('-before','-after')]})
                write(out / 'negative-controls.json', controls(initial))
                mut = {}
                for side in ('bun', 'native'):
                    subroot = root / side
                    subroot.mkdir()
                    target = subroot / 'state.sqlite'
                    backup(out / 'fixture.sqlite', target)
                    argv = ['bun', str(HERE / 'oracle.ts'), release, str(subroot), 'mutate'] if side == 'bun' else [binary, 'finite-mutations-contract', '--db', str(target)]
                    mut[side], before, after = command('mutation-' + side, argv, target, False)
                    # Same oracle detects actual known updateActivity (not an empty WAL heuristic).
                    assert before != after
                    mutation_checks(mut[side])
                    backup(target, out / ('mutation-' + side + '.sqlite'))
                same(mut['bun'], mut['native'], 'mutation')
                same(logical(out / 'mutation-bun.sqlite'), logical(out / 'mutation-native.sqlite'), 'mutation-logical')
                backup(db, out / 'final.sqlite')
                write(out / 'assertion-anchors.json', records)
                summary.update(complete=True, phases=len(records), negativeControls=7, mutationDetected=True)
    finally:
        after_hashes = {str(p.relative_to(ROOT)): digest(p) for p in sources}
        write(out / 'sources-after.json', after_hashes)
        summary['sourceUnchanged'] = hashes == after_hashes
        summary['nativeUnchanged'] = digest(binary) == identity['native']['sha256']
        write(out / 'summary.json', summary)
        files=sorted(p for p in out.rglob('*') if p.is_file() and p != out/'SHA256SUMS')
        (out/'SHA256SUMS').write_text(''.join(digest(p)+'  '+str(p.relative_to(out))+'\n' for p in files))
    assert summary['sourceUnchanged'] and summary['nativeUnchanged']


if __name__ == '__main__':
    main()
