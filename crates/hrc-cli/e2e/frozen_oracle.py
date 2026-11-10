"""The one declared divergence between the Rust CLI and its Bun oracle.

The TypeScript migration graph is frozen at the baseline head (T-12840 r3
section 6); a Rust release carries that set plus its forward registry
(`FORWARD` in crates/hrc-store/src/migrate/mod.rs). On a store that holds no
forward id, every schema report differs from Bun's only by that registry:
Rust's `releaseVersion` is the forward head, its `pending` list ends with the
forward ids, and its human line says so. `project` maps a report onto the
frozen view: forward ids leave `pending`, a forward `releaseVersion` reads as
the baseline head, and `schemaAhead` follows the projected `pending`. It is
applied to both sides, changes nothing that names no forward id, and is valid
only for stores without forward ids, which every seeded scenario is.
"""
import json
import re
from pathlib import Path

_MOD = (Path(__file__).resolve().parents[3] / 'crates/hrc-store/src/migrate/mod.rs').read_text()
BASELINE_HEAD = re.search(r'pub const BASELINE_HEAD: &str = "([^"]+)"', _MOD).group(1)
_REGISTRY = _MOD[_MOD.index('pub const FORWARD: &[Forward] = &['):]
FORWARD_IDS = re.findall(r'id: "([0-9]{4}_[^"]+)"', _REGISTRY[:_REGISTRY.index('];')])

_HUMAN = re.compile(
    r'store schema: (\S+) — schemaAhead: this release carries (\S+) \((\d+) pending\); '
    r'run `hrc server restart` to apply it')


def schema(block):
    """The frozen view of a JSON `schema` block."""
    if not isinstance(block, dict) or not FORWARD_IDS:
        return block
    out = dict(block)
    if isinstance(out.get('pending'), list):
        out['pending'] = [i for i in out['pending'] if i not in FORWARD_IDS]
        if out.get('readable') is True and 'schemaAhead' in out:
            out['schemaAhead'] = bool(out['pending'])
    if out.get('releaseVersion') in FORWARD_IDS:
        out['releaseVersion'] = BASELINE_HEAD
    return out


def _human(match):
    store, carries, pending = match.group(1), match.group(2), int(match.group(3))
    if carries not in FORWARD_IDS:
        return match.group(0)
    left = pending - len(FORWARD_IDS)
    if left <= 0:
        return f'store schema: {store} (matches this release)'
    return (f'store schema: {store} — schemaAhead: this release carries {BASELINE_HEAD} '
            f'({left} pending); run `hrc server restart` to apply it')


def text(stdout):
    if not FORWARD_IDS or not isinstance(stdout, str):
        return stdout
    try:
        body = json.loads(stdout)
    except ValueError:
        return _HUMAN.sub(_human, stdout)
    if isinstance(body, dict) and 'schema' in body:
        body = dict(body, schema=schema(body['schema']))
        return json.dumps(body, indent=2, ensure_ascii=False) + ('\n' if stdout.endswith('\n') else '')
    return stdout


def project(item):
    """A {exit, stdout, stderr} observation in the frozen view."""
    return dict(item, stdout=text(item.get('stdout')))
