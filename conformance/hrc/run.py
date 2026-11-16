#!/usr/bin/env python3
"""Run cardo's exact pinned wire and embedder suites against private HRC hosts."""
import argparse
import fcntl
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import tomllib

ROOT = Path(__file__).resolve().parents[2]


def git_environment():
    # A pre-push hook exports GIT_DIR, which otherwise overrides git -C.
    routing = {'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE',
               'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES',
               'GIT_PREFIX', 'GIT_INTERNAL_SUPER_PREFIX', 'GIT_SHALLOW_FILE',
               'GIT_GRAFT_FILE', 'GIT_QUARANTINE_PATH'}
    # Preserve Git transport/config variables: mini uses them for SSH auth.
    return {k: v for k, v in os.environ.items() if k not in routing}


def pinned_cardo():
    deps = tomllib.loads((ROOT / 'crates/Cargo.toml').read_text())['workspace']['dependencies']
    revs = {v['rev'] for k, v in deps.items() if k.startswith('cardo-')}
    if len(revs) != 1:
        raise RuntimeError('cardo crates must pin one revision')
    rev = revs.pop()
    # rbuild supplies binaries without populating the consumer's Cargo cache.
    # Keep one immutable source checkout per pin, independent of local builds.
    cache = ROOT / 'crates/target/cardo-conformance'
    cache.mkdir(parents=True, exist_ok=True)
    checkout = cache / rev
    env = git_environment()
    with (cache / '.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if not checkout.exists():
            with tempfile.TemporaryDirectory(prefix='fetch-', dir=cache) as tmp:
                subprocess.run(['git', 'init', '-q', tmp], check=True, env=env)
                # Pins are main revisions. Fetch its history so abbreviated
                # Cargo pins resolve too; verify the resolved commit below.
                subprocess.run(['git', '-C', tmp, 'fetch', '--quiet', '--no-tags',
                                'https://github.com/lherron/cardo', 'refs/heads/main'],
                               check=True, env=env)
                subprocess.run(['git', '-C', tmp, 'checkout', '--quiet', '--detach', rev],
                               check=True, env=env)
                Path(tmp).rename(checkout)
        head = subprocess.check_output(['git', '-C', str(checkout), 'rev-parse', 'HEAD'],
                                       text=True, env=env).strip()
        if not head.startswith(rev):
            raise RuntimeError(f'cardo source cache has {head}, expected {rev}')
    return checkout, head


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
        # cardo's workspace gets its own target dir per pinned rev: sharing HRC's
        # crates/target built the cardo CLI against stale cardo artifacts after a
        # pin move (a8d7b7e -> c363992: cardo-runtime saw an older cardo-core).
        target = ROOT / f'crates/target/cardo-conformance/{rev}-build'
        subprocess.run(['cargo', 'build', '--manifest-path', str(checkout / 'Cargo.toml'),
                        '--locked', '-p', 'cardo-cli', '--bin', 'cardo', '--target-dir', str(target)], check=True, env=git_environment())
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
