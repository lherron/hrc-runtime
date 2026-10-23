#!/usr/bin/env python3
"""Broker mirror/projection plus persistent plans and operations, with real SQLite."""
import argparse,json,pathlib,subprocess,tempfile,sqlite3,os
p=argparse.ArgumentParser();p.add_argument('--binary',required=True);p.add_argument('--release',required=True);p.add_argument('--artifacts',required=True);a=p.parse_args();out=pathlib.Path(a.artifacts);out.mkdir(parents=True,exist_ok=True)
with tempfile.TemporaryDirectory(prefix='hrcp1-broker-',dir='/tmp') as root:
    seed=subprocess.run(['bun',str(pathlib.Path(__file__).with_name('oracle.ts')),a.release,root,'seed'],capture_output=True,text=True);(out/'seed.json').write_text(json.dumps({'exit':seed.returncode,'stdout':seed.stdout,'stderr':seed.stderr},indent=2));assert seed.returncode==0,seed.stderr
    r=subprocess.run([a.binary,'broker-contract','--db',str(pathlib.Path(root)/'state.sqlite')],capture_output=True,text=True,env={**os.environ,'PATH':'/usr/bin:/bin','HRC_SOCKET_PATH':str(pathlib.Path(root)/'unavailable.sock')});(out/'native.json').write_text(json.dumps({'exit':r.returncode,'stdout':r.stdout,'stderr':r.stderr},indent=2));assert r.returncode==0,r.stdout+r.stderr
    result=json.loads(r.stdout)
    for key in ['contentAddressedPlan','preparedOperation','retainedZeroMarker','rawIdempotencyConflict','contiguousCursor','projectionRollback','importOriginConflict','envelopeRepair','retainedFence']:
        assert result.get(key) is True,(key,result)

    observed=result['observations']
    assert observed['dispositionGapCursor']==0 and observed['contiguousCursor']==2
    assert observed['rollbackHeadBefore']==observed['rollbackHeadAfter']
    assert [r['seq'] for r in observed['rows']]==[1,4]
    assert [r['seq'] for r in observed['boundedTurnRows']]==[1]
    assert observed['invocation']['retainedProjectedThroughSeq']==0
    assert observed['identityConflict']['code']=='broker_invocation_event_conflict'
    assert observed['importConflict']['code']=='broker_invocation_event_conflict'
    assert observed['retainedExcluded'] is False and observed['retainedIncluded'] is True
    with sqlite3.connect(pathlib.Path(root)/'state.sqlite') as db:
        db.row_factory=sqlite3.Row
        raw={table:[dict(r) for r in db.execute('SELECT * FROM '+table)] for table in ['broker_invocation_events','broker_projection_dispositions','broker_invocations','runtime_operations','compiled_runtime_plans']}
    (out/'sqlite-raw.json').write_text(json.dumps(raw,indent=2))
    assert [r['seq'] for r in raw['broker_projection_dispositions']]==[2,1]
    assert all(r['seq']!=3 for r in raw['broker_invocation_events'])
    assert raw['broker_invocations'][0]['last_projected_seq']==2
    assert raw['broker_invocations'][0]['retained_projected_through_seq']==0
    assert raw['compiled_runtime_plans'][0]['plan_projection_json']=='{}'
    imported=[r for r in raw['broker_invocation_events'] if r['source_ref']=='p1-peer']
    assert len(imported)==1 and imported[0]['origin_seq']==10 and imported[0]['hrc_event_seq'] is None
    assert 'payload' not in json.loads(imported[0]['broker_envelope_json'])
    bun=subprocess.run(['bun',str(pathlib.Path(__file__).with_name('oracle.ts')),a.release,root,'broker-read'],capture_output=True,text=True)
    (out/'unchanged-bun.json').write_text(json.dumps({'exit':bun.returncode,'stdout':bun.stdout,'stderr':bun.stderr},indent=2));assert bun.returncode==0,bun.stderr
    readback=json.loads(bun.stdout)
    assert readback['events']==observed['rows']
    assert readback['invocation']==observed['invocation']
    assert readback['disposition']['seq']==2
