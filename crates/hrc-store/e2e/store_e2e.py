#!/usr/bin/env python3
"""External real-SQLite store checks. Missing binary/empty evidence cannot pass."""
import argparse
import json
import pathlib
import subprocess
import tempfile


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--binary', required=True)
    p.add_argument('--release', required=True)
    p.add_argument('--artifacts', required=True)
    a = p.parse_args()
    out = pathlib.Path(a.artifacts)
    out.mkdir(parents=True, exist_ok=True)
    checks = []
    with tempfile.TemporaryDirectory(prefix='hrcp1-store-', dir='/tmp') as scratch:
        def call(name, argv, expected=0):
            try:
                r = subprocess.run(argv, capture_output=True, text=True, timeout=30)
                evidence = {'argv':argv, 'exit':r.returncode, 'stdout':r.stdout, 'stderr':r.stderr}
            except OSError as e:
                evidence = {'argv':argv, 'exit':127, 'stderr':str(e), 'stdout':''}
            (out/(name+'.json')).write_text(json.dumps(evidence, indent=2)+'\n')
            assert evidence['exit'] == expected, (name,evidence)
            return json.loads(evidence['stdout']) if evidence['stdout'].strip() else None
        oracle = str(pathlib.Path(__file__).with_name('oracle.ts'))
        seed = call('bun-seed', ['bun',oracle,a.release,scratch,'seed'])
        assert seed['head'] == 4 and len(seed['page']['rows']) == 2
        checks.append('real-bun-nonempty-highwater-oracle')
        missing = pathlib.Path(scratch)/'absent.sqlite'
        call('missing-refusal',[a.binary,'inspect','--db',str(missing)],1)
        assert not missing.exists()
        checks.append('missing-store-no-create')
        db = str(pathlib.Path(scratch)/'state.sqlite')
        page = call('native-page',[a.binary,'page','--db',db,'--after','0','--limit','10'])
        assert page == seed['page'], (page,seed['page'])
        checks.append('native-page-holes-deleted-highest')
        full = call('native-full',[a.binary,'page','--db',db,'--after','0','--limit','1'])
        assert len(full['rows']) == 1 and full['scannedThrough'] == full['rows'][0]['hrcSeq'] < full['head']
        checks.append('full-page-coverage')
        call('incarnation-refusal',[a.binary,'page','--db',db,'--after','0','--limit','1','--incarnation','wrong'],1)
        checks.append('incarnation-refusal')
        result = {'complete':True,'claim':'p1-source-subset','checks':checks,'nativeBunDaemonUsed':False}
        (out/'summary.json').write_text(json.dumps(result,indent=2)+'\n')
        print(json.dumps(result))


if __name__ == '__main__':
    main()
