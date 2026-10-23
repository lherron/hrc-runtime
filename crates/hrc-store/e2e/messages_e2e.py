#!/usr/bin/env python3
"""Real message idempotency, reply joins, metadata and atomic finalizer recipe."""
import argparse,json,pathlib,subprocess,tempfile,os,sqlite3
p=argparse.ArgumentParser();p.add_argument('--binary',required=True);p.add_argument('--release',required=True);p.add_argument('--artifacts',required=True);a=p.parse_args();out=pathlib.Path(a.artifacts);out.mkdir(parents=True,exist_ok=True)
with tempfile.TemporaryDirectory(prefix='hrcp1-messages-',dir='/tmp') as root:
    seed=subprocess.run(['bun',str(pathlib.Path(__file__).with_name('oracle.ts')),a.release,root,'seed'],capture_output=True,text=True)
    (out/'seed.json').write_text(json.dumps({'exit':seed.returncode,'stdout':seed.stdout,'stderr':seed.stderr},indent=2));assert seed.returncode==0,seed.stderr
    n=subprocess.run([a.binary,'messages-contract','--db',str(pathlib.Path(root)/'state.sqlite')],capture_output=True,text=True,env={**os.environ,'PATH':'/usr/bin:/bin','HRC_SOCKET_PATH':str(pathlib.Path(root)/'absent.sock')})
    (out/'native.json').write_text(json.dumps({'exit':n.returncode,'stdout':n.stdout,'stderr':n.stderr},indent=2));assert n.returncode==0,n.stdout+n.stderr
    r=json.loads(n.stdout)
    assert r['duplicate']['body']=='request body' and r['duplicateInserted'] is False
    assert len(r['responses'])==1 and r['responses'][0]['body']=='actual response'
    assert r['rollbackResponses']==[] and r['rollbackExecution']['execution']['state']=='started'
    assert r['request']['execution']['state']=='completed'
    assert r['request']['metadataJson']=={'ingress':'preserved','turnResponseFinalizer':True,'answer':'retained'}
    assert [x['messageId'] for x in r['filtered']]==['p1-response','p1-message']
    assert len(r['hints'])==4 and r['unsubscribeWorked'] is True
    with sqlite3.connect(pathlib.Path(root)/'state.sqlite') as db:
        db.row_factory=sqlite3.Row;raw=[dict(x) for x in db.execute('SELECT * FROM messages ORDER BY message_seq')]
    (out/'raw.json').write_text(json.dumps(raw,indent=2));assert len(raw)==2
    bun=subprocess.run(['bun',str(pathlib.Path(__file__).with_name('oracle.ts')),a.release,root,'messages-read'],capture_output=True,text=True)
    (out/'unchanged-bun.json').write_text(json.dumps({'exit':bun.returncode,'stdout':bun.stdout,'stderr':bun.stderr},indent=2));assert bun.returncode==0,bun.stderr
    assert json.loads(bun.stdout)['messages']==list(reversed(r['filtered']))
