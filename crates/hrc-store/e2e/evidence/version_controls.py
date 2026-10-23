"""Real329 controls for caller-pinned source selection and unknown-source refusal."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
from controls import manifest


def run(root, identity, out):
    out.mkdir(parents=True, exist_ok=False)
    checker = Path(__file__).with_name('revalidate.py')
    def check(candidate, pin, name):
        p = subprocess.run([sys.executable, '-B', str(checker), '--root', str(candidate), '--identity', str(pin)], capture_output=True)
        (out / (name + '.json')).write_bytes(p.stdout)
        (out / (name + '.stderr')).write_bytes(p.stderr)
        result = json.loads(p.stdout)
        return {r['id']: r for r in result['assertions']}
    family = 'serialization_e2e'; source = 'crates/hrc-store/e2e/serialization_e2e.py'
    baseline = check(root, identity, 'baseline')
    source_baseline = baseline['serialization_e2e/L14C4']
    if source_baseline['status'] != 'PASS' or source_baseline.get('sourceSha256') != json.loads(identity.read_text())['sources'][family]:
        raise AssertionError('known historical source assertion baseline was not reconstructed')
    targets = []
    for case in ('caller-source-mismatch', 'unreviewed-coherent-source'):
        candidate = out / case; shutil.copytree(root, candidate)
        expected = json.loads(identity.read_text())
        if case == 'caller-source-mismatch':
            expected['sources'][family] = 'f' * 64
        else:
            raw = b'# deliberately unreviewed source; no producer execution\n'
            digest = hashlib.sha256(raw).hexdigest()
            expected['sources'][family] = digest
            observed = json.loads((candidate / 'identity.json').read_text())
            observed['sources'][family] = digest
            (candidate / 'identity.json').write_text(json.dumps(observed))
            for directory in candidate.iterdir():
                before = directory / 'sources-before.json'
                after = directory / 'sources-after.json'
                retained = directory / 'source' / source
                if not before.is_file():
                    continue
                for path in (before, after):
                    value = json.loads(path.read_text()); value[source] = digest
                    path.write_text(json.dumps(value))
                retained.write_bytes(raw)
            entry = candidate / family / 'entry.json'
            value = json.loads(entry.read_text()); value['scriptSha256'] = digest
            value['identity']['sources'][family] = digest
            entry.write_text(json.dumps(value))
        pin = out / (case + '-pin.json'); pin.write_text(json.dumps(expected))
        manifest(candidate)
        rows = check(candidate, pin, case)
        target = rows[family + '/identity']
        source_rows = [r for r in rows.values() if r['family'] == family and r.get('scope') == 'raw-output-only']
        accepted = baseline[family + '/identity']['status'] == 'PASS' and rows['integrity/manifest']['status'] == 'PASS'
        if case == 'caller-source-mismatch':
            accepted = accepted and target['status'] == 'FAIL' and 'caller' in target['reason']
        else:
            accepted = accepted and target['status'] == 'GAP' and 'unreviewed' in target['reason'] and not source_rows and rows['identity/root']['status'] == 'PASS'
        targets.append({'control': case, 'baseline': baseline[family + '/identity']['status'], 'status': target['status'], 'reason': target['reason'], 'manifest': rows['integrity/manifest']['status'], 'attributedSourceRows': len(source_rows), 'accepted': accepted})
    result = {'passed': all(r['accepted'] for r in targets), 'controls': targets}
    (out / 'controls.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({'passed': result['passed'], 'controls': len(targets)}))
    return result


if __name__ == '__main__':
    p = argparse.ArgumentParser(); p.add_argument('--root', type=Path, required=True); p.add_argument('--identity', type=Path, required=True); p.add_argument('--out', type=Path, required=True); a = p.parse_args()
    sys.exit(0 if run(a.root, a.identity, a.out)['passed'] else 1)
