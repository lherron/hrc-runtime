#!/usr/bin/env python3
"""Build/freeze the fixed native scratch driver in the existing shared Cargo target."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import time

ROOT = Path(__file__).resolve().parents[2]


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2) + '\n')


def dependencies(depfile):
    paths = {Path(item) for item in depfile.read_text().splitlines()[0].split(': ', 1)[1].split()}
    if not paths or any(not path.is_relative_to(ROOT) for path in paths):
        raise ValueError('warm compiler dependency file must name this checkout')
    paths.update((ROOT / 'crates').glob('*/Cargo.toml'))
    paths.update([ROOT / 'crates/Cargo.toml', ROOT / 'crates/Cargo.lock'])
    for directory in ('.cargo', 'crates/.cargo'):
        if (ROOT / directory).is_dir():
            paths.update(path for path in (ROOT / directory).rglob('*') if path.is_file())
    return paths


def manifest(paths):
    return {str(path.relative_to(ROOT)): digest(path) for path in sorted(paths)}


def capture(command, output, environment=None):
    started = time.time()
    result = subprocess.run(command, cwd=ROOT, capture_output=True, text=True, env=environment)
    write(output, {'command': command, 'startedAt': started, 'completedAt': time.time(),
                   'exit': result.returncode, 'stdout': result.stdout, 'stderr': result.stderr})
    if result.returncode:
        raise RuntimeError('build/identity command failed; actual receipt: ' + str(output))
    return result.stdout


def freeze(output, release):
    output, release = Path(output).resolve(), Path(release).resolve()
    output.mkdir(parents=True, exist_ok=False)
    write(output / 'completion.json', {'complete': False})
    target = (ROOT / 'crates/target').resolve(strict=True)
    if not target.is_dir():
        raise ValueError('existing shared Cargo target is required; no new target')
    if os.environ.get('CARGO_TARGET_DIR') and Path(os.environ['CARGO_TARGET_DIR']).resolve() != target:
        raise ValueError('CARGO_TARGET_DIR disagrees with existing shared target')
    depfile = target / 'debug/rusthrc.d'
    paths = dependencies(depfile)
    before = manifest(paths)
    write(output / 'native-source-manifest.json', before)
    shutil.copyfile(depfile, output / 'compiler-dependencies-before.d')
    for path in paths:
        destination = output / 'source' / path.relative_to(ROOT)
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(path, destination)
    head = capture(['git', 'rev-parse', 'HEAD'], output / 'source-head.json').strip()
    capture(['git', 'status', '--short'], output / 'source-dirty.json')
    capture(['rustc', '-vV'], output / 'compiler.json')
    environment = {**os.environ, 'CARGO_TARGET_DIR': str(target)}
    write(output / 'build-environment.json', {key: environment.get(key) for key in (
        'CARGO_TARGET_DIR', 'RUSTFLAGS', 'CARGO_ENCODED_RUSTFLAGS', 'CARGO_BUILD_TARGET')})
    capture(['cargo', 'build', '--manifest-path', 'crates/Cargo.toml', '-p', 'hrc-store', '--locked'],
            output / 'build.json', environment)
    if paths != dependencies(depfile) or before != manifest(paths):
        raise ValueError('compiler inputs changed during capture; retain this attempt and refresh')
    if capture(['git', 'rev-parse', 'HEAD'], output / 'source-head-after.json').strip() != head:
        raise ValueError('source HEAD changed during build')
    write(output / 'native-source-after.json', manifest(paths))
    shutil.copyfile(depfile, output / 'compiler-dependencies-after.d')
    binary = output / 'rusthrc'
    shutil.copy2(target / 'debug/rusthrc', binary)
    producer = json.loads((release / 'praesidium-release.json').read_text())
    shutil.copyfile(release / 'praesidium-release.json', output / 'bun-release.json')
    identity = {
        'native': {'path': str(binary), 'sha256': digest(binary), 'sourceHead': head,
                   'sourceTreeSha256': hashlib.sha256(json.dumps(before, sort_keys=True,
                       separators=(',', ':')).encode()).hexdigest()},
        'bun': {'release': str(release), 'sourceCommit': producer['hrcBuild']['sourceCommit']},
        'scope': 'SOURCE_UNDER_QUALIFICATION_NOT_READINESS',
        'sourceManifest': 'build/native-source-manifest.json',
        'sourceTreeDigestAlgorithm': 'sha256 UTF8 compact sorted-key JSON compiler-local-input-path->file-sha256 plus Cargo/config inputs',
    }
    write(output / 'identity.json', identity)
    identity['sources'] = {path.stem: digest(path) for path in sorted(
        (ROOT / 'crates/hrc-store/e2e').glob('*e2e.py'))}
    identity['controls'] = {str(path.relative_to(ROOT)): digest(path) for path in sorted(
        list((ROOT / 'crates/hrc-store/e2e').glob('*.ts')) +
        list((ROOT / 'crates/hrc-store/e2e/fixtures').glob('*')) +
        [ROOT / 'conformance/hrc-parity/native_capture.py']) if path.is_file()}
    write(output / 'qualification-identity.json', identity)
    write(output / 'completion.json', {'complete': True, 'scope': identity['scope']})
    return identity


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', required=True)
    parser.add_argument('--release', required=True)
    args = parser.parse_args()
    print(json.dumps(freeze(args.out, args.release), indent=2))


if __name__ == '__main__':
    main()
