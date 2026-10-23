#!/usr/bin/env python3
"""Pure reply-schema outcomes paired with actual unchanged installed Bun exports."""
import argparse,json,pathlib,subprocess,os
p=argparse.ArgumentParser();p.add_argument('--binary',required=True);p.add_argument('--release',required=True);p.add_argument('--artifacts',required=True);a=p.parse_args();out=pathlib.Path(a.artifacts);out.mkdir(parents=True,exist_ok=True)
source=pathlib.Path(__file__).parent/'fixtures/reply-schema.jsonl';payload=source.read_text();(out/'input.jsonl').write_text(payload)
code="""const {validateHrcMailReply}=await import(process.argv[1]+'/packages/hrc-store-sqlite/src/mail/reply-schema.ts');for(const line of (await Bun.stdin.text()).split('\\n').slice(0,-1)){const input=JSON.parse(line);try{console.log(JSON.stringify({result:validateHrcMailReply(input.schema,input.response)}))}catch(error){console.log(JSON.stringify({error:{name:error.name,message:error.message}}))}}"""
bun_command=['bun','-e',code,a.release];b=subprocess.run(bun_command,input=payload,capture_output=True,text=True)
(out/'bun.jsonl').write_text(b.stdout);(out/'bun.stderr').write_text(b.stderr);assert b.returncode==0,b.stderr
native_command=[a.binary,'mail-schema-values'];n=subprocess.run(native_command,input=payload,capture_output=True,text=True,env={**os.environ,'PATH':'/usr/bin:/bin'})
(out/'native.jsonl').write_text(n.stdout);(out/'native.stderr').write_text(n.stderr)
inputs=[json.loads(s) for s in payload.splitlines()];expected=[json.loads(s) for s in b.stdout.split('\n')if s];actual=[json.loads(s)for s in n.stdout.split('\n')if s]
differences=[{'index':i,'input':v,'bun':e,'native':r}for i,(v,e,r)in enumerate(zip(inputs,expected,actual))if e!=r]
(out/'comparison.json').write_text(json.dumps({'commands':[bun_command,native_command],'bunExit':b.returncode,'nativeExit':n.returncode,'inputCount':len(inputs),'bunCount':len(expected),'nativeCount':len(actual),'differences':differences},indent=2))
assert len(inputs)==len(expected)==len(actual) and len(inputs)>=250
assert n.returncode==0,n.stderr
assert not differences,differences[:5]
