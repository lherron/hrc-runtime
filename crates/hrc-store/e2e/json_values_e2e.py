#!/usr/bin/env python3
"""Deterministic real Bun oracle for JS parsing, property keys and number output."""
import argparse,subprocess,json,random,struct,math,pathlib,os
p=argparse.ArgumentParser();p.add_argument('--binary',required=True);p.add_argument('--artifacts',required=True);a=p.parse_args();out=pathlib.Path(a.artifacts);out.mkdir(parents=True,exist_ok=True)
raw=[r'{"2":2,"1":1,"z":1.0,"negativeZero":-0.0,"unsafe":9007199254740993}',r'{"x":1,"y":2,"x":3,"4294967295":5,"4294967294":4,"00":6,"0":7,"01":8}',r'{"\ud800":"\udfff","\ud800":2,"\ud800\udfff":"\ud800x\udfff","a\u0000b":"\b\t\n\f\r\u0001"}',r'[1e400,-1e400,1e-400,-0,1e-6,1e-7,1e20,1e21,1000000000000000128,0.0000010000000000000002]',r'{"__proto__":3,"constructor":4,"toString":5}',r'"\ud800\ud800\udc00\udc00"',r'"é中🫠\u2028\u2029/"']
rng=random.Random(11528)
for _ in range(20000):
 f=struct.unpack('>d',rng.getrandbits(64).to_bytes(8,'big'))[0]
 if math.isfinite(f):raw.append(repr(f))
invalid=['', '01','-01','+1','1.','1e','1e+','[1,]','{"a":1,}','"\\ud80g"','"\\u123"','"\\x00"','"\x01"','null true','NaN','undefined','[','{"a" 2}','truex']
raw+=invalid
(out/'input.jsonl').write_text('\n'.join(raw)+'\n')
payload='\n'.join(raw)+'\n'
bun=subprocess.run(['bun','-e',"for (const line of (await Bun.stdin.text()).split('\\n').slice(0,-1)) {try { console.log(JSON.stringify(JSON.parse(line))); } catch {console.log('INVALID_JSON');}}"],input=payload,capture_output=True,text=True);assert bun.returncode==0,bun.stderr
native=subprocess.run([a.binary,'json-compat-values'],input=payload,capture_output=True,text=True,env={**os.environ,'PATH':'/usr/bin:/bin','HRC_SOCKET_PATH':'/tmp/hrcp1-absent-json.sock'})
(out/'bun.jsonl').write_text(bun.stdout);(out/'native.jsonl').write_text(native.stdout);(out/'native.stderr').write_text(native.stderr)
expected=bun.stdout.split("\n")[:-1];actual=native.stdout.split("\n")[:-1];differences=[{'index':i,'input':v,'bun':b,'native':n}for i,(v,b,n)in enumerate(zip(raw,expected,actual)) if b!=n]
(out/'comparison.json').write_text(json.dumps({'seed':11528,'inputCount':len(raw),'bunCount':len(expected),'nativeCount':len(actual),'nativeExit':native.returncode,'differences':differences},indent=2));assert native.returncode==0,native.stderr
assert len(raw)==len(expected)==len(actual)
assert not differences,differences[:10]
assert expected[-len(invalid):]==['INVALID_JSON']*len(invalid)
