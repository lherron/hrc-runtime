"""Real pure JSON depth/order/refusal controls; no daemon or SQL fixture."""
import argparse,hashlib,json,subprocess
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--binary',required=True);p.add_argument('--artifacts',required=True);a=p.parse_args()
out=Path(a.artifacts);out.mkdir(parents=True,exist_ok=False)
binary=Path(a.binary).resolve();sha=hashlib.sha256(binary.read_bytes()).hexdigest()
lines=[];cases=[]
for kind in ['array','object','mixed']:
 for depth in [64,127,128,129,256,512,1024,4096,8192,16384,32768]:
  prefix=['[' if kind=='array' or kind=='mixed' and i%2==0 else '{"x":' for i in range(depth)]
  suffix=[']' if v=='[' else '}' for v in prefix]
  lines.append(''.join(prefix)+'0'+''.join(reversed(suffix)));cases.append({'kind':kind,'depth':depth})
for value in ['[0,]','{"x":0,}','[','{','01','[true false]','{"x" 0}','[null]junk','{"2":2,"1":1,"x":0,"x":1}']:
 lines.append(value);cases.append({'kind':'refusal-or-order','index':len(cases)})
raw=('\n'.join(lines)+'\n').encode();(out/'input.jsonl').write_bytes(raw);(out/'cases.json').write_text(json.dumps(cases))
commands=[]
def run(argv,**kwargs):
 r=subprocess.run(argv,capture_output=True,**kwargs);commands.append({'argv':argv,'exit':r.returncode,'stdoutBytes':len(r.stdout),'stderr':r.stderr.decode(errors='backslashreplace')});(out/'commands.json').write_text(json.dumps(commands,indent=2));assert r.returncode==0;return r
run(['bun',str(Path(__file__).with_name('oracle.ts')),str(out/'input.jsonl'),str(out/'bun.jsonl')])
r=run([str(binary),'json-compat-values'],input=raw);(out/'native.jsonl').write_bytes(r.stdout)
assert r.stdout==(out/'bun.jsonl').read_bytes()
assert hashlib.sha256(binary.read_bytes()).hexdigest()==sha
(out/'summary.json').write_text(json.dumps({'status':'PASS','scope':'PURE_JSON_SOURCE_SUBSET','nativeSha256':sha,'cases':len(cases),'stdinSha256':hashlib.sha256(raw).hexdigest()},indent=2))
