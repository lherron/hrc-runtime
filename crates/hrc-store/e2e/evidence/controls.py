"""Behavior-first adversarial checks against owned copies of real retained evidence."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys


def manifest(root):
    files = {str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest()
             for p in sorted(root.rglob('*')) if p.is_file() and str(p.relative_to(root)) not in ('manifest.json', 'SHA256SUMS')}
    (root / 'manifest.json').write_text(json.dumps(files, indent=2) + '\n')
    (root / 'SHA256SUMS').write_text(''.join(digest + '  ' + path + '\n' for path, digest in files.items()))


def edit_stdout(root, family, receipt, edit):
    path = root / family / receipt
    raw = json.loads(path.read_text())
    body = json.loads(raw['stdout'])
    edit(body)
    raw['stdout'] = json.dumps(body)
    path.write_text(json.dumps(raw))


def run(source, out, identity=None):
    out.mkdir(parents=True, exist_ok=False)
    checker = Path(__file__).with_name('revalidate.py')
    cases = [
        ('missing-field', 'reconciliation_e2e/cas-results',
         lambda r: edit_stdout(r, 'reconciliation_e2e', 'native.json', lambda b: b['results'][0].pop('changed'))),
        ('missing-command', 'reconciliation_e2e/cas-results',
         lambda r: (r / 'reconciliation_e2e/native.json').unlink()),
        ('both-empty', 'reconciliation_e2e/cas-results',
         lambda r: [edit_stdout(r, 'reconciliation_e2e', n + '.json', lambda b: b.update(results=[])) for n in ('bun', 'native')]),
        ('wrong-order', 'reconciliation_e2e/cas-results',
         lambda r: edit_stdout(r, 'reconciliation_e2e', 'native.json', lambda b: b['results'].reverse())),
        ('zero-effect', 'reconciliation_e2e/cas-effects',
         lambda r: shutil.copyfile(r / 'reconciliation_e2e/native-before.json', r / 'reconciliation_e2e/native-after.json')),
        ('changed-row', 'reconciliation_e2e/cas-effects',
         lambda r: change_row(r)),
        ('rollback-gap', 'reconciliation_e2e/atomic-boundaries',
         lambda r: edit_stdout(r, 'reconciliation_e2e', 'native.json', lambda b: b.pop('boundaries'))),
        ('identity-substitution', 'identity/root',
         lambda r: change_identity(r)),
        ('malformed-receipt', 'reconciliation_e2e/cas-results',
         lambda r: (r / 'reconciliation_e2e/native.json').write_text('{broken')),
        ('mail-cardinality', 'mail_body_e2e/utf16-body',
         lambda r: edit_stdout(r, 'mail_body_e2e', 'native-writer.json', lambda b: b['results'].pop())),
        ('source-substitution', 'active_delivery_e2e/identity',
         lambda r: (r / 'active_delivery_e2e/source/crates/hrc-store/e2e/active_delivery_e2e.py').write_text('# substituted source\n')),
        ('observer-order', 'reconciliation_e2e/atomic-boundaries',
         lambda r: edit_stdout(r, 'reconciliation_e2e', 'native.json', lambda b: b['boundaries'][-1]['hints'].reverse())),
        ('fts-order', 'transcript_e2e/fts-transaction-readbacks',
         lambda r: edit_stdout(r, 'transcript_e2e', 'native.json', lambda b: b['boundaries'][5]['state']['cafe'].reverse())),
        ('part-refusal-effect', 'atomic_e2e/invalid-part-effects',
         lambda r: edit_stdout(r, 'atomic_e2e', 'native-atomic.json', lambda b: b['observations']['partBoundaries'][2]['state']['parts'].clear())),
        ('roster-rollback-leak', 'repository_e2e/roster-atomicity',
         lambda r: edit_stdout(r, 'repository_e2e', 'native.json', lambda b: b['observations']['rosterRollback']['after']['roster'].append({'idempotencyKey':'leaked'}))),
    ]
    baseline_command = [sys.executable, '-B', str(checker), '--root', str(source)]
    if identity:
        baseline_command += ['--identity', str(identity)]
    baseline_process = subprocess.run(baseline_command, capture_output=True, text=True)
    baseline = json.loads(baseline_process.stdout)
    (out / 'baseline.json').write_text(baseline_process.stdout)
    baseline_rows = {v['id']: v for v in baseline['assertions']}
    results = []
    for name, assertion_id, mutate in cases:
        target = out / name
        # Backups are copied, never opened writable or altered by these controls.
        shutil.copytree(source, target)
        mutate(target)
        manifest(target)  # A coherent manifest must NOT make the semantic variant pass.
        command = [sys.executable, '-B', str(checker), '--root', str(target)]
        if identity:
            command += ['--identity', str(identity)]
        p = subprocess.run(command, capture_output=True, text=True)
        (out / (name + '-result.json')).write_text(p.stdout)
        try:
            result = json.loads(p.stdout)
            row = next(x for x in result['assertions'] if x['id'] == assertion_id)
            integrity = next(x for x in result['assertions'] if x['id'] == 'integrity/manifest')
            accepted = baseline_rows[assertion_id]['status'] == 'PASS' and row['status'] != 'PASS' and p.returncode != 0 and integrity['status'] == 'PASS'
            if name == 'identity-substitution':
                accepted = accepted and row['status'] == 'FAIL'
            results.append({'control': name, 'target': assertion_id, 'accepted': accepted,
                            'integrityStatus': integrity['status'], 'baselineStatus': baseline_rows[assertion_id]['status'], 'status': row['status'], 'reason': row['reason'], 'exit': p.returncode})
        except (ValueError, KeyError, StopIteration) as e:
            results.append({'control': name, 'accepted': False, 'error': str(e), 'stdout': p.stdout, 'stderr': p.stderr})
    result = {'controls': results, 'passed': all(x['accepted'] for x in results)}
    (out / 'controls.json').write_text(json.dumps(result, indent=2) + '\n')
    return result


def change_identity(root):
    path = root / 'identity.json'
    observed = json.loads(path.read_text())
    observed['native']['sha256'] = '0' * 64
    path.write_text(json.dumps(observed))


def change_row(root):
    path = root / 'reconciliation_e2e/native-after.json'
    body = json.loads(path.read_text())
    body['runs'][0]['status'] = 'TAMPERED'
    path.write_text(json.dumps(body))


if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('source', type=Path)
    p.add_argument('--out', required=True, type=Path)
    p.add_argument('--identity', type=Path)
    a = p.parse_args()
    try:
        result = run(a.source, a.out, a.identity)
    except Exception as e:
        result = {'passed': False, 'error': type(e).__name__ + ': ' + str(e)}
    print(json.dumps(result, indent=2))
    raise SystemExit(0 if result['passed'] else 1)
