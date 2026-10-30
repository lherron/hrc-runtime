#!/usr/bin/env python3
"""Replay/live/reconnect streams over owner restart on real HTTP writes.

Failure modes: a replay/live gap, duplicate boundary rows, coalesced/missed wake
stranding a follower, an inclusive cursor on reconnect, an unbounded replay,
and non-NDJSON framing.
Latency is measured against Bun, never a budget gate.
"""
import argparse,json,queue,socket,subprocess,threading,time
from http.client import HTTPException
from pathlib import Path
from urllib.parse import urlencode
from n3_scratch import Scratch,UnixHTTP

class Follow:
    def __init__(self,s,path):
        self.connection=UnixHTTP(s.socket,15);self.connection.request('GET',path);self.response=self.connection.getresponse();assert self.response.status==200,(self.response.status,self.response.read())
        self.records=queue.Queue();self.seen=[]
        def read():
            try:
                while True:
                    line=self.response.readline()
                    if not line:break
                    if line.strip():self.records.put(json.loads(line))
            except (OSError,ValueError,HTTPException):pass
        self.thread=threading.Thread(target=read,daemon=True);self.thread.start()
    def next(self):
        value=self.records.get(timeout=15);self.seen.append(value);return value
    def close(self):
        if getattr(self,'closed',False):return
        self.closed=True
        if self.connection.sock:
            try:self.connection.sock.shutdown(socket.SHUT_RDWR)
            except OSError:pass
        self.thread.join(timeout=2)
        self.connection.close()

def main():
    p=argparse.ArgumentParser();p.add_argument('--owner',choices=['bun','native'],required=True)
    for k in ('binary','installed-release','aspd-socket','scratch-root','artifacts'):p.add_argument('--'+k,type=Path,required=True)
    a=p.parse_args();s=Scratch(a.scratch_root,a.installed_release,a.aspd_socket,a.binary,a.artifacts,project_id='n3-t11839');followers=[];out={}
    try:
        s.init_substrate();owner=s.up(a.owner,'stream')
        def create(label):
            scope='agent:tabularasa:project:n3-t11839:task:stream-'+label
            status,value=s.http('POST','/v1/sessions/resolve',{'sessionRef':scope+'/lane:main','create':True,'summonIntent':'explicit_local'})
            assert status==200,(status,value);return scope
        scope1=create('replay');page=s.http('GET','/v1/events/page?afterSeq=0&limit=1000')[1];incarnation=page['ledgerIncarnationId']
        bounded=Follow(s,'/v1/events/bounded-stream?'+urlencode({'follow':'true','afterSeq':0,'ledgerIncarnationId':incarnation,'category':'session'}));followers.append(bounded)
        ready=bounded.next();assert ready['type']=='ready',ready
        replay=[bounded.next() for _ in [e for e in page['rows'] if e['category']=='session']]
        assert all(r['type']=='event' for r in replay),replay
        legacy=Follow(s,'/v1/events?follow=true&fromSeq='+str(page['head']+1)+'&category=session');followers.append(legacy)
        at=time.monotonic();scope2=create('live')
        event=bounded.next();elapsed=time.monotonic()-at;assert event['type']=='event',event
        assert event['event']['scopeRef']==scope2,event
        legacy_event=legacy.next();assert legacy_event==event['event'],(legacy_event,event)
        cursor=event['event']['hrcSeq'];assert cursor>ready['replayHeadHrcSeq']
        bounded.close();legacy.close();s.down(owner)
        owner=s.up(a.owner,'stream-restart')
        resumed=Follow(s,'/v1/events/bounded-stream?'+urlencode({'follow':'true','afterSeq':cursor,'ledgerIncarnationId':incarnation,'category':'session'}));followers.append(resumed)
        restart_ready=resumed.next();assert restart_ready['type']=='ready' and restart_ready['acceptedAfterHrcSeq']==cursor,restart_ready
        scope3=create('resumed');event3=resumed.next();assert event3['type']=='event' and event3['event']['scopeRef']==scope3,event3
        seqs=[r['event']['hrcSeq'] for r in replay]+[cursor,event3['event']['hrcSeq']]
        assert seqs==sorted(set(seqs)),seqs
        actual=s.http('GET','/v1/events?category=session')[1]
        rows=[json.loads(line) for line in actual.splitlines()] if isinstance(actual,str) else [actual]
        assert seqs==[r['hrcSeq'] for r in rows],(seqs,rows)
        out={'owner':a.owner,'pass':True,'followLatencySeconds':elapsed,'frames':[ready,*replay,event,restart_ready,event3],'sequences':seqs}
        (a.artifacts/'streams.json').write_text(json.dumps(out,indent=2)+'\n');print(json.dumps({'owner':a.owner,'pass':True,'followLatencySeconds':elapsed}))
    finally:
        for follower in followers:
            try:follower.close()
            except OSError:pass
        s.cleanup('agent:tabularasa:project:n3-t11839:task:')
if __name__=='__main__':main()
