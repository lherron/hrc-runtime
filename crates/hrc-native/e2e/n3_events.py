#!/usr/bin/env python3
"""Native event history reads over a seeded scratch ledger.

Nine server events are appended with the native store's own append (the
event_stream_cursor bump, then the insert, `hrc_store::append_event`) while the
owner runs, alternating lane, kind and generation; the last is then deleted so
the allocated head outlives the surviving rows. Every read is checked against
the seeded rows it must select. Failure modes: exclusive/inclusive cursor
confusion, filters applied after page limits, wrong ledger fences, head
computed from surviving rows instead of the allocated sequence, and limits
over the cap admitted.
"""
import argparse,json,sqlite3
from pathlib import Path
from n3_scratch import Scratch


def append_events(db_path,events):
    """hrc_store::append_event, verbatim: one cursor bump and one insert per event."""
    seqs=[]
    with sqlite3.connect(db_path,timeout=30) as db:
        for e in events:
            stream=db.execute('UPDATE event_stream_cursor SET next_seq=next_seq+1 WHERE id=1 RETURNING next_seq-1').fetchone()[0]
            cur=db.execute('INSERT INTO hrc_events(stream_seq,ts,host_session_id,scope_ref,lane_ref,generation,category,event_kind,replayed,payload_json) VALUES (?,?,?,?,?,?,?,?,0,?)',
                           (stream,e['ts'],e.get('hostSessionId','hrc-server'),e.get('scopeRef','server:hrc'),e.get('laneRef','main'),e.get('generation',0),e.get('category','server'),e['eventKind'],json.dumps(e['payload'])))
            seqs.append(cur.lastrowid)
    return seqs


def main():
    p=argparse.ArgumentParser()
    for key in ('binary','installed-release','aspd-socket','scratch-root','artifacts'):
        p.add_argument('--'+key,type=Path,required=True)
    a=p.parse_args()
    s=Scratch(a.scratch_root,a.installed_release,a.aspd_socket,a.binary,a.artifacts,project_id='n3-t11839')
    try:
        s.init_substrate()
        s.up('native','read-subject')
        seeded=[{'ts':'2023-11-14T22:13:20.%03dZ'%i,'laneRef':'other' if i%2 else 'main','generation':i%3,
                 'eventKind':'server.test.odd' if i%2 else 'server.test.even','payload':{'i':i}} for i in range(9)]
        seqs=append_events(s.db_path,seeded)
        # An allocated-but-deleted tail still belongs to the covering page's head.
        with sqlite3.connect(s.db_path,timeout=30) as db:db.execute('DELETE FROM hrc_events WHERE hrc_seq=?',(seqs[-1],))
        incarnation=s.http('GET','/v1/events/page?afterSeq=0&limit=1')[1]['ledgerIncarnationId']
        paths=['/v1/events/head','/v1/events','/v1/events?fromSeq=3',
               '/v1/events?generation=1','/v1/events?laneRef=other',
               '/v1/events?eventKind=server.test.even','/v1/events?scopeRef=absent',
               '/v1/events/latest-by-session','/v1/events/latest-by-session?generation=2',
               '/v1/events/tail?limit=3','/v1/events/tail?limit=2&laneRef=main',
               '/v1/events/tail?limit=2&beforeHrcSeq=7&ledgerIncarnationId='+incarnation,
               '/v1/events/page?afterSeq=2&limit=3','/v1/events/page?afterSeq=100&limit=3',
               '/v1/events/page?afterSeq=0&limit=3&ledgerIncarnationId=wrong',
               '/v1/events/tail?limit=3&ledgerIncarnationId=wrong',
               '/v1/events/tail?limit=2&beforeHrcSeq=5',
               '/v1/events/page?limit=3','/v1/events/page?afterSeq=-1&limit=3',
               '/v1/events/page?afterSeq=0&limit=1001','/v1/events/tail?limit=501',
               '/v1/events?generation=-1','/v1/events?receipt=consumer-ack-v1']
        got={path:s.http('GET',path) for path in paths}
        (a.artifacts/'events.json').write_text(json.dumps({'seqs':seqs,'reads':got},indent=2)+'\n')
        def nd(path):
            status,body=got[path];assert status==200,(path,status,body)
            return [json.loads(l) for l in body.splitlines() if l.strip()] if isinstance(body,str) else [body]
        def ids(rows):return [r['hrcSeq'] for r in rows]
        alive={seqs[i]:seeded[i] for i in range(8)}  # the ninth was deleted
        allocated,surviving=seqs[-1],seqs[-2]
        sel=lambda f:[q for q,e in alive.items() if f(e)]
        problems={}
        def want(name,ok,value):
            if not ok:problems[name]=value
        everything=nd('/v1/events')
        want('all',ids(everything)[-8:]==list(alive) and allocated not in ids(everything),ids(everything))
        want('lane-canonical',{r['laneRef'] for r in everything if r['hrcSeq'] in alive}=={'main','lane:other'},[r['laneRef'] for r in everything])
        want('fromSeq-inclusive',ids(nd('/v1/events?fromSeq=3'))==[q for q in ids(everything) if q>=3],ids(nd('/v1/events?fromSeq=3')))
        want('generation',ids(nd('/v1/events?generation=1'))==sel(lambda e:e['generation']==1),nd('/v1/events?generation=1'))
        want('laneRef',ids(nd('/v1/events?laneRef=other'))==sel(lambda e:e['laneRef']=='other'),nd('/v1/events?laneRef=other'))
        want('eventKind',ids(nd('/v1/events?eventKind=server.test.even'))==sel(lambda e:e['eventKind']=='server.test.even'),nd('/v1/events?eventKind=server.test.even'))
        want('scope-absent',got['/v1/events?scopeRef=absent'][0]==200 and not nd('/v1/events?scopeRef=absent'),got['/v1/events?scopeRef=absent'])
        # head is the highest surviving row; a page's head is the allocated sequence.
        want('head',got['/v1/events/head']==(200,{'hrcSeq':surviving,'brokerCommit':0}),got['/v1/events/head'])
        latest=got['/v1/events/latest-by-session'][1]
        want('latest',got['/v1/events/latest-by-session'][0]==200 and latest[0]['hrcSeq']==surviving and len({(r['hostSessionId'],r['generation']) for r in latest})==len(latest),latest)
        latest2=got['/v1/events/latest-by-session?generation=2'][1]
        want('latest-generation',ids(latest2)==[max(sel(lambda e:e['generation']==2))],latest2)
        tail=lambda path:ids(got[path][1]['events']) if got[path][0]==200 else got[path]
        want('tail',tail('/v1/events/tail?limit=3')==list(alive)[-3:],tail('/v1/events/tail?limit=3'))
        want('tail-filter-before-limit',tail('/v1/events/tail?limit=2&laneRef=main')==sel(lambda e:e['laneRef']=='main')[-2:],tail('/v1/events/tail?limit=2&laneRef=main'))
        before='/v1/events/tail?limit=2&beforeHrcSeq=7&ledgerIncarnationId='+incarnation
        want('tail-before-exclusive',tail(before)==[q for q in ids(everything) if q<7][-2:],tail(before))
        page=got['/v1/events/page?afterSeq=2&limit=3']
        want('page-exclusive',page[0]==200 and ids(page[1]['rows'])==[3,4,5] and page[1]['head']==allocated and page[1]['ledgerIncarnationId']==incarnation,page)
        empty=got['/v1/events/page?afterSeq=100&limit=3']
        want('page-past-head',empty[0]==200 and empty[1]['rows']==[] and empty[1]['head']==allocated,empty)
        for path in ('/v1/events/page?afterSeq=0&limit=3&ledgerIncarnationId=wrong','/v1/events/tail?limit=3&ledgerIncarnationId=wrong'):
            want('fence:'+path,got[path][0]==409 and got[path][1]['error']['code']=='cursor_invalid',got[path])
        for path,field in [('/v1/events/tail?limit=2&beforeHrcSeq=5','ledgerIncarnationId'),('/v1/events/page?limit=3','afterSeq'),
                           ('/v1/events/page?afterSeq=-1&limit=3','afterSeq'),('/v1/events/page?afterSeq=0&limit=1001','limit'),
                           ('/v1/events/tail?limit=501','limit'),('/v1/events?generation=-1','generation'),('/v1/events?receipt=consumer-ack-v1','follow')]:
            want('refuse:'+path,got[path][0]==400 and got[path][1]['error']['detail']['field']==field,got[path])
        assert not problems,json.dumps(problems,indent=1)[:6000]
        print(json.dumps({'pass':True,'reads':len(got),'artifacts':str(a.artifacts)}))
    finally:
        s.cleanup('agent:tabularasa:project:n3-t11839:task:')

if __name__=='__main__':main()
