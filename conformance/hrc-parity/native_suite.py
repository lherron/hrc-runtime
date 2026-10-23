"""P1 repository runner adapter. Fixed producers, explicit identity, raw revalidation.

No Bun daemon status admission for native storage. The separately owned consumer
harness performs its real sequential foreground-Bun compatibility leg.
"""
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
E2E = ROOT / 'crates/hrc-store/e2e'


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, ensure_ascii=True) + '\n')


def seal(root):
    (root / 'SHA256SUMS').write_text(''.join(digest(p) + '  ' + str(p.relative_to(root)) + '\n'
        for p in sorted(root.rglob('*')) if p.is_file() and p.name != 'SHA256SUMS'))


def command(argv, receipt, timeout=900):
    started = time.time()
    write(receipt, {'command': argv, 'startedAt': started, 'captureComplete': False})
    try:
        result = subprocess.run(argv, cwd=ROOT, capture_output=True, text=True, timeout=timeout)
        value = {'command': argv, 'startedAt': started, 'completedAt': time.time(),
                 'exit': result.returncode, 'stdout': result.stdout, 'stderr': result.stderr,
                 'captureComplete': True}
    except subprocess.TimeoutExpired as error:
        value = {'command': argv, 'startedAt': started, 'completedAt': time.time(),
                 'exit': None, 'stdout': str(error.stdout or ''), 'stderr': str(error.stderr or ''),
                 'timeout': True, 'captureComplete': False}
    write(receipt, value)
    return value


def execute_repositories(root, identity_path, frozen, contract):
    root.mkdir(parents=True, exist_ok=False)
    identity = json.loads(identity_path.read_text())
    identity['legs'] = []
    identity['buildProvenance'] = {}
    # Freeze directory is independently chosen by the profile, never inferred
    # from a mutable target or supplied by a child scenario result.
    for path in sorted(frozen.rglob('*')):
        if not path.is_file() or path.name == 'rusthrc':
            continue
        relative = path.relative_to(frozen)
        target = root / 'build' / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(path, target)
        identity['buildProvenance'][str(target.relative_to(root))] = digest(target)
    shutil.copyfile(frozen / 'bun-release.json', root / 'bun-release.json')
    outcomes = []
    write(root / 'identity.json', identity)
    for family in contract['families']:
        argv = [sys.executable, '-B', str(HERE / 'native_capture.py'), '--script',
                str(E2E / (family + '.py')), '--identity', str(identity_path),
                '--artifacts', str(root / family)]
        result = command(argv, root / (family + '.command.json'))
        outcomes.append({'family': family, 'exit': result['exit'],
                         'receipt': family + '.command.json'})
        capture = root / family / 'capture.json'
        if capture.is_file():
            identity['legs'].extend(json.loads(capture.read_text())['legs'])
        write(root / 'identity.json', identity)
        write(root / 'producer-outcomes.json', outcomes)
        if not result['captureComplete']:
            break
    seal(root)
    return outcomes


def validate_coverage(mapping, contract, assertions, check, checks):
    """A linkage is usable only with real semantic assertions; labels never pass."""
    closed = []
    gaps = []
    for group, key in (('operations', 'operations'), ('directFiles', 'directFiles'),
                       ('directTemplates', 'directTemplates')):
        expected = {row['id'] for row in contract[key]}
        supplied = mapping.get(group, [])
        ids = [row.get('id') for row in supplied]
        exact = len(ids) == len(set(ids)) and set(ids) == expected
        check(checks, 'native:coverage-identities:' + group, exact,
              'exact original identities required; missing/extra/duplicate entries are GAP', 2)
        by_id = {row.get('id'): row for row in supplied}
        for name in sorted(expected):
            row = by_id.get(name, {})
            refs = row.get('semanticAssertions', [])
            proofs = [assertions.get(ref) for ref in refs]
            valid = bool(refs) and len(refs) == len(set(refs)) and all(
                proof and proof['status'] == 'PASS' and proof.get('receipts')
                and proof.get('scope') != 'raw-output-only'
                and name in proof.get('coverageIdentities', {}).get(group, [])
                for proof in proofs)
            # Source anchors and recipe are reviewable obligations, not proof by themselves.
            valid = valid and bool(row.get('nativeSignatures')) and bool(row.get('behavior'))
            if valid:
                closed.append({'group': group, 'id': name, 'semanticAssertions': refs})
            else:
                gaps.append({'group': group, 'id': name,
                             'reason': 'missing specific passing raw semantic proof/signature/behavior binding'})
    check(checks, 'native:coverage-adequacy', not gaps,
          'all repository/direct-reader obligations need individual semantic proof', 2)
    return {'closed': closed, 'gaps': gaps}


def run(args, checks, check):
    if not args.profile:
        check(checks, 'native:profile-required', False, 'explicit native-store profile required', 2)
        return {'claim': 'native-store', 'validationSurface': 'source'}
    profile = json.loads(Path(args.profile).read_text())
    contract = json.loads((ROOT / 'contract/hrc-parity/native-store.json').read_text())
    output = Path(args.out).resolve()
    check(checks, 'native:profile-scope', profile.get('suite') == 'p1-native-store'
          and profile.get('claim') == 'native-store', 'profile must name native-store scope', 2)
    check(checks, 'native:surface', profile.get('validationSurface') in ('source', 'installed'),
          'source and canonical installed acceptance must be distinguished', 2)
    if any(not row['pass'] for row in checks):
        return {'claim': 'native-store', 'mutationRequests': 0}
    identity_path = Path(profile['identity']).resolve(strict=True)
    identity = json.loads(identity_path.read_text())
    native = identity['native']
    check(checks, 'native:binary-pin', digest(native['path']) == native['sha256'],
          'actual frozen rusthrc must match independently supplied executable pin')
    check(checks, 'native:identity-source', bool(native.get('sourceHead'))
          and bool(native.get('sourceTreeSha256')), 'source/build identity is required', 2)
    release = Path(identity['bun']['release'])
    producer = json.loads((release / 'praesidium-release.json').read_text())
    check(checks, 'native:bun-tuple', producer['hrcBuild']['sourceCommit'] == identity['bun']['sourceCommit'],
          'unchanged Bun controls must use the admitted immutable release')
    if any(not row['pass'] for row in checks):
        return {'claim': 'native-store', 'mutationRequests': 0}
    if profile.get('mode') == 'execute':
        batch = output / 'repositories'
        outcomes = execute_repositories(batch, identity_path, Path(profile['frozenBuild']), contract)
        for row in outcomes:
            check(checks, 'native:producer:' + row['family'], row['exit'] == 0,
                  'actual fixed producer command must finish successfully')
    elif profile.get('mode') == 'readback':
        batch = Path(profile['repositories']).resolve(strict=True)
    else:
        check(checks, 'native:mode', False, 'mode must be execute or readback', 2)
        return {'claim': 'native-store', 'mutationRequests': 0}
    raw = command([sys.executable, '-B', str(E2E / 'evidence/revalidate.py'), '--root',
                   str(batch), '--identity', str(identity_path), '--output',
                   str(output / 'repository-revalidation.json')], output / 'repository-checker.command.json')
    observed = json.loads(raw['stdout'])
    assertions = {row['id']: row for row in observed['assertions']}
    check(checks, 'native:raw-completion', raw['captureComplete'] and raw['exit'] in (0, 1, 2),
          'raw checker must finish with typed PASS/FAIL/GAP output', 3)
    check(checks, 'native:repository-raw', observed['status'] == 'PASS',
          'missing/unsupported evidence remains GAP', 1 if observed['status'] == 'FAIL' else 2)
    mapping = json.loads(Path(profile['coverageBindings']).read_text())
    coverage = validate_coverage(mapping, contract, assertions, check, checks)
    # These independently graded families are mandatory and never inherited from
    # the fixed45 producer count. Their raw adapters must be explicitly integrated.
    from native_families import readback
    family_results = {}
    for family in ('finite-reads', 'presentation', 'consumers', 'schema-constraints', 'native-discriminator'):
        location = profile.get('families', {}).get(family)
        if location:
            try:
                family_results[family] = readback(family, location, identity, command, output)
            except FileNotFoundError as error:
                family_results[family] = {'status': 'GAP', 'reason': 'missing raw family receipt: ' + str(error)}
            except (ValueError, KeyError, AssertionError) as error:
                family_results[family] = {'status': 'FAIL', 'reason': 'raw family contradiction: ' + str(error)}
        else:
            family_results[family] = {'status': 'GAP', 'reason': 'missing mandatory raw family location'}
        result = family_results[family]
        check(checks, 'native:required-family:' + family, result['status'] == 'PASS',
              result.get('reason', 'independent raw family reconstruction'),
              1 if result['status'] == 'FAIL' else 2)
        if result['status'] != 'PASS':
            coverage['gaps'].append({'id': family, 'reason': result.get('reason', 'raw family incomplete')})
    if profile['validationSurface'] == 'installed':
        check(checks, 'native:installed-admission', False,
              'canonical installed driver/manifest admission not yet integrated; source evidence cannot certify installed', 2)
    return {'claim': 'native-store', 'validationSurface': profile['validationSurface'],
            'nativeIdentity': native, 'bunIdentity': identity['bun'], 'coverage': coverage,
            'rawAssertions': observed['assertions'], 'familyResults': family_results, 'inventoryComplete': False,
            'behaviorQualified': False, 'complete': True}
