#!/usr/bin/env python3
"""Pin real WAL read snapshot while independent unchanged Bun writer commits."""
import argparse,json,pathlib,subprocess,tempfile,os,time
p=argparse.ArgumentParser();p.add_argument('--binary',required=True);p.add_argument('--release',required=True);p.add_argument('--artifacts',required=True);a=p.parse_args();out=pathlib.Path(a.artifacts);out.mkdir(parents=True,exist_ok=True)
with tempfile.TemporaryDirectory(prefix='hrcp1-snapshot-',dir='/tmp') as root:
    root=pathlib.Path(root);oracle=['bun',str(pathlib.Path(__file__).with_name('oracle.ts')),a.release,str(root)]
    seed=subprocess.run(oracle+['seed'],capture_output=True,text=True);assert seed.returncode==0,seed.stderr
    child=subprocess.Popen([a.binary,'snapshot-contract','--db',str(root/'state.sqlite')],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env={**os.environ,'PATH':'/usr/bin:/bin','HRC_SOCKET_PATH':str(root/'absent.sock')})
    deadline=time.monotonic()+8
    while not (root/'snapshot-pinned').exists() and child.poll() is None and time.monotonic()<deadline:time.sleep(.01)
    if not (root/'snapshot-pinned').exists():
        stdout,stderr=child.communicate(timeout=2);(out/'native.json').write_text(json.dumps({'exit':child.returncode,'stdout':stdout,'stderr':stderr},indent=2));raise AssertionError('native did not pin snapshot: '+stdout+stderr)
    writer=subprocess.run(oracle+['append-control'],capture_output=True,text=True);(out/'bun-writer.json').write_text(json.dumps({'exit':writer.returncode,'stdout':writer.stdout,'stderr':writer.stderr},indent=2));assert writer.returncode==0,writer.stderr
    (root/'snapshot-continue').write_text('writer committed')
    stdout,stderr=child.communicate(timeout=8);(out/'native.json').write_text(json.dumps({'exit':child.returncode,'stdout':stdout,'stderr':stderr},indent=2));assert child.returncode==0,stdout+stderr
    r=json.loads(stdout);assert r['before']==r['during'] and r['after']['head']==r['before']['head']+1
    assert r['after']['rows'][-1]['payload']['text']=='Bun mutation control'
    assert len(r['after']['rows'])==len(r['before']['rows'])+1
