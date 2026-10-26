"""Scratch Bun daemons must never run from the atomic release tree.

Startup pruning protects only that daemon's runtime root. A scratch atomic
daemon can therefore delete the release a production daemon still runs from.
Copy with cp -R, resolve the copied CLI, and use the daemon's own provenance
function to refuse atomic mode before any listener or startup pruning runs.
"""
import json
import os
from pathlib import Path
import shutil
import subprocess


def copied_bun_cli(oracle, destination):
    oracle = Path(oracle).resolve()
    source = oracle.parents[3]
    assert (source / 'praesidium-release.json').is_file(), 'daemon fixture requires an installed or copied release'
    destination = Path(destination)
    assert 'hrc-runtime-releases' not in destination.resolve().parts
    assert destination.resolve().is_relative_to(Path('/tmp').resolve())
    if not destination.exists():
        subprocess.run(['/bin/cp', '-R', str(source), str(destination)], check=True)
    assert (destination / 'praesidium-release.json').read_bytes() == (source / 'praesidium-release.json').read_bytes(), 'copied release does not match requested source'
    copied = (destination / 'packages/hrc-cli/bin/hrc.js').resolve()
    assert copied.is_relative_to(destination.resolve()) and 'hrc-runtime-releases' not in copied.parts
    return copied


def preflight_unmanaged(oracle, env, evidence=None, bun=None):
    oracle = Path(oracle).resolve()
    assert 'hrc-runtime-releases' not in oracle.parts, oracle
    root = oracle.parents[3]
    package = root / 'packages/hrc-server'
    command = [bun or shutil.which('bun'), '-e',
               'const {captureServerRelease}=await import(process.argv[1]); '
               'console.log(JSON.stringify(captureServerRelease(process.argv[2],new Date().toISOString())))',
               str(package / 'src/release-provenance.ts'), str(package)]
    probe_env = dict(env, PATH=os.environ.get('PATH', ''))
    result = subprocess.run(command, env=probe_env, cwd=root, capture_output=True, text=True, check=True)
    release = json.loads(result.stdout)
    assert release['mode'] == 'unmanaged' and 'hrc-runtime-releases' not in Path(release['packagePath']).parts, release
    if evidence:
        Path(evidence).write_text(json.dumps(release, indent=2))
    return release
