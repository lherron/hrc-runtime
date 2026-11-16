#!/usr/bin/env python3
"""Run cardo's exact pinned wire and embedder suites against private HRC hosts."""
import argparse
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import tomllib

ROOT = Path(__file__).resolve().parents[2]


def pinned_cardo():
    deps = tomllib.loads((ROOT / 'crates/Cargo.toml').read_text())['workspace']['dependencies']
    revs = {v['rev'] for k, v in deps.items() if k.startswith('cardo-')}
    if len(revs) != 1:
        raise RuntimeError('cardo crates must pin one revision')
    rev = revs.pop()
    cargo = Path(os.environ.get('CARGO_HOME', Path.home() / '.cargo'))
    for p in (cargo / 'git/checkouts').glob('cardo-*/*'):
        if (p / 'conformance/wire_suite.py').is_file():
            head = subprocess.check_output(['git', '-C', str(p), 'rev-parse', 'HEAD'], text=True).strip()
            if head.startswith(rev):
                return p, head
    raise RuntimeError(f'Cargo checkout for {rev} absent; build HRC first')


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--binary', required=True, type=Path)
    p.add_argument('--cardo', type=Path)
    p.add_argument('--artifacts', required=True, type=Path)
    p.add_argument('--class', dest='only', action='append')
    p.add_argument('--suite', choices=('both', 'embed', 'wire'), default='both')
    args = p.parse_args()
    checkout, rev = pinned_cardo()
    if args.cardo is None and args.suite != 'wire':
        target = ROOT / 'crates/target'
        subprocess.run(['cargo', 'build', '--manifest-path', str(checkout / 'Cargo.toml'),
                        '--locked', '-p', 'cardo-cli', '--bin', 'cardo', '--target-dir', str(target)], check=True)
        args.cardo = target / 'debug/cardo'
    sys.path.insert(0, str(checkout / 'conformance'))
    import wire_suite as suite
    from embed_suite import Profile, grade
    from host import Host
    from profile import HrcProfile
    suite.V.set(3)
    args.artifacts.mkdir(parents=True, exist_ok=True)
    binary = args.binary.resolve()
    print(f'HRC cardo conformance: cardo={rev}, binary={binary}', flush=True)
    with tempfile.TemporaryDirectory(prefix='hc13588-', dir='/tmp') as tmp:
        root = Path(tmp)
        host = Host(binary, root, args.artifacts / 'rusthrc.log')
        if args.suite != 'wire':
            profile = Profile(start=host.start, stop=host.stop, root=root, mount='hrc', socket=host.socket,
                              log=host.log, directory=None, stop_supported=False, cli=[str(args.cardo.resolve())])
            cells = grade(profile, args.artifacts / 'embed')
            for name, cell in cells.items():
                print(f"{cell['status'].upper()} hrc {name}: {cell['reason']}", flush=True)
            if any(c['status'] == 'fail' for c in cells.values()):
                return 1
            if args.suite == 'embed':
                return 0
        # embed_suite stops the host after its lifecycle checks; run wire on a
        # fresh serving instance, retaining the same isolated root.
        host.start()
        try:
            def ready():
                if not host.socket.exists():
                    return False
                try:
                    wire = suite.Wire(str(host.socket))
                    try:
                        return wire.call('kernel.health').get('ok')
                    finally:
                        wire.close()
                except OSError:
                    return False
            suite.wait_for(ready, 30, 'private HRC wire serves')
            args.target = 'hrc'
            args.socket = str(host.socket)
            args.sockets = [args.socket]
            args.workdir = str(root)
            args.artifact_dir = str(args.artifacts)
            return suite.grade(args, HrcProfile(str(root)), str(root))
        finally:
            host.stop()


if __name__ == '__main__':
    sys.exit(main())
