#!/usr/bin/env python3
"""Bun reappend identity and raw spill excerpts, including UTF-16 slice boundaries."""
import argparse,json,pathlib,subprocess,tempfile,os
p=argparse.ArgumentParser();p.add_argument('--binary',required=True);p.add_argument('--release',required=True);p.add_argument('--artifacts',required=True);a=p.parse_args();out=pathlib.Path(a.artifacts);out.mkdir(parents=True,exist_ok=True)
with tempfile.TemporaryDirectory(prefix='hrcp1-serialization-',dir='/tmp') as root:
    oracle=['bun',str(pathlib.Path(__file__).with_name('oracle.ts')),a.release,root]
    seed=subprocess.run(oracle+['seed'],capture_output=True,text=True);assert seed.returncode==0,seed.stderr
    n=subprocess.run([a.binary,'serialization-contract','--db',str(pathlib.Path(root)/'state.sqlite')],capture_output=True,text=True,env={**os.environ,'PATH':'/usr/bin:/bin','HRC_SOCKET_PATH':str(pathlib.Path(root)/'absent.sock')})
    (out/'native.json').write_text(json.dumps({'exit':n.returncode,'stdout':n.stdout,'stderr':n.stderr},indent=2));assert n.returncode==0,n.stdout+n.stderr
    bun=subprocess.run(oracle+['serialization-read'],capture_output=True,text=True)
    (out/'unchanged-bun.json').write_text(json.dumps({'exit':bun.returncode,'stdout':bun.stdout,'stderr':bun.stderr},indent=2));assert bun.returncode==0,bun.stderr
    b=json.loads(bun.stdout)
    assert b['numericIdempotent'] is True,b.get('numericError')
    assert b['storedNumeric']==b['expectedNumeric'],'numeric serialization differs'
    assert b['storedSpill']==b['expectedSpill'],'raw spill serialization differs'

    def run_evidence(cmd,name,env=None):
        result=subprocess.run(cmd,capture_output=True,text=True,env=env)
        (out/name).write_text(json.dumps({'command':cmd,'exit':result.returncode,'stdout':result.stdout,'stderr':result.stderr},indent=2))
        assert result.returncode==0,result.stdout+result.stderr
        return json.loads(result.stdout)
    written=run_evidence(oracle+['serialization-bun-write'],'bun-write.json')
    assert written['repeat'] and written['conflictRefused'] and written['spillRepeat']
    assert written['expectedDiagnostic']==written['storedDiagnostic']
    native=run_evidence([a.binary,'serialization-observe','--db',str(pathlib.Path(root)/'state.sqlite')],'native-read.json',{**os.environ,'PATH':'/usr/bin:/bin','HRC_SOCKET_PATH':str(pathlib.Path(root)/'absent.sock')})
    control=run_evidence(oracle+['serialization-observe'],'bun-read.json')
    assert native==control,'Bun/native passive page, broker rehydration or lifecycle hydration differ'
    excerpt=native['page']['rows'][-1]['payload']['result']['content'][0]['text']
    head=excerpt.split('\n…[',1)[0]
    assert len(head.encode('utf-16-le','surrogatepass'))//2==4095
    assert not 0xd800<=int.from_bytes(head.encode('utf-16-le','surrogatepass')[-2:],'little')<=0xdbff
    assert native['hydrated']['payload']['result']=='X'+'🫠'*20000
