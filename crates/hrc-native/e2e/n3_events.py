#!/usr/bin/env python3
"""Compare native event history to the named Bun copy on one scratch ledger.

Failure modes: exclusive/inclusive cursor confusion, filters applied after page
limits, wrong ledger fences, head computed from surviving rows instead of the
allocated sequence, hydrated covering pages, and NDJSON records reshaped by the
monitor projection. Bun creates all rows; N3 only reads them.
"""
import argparse,json,sqlite3
from pathlib import Path
from n3_scratch import Scratch


def main():
    p=argparse.ArgumentParser()
    for key in ('binary','installed-release','aspd-socket','scratch-root','artifacts'):
        p.add_argument('--'+key,type=Path,required=True)
    a=p.parse_args()
    s=Scratch(a.scratch_root,a.installed_release,a.aspd_socket,a.binary,a.artifacts,project_id='n3-t11839')
    cases={}
    try:
        s.init_substrate()
        bun=s.up('bun','read-baseline')
        # Real producer API, not a hand-declared SQL fixture.
        module=s.release/'packages/hrc-store-sqlite/src/database.ts'
        script='import {openHrcDatabase} from '+json.dumps(str(module))+''';
const db=openHrcDatabase(process.argv[1]);
for(let i=0;i<9;i++) db.hrcEvents.append({ts:new Date(1700000000000+i).toISOString(),hostSessionId:'hrc-server',scopeRef:'server:hrc',laneRef:i%2?'other':'main',generation:i%3,category:'server',eventKind:i%2?'server.test.odd':'server.test.even',payload:{i}});
// An allocated-but-deleted tail still belongs to the covering page's head.
db.sqlite.exec('DELETE FROM hrc_events WHERE hrc_seq=(SELECT MAX(hrc_seq) FROM hrc_events)'); db.close();'''
        s.command('seed-real-repository',['bun','-e',script,s.db_path])
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
        expected={path:s.http('GET',path) for path in paths}
        snapshot=s.root/'history.sqlite'
        with sqlite3.connect(s.db_path) as source, sqlite3.connect(snapshot) as target:
            source.backup(target)
        s.down(bun)
        # Graceful Bun shutdown appends its own lifecycle records. Restore the
        # read snapshot after its owner exits so comparisons see identical rows.
        with sqlite3.connect(snapshot) as source, sqlite3.connect(s.db_path) as target:
            source.backup(target)
        native=s.up('native','read-subject')
        for path,want in expected.items():
            got=s.http('GET',path)
            cases[path]={'bun':want,'native':got,'pass':want==got}
        (a.artifacts/'event-compares.json').write_text(json.dumps(cases,indent=2)+'\n')
        for side,observations in [('bun',expected),('native',{k:v['native'] for k,v in cases.items()})]:
            directory=a.artifacts/side;directory.mkdir(exist_ok=True)
            (directory/'events.json').write_text(json.dumps(observations,indent=2)+'\n')
        import subprocess
        runner=Path(__file__).resolve().parents[3]/'conformance/hrc-parity/run.py'
        compared=subprocess.run(['python3',str(runner),'compare','--suite','n3-events','--baseline',str(a.artifacts/'bun'),'--candidate',str(a.artifacts/'native'),'--out',str(a.artifacts/'compare')],capture_output=True,text=True)
        (a.artifacts/'compare.stdout').write_text(compared.stdout);(a.artifacts/'compare.stderr').write_text(compared.stderr)
        assert compared.returncode==0,(compared.stdout,compared.stderr)
        bad=[k for k,v in cases.items() if not v['pass']]
        assert not bad,bad
        print(json.dumps({'compared':len(cases),'pass':True,'artifacts':str(a.artifacts)}))
    finally:
        s.cleanup('agent:tabularasa:project:n3-t11839:task:')

if __name__=='__main__':main()
