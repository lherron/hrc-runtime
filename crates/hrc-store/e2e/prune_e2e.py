#!/usr/bin/env python3
"""Compare both prune modes with unchanged Bun on identical real scratch stores."""
import argparse,json,pathlib,subprocess,tempfile,os,sqlite3
p=argparse.ArgumentParser();p.add_argument('--binary',required=True);p.add_argument('--release',required=True);p.add_argument('--artifacts',required=True);a=p.parse_args();out=pathlib.Path(a.artifacts);out.mkdir(parents=True,exist_ok=True)
with tempfile.TemporaryDirectory(prefix='hrcp1-prune-',dir='/tmp') as temp:
    root=pathlib.Path(temp);env={**os.environ,'PATH':'/usr/bin:/bin','HRC_SOCKET_PATH':str(root/'absent.sock')}
    def run(argv,name,native=False):
        r=subprocess.run(argv,capture_output=True,text=True,env=env if native else None);(out/(name+'.json')).write_text(json.dumps({'argv':argv,'exit':r.returncode,'stdout':r.stdout,'stderr':r.stderr},indent=2));assert r.returncode==0,r.stdout+r.stderr;return json.loads(r.stdout)
    run(['bun',str(pathlib.Path(__file__).with_name('oracle.ts')),a.release,str(root),'seed'],'seed')
    for scenario in ['broker-contract','transcript-contract','atomic-contract']:
        run([a.binary,scenario,'--db',str(root/'state.sqlite')],scenario,True)
    run(['bun',str(pathlib.Path(__file__).with_name('oracle.ts')),a.release,str(root),'seed-prune'],'seed-prune')
    discrepancies=[]
    def snapshot(path):
        db=sqlite3.connect(path);db.row_factory=sqlite3.Row
        data={t:[dict(r) for r in db.execute('SELECT * FROM "'+t+'"')] for(t,)in db.execute("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'transcript_turns_fts%' ORDER BY name")};db.close();return data
    def clone(source,target):
        target.mkdir();src=sqlite3.connect(source);dst=sqlite3.connect(target/'state.sqlite');src.backup(dst);src.close();dst.close()
    for variant in ['minimal','full','full-shared']:
        mode='full' if variant=='full-shared' else variant
        native=root/('native-'+variant);bun=root/('bun-'+variant);clone(root/'state.sqlite',native);clone(root/'state.sqlite',bun)
        if variant=='full-shared':
            for seat in [native,bun]:run(['bun',str(pathlib.Path(__file__).with_name('oracle.ts')),a.release,str(seat),'share-plan'],'share-'+seat.name)
        before=snapshot(native/'state.sqlite')
        observed=run([a.binary,'prune-'+mode+'-contract','--db',str(native/'state.sqlite')],'native-'+variant,True)
        control=run(['bun',str(pathlib.Path(__file__).with_name('oracle.ts')),a.release,str(bun),'prune-'+mode],'bun-'+variant)
        assert observed['beforeCounts']==control['beforeCounts']
        assert observed['removed']==control['removed']
        if observed['removed']!=control['removed']:discrepancies.append(variant)
        (out/('return-value-'+variant+'.json')).write_text(json.dumps({'native':observed['removed'],'bun':control['removed'],'bunSqliteChanges':control['sqliteChanges'],'status':'compatible' if observed['removed']==control['removed'] else 'GAP'},indent=2))
        n=snapshot(native/'state.sqlite');b=snapshot(bun/'state.sqlite');(out/('remaining-'+variant+'.json')).write_text(json.dumps({'native':n,'bun':b},indent=2));assert n==b
        assert n!=before
        assert n['event_stream_cursor']==before['event_stream_cursor']
        if mode=='full':
            assert n['broker_invocation_events']==[] and all(x['runtime_id']!='p1-runtime' for x in n['transcript_turns']) and all(x['runtime_id']!='p1-runtime' for x in n['tool_result_blobs'])
        else:assert n['broker_invocation_events']==before['broker_invocation_events']

        if mode=='full':assert all(x['runtimeId']!='p1-runtime' for x in control['fts'])
        if variant=='full-shared':
            assert observed['beforeCounts']['compiled_runtime_plans']==0
            assert len(n['compiled_runtime_plans'])==1 and len(n['runtimes'])==1 and n['runtimes'][0]['runtime_id']=='p1-survivor'
            assert all(x['run_id']!='p1-run' for x in n['events']+n['runtime_buffers'])

        assert any(x['runtime_id']=='p1-runtime' for x in before['transcript_turns'])
        if mode=='full':assert observed['beforeCounts']['tool_result_blobs']==1 and observed['beforeCounts']['tool_result_blob_parts']==1
    assert discrepancies==[],{'unresolvedBunReturnValueDiscrepancy':discrepancies}
