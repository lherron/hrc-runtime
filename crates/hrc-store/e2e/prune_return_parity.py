#!/usr/bin/env python3
"""Native return values compared to durable canonical Bun characterizations."""
import argparse,json,pathlib,tempfile,subprocess,os
p=argparse.ArgumentParser();p.add_argument('--binary',required=True);p.add_argument('--release',required=True);p.add_argument('--baseline',required=True);p.add_argument('--artifacts',required=True);a=p.parse_args();out=pathlib.Path(a.artifacts);out.mkdir(parents=True,exist_ok=True);records=[];source=pathlib.Path(__file__).parent
for i,control in enumerate(json.loads(pathlib.Path(a.baseline).read_text())):
 with tempfile.TemporaryDirectory(prefix='hrcp1-prunereturn-',dir='/tmp') as root:
    seed=subprocess.run(['bun',str(source/'oracle.ts'),a.release,root,'seed'],capture_output=True,text=True);assert seed.returncode==0,seed.stderr
    config=pathlib.Path(root)/'case.json';config.write_text(json.dumps({**control['config'],'setupOnly':True}))
    setup=subprocess.run(['bun',str(source/'prune_characterize.ts'),a.release,root,str(config)],capture_output=True,text=True);assert setup.returncode==0,setup.stderr
    ids=json.loads(setup.stdout)['ids'];command='prune-return-'+('full' if control['config']['includeLedgers'] else 'minimal')+('-single' if control['config']['singular'] else '-batch')
    argv=[a.binary,command,'--db',str(pathlib.Path(root)/'state.sqlite'),'--ids',','.join(ids)]
    native=subprocess.run(argv,capture_output=True,text=True,env={**os.environ,'PATH':'/usr/bin:/bin','HRC_SOCKET_PATH':str(pathlib.Path(root)/'absent.sock')})
    record={'argv':argv,'config':control['config'],'control':control,'setup':setup.stdout,'native':{'exit':native.returncode,'stdout':native.stdout,'stderr':native.stderr}};records.append(record);(out/f'case-{i:02}.json').write_text(json.dumps(record,indent=2));assert native.returncode==0,native.stdout+native.stderr
    observed=json.loads(native.stdout);assert observed['result']==control['result'] and observed['afterCount']==control['afterCount']==0
(out/'summary.json').write_text(json.dumps({'compared':len(records),'passed':True},indent=2))
