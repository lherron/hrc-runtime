#!/usr/bin/env python3
"""Real copied-Bun/native subscriber and broker evidence parity on a private DB.

Failure modes: undeclared consumers, retained evidence leaking into delivery,
inclusive commit retry skipping a row, token bypass, receipt advancing past the
served head, duplicate/stale ACK mutation, and live admission leaked on close.
"""
import argparse,json,time,sqlite3
from pathlib import Path
from n3_scratch import Scratch,UnixHTTP

def request(s,method,path,body=None,headers=None):
    c=UnixHTTP(s.socket);c.request(method,path,json.dumps(body) if body is not None else None,{'Content-Type':'application/json',**(headers or {})});r=c.getresponse();raw=r.read().decode();c.close()
    try:return r.status,json.loads(raw)
    except ValueError:return r.status,raw

def normalize(v):
    if isinstance(v,dict):return {k:normalize(x) for k,x in v.items() if k not in ('subscriberId','receiptToken','openedAt','lastStreamAcceptedAt','consumerReceiptBehindSince','lastConsumerAcknowledgedAt','keepaliveOnlySince','pendingSince')}
    if isinstance(v,(list,tuple)):return [normalize(x) for x in v]
    return v

def exercise(s,runtime):
    out={}
    def call(name,method,path,body=None,headers=None):
        value=request(s,method,path,body,headers);out[name]=value;return value
    root='/v1/server/subscribers';follow='/v1/broker-events/follow'
    for i,b in enumerate([None,[],{}, {'name':' '},{'name':'x','route':'bad'},{'name':'x','receiptMode':'bad'}]):call('bad-declare-'+str(i),'POST',root,b)
    call('unnamed','GET',follow+'?afterCommit=0')
    call('unknown','GET',follow+'?afterCommit=0',headers={'x-hrc-subscriber-name':'unknown'})
    decl=call('declare','POST',root,{'name':'n3','receiptMode':'consumer-ack-v1'})[1];token=decl['receiptToken'];id=decl['subscriberId']
    call('redeclare','POST',root,{'name':'n3','receiptMode':'none'})
    headers={'x-hrc-subscriber-name':'n3'}
    for key,path in [('page',follow+'?afterCommit=0&limit=2'),('retained',follow+'?afterCommit=0&includeRetained=true'),('bad-retained',follow+'?afterCommit=0&includeRetained=1'),('missing-after',follow),('bad-limit',follow+'?afterCommit=0&limit=1001')]:call(key,'GET',path,headers=headers)
    page=out['page'][1];assert page['events'],page
    boundary=page['nextCommit'];again=call('inclusive-retry','GET',follow+f'?afterCommit={boundary}&limit=2',headers=headers)[1];assert again['events'][0]['commitOrdinal']==boundary
    for name,body in [('unknown-ack',{'subscriberId':'none','receiptToken':token,'seq':1}),('bad-token',{'subscriberId':id,'receiptToken':'wrong','seq':1}),('ahead',{'subscriberId':id,'receiptToken':token,'seq':999999}),('zero',{'subscriberId':id,'receiptToken':token,'seq':0}),('advanced',{'subscriberId':id,'receiptToken':token,'seq':again['nextCommit']}),('duplicate',{'subscriberId':id,'receiptToken':token,'seq':again['nextCommit']}),('stale',{'subscriberId':id,'receiptToken':token,'seq':1})]:call(name,'POST',root+'/ack',body)
    call('snapshot','GET',root)
    for op,param in [('input-accepted','inputId'),('admission-rejection','submissionId'),('disposition','submissionId'),('input-rejection-evidence','submissionId')]:call('query-'+op,'GET',f'/v1/broker-events/query?op={op}&runtimeId={runtime}&{param}=absent')
    call('query-unique','GET',f'/v1/broker-events/query?op=unique-submission-after&runtimeId={runtime}&invocationId=none&envelopeId=none&afterSeq=0')
    for suffix in ['', '?op=invalid','?op=input-accepted','?op=input-accepted&runtimeId=missing&inputId=x']:call('invalid-query'+suffix,'GET','/v1/broker-events/query'+suffix)
    call('hint','POST','/v1/internal/mail/hint-decision',{'runtimeId':runtime})
    call('clear-stop','POST','/v1/internal/mail/stop-decision',{'runtimeId':runtime})
    return out

def main():
    p=argparse.ArgumentParser()
    for k in ('binary','installed-release','aspd-socket','scratch-root','artifacts'):p.add_argument('--'+k,type=Path,required=True)
    a=p.parse_args();s=Scratch(a.scratch_root,a.installed_release,a.aspd_socket,a.binary,a.artifacts,project_id='n3-t11839')
    try:
        s.init_substrate();bun=s.up('bun','subscribers')
        scope='agent:tabularasa:project:n3-t11839:task:subscribers'
        start=s.command('birth',['hrc','start',scope,'--project-id',s.project_id,'--project-root',s.project,'--cwd',s.project,'--json','-p','Reply with exactly the word OK and nothing else. No tools.'])
        runtime=start['runtime']['runtimeId'];s.wait_completed(start['runtime']['runId'])
        expected=exercise(s,runtime)
        snapshot=s.root/'history.sqlite'
        with sqlite3.connect(s.db_path) as source,sqlite3.connect(snapshot) as target:source.backup(target)
        s.down(bun)
        with sqlite3.connect(snapshot) as source,sqlite3.connect(s.db_path) as target:source.backup(target)
        s.up('native','subscribers');actual=exercise(s,runtime)
        s.assert_no_duplicate_turn_messages()
        cases={k:{'bun':v,'native':actual[k],'pass':normalize(v)==normalize(actual[k]),'keyOrderPass':json.dumps(normalize(v),separators=(',',':'))==json.dumps(normalize(actual[k]),separators=(',',':'))} for k,v in expected.items()}
        (a.artifacts/'subscriber-compares.json').write_text(json.dumps(cases,indent=2)+'\n')
        for side,observations in [('bun',expected),('native',actual)]:
            directory=a.artifacts/side;directory.mkdir(exist_ok=True)
            (directory/'subscribers.json').write_text(json.dumps(observations,indent=2)+'\n')
        import subprocess
        runner=Path(__file__).resolve().parents[3]/'conformance/hrc-parity/run.py'
        compared=subprocess.run(['python3',str(runner),'compare','--suite','n3-subscribers','--baseline',str(a.artifacts/'bun'),'--candidate',str(a.artifacts/'native'),'--out',str(a.artifacts/'compare')],capture_output=True,text=True)
        (a.artifacts/'compare.stdout').write_text(compared.stdout);(a.artifacts/'compare.stderr').write_text(compared.stderr)
        assert compared.returncode==0,(compared.stdout,compared.stderr)
        bad=[k for k,v in cases.items() if not v['pass'] or not v['keyOrderPass']];assert not bad,bad
        print(json.dumps({'pass':True,'compared':len(cases),'artifacts':str(a.artifacts)}))
    finally:s.cleanup('agent:tabularasa:project:n3-t11839:task:')
if __name__=='__main__':main()
