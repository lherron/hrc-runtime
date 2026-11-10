"""Read reviewable Bun literals; never refresh expectations from the subject."""
import difflib
import json


def load(path, manifest):
    frozen = json.loads(path.read_text())
    rows = frozen['cases']
    actual = [(r['case'], r['argv']) for r in rows]
    assert actual == manifest, f'frozen case manifest differs: expected {manifest!r}, fixture {actual!r}'
    assert len({r['case'] for r in rows}) == len(rows), 'duplicate frozen case'
    return frozen, {r['case']: r for r in rows}


def compare(expected, subject):
    good = expected == subject
    diff = ''.join(difflib.unified_diff(
        json.dumps(expected, indent=2, ensure_ascii=True).splitlines(True),
        json.dumps(subject, indent=2, ensure_ascii=True).splitlines(True),
        fromfile='frozen', tofile='native')) if not good else ''
    return good, diff


def observation(child):
    return dict(exit=child.returncode, stdout=child.stdout, stderr=child.stderr)


def roots(item, runtime, state):
    return {k: v.replace(str(runtime), '<runtime-root>').replace(str(state), '<state-root>')
            if isinstance(v, str) else v for k, v in item.items()}
