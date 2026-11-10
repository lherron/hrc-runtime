#!/usr/bin/env python3
"""Stream replay, receipt headers and bounded-loss wire on rusthrc.

After a real birth, 2050 server events and one 16 MiB event are appended with
the native store's own append while the owner is down. A count overflow and an
oversized final event must become explicit replay_window/event_oversize gaps,
raw broker follow must reconstruct the finite read frame for frame, a consumer
receipt is served and ACKed, and malformed or fenced broker-event selectors
are refused.
"""
import argparse,json
from pathlib import Path
from urllib.parse import urlencode
from n3_scratch import Scratch,UnixHTTP
from n3_streams import Follow
from n3_events import append_events

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
        s.init_substrate();owner=s.up('native','replay-birth');scope='agent:tabularasa:project:n3-t11839:task:replay'
        start=s.command('birth',['hrc','start',scope,'--project-id',s.project_id,'--project-root',s.project,'--cwd',s.project,'--json','-p','Reply with exactly the word OK and nothing else. No tools.'])
        rt=start['runtime'];runtime=rt['runtimeId'];generation=rt['generation'];s.wait_completed(rt['runId']);invocation=s.rows('SELECT active_invocation_id FROM runtimes WHERE runtime_id=?',(runtime,))[0]['active_invocation_id'];s.down(owner)
        fixture=[{'ts':'2026-01-01T00:00:00.000Z','eventKind':'server.n3.replay','payload':{'i':i}} for i in range(2050)]
        fixture.append({'ts':'2026-01-01T00:00:00.000Z','eventKind':'server.n3.replay','payload':{'oversize':'x'*(16*1024*1024)}})
        append_events(s.db_path,fixture)
        s.up('native','replay');out=exercise(s,runtime,invocation,generation)
        s.assert_no_duplicate_turn_messages()
        (a.artifacts/'replay.json').write_text(json.dumps({k:v for k,v in out.items() if k!='bounded-overflow'},indent=1)+'\n')
        assert out['receipt-ack'][0]==200 and out['receipt-ack'][1]['disposition']=='advanced',out['receipt-ack']
        refused={k:out[k][0] for k in ('missing','generation','invalid-generation','invalid-after','nonfollow-receipt')}
        assert all(v==400 for v in refused.values()),refused
        assert out['unknown'][0]==400 and out['unknown'][1]['error']['code']=='invalid_selector',out['unknown']
        assert out['fence'][0]==400 and out['fence'][1]['error']['code']=='invalid_fence',out['fence']
        print(json.dumps({'pass':True,'cases':len(out),'artifacts':str(a.artifacts)}))
    finally:s.cleanup('agent:tabularasa:project:n3-t11839:task:')
if __name__=='__main__':main()
