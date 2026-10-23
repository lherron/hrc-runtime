#!/usr/bin/env python3
"""Pure native mail canonicalization/fingerprint paired with unchanged installed exports."""
import argparse,pathlib,subprocess,json,random,os
p=argparse.ArgumentParser();p.add_argument('--binary',required=True);p.add_argument('--release',required=True);p.add_argument('--artifacts',required=True);a=p.parse_args();out=pathlib.Path(a.artifacts);out.mkdir(parents=True,exist_ok=True)
raw=[r'{"z":1,"a":{"__proto__":{"x":1},"constructor":2,"b":3,"a":4},"__proto__":2}',r'{"\ud800":3,"é":1,"😀":2,"a":4,"\udfff":5}',r'{"2":2,"1":1,"4294967295":3,"01":4,"0":5,"negativeZero":-0,"unsafe":9007199254740993}',r'[{"y":2,"x":1},{"x":1,"y":2}]',r'{"a":1,"a":2,"b":3}']
rng=random.Random(11528)
for i in range(1000):
 keys=['z','a','__proto__','constructor','1','0','01','4294967295','\ud800','😀']
 rng.shuffle(keys)
 raw.append(json.dumps({key:{'number':rng.random()*10**rng.randrange(-10,24),'text':key} for key in keys},ensure_ascii=True))
payload='\n'.join(raw)+'\n';(out/'input.jsonl').write_text(payload)
code="""const {canonicalHrcMailJson,fingerprintHrcMailJson}=await import(process.argv[1]+'/packages/hrc-store-sqlite/src/mail/reply-schema.ts');for(const line of (await Bun.stdin.text()).split('\\n').slice(0,-1)){const value=JSON.parse(line);console.log(JSON.stringify({canonical:canonicalHrcMailJson(value),fingerprint:fingerprintHrcMailJson(value)}));}"""
b=subprocess.run(['bun','-e',code,a.release],input=payload,capture_output=True,text=True);(out/'bun.jsonl').write_text(b.stdout);assert b.returncode==0,b.stderr
n=subprocess.run([a.binary,'mail-json-values'],input=payload,capture_output=True,text=True,env={**os.environ,'PATH':'/usr/bin:/bin'});(out/'native.jsonl').write_text(n.stdout);(out/'native.stderr').write_text(n.stderr);assert n.returncode==0,n.stderr
assert len(b.stdout.split('\n'))==len(raw)+1
assert n.stdout==b.stdout
