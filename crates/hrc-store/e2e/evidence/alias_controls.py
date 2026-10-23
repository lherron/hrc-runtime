"""Coherent real-evidence controls for reviewed retained-data alias bindings."""
import argparse
import json
from pathlib import Path
import shutil
import subprocess
import sys
from controls import manifest


def replace_stdout(root, family, name, transform):
    path = root / family / name
    old = path.read_text() if path.suffix == '.jsonl' else json.loads(path.read_text())['stdout']
    new = transform(old)
    if path.suffix == '.jsonl':
        path.write_text(new)
    else:
        value = json.loads(path.read_text()); value['stdout'] = new
        path.write_text(json.dumps(value, ensure_ascii=True))
    command_hint = None if path.suffix == '.jsonl' else json.loads(path.read_text()).get('command')
    native_path = json.loads((root / 'identity.json').read_text())['native']['path']
    matches = []
    for command in (root / family / 'commands').glob('*.json'):
        raw = json.loads(command.read_text())
        same_producer = ((raw['argv'][0] == native_path) == (path.stem == 'native')) if path.suffix == '.jsonl' else (command_hint is None or raw['argv'] == command_hint)
        if raw['stdout'] == old and same_producer:
            matches.append(command)
    if len(matches) != 1:
        raise AssertionError('control needs unique original raw command')
    raw = json.loads(matches[0].read_text()); raw['stdout'] = new
    matches[0].write_text(json.dumps(raw, ensure_ascii=True))


def change_json(value, field, replacement):
    body = json.loads(value); body[field] = replacement
    return json.dumps(body, ensure_ascii=True)


def mutate(root, case):
    if case == 'jsonl-cardinality':
        replace_stdout(root, 'json_values_e2e', 'native.jsonl', lambda s: '\n'.join(s.split('\n')[:-2]) + '\n')
    elif case == 'both-invalid-tail':
        for side in ('bun', 'native'):
            replace_stdout(root, 'json_values_e2e', side + '.jsonl', lambda s: '\n'.join(s.split('\n')[:-2] + ['null', '']))
    elif case == 'prune-return':
        replace_stdout(root, 'prune_e2e', 'native-minimal.json', lambda s: change_json(s, 'removed', -1))
    elif case == 'prune-state':
        path = root / 'prune_e2e/remaining-minimal.json'
        value = json.loads(path.read_text()); value['native']['event_stream_cursor'] = []
        path.write_text(json.dumps(value, ensure_ascii=True))
    elif case == 'both-read-predicate':
        def transform(s):
            value = json.loads(s); value['result']['accepted'] = [0, None]
            return json.dumps(value, ensure_ascii=True)
        for side in ('bun', 'native'):
            replace_stdout(root, 'read_predicates_e2e', side + '.json', transform)


def run(root, identity, out):
    out.mkdir(parents=True, exist_ok=False)
    checker = Path(__file__).with_name('revalidate.py')
    def check(candidate, label):
        p = subprocess.run([sys.executable, '-B', str(checker), '--root', str(candidate), '--identity', str(identity)], capture_output=True)
        (out / (label + '.json')).write_bytes(p.stdout)
        (out / (label + '.stderr')).write_bytes(p.stderr)
        return {r['id']: r for r in json.loads(p.stdout)['assertions']}
    baseline = check(root, 'baseline')
    targets = {'jsonl-cardinality': 'json_values_e2e/L19C0',
               'both-invalid-tail': 'json_values_e2e/L21C0',
               'prune-return': 'prune_e2e/L28C8:variant=minimal',
               'prune-state': 'prune_e2e/L31C164:variant=minimal',
               'both-read-predicate': 'read_predicates_e2e/L47C24'}
    results = []
    for case, target in targets.items():
        candidate = out / case; shutil.copytree(root, candidate)
        mutate(candidate, case); manifest(candidate)
        rows = check(candidate, case); family = target.split('/')[0]
        results.append({'control': case, 'target': target, 'baseline': baseline[target]['status'],
                        'status': rows[target]['status'], 'reason': rows[target]['reason'],
                        'identity': rows[family + '/identity']['status'],
                        'manifest': rows['integrity/manifest']['status'],
                        'accepted': baseline[target]['status'] == 'PASS' and rows[target]['status'] == 'FAIL' and rows[family + '/identity']['status'] == 'PASS' and rows['integrity/manifest']['status'] == 'PASS'})
    result = {'passed': all(r['accepted'] for r in results), 'controls': results}
    (out / 'controls.json').write_text(json.dumps(result, indent=2, ensure_ascii=True) + '\n')
    print(json.dumps({'passed': result['passed'], 'controls': len(results)}))
    return result


if __name__ == '__main__':
    p = argparse.ArgumentParser(); p.add_argument('--root', type=Path, required=True); p.add_argument('--identity', type=Path, required=True); p.add_argument('--out', type=Path, required=True); a = p.parse_args()
    sys.exit(0 if run(a.root, a.identity, a.out)['passed'] else 1)
