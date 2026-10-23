"""Real-evidence controls for exact source invocation bindings (no producer runs)."""
import argparse
import json
from pathlib import Path
import shutil
import subprocess
import sys
from controls import manifest

TARGET = 'active_delivery_e2e/L8C115'


def run(root, identity, out):
    out.mkdir(parents=True, exist_ok=False)
    checker = Path(__file__).with_name('revalidate.py')
    def check(candidate, label):
        p = subprocess.run([sys.executable, '-B', str(checker), '--root', str(candidate), '--identity', str(identity)], capture_output=True)
        (out / (label + '.json')).write_bytes(p.stdout)
        (out / (label + '.stderr')).write_bytes(p.stderr)
        result = json.loads(p.stdout)
        return {r['id']: r for r in result['assertions']}
    baseline = check(root, 'baseline')
    results = []
    for case in ('wrong-scenario', 'nonzero-exit', 'missing-stdout'):
        candidate = out / case
        shutil.copytree(root, candidate)
        family = candidate / 'active_delivery_e2e'
        path = next(p for p in (family / 'commands').glob('*.json') if json.loads(p.read_text())['argv'][0] == json.loads((candidate / 'identity.json').read_text())['native']['path'])
        command = json.loads(path.read_text())
        if case == 'wrong-scenario':
            command['argv'][1] = command['command'][1] = 'wrong-contract'
            for file in (candidate / 'identity.json', family / 'capture.json'):
                value = json.loads(file.read_text())
                for leg in value['legs']:
                    if leg['family'] == 'active_delivery_e2e' and leg['receipt'] == 'commands/' + path.name:
                        leg['command'] = command['command']
                file.write_text(json.dumps(value))
        elif case == 'nonzero-exit':
            command['exit'] = 7
            value = json.loads((family / 'native.json').read_text()); value['exit'] = 7
            (family / 'native.json').write_text(json.dumps(value))
        else:
            del command['stdout']
        path.write_text(json.dumps(command))
        manifest(candidate)
        rows = check(candidate, case)
        results.append({'case': case, 'baseline': baseline[TARGET]['status'], 'target': rows[TARGET]['status'], 'reason': rows[TARGET]['reason'], 'manifest': rows['integrity/manifest']['status'], 'accepted': baseline[TARGET]['status'] == 'PASS' and rows[TARGET]['status'] != 'PASS' and rows['integrity/manifest']['status'] == 'PASS'})
    result = {'passed': all(r['accepted'] for r in results), 'controls': results}
    (out / 'controls.json').write_text(json.dumps(result, indent=2))
    print(json.dumps(result))
    return result


if __name__ == '__main__':
    p = argparse.ArgumentParser(); p.add_argument('--root', type=Path, required=True); p.add_argument('--identity', type=Path, required=True); p.add_argument('--out', type=Path, required=True); a = p.parse_args()
    sys.exit(0 if run(a.root, a.identity, a.out)['passed'] else 1)
