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
    for control in ('remove-required-assertion', 'remove-case', 'remove-command', 'truncate-stdout', 'erase-native-rows', 'incomplete-run', 'coherent-missing-annotation-negative', 'coherent-capture-hole-cleared', 'coherent-monitor-wrong-head', 'coherent-maintenance-hydration-erased', 'coherent-restub-skip-erased', 'coherent-wrong-native-identity', 'coherent-native-archive-payload', 'coherent-spill-append-timing'):
        with tempfile.TemporaryDirectory(prefix='hrcp1-evidence-control-') as temp:
            target = Path(temp) / 'evidence'; shutil.copytree(source, target)
            summary = json.loads((target / 'summary.json').read_text())
            coherent = control.startswith('coherent-')
            if control == 'coherent-native-archive-payload':
                command = next((target / 'C06').glob('*-native-archive-reopen.json'))
                data = json.loads(command.read_text()); body = json.loads(data['stdout'])
                body['events'][0]['eventJson'] = {'wrong': True}
                data['stdout'] = json.dumps(body); data['body'] = body
                command.write_text(json.dumps(data))
            elif control == 'coherent-spill-append-timing':
                command = next((target / 'C05').glob('*-native-during-spill.json'))
                data = json.loads(command.read_text()); data['startedAt'] = 946684800; data['endedAt'] = 946684801
                command.write_text(json.dumps(data))
            elif control == 'coherent-wrong-native-identity':
                artifact = target / 'identity.json'
                data = json.loads(artifact.read_text()); data['nativeRealpath'] = data['bunRealpath']
                artifact.write_text(json.dumps(data))
            elif control == 'coherent-missing-annotation-negative':
                next((target / 'C02').glob('*-invalid-json.json')).unlink()
            elif control == 'coherent-capture-hole-cleared':
                command = next((target / 'C03').glob('*-sequence-hole.json'))
                data = json.loads(command.read_text()); body = json.loads(data['stdout'])
                body['findings'] = []; body['status'] = 'pass'; body['ok'] = True
                data['stdout'] = json.dumps(body); data['body'] = body; data['exit'] = 0
                command.write_text(json.dumps(data))
            elif control == 'coherent-monitor-wrong-head':
                command = next((target / 'C04').glob('*-real-monitor-show.json'))
                data = json.loads(command.read_text()); body = json.loads(data['stdout'])
                body['eventLog']['highWaterSeq'] += 100
                data['stdout'] = json.dumps(body); data['body'] = body
                command.write_text(json.dumps(data))
            elif control == 'coherent-maintenance-hydration-erased':
                command = next((target / 'C05').glob('*-native-maintenance-read.json'))
                data = json.loads(command.read_text()); body = json.loads(data['stdout'])
                for item in body.values():
                    item['brokerEvents'] = []; item['lifecycle'] = []
                data['stdout'] = json.dumps(body); data['body'] = body
                command.write_text(json.dumps(data))
            elif control == 'coherent-restub-skip-erased':
                command = next((target / 'C05').glob('*-restub-apply.json'))
                data = json.loads(command.read_text())
                records = [json.loads(line) for line in data['stdout'].splitlines()]
                for record in records:
                    if record.get('event') == 'prune.report':
                        record['data']['brokerInvocationEvents']['skipped']['missingBlob'] = 0
                data['stdout'] = '\n'.join(json.dumps(r) for r in records) + '\n'
                command.write_text(json.dumps(data))
            elif control == 'remove-required-assertion':
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
            if coherent:
                import hashlib
                files = sorted(p for p in target.rglob('*') if p.is_file() and p.name != 'SHA256SUMS')
                (target / 'SHA256SUMS').write_text(''.join(hashlib.sha256(p.read_bytes()).hexdigest() + '  ' + str(p.relative_to(target)) + '\n' for p in files))
            process = subprocess.run(['python3', '-B', str(validator), str(target)], capture_output=True, text=True)
            record = {'control': control, 'exit': process.returncode, 'stdout': process.stdout, 'stderr': process.stderr}
            (out / (control + '.json')).write_text(json.dumps(record, indent=2) + '\n')
            assert process.returncode != 0, 'inadequate evidence accepted: ' + control
            results.append(record)
    (out / 'summary.json').write_text(json.dumps({'claim': 'checker-controls-only', 'rejected': [r['control'] for r in results]}, indent=2) + '\n')


if __name__ == '__main__':
    main()
