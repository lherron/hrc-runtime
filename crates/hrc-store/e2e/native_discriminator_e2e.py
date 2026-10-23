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
code='import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print("bound"); s.close()'
assert run('network-positive',['/usr/bin/python3','-c',code]).returncode==0
assert run('network-denied',['/usr/bin/sandbox-exec','-p',network,'/usr/bin/python3','-c',code]).returncode!=0
assert run('bun-exec-positive',[bun,'--version']).returncode==0
exec_profile='(version 1)(allow default)(deny process-exec)(allow process-exec (literal "/bin/sh"))'
assert run('bun-exec-denied',['/usr/bin/sandbox-exec','-p',exec_profile,'/bin/sh','-c','exec "$1" --version','sh',bun]).returncode!=0
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
