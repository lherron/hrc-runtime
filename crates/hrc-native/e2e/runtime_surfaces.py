"""Real ready-seat attachment and durable surface fences on isolated state."""
import json
import sqlite3
from runtime_reads import main


def cases(runtime,host,scope,root):
    base={'surfaceKind':'ghostty','surfaceId':'n1-surface-a','clientTty':'/dev/n1-t11818-a',
          'runtimeId':runtime,'hostSessionId':host,'generation':1,'windowId':'@1','paneId':'%1'}
    bind=lambda name,body:(name,'POST','/v1/surfaces/bind',body)
    return [
        ('attach','POST','/v1/runtimes/attach',{'runtimeId':runtime}),
        ('attach-trimmed','POST','/v1/runtimes/attach',{'runtimeId':' '+runtime+' '}),
        ('attach-missing','POST','/v1/runtimes/attach',{}),
        ('attach-unknown','POST','/v1/runtimes/attach',{'runtimeId':'absent'}),
        ('attach-sdk','POST','/v1/runtimes/attach',{'runtimeId':runtime+'-old-a'}),
        bind('bind',base),bind('bind-repeat',base),
        bind('bind-tty-displaced',dict(base,surfaceId='n1-surface-b')),
        bind('bind-rebound',dict(base,surfaceId='n1-surface-b',clientTty='/dev/n1-t11818-b')),
        bind('bind-missing',{}),bind('bind-unknown',dict(base,runtimeId='absent')),
        bind('bind-stale-host',dict(base,hostSessionId='hsid-absent')),
        bind('bind-stale-generation',dict(base,generation=2)),
        bind('bind-negative-generation',dict(base,generation=-1)),
        bind('bind-null-tty',dict(base,clientTty=None)),
        bind('bind-dead-runtime',dict(base,runtimeId=runtime+'-old-a')),
    ]


def observe(kind,record,dbpath):
    with sqlite3.connect(f'file:{dbpath}?mode=ro',uri=True) as db:
        db.row_factory=sqlite3.Row
        rows=[dict(row) for row in db.execute('SELECT * FROM surface_bindings ORDER BY surface_kind,surface_id')]
        events=[dict(row) for row in db.execute("SELECT hrc_seq,ts,host_session_id,scope_ref,lane_ref,generation,runtime_id,category,event_kind,payload_json FROM hrc_events WHERE category='surface' ORDER BY hrc_seq")]
        for event in events:event['payload']=json.loads(event.pop('payload_json'))
    return {'surfaceRows':rows,'surfaceEvents':events}


main(case_factory=cases,observe=observe,paginate=False)
