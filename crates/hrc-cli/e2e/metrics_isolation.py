"""Detect only suite-owned usage writes to production; foreign growth is normal."""
import functools
import json
from pathlib import Path
import subprocess
import sys


class MetricsIsolation:
    def __enter__(self):
        self.root = Path.home() / 'praesidium/var/state/hrc/metrics'
        self.before = {p: (p.stat().st_ino, p.stat().st_size) for p in self.root.glob('cli-*.ndjson')}
        self.pids = set()
        self.original = subprocess.Popen
        owner = self

        class TrackedPopen(self.original):
            def __init__(self, *args, **kwargs):
                super().__init__(*args, **kwargs)
                owner.pids.add(self.pid)
        subprocess.Popen = TrackedPopen
        return self

    def __exit__(self, exc_type, exc, traceback):
        subprocess.Popen = self.original
        growth, owned = [], []
        for path in self.root.glob('cli-*.ndjson'):
            stat = path.stat()
            inode, offset = self.before.get(path, (None, 0))
            if inode != stat.st_ino or stat.st_size < offset:
                offset = 0
            if stat.st_size == offset:
                continue
            with path.open('rb') as stream:
                stream.seek(offset)
                data = stream.read(stat.st_size - offset)
            growth.append(dict(path=str(path), beforeBytes=offset, afterBytes=stat.st_size))
            for line in data.splitlines():
                try:
                    record = json.loads(line)
                except json.JSONDecodeError:
                    continue  # a foreign append can straddle either observation
                if record.get('pid') in self.pids:
                    owned.append(record)
        index = sys.argv.index('--artifacts') if '--artifacts' in sys.argv else None
        if index is not None:
            artifacts = Path(sys.argv[index + 1])
            artifacts.mkdir(parents=True, exist_ok=True)
            (artifacts / 'production-metrics-isolation.json').write_text(json.dumps(dict(spawnedPids=sorted(self.pids), growth=growth, ownedRecords=owned, **{'pass': not owned}), indent=2) + '\n')
        assert not owned, f'suite-owned production CLI metrics: {owned}'


def isolated_suite(fn):
    @functools.wraps(fn)
    def run(*args, **kwargs):
        with MetricsIsolation():
            return fn(*args, **kwargs)
    return run
