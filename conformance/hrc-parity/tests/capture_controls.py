#!/usr/bin/env python3
"""Real process capture controls; no database, daemon, build or installed claim."""
import argparse,hashlib,importlib.util,json,pathlib,subprocess,sys,tempfile
p=argparse.ArgumentParser();p.add_argument('--binary',required=True);p.add_argument('--out',required=True);a=p.parse_args()
out=pathlib.Path(a.out);out.mkdir(parents=True,exist_ok=True)
path=pathlib.Path(__file__).resolve().parents[1]/'native_capture.py'
spec=importlib.util.spec_from_file_location('native_capture',path);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
native={'path':str(pathlib.Path(a.binary).resolve()),'sha256':hashlib.sha256(pathlib.Path(a.binary).read_bytes()).hexdigest(),'sourceHead':'capture-control-only','sourceTreeSha256':'capture-control-only'}
identity={'native':native,'bun':{'release':'capture-control-no-Bun','sourceCommit':'not-a-Bun-qualification'}}
with module.ProcessRecorder(out,'capture-control',identity)as recorder:
 r=subprocess.run([native['path'],'json-compat-values'],input='{"2":2,"1":1}\n',capture_output=True,text=True)
 assert r.returncode==0 and r.stdout=='{"1":1,"2":2}\n'
 child=subprocess.Popen([native['path'],'json-compat-values'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
 child.stdin.write('{"a":1}\n');child.stdin.flush()
 first=child.stdout.readline();assert first=='{"a":1}\n'
 child.stdin.close();child.stdin=None
 remaining,stderr=child.communicate(timeout=5);assert remaining==''and stderr==''
 false=subprocess.run(['/usr/bin/false'],capture_output=True,text=True);assert false.returncode==1
receipts=[json.loads(path.read_text())for path in sorted((out/'commands').glob('*.json'))]
assert len(receipts)==3 and [r['exit']for r in receipts]==[0,0,1]
for receipt,payload in zip(receipts,['{"2":2,"1":1}\n','{"a":1}\n']):
 assert receipt['stdin']=={'present':True,'bytes':len(payload.encode()),'sha256':hashlib.sha256(payload.encode()).hexdigest(),'literalNewlineCount':1}
assert receipts[2]['stdin']['present']is False
assert receipts[1]['stdout']==first and receipts[1]['command']==[native['path'],'json-compat-values']
for r in receipts:
 assert r['completedAt']>=r['startedAt'] and r['pid']>0 and r['nativeBefore']==r['nativeAfter']=={'path':native['path'],'sha256':native['sha256']}
try:
 with module.ProcessRecorder(out/'wrong','capture-control',{**identity,'native':{**native,'sha256':'0'*64}}):raise AssertionError('wrong binary admitted')
except ValueError:pass
(out/'summary.json').write_text(json.dumps({'status':'PASS','realReceipts':3,'partialPipeOutputRetained':True,'nonzeroIsRecordedNotPassed':True,'wrongHashRefusedBeforeLaunch':True},indent=2))
