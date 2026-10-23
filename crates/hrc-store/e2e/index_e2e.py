#!/usr/bin/env python3
"""Materialized session index, keyset/facet semantics and pure presentation candidates."""
import argparse,json,pathlib,subprocess,tempfile,os
p=argparse.ArgumentParser();p.add_argument('--binary',required=True);p.add_argument('--release',required=True);p.add_argument('--artifacts',required=True);a=p.parse_args();out=pathlib.Path(a.artifacts);out.mkdir(parents=True,exist_ok=True)
with tempfile.TemporaryDirectory(prefix='hrcp1-index-',dir='/tmp') as root:
    seed=subprocess.run(['bun',str(pathlib.Path(__file__).with_name('oracle.ts')),a.release,root,'seed'],capture_output=True,text=True);assert seed.returncode==0,seed.stderr
    n=subprocess.run([a.binary,'index-contract','--db',str(pathlib.Path(root)/'state.sqlite')],capture_output=True,text=True,env={**os.environ,'PATH':'/usr/bin:/bin','HRC_SOCKET_PATH':str(pathlib.Path(root)/'absent.sock')})
    (out/'native.json').write_text(json.dumps({'exit':n.returncode,'stdout':n.stdout,'stderr':n.stderr},indent=2));assert n.returncode==0,n.stdout+n.stderr
    r=json.loads(n.stdout)
    assert r['facets']['total']==3 and r['facets']['byAgentId']=={'other':1,'tabularasa':2}
    assert r['filteredFacets']['total']==2 and r['filteredFacets']['byAgentId']==r['facets']['byAgentId']
    assert len(r['escaped']['items'])==1 and r['escaped']['items'][0]['hostSessionId']=='p1-index-a'
    assert r['first']['hasMore'] is True and r['second']['hasMore'] is False
    assert len({x['hostSessionId'] for x in r['first']['items']+r['second']['items']})==3
    assert r['beforeArchiveRecency']==r['afterArchiveRecency']=='2026-10-23T05:00:00.000Z'
    assert [x['hostSessionId'] for x in r['recent']]==['p1-index-a']
    assert r['archiveCandidates']==['p1-index-b']
    bun=subprocess.run(['bun',str(pathlib.Path(__file__).with_name('oracle.ts')),a.release,root,'index-read'],capture_output=True,text=True)
    (out/'unchanged-bun.json').write_text(json.dumps({'exit':bun.returncode,'stdout':bun.stdout,'stderr':bun.stderr},indent=2));assert bun.returncode==0,bun.stderr
    b=json.loads(bun.stdout);assert b['page']==r['all'] and b['facets']==r['facets'] and b['filteredFacets']==r['filteredFacets'] and b['backfill']==r['backfill']
