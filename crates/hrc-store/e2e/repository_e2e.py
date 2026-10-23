#!/usr/bin/env python3
"""Typed repository family behavior, real canonical SQLite, no Bun daemon."""
import argparse,json,pathlib,subprocess,tempfile
p=argparse.ArgumentParser();p.add_argument('--binary',required=True);p.add_argument('--release',required=True);p.add_argument('--artifacts',required=True);a=p.parse_args()
out=pathlib.Path(a.artifacts);out.mkdir(parents=True,exist_ok=True)
with tempfile.TemporaryDirectory(prefix='hrcp1-repositories-',dir='/tmp') as root:
    seed=subprocess.run(['bun',str(pathlib.Path(__file__).with_name('oracle.ts')),a.release,root,'seed'],capture_output=True,text=True)
    assert seed.returncode==0,seed.stderr
    r=subprocess.run([a.binary,'repository-contract','--db',str(pathlib.Path(root)/'state.sqlite')],capture_output=True,text=True)
    (out/'native.json').write_text(json.dumps({'exit':r.returncode,'stdout':r.stdout,'stderr':r.stderr},indent=2))
    assert r.returncode==0,r.stdout+r.stderr
    checks=json.loads(r.stdout)
    for name in ['rosterAtomic','acceptanceIdempotency','acceptanceConflict','permissionIdentity','artifactIdempotency','retainedAppendOnly','emissionClaimDedup','bufferOrdering','surfaceReplacement','bridgeClose']:
        assert checks.get(name) is True,(name,checks)

    rollback=checks.get('observations',{}).get('rosterRollback')
    assert rollback is not None,'missing raw roster rollback boundary'
    assert rollback['before']==rollback['after'] and len(rollback['before']['roster'])==1 and len(rollback['within']['roster'])==2
    control_root=pathlib.Path(root)/'roster-control';control_root.mkdir()
    seed_argv=['bun',str(pathlib.Path(__file__).with_name('oracle.ts')),a.release,str(control_root),'seed'];seed=subprocess.run(seed_argv,capture_output=True,text=True);assert seed.returncode==0,seed.stderr
    command=['bun',str(pathlib.Path(__file__).with_name('roster_rollback_control.ts')),a.release,str(control_root)]
    control=subprocess.run(command,capture_output=True,text=True);(out/'bun-roster.json').write_text(json.dumps({'command':command,'exit':control.returncode,'stdout':control.stdout,'stderr':control.stderr},indent=2));assert control.returncode==0,control.stderr
    actual=json.loads(control.stdout)
    assert actual=={stage:rollback[stage]['roster']for stage in ['before','within','after']}
