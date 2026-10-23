#!/usr/bin/env python3
"""Participant state graph, CAS snapshots, work eligibility and host binding slots."""
import argparse,json,pathlib,subprocess,tempfile,os,sqlite3
p=argparse.ArgumentParser();p.add_argument('--binary',required=True);p.add_argument('--release',required=True);p.add_argument('--artifacts',required=True);a=p.parse_args();out=pathlib.Path(a.artifacts);out.mkdir(parents=True,exist_ok=True)
with tempfile.TemporaryDirectory(prefix='hrcp1-participants-',dir='/tmp') as root:
    seed=subprocess.run(['bun',str(pathlib.Path(__file__).with_name('oracle.ts')),a.release,root,'seed'],capture_output=True,text=True)
    (out/'seed.json').write_text(json.dumps({'exit':seed.returncode,'stdout':seed.stdout,'stderr':seed.stderr},indent=2));assert seed.returncode==0,seed.stderr
    n=subprocess.run([a.binary,'participants-contract','--db',str(pathlib.Path(root)/'state.sqlite')],capture_output=True,text=True,env={**os.environ,'PATH':'/usr/bin:/bin','HRC_SOCKET_PATH':str(pathlib.Path(root)/'absent.sock')})
    (out/'native.json').write_text(json.dumps({'exit':n.returncode,'stdout':n.stdout,'stderr':n.stderr},indent=2));assert n.returncode==0,n.stdout+n.stderr
    r=json.loads(n.stdout)
    assert r['illegalJump'] is False and r['nonRunnable']==[]
    assert r['prepareFirst'] is True and r['prepareRepeat'] is False
    assert r['snapshotFirst'] is True and r['snapshotRepeat'] is False
    assert r['selectionFirst'] is True and r['selectionRepeat'] is False
    assert r['attempt']['continuation']['reason']=='participant_fresh'
    assert r['initialActivation'] is True and r['activationRepeat'] is False
    assert r['reconnectFirst'] is True and r['reconnectRepeat'] is False
    assert r['retireWithoutReceipt'] is False and r['retireWithReceipt'] is True
    assert r['reservationStillHeld'] is True and r['releaseFirst'] is True and r['releaseRepeat'] is False
    assert r['replacementStore']==['stored','same','conflict']
    assert r['exhausted']['establishmentWorkState']=='exhausted' and r['renewEmpty'] is False and r['renewValid'] is True
    with sqlite3.connect(pathlib.Path(root)/'state.sqlite') as db:
        db.row_factory=sqlite3.Row;raw={t:[dict(x) for x in db.execute('SELECT * FROM '+t)] for t in ['participant_registrations','participant_registration_attempts','participant_address_reservations','participant_host_bindings']}
    (out/'raw.json').write_text(json.dumps(raw,indent=2))
    assert raw['participant_host_bindings'][0]['state']=='RETIRING'
    bun=subprocess.run(['bun',str(pathlib.Path(__file__).with_name('oracle.ts')),a.release,root,'participants-read'],capture_output=True,text=True)
    (out/'unchanged-bun.json').write_text(json.dumps({'exit':bun.returncode,'stdout':bun.stdout,'stderr':bun.stderr},indent=2));assert bun.returncode==0,bun.stderr
    observed=json.loads(bun.stdout)
    assert observed['attempt']==r['attempt'] and observed['binding']==r['binding'] and observed['registration']==r['registration']
