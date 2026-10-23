#!/usr/bin/env python3
"""Tamper genuine run artifacts; external validator must reject each change."""
import argparse
import json
from pathlib import Path
import shutil
import subprocess
import tempfile


def main():
    p = argparse.ArgumentParser(); p.add_argument('evidence'); p.add_argument('--out', required=True)
    a = p.parse_args(); source = Path(a.evidence).resolve(); out = Path(a.out)
    assert not out.exists(); out.mkdir()
    validator = Path(__file__).with_name('validate.py')
    results = []
    for control in ('remove-required-assertion', 'remove-case', 'remove-command', 'truncate-stdout', 'erase-native-rows', 'incomplete-run'):
        with tempfile.TemporaryDirectory(prefix='hrcp1-evidence-control-') as temp:
            target = Path(temp) / 'evidence'; shutil.copytree(source, target)
            summary = json.loads((target / 'summary.json').read_text())
            if control == 'remove-required-assertion':
                summary['cases'][0]['assertions'] = []
            elif control == 'remove-case':
                summary['cases'] = summary['cases'][1:]
            elif control == 'incomplete-run':
                summary['complete'] = False
            elif control == 'erase-native-rows':
                artifact = target / 'C01/native-history-rows.json'
                data = json.loads(artifact.read_text()); data['hrc_events'] = []
                artifact.write_text(json.dumps(data))
            else:
                command = next((target / 'C02').glob('*native-reload.json'))
                if control == 'remove-command':
                    command.unlink()
                else:
                    data = json.loads(command.read_text()); data['stdout'] = '{'
                    command.write_text(json.dumps(data))
            (target / 'summary.json').write_text(json.dumps(summary))
            process = subprocess.run(['python3', '-B', str(validator), str(target)], capture_output=True, text=True)
            record = {'control': control, 'exit': process.returncode, 'stdout': process.stdout, 'stderr': process.stderr}
            (out / (control + '.json')).write_text(json.dumps(record, indent=2) + '\n')
            assert process.returncode != 0, 'inadequate evidence accepted: ' + control
            results.append(record)
    (out / 'summary.json').write_text(json.dumps({'claim': 'checker-controls-only', 'rejected': [r['control'] for r in results]}, indent=2) + '\n')


if __name__ == '__main__':
    main()
