#!/usr/bin/env python3
"""Post-push native product workflows; all writes stay in disposable roots.

Run every selected workflow even after a failure. Each keeps its own artifacts;
summary.json records argv and exit status, and the recipe fails if any failed.
Bun is required: it owns scratch migrations and supplies the parity baseline.
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

SUITES = ('schema_refusal', 'server_owner', 'accounting', 'front_door',
          'cold_birth', 'n2_restart', 'n3_submissions', 'maintenance')


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--artifacts', type=Path, required=True)
    p.add_argument('--binary', type=Path, default=Path('crates/target/debug/rusthrc'))
    p.add_argument('--bun-release', type=Path, default=Path.home()/'.bun/install/hrc-runtime-current')
    p.add_argument('--aspd-socket', type=Path, default=Path.home()/'praesidium/var/aspd/run/aspd.sock')
    args = p.parse_args()
    # Drivers which require a clean terminal must still enforce that contract.
    if any(os.environ.get(k) for k in ('CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CODEX_SANDBOX')):
        p.error('run e2e-native-full in a clean ghostmux terminal')
    art = args.artifacts.resolve()
    art.mkdir(parents=True, exist_ok=True)
    results = []
    with tempfile.TemporaryDirectory(prefix='hrc-full-', dir='/tmp') as tmp:
        root = Path(tmp)
        release = root/'bun-release'
        # Never start a Bun daemon from its atomic release: boot prunes it.
        shutil.copytree(args.bun_release.resolve(), release, symlinks=True)
        manifest = release/'praesidium-release.json'
        if manifest.exists():
            shutil.copy2(manifest, art/'bun-release.json')
        build = subprocess.run([str(args.binary.resolve()), '--build-info'], capture_output=True, text=True, check=True)
        (art/'native-build.json').write_text(build.stdout)
        oracle = release/'packages/hrc-cli/bin/hrc.js'
        for name in SUITES:
            dest = art/name
            dest.mkdir(exist_ok=True)
            argv = [sys.executable, str(Path(__file__).with_name(name+'.py')),
                    '--artifacts', str(dest)]
            binary_flag = '--rusthrc' if name == 'front_door' else '--binary'
            argv += [binary_flag, str(args.binary.resolve())]
            if name == 'server_owner':
                argv += ['--oracle', str(oracle)]
            else:
                argv += ['--scratch-root', str(root/name)]
                if name != 'schema_refusal':
                    release_flag = '--installed-release' if name in ('n2_restart', 'n3_submissions') else '--bun-release'
                    argv += [release_flag, str(release)]
                if name in ('front_door', 'cold_birth', 'n2_restart', 'n3_submissions', 'maintenance'):
                    argv += ['--aspd-socket', str(args.aspd_socket.resolve())]
                if name == 'front_door':
                    argv += ['--installed-hrc', str(oracle)]
            print('RUN', name, flush=True)
            with (dest/'driver.log').open('w') as log:
                child = subprocess.run(argv, stdout=log, stderr=subprocess.STDOUT)
            results.append(dict(suite=name, argv=argv, exit=child.returncode))
            (art/'summary.json').write_text(json.dumps(results, indent=2)+'\n')
            print('EXIT', name, child.returncode, flush=True)
    return int(any(row['exit'] != 0 for row in results))


if __name__ == '__main__':
    raise SystemExit(main())
