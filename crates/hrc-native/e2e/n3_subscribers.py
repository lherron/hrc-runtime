#!/usr/bin/env python3
"""Real subscriber, receipt and broker evidence doors on rusthrc with a private DB.

Failure modes: undeclared consumers, retained evidence leaking into delivery,
inclusive commit retry skipping a row, token bypass, receipt advancing past the
served head, duplicate/stale ACK mutation, and live admission leaked on close.
"""
import argparse,json
from pathlib import Path
from n3_scratch import Scratch,UnixHTTP

def request(s,method,path,body=None,headers=None):
    c=UnixHTTP(s.socket);c.request(method,path,json.dumps(body) if body is not None else None,{'Content-Type':'application/json',**(headers or {})});r=c.getresponse();raw=r.read().decode();c.close()
    try:return r.status,json.loads(raw)
    except ValueError:return r.status,raw

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
        s.init_substrate();s.up('native','subscribers')
        scope='agent:tabularasa:project:n3-t11839:task:subscribers'
        start=s.command('birth',['hrc','start',scope,'--project-id',s.project_id,'--project-root',s.project,'--cwd',s.project,'--json','-p','Reply with exactly the word OK and nothing else. No tools.'])
        runtime=start['runtime']['runtimeId'];s.wait_completed(start['runtime']['runId'])
        out=exercise(s,runtime)
        s.assert_no_duplicate_turn_messages()
        (a.artifacts/'subscribers.json').write_text(json.dumps(out,indent=2)+'\n')
        status={k:v[0] for k,v in out.items()}
        want={**{'bad-declare-'+str(i):400 for i in range(6)},'declare':200,
              'page':200,'retained':400,'bad-retained':400,'missing-after':400,'bad-limit':400,'inclusive-retry':200,
              'zero':400,'advanced':200,'duplicate':200,'snapshot':200,'hint':200,'clear-stop':200,
              **{'invalid-query'+q:400 for q in ['','?op=invalid','?op=input-accepted']},'invalid-query?op=input-accepted&runtimeId=missing&inputId=x':404}
        wrong={k:out[k] for k,v in want.items() if status[k]!=v}
        # Undeclared consumers, a wrong token, an unknown subscriber and a
        # receipt past the served head are refused, whatever the code.
        for k in ('unnamed','unknown','unknown-ack','bad-token','ahead'):
            if status[k]<400:wrong[k]=out[k]
        # Duplicate and stale ACKs are answered but never move the receipt.
        acks={k:(out[k][1].get('disposition'),out[k][1].get('lastConsumerAcknowledgedSeq')) for k in ('advanced','duplicate','stale')}
        head=out['advanced'][1].get('seq')
        if acks!={'advanced':('advanced',head),'duplicate':('duplicate',head),'stale':('stale',head)}:wrong['acks']=acks
        # Redeclaring a name on its route returns the same admission and keeps its receipt mode.
        if (out['redeclare'][1].get('subscriberId'),out['redeclare'][1].get('receiptMode'))!=(out['declare'][1]['subscriberId'],'consumer-ack-v1'):wrong['redeclare']=out['redeclare']
        assert not wrong,wrong
        # Retained evidence never reaches a named delivery consumer.
        assert out['retained'][1]['error']['code']=='invalid_fence',out['retained']
        assert out['page'][1]['events'],out['page']
        print(json.dumps({'pass':True,'cases':len(out),'artifacts':str(a.artifacts)}))
    finally:s.cleanup('agent:tabularasa:project:n3-t11839:task:')
if __name__=='__main__':main()
