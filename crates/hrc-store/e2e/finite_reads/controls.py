#!/usr/bin/env python3
"""Run actual verifier children against a real baseline and coherent tampered copies."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time

HERE = Path(__file__).resolve().parent


def load(path):
    return json.loads(path.read_text())


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2) + '\n')


def change_observation(root, label, mutate):
    path = root / (label + '.json')
    raw = load(path)
    value = json.loads(raw['stdout'])
    mutate(value.get('result', value))
    raw['stdout'] = json.dumps(value) + '\n'
    write(path, raw)
    command = root / raw['capture']
    receipt = load(command)
    receipt['stdout'] = raw['stdout']
    write(command, receipt)


def observations(root, mutate):
    for side in ('bun', 'native'):
        change_observation(root, 'initial-' + side, mutate)


def command_mutation(root):
    rawpath = root / 'initial-native.json'
    raw = load(rawpath)
    raw['argv'][1] = 'absent-operation'
    write(rawpath, raw)
    receiptpath = root / raw['capture']
    receipt = load(receiptpath)
    receipt['argv'] = raw['argv']
    receipt['command'] = raw['argv']
    write(receiptpath, receipt)


def mapping_mutation(root):
    relative = 'crates/hrc-store/e2e/finite_reads/method-map.json'
    source = root / 'source' / relative
    mapping = load(source)
    mapping['methods'].pop()
    write(source, mapping)
    for filename in ('sources-before.json', 'sources-after.json'):
        hashes = load(root / filename)
        hashes[relative] = hashlib.sha256(source.read_bytes()).hexdigest()
        write(root / filename, hashes)


def missing_command(root):
    raw = load(root / 'initial-native.json')
    (root / raw['capture']).unlink()


def missing_field(root):
    observations(root, lambda v: v['runtime']['one'].pop('status'))


def missing_newest(root):
    observations(root, lambda v: v['lifecycle']['all'].pop())


def wrong_generation(root):
    observations(root, lambda v: v['lifecycle'].__setitem__('latestSession', v['lifecycle']['all'][0]))


def wrong_order(root):
    observations(root, lambda v: v['runtime']['all'].reverse())


def zero_effect(root):
    observations(root, lambda v: v['runtime'].__setitem__('all', []))


def stale_max(root):
    observations(root, lambda v: v['lifecycle']['pageShort'].__setitem__('head', 9))


def zero_mutation(root):
    shutil.copyfile(root / 'activity-passivity-control-before.json', root / 'activity-passivity-control-after.json')


def source_null(root):
    observations(root, lambda v: v['lifecycle'].__setitem__('emptySource', v['lifecycle']['local']))


def missing_matrix_case(root):
    observations(root, lambda v: v['lifecycle']['repositoryPages'].pop())


def negative_tail_pop(root):
    observations(root, lambda v: v['lifecycle']['repositoryTails'][2]['value'].__setitem__('events', v['lifecycle']['repositoryTails'][3]['value']['events']))


def bounded_accepts(root):
    change_observation(root, 'initial-native', lambda v: v['nativeBoundedRefusals'].__setitem__('pageZero', {'rejected': False}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('baseline')
    parser.add_argument('--artifacts', required=True)
    args = parser.parse_args()
    base = Path(args.baseline).resolve()
    out = Path(args.artifacts).resolve()
    out.mkdir(parents=True, exist_ok=False)

    def run(label, path, expected_exit):
        argv = [sys.executable, str(HERE / 'verify.py'), str(path)]
        started = time.time()
        child = subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        stdout, stderr = child.communicate()
        receipt = {'argv': argv, 'pid': child.pid, 'startedAt': started, 'completedAt': time.time(),
                   'exit': child.returncode, 'stdout': stdout, 'stderr': stderr,
                   'verifierSha256': hashlib.sha256((HERE / 'verify.py').read_bytes()).hexdigest()}
        write(out / label / 'command.json', receipt)
        assert (child.returncode == 0) == expected_exit, (label, stderr)
        return receipt

    baseline_hashes = {str(p.relative_to(base)): hashlib.sha256(p.read_bytes()).hexdigest()
                       for p in base.rglob('*') if p.is_file()}
    write(out / 'baseline-files.json', baseline_hashes)
    run('baseline', base, True)
    results = []
    recipes = (
        ('missing-command', missing_command), ('missing-required-field-both', missing_field),
        ('omitted-newest-both', missing_newest), ('swapped-generation-both', wrong_generation),
        ('changed-order-both', wrong_order), ('zero-effect-both', zero_effect),
        ('retained-max-as-head-both', stale_max), ('missing-operation-coherent', command_mutation),
        ('missing-method-coherent-source', mapping_mutation), ('zero-mutation-control', zero_mutation),
        ('source-null-empty-conflated-both', source_null),
        ('missing-repository-matrix-case', missing_matrix_case),
        ('negative-tail-missing-single-pop-both', negative_tail_pop),
        ('bounded-observation-accepts-zero', bounded_accepts),
    )
    with tempfile.TemporaryDirectory(prefix='hrcp1-finite-controls-', dir='/tmp') as tmp:
        for name, mutate in recipes:
            target = Path(tmp) / name
            shutil.copytree(base, target)
            mutate(target)
            changed, removed = [], []
            for relative, sha in baseline_hashes.items():
                file = target / relative
                if not file.exists():
                    removed.append(relative)
                elif hashlib.sha256(file.read_bytes()).hexdigest() != sha:
                    changed.append(relative)
                    frozen = out / name / 'delta' / relative
                    frozen.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copyfile(file, frozen)
            write(out / name / 'reconstruction.json', {'base': str(base), 'changed': changed, 'removed': removed})
            receipt = run(name, target, False)
            results.append({'control': name, 'exit': receipt['exit'], 'raw': name + '/command.json'})
            shutil.rmtree(target)
    after_hashes = {str(p.relative_to(base)): hashlib.sha256(p.read_bytes()).hexdigest()
                    for p in base.rglob('*') if p.is_file()}
    assert baseline_hashes == after_hashes
    write(out / 'results.json', {'baseline': str(base), 'controls': results,
                                'baselineUnchanged': True, 'scratchRemoved': True})


if __name__ == '__main__':
    main()
