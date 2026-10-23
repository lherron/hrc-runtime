#!/usr/bin/env python3
"""OS denies network and child executable delegation while native repositories commit."""
import argparse,json,pathlib,subprocess,tempfile,os,shutil
p=argparse.ArgumentParser();p.add_argument('--binary',required=True);p.add_argument('--release',required=True);p.add_argument('--artifacts',required=True);a=p.parse_args();out=pathlib.Path(a.artifacts);out.mkdir(parents=True,exist_ok=True)
binary=str(pathlib.Path(a.binary).resolve());bun=shutil.which('bun');assert bun
rows=[]
def run(name,cmd,env=None):
 r=subprocess.run(cmd,capture_output=True,text=True,env=env);rows.append({'name':name,'command':cmd,'exit':r.returncode,'stdout':r.stdout,'stderr':r.stderr});(out/'commands.json').write_text(json.dumps(rows,indent=2));return r
profile='(version 1)(allow default)(deny network*)(deny process-exec)(allow process-exec (literal '+json.dumps(binary)+'))'
(out/'native.sb').write_text(profile)
network='(version 1)(allow default)(deny network*)'
python=str(pathlib.Path(subprocess.check_output(['/usr/bin/python3','-c','import os,sys;print(os.path.realpath(sys.executable))'],text=True).strip()).resolve())
# Apple's framework wrapper execs Python.app before evaluating -c. Launch the
# real interpreter directly so the constrained control reaches our marker.
framework_python=pathlib.Path(python).parent.parent/'Resources/Python.app/Contents/MacOS/Python'
if framework_python.is_file(): python=str(framework_python.resolve())
network_code="""import socket,json,errno,sys
s=socket.socket()
print(json.dumps({'phase':'before_bind','host':'127.0.0.1','port':0}),flush=True)
try:
 s.bind(('127.0.0.1',0))
except OSError as error:
 print(json.dumps({'phase':'bind_error','errno':error.errno,'errnoName':errno.errorcode.get(error.errno)}),flush=True)
 sys.exit(91 if error.errno==errno.EPERM else 92)
else:
 print(json.dumps({'phase':'bound','port':s.getsockname()[1]}),flush=True)
 s.close()
"""
positive_network=run('network-positive',[python,'-c',network_code])
denied_network=run('network-denied',['/usr/bin/sandbox-exec','-p',network,python,'-c',network_code])
positive_rows=[json.loads(line)for line in positive_network.stdout.splitlines()]
denied_rows=[json.loads(line)for line in denied_network.stdout.splitlines()]
assert positive_network.returncode==0 and [r['phase']for r in positive_rows]==['before_bind','bound']
assert denied_network.returncode==91 and [r['phase']for r in denied_rows]==['before_bind','bind_error']
assert denied_rows[-1]['errno']==1 and denied_rows[-1]['errnoName']=='EPERM'
exec_code="""import os,sys,json,errno
path=os.path.realpath(sys.argv[1])
print(json.dumps({'phase':'before_exec','target':path}),flush=True)
try:
 os.execv(path,[path,'--version'])
except OSError as error:
 print(json.dumps({'phase':'exec_error','target':path,'errno':error.errno,'errnoName':errno.errorcode.get(error.errno)}),flush=True)
 sys.exit(91 if error.errno==errno.EPERM else 92)
"""
exec_profile='(version 1)(allow default)(deny process-exec)(allow process-exec (literal '+json.dumps(python)+'))'
positive_exec=run('bun-exec-positive',[python,'-c',exec_code,bun])
denied_exec=run('bun-exec-denied',['/usr/bin/sandbox-exec','-p',exec_profile,python,'-c',exec_code,bun])
positive_lines=positive_exec.stdout.splitlines();denied_lines=[json.loads(line)for line in denied_exec.stdout.splitlines()]
assert positive_exec.returncode==0 and json.loads(positive_lines[0])=={'phase':'before_exec','target':str(pathlib.Path(bun).resolve())}
assert len(positive_lines)>1 and positive_lines[-1].strip()
assert denied_exec.returncode==91 and [r['phase']for r in denied_lines]==['before_exec','exec_error']
assert denied_lines[-1]=={'phase':'exec_error','target':str(pathlib.Path(bun).resolve()),'errno':1,'errnoName':'EPERM'}
with tempfile.TemporaryDirectory(prefix='hrcp1-discriminator-',dir='/tmp') as root:
 root=pathlib.Path(root);oracle=[bun,str(pathlib.Path(__file__).with_name('oracle.ts')),a.release,str(root)]
 assert run('canonical-seed',oracle+['seed']).returncode==0
 assert not (root/'absent.sock').exists()
 env={**os.environ,'PATH':'/usr/bin:/bin','HRC_SOCKET_PATH':str(root/'absent.sock')}
 native=run('native-network-exec-denied',['/usr/bin/sandbox-exec','-p',profile,binary,'atomic-contract','--db',str(root/'state.sqlite')],env)
 assert native.returncode==0,native.stdout+native.stderr
 assert json.loads(native.stdout)['commitHintsOnly'] is True
 assert not (root/'absent.sock').exists()
 control=run('unchanged-bun-after-native-exit',oracle+['read']);assert control.returncode==0,control.stderr
 assert len(json.loads(control.stdout)['page']['rows'])>2
