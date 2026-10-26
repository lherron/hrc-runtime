#!/usr/bin/env python3
"""Bun/native stream replay, receipt headers and bounded-loss wire parity.

Bun's real repositories write the fixture with the owner down. A count overflow
and an oversized final event must become explicit replay/oversize gaps, while
raw broker follow reconstructs payload-less envelopes identically to a finite
read. Native never writes the seeded projection.
"""
import argparse,json,sqlite3,subprocess
from pathlib import Path
from urllib.parse import urlencode
from n3_scratch import Scratch,UnixHTTP
from n3_streams import Follow

def exercise(s,runtime,invocation,generation):
    out={};page=s.http('GET','/v1/events/page?afterSeq=0&limit=1')[1];inc=page['ledgerIncarnationId']
    path='/v1/events/bounded-stream?'+urlencode({'follow':'true','ledgerIncarnationId':inc,'afterSeq':0,'eventKind':'server.n3.replay'})
    f=Follow(s,path)
    try:
        frames=[f.next() for _ in range(2049)]
        assert frames[0]['type']=='ready' and frames[1]['type']=='gap' and frames[1]['reason']=='replay_window'
        assert frames[-1]['type']=='gap' and frames[-1]['reason']=='event_oversize'
        out['bounded-overflow']=frames
    finally:f.close()
    selector={'runtimeId':runtime,'invocationId':invocation,'generation':generation,'afterSeq':0}
    path='/v1/broker-events?'+urlencode(selector)
    status,body=s.http('GET',path);assert status==200,(status,body);out['broker-finite']=[status,body]
    expected=[json.loads(line) for line in body.splitlines()] if isinstance(body,str) else [body]
    f=Follow(s,path+'&follow=true&receipt=consumer-ack-v1')
    try:
        frames=[f.next() for _ in expected];assert frames==expected,(frames,expected)
        headers={k.lower():v for k,v in f.response.getheaders() if k.lower().startswith('x-hrc-')};assert set(headers)=={'x-hrc-subscriber-id','x-hrc-receipt-token','x-hrc-receipt-ack-path','x-hrc-streaming'},headers
        out['broker-follow']=frames;out['receipt-path']=headers['x-hrc-receipt-ack-path']
        out['stream-headers']={'content-type':f.response.getheader('content-type'),'x-hrc-streaming':headers['x-hrc-streaming']}
        out['receipt-ack']=s.http('POST','/v1/server/subscribers/ack',{'subscriberId':headers['x-hrc-subscriber-id'],'receiptToken':headers['x-hrc-receipt-token'],'seq':expected[-1]['seq']})
    finally:f.close()
    for name,query in [('missing',{}),('generation',{'generation':generation}),('invalid-generation',{**selector,'generation':-1}),('invalid-after',{**selector,'afterSeq':-1}),('unknown',{**selector,'runtimeId':'missing'}),('fence',{**selector,'generation':generation+1}),('nonfollow-receipt',{**selector,'receipt':'consumer-ack-v1'})]:out[name]=s.http('GET','/v1/broker-events?'+urlencode(query))
    return out

def main():
    p=argparse.ArgumentParser()
    for k in ('binary','installed-release','aspd-socket','scratch-root','artifacts'):p.add_argument('--'+k,type=Path,required=True)
    a=p.parse_args();s=Scratch(a.scratch_root,a.installed_release,a.aspd_socket,a.binary,a.artifacts,project_id='n3-t11839')
    try:
        s.init_substrate();bun=s.up('bun','replay-birth');scope='agent:tabularasa:project:n3-t11839:task:replay'
        start=s.command('birth',['hrc','start',scope,'--project-id',s.project_id,'--project-root',s.project,'--cwd',s.project,'--json','-p','Reply with exactly the word OK and nothing else. No tools.'])
        rt=start['runtime'];runtime=rt['runtimeId'];generation=rt['generation'];s.wait_completed(rt['runId']);invocation=s.rows('SELECT active_invocation_id FROM runtimes WHERE runtime_id=?',(runtime,))[0]['active_invocation_id'];s.down(bun)
        module=s.release/'packages/hrc-store-sqlite/src/database.ts'
        script='import {openHrcDatabase} from '+json.dumps(str(module))+''';const db=openHrcDatabase(process.argv[1]);
for(let i=0;i<2050;i++)db.hrcEvents.append({ts:'2026-01-01T00:00:00.000Z',hostSessionId:'hrc-server',scopeRef:'server:hrc',laneRef:'main',generation:0,category:'server',eventKind:'server.n3.replay',payload:{i}});
db.hrcEvents.append({ts:'2026-01-01T00:00:00.000Z',hostSessionId:'hrc-server',scopeRef:'server:hrc',laneRef:'main',generation:0,category:'server',eventKind:'server.n3.replay',payload:{oversize:'x'.repeat(16*1024*1024)}});db.close();'''
        s.command('Bun-replay-fixture',['bun','-e',script,s.db_path]);bun=s.up('bun','replay')
        expected=exercise(s,runtime,invocation,generation);snapshot=s.root/'history.sqlite'
        with sqlite3.connect(s.db_path) as source,sqlite3.connect(snapshot) as target:source.backup(target)
        s.down(bun)
        with sqlite3.connect(snapshot) as source,sqlite3.connect(s.db_path) as target:source.backup(target)
        s.up('native','replay');actual=exercise(s,runtime,invocation,generation)
        for side,v in [('bun',expected),('native',actual)]:
            directory=a.artifacts/side;directory.mkdir(exist_ok=True);(directory/'replay.json').write_text(json.dumps(v,indent=1)+'\n')
        runner=Path(__file__).resolve().parents[3]/'conformance/hrc-parity/run.py';result=subprocess.run(['python3',str(runner),'compare','--suite','n3-replay','--baseline',str(a.artifacts/'bun'),'--candidate',str(a.artifacts/'native'),'--out',str(a.artifacts/'compare')],capture_output=True,text=True)
        (a.artifacts/'compare.stdout').write_text(result.stdout);(a.artifacts/'compare.stderr').write_text(result.stderr);assert result.returncode==0,(result.stdout[-4000:],result.stderr)
        print(json.dumps({'pass':True,'compared':len(expected),'artifacts':str(a.artifacts)}))
    finally:s.cleanup('agent:tabularasa:project:n3-t11839:task:')
if __name__=='__main__':main()
