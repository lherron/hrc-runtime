"""External identity/integrity guards around fixed P1 raw consumer validators."""
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
E2E = ROOT / 'crates/hrc-store/e2e'


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def exact_manifest(root):
    root = Path(root).resolve(strict=True)
    listed = {}
    for line in (root / 'SHA256SUMS').read_text().splitlines():
        sha, name = line.split('  ', 1)
        path = root / name
        if name in listed or path.is_symlink() or not path.resolve().is_relative_to(root):
            raise ValueError('duplicate/escaping artifact manifest path')
        listed[name] = sha
    actual = {str(p.relative_to(root)): digest(p) for p in root.rglob('*')
              if p.is_file() and p != root / 'SHA256SUMS'}
    if not listed or listed != actual:
        raise ValueError('artifact manifest must cover exact complete file set')


def readback(family, root, identity, command, output):
    root = Path(root).resolve(strict=True)
    exact_manifest(root)
    expected = identity['native']
    if digest(expected['path']) != expected['sha256']:
        raise ValueError('independent executable pin changed')
    if family == 'native-discriminator':
        return discriminator(root, identity)
    if family == 'finite-reads':
        observed = json.loads((root / 'identity-input.json').read_text())
        if any(observed.get(key) != identity[key] for key in ('native', 'bun')):
            raise ValueError('finite-read tuple differs from independent caller pin')
        argv = [sys.executable, '-B', str(E2E / 'finite_reads/verify.py'), str(root)]
    elif family == 'consumers':
        observed = json.loads((root / 'identity.json').read_text())
        if observed['nativeRealpath'] != expected['path'] or observed['nativeHashBefore'] != expected['sha256']:
            raise ValueError('consumer native tuple differs from independent caller pin')
        manifest = json.loads((Path(identity['bun']['release']) / 'praesidium-release.json').read_text())
        if manifest['hrcBuild']['sourceCommit'] != identity['bun']['sourceCommit']:
            raise ValueError('consumer Bun producer differs from caller pin')
        argv = [sys.executable, '-B', str(E2E / 'consumers/validate.py'), str(root)]
    else:
        return {'status': 'GAP', 'reason': 'fixed raw adapter not yet integrated: ' + family}
    raw = command(argv, output / (family + '-checker.command.json'))
    parsed = json.loads(raw['stdout'])
    if not raw['captureComplete'] or raw['exit'] != 0:
        return {'status': 'FAIL', 'reason': 'fixed raw family checker refused', 'result': parsed}
    if family == 'finite-reads':
        # Candidate shape fallback is forbidden at the aggregation boundary even
        # though the original bounded verifier tolerates the Bun wrapper.
        phases = ('initial', 'deleted-highest', 'incarnation-replaced', 'malformed-payload', 'all-deleted')
        for label in [p + '-native' for p in phases] + ['mutation-native']:
            row = json.loads((root / (label + '.json')).read_text())
            body = json.loads(row['stdout'])
            if not isinstance(body, dict) or 'result' in body:
                raise ValueError('native result must be direct typed observation, not wrapper')
        return {'status': 'PASS', 'scope': 'finite-source-subset', 'result': parsed}
    if parsed.get('status') != 'PASS' or parsed.get('cases') != ['C01', 'C02', 'C03', 'C04', 'C05', 'C06', 'C07']:
        raise ValueError('complete seven real consumer groups required')
    return {'status': 'PASS', 'scope': 'consumer-source-subset', 'result': parsed}


def discriminator(root, identity):
    """Read actual reached-operation denials, constrained commit and Bun reread."""
    observed = json.loads((root / 'identity.json').read_text())
    if any(observed[key] != identity[key] for key in ('native', 'bun')):
        raise ValueError('discriminator source tuple differs from independent pin')
    family = root / 'native_discriminator_e2e'
    raw = json.loads((family / 'commands.json').read_text())
    names = ['network-positive', 'network-denied', 'bun-exec-positive', 'bun-exec-denied',
             'canonical-seed', 'native-network-exec-denied', 'unchanged-bun-after-native-exit']
    if [row['name'] for row in raw] != names:
        raise ValueError('exact reached-operation control identities/order required')
    captured = [json.loads(p.read_text()) for p in sorted((family / 'commands').glob('*.json'))]
    selected = []
    for row in raw:
        matches = [r for r in captured if r['command'] == row['command']
                   and all(r[k] == row[k] for k in ('exit', 'stdout', 'stderr'))]
        if len(matches) != 1 or not matches[0]['captureComplete']:
            raise ValueError('discriminator raw command not bound to exact actual capture')
        record = matches[0]
        pin = {k: identity['native'][k] for k in ('path', 'sha256')}
        if record['nativeBefore'] != pin or record['nativeAfter'] != pin:
            raise ValueError('discriminator executable changed')
        selected.append(record)
    rows = dict(zip(names, raw))
    def lines(name):
        return [json.loads(line) for line in rows[name]['stdout'].splitlines()]
    if rows['network-denied']['command'][3:] != rows['network-positive']['command'] or rows['bun-exec-denied']['command'][3:] != rows['bun-exec-positive']['command']:
        raise ValueError('positive/denied controls must use the same exact interpreter and operation')
    positive, denied = lines('network-positive'), lines('network-denied')
    if rows['network-positive']['exit'] != 0 or [v['phase'] for v in positive] != ['before_bind', 'bound'] or positive[-1]['port'] <= 0:
        raise ValueError('unrestricted network control did not reach and bind')
    if rows['network-denied']['exit'] != 91 or [v['phase'] for v in denied] != ['before_bind', 'bind_error'] or denied[-1]['errno'] != 1 or denied[-1]['errnoName'] != 'EPERM':
        raise ValueError('network negative must reach bind and receive exact EPERM')
    positive = rows['bun-exec-positive']['stdout'].splitlines()
    denied = lines('bun-exec-denied')
    if rows['bun-exec-positive']['exit'] != 0 or len(positive) != 2 or not re.fullmatch(r'\d+\.\d+\.\d+.*', positive[1]):
        raise ValueError('unrestricted same launcher did not exec Bun version')
    marker = json.loads(positive[0])
    if marker['phase'] != 'before_exec' or denied[0] != marker or denied[-1] != {'phase': 'exec_error', 'target': marker['target'], 'errno': 1, 'errnoName': 'EPERM'} or rows['bun-exec-denied']['exit'] != 91:
        raise ValueError('Bun negative must reach same exact target and receive EPERM')
    native = rows['native-network-exec-denied']
    policy = '(version 1)(allow default)(deny network*)(deny process-exec)(allow process-exec (literal ' + json.dumps(identity['native']['path']) + '))'
    if native['command'][:5] != ['/usr/bin/sandbox-exec', '-p', policy, identity['native']['path'], 'atomic-contract'] or native['exit'] != 0:
        raise ValueError('native commit did not run under exact no-network/no-delegation policy')
    states = {v['stage']: v for v in json.loads(native['stdout'])['observations']['boundaries']}
    final = states['afterObserverFailureCommit']['state']['page']
    if not final['rows'] or final == states['before']['state']['page']:
        raise ValueError('constrained native execution produced no durable rows')
    reread = rows['unchanged-bun-after-native-exit']
    if reread['exit'] != 0 or json.loads(reread['stdout'])['page'] != final or selected[-1]['startedAt'] < selected[-2]['completedAt']:
        raise ValueError('sequential unchanged Bun did not read exact committed native page')
    return {'status': 'PASS', 'scope': 'native-repository-discriminator',
            'receipts': ['native_discriminator_e2e/commands.json'],
            'reachedBindAndExecDenials': True, 'constrainedCommitAndSequentialBunReadback': True}
