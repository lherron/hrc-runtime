#!/usr/bin/env python3
"""Message filters/row shape against real Bun repo inserts and HTTP responses.

Failure modes: applying filters after limit, wrong address/lane normalization,
missing execution/metadata fields, invalid-type error order, or pretending local
history is complete. Collective authority/replication belongs to N4.
"""
import argparse,json,sqlite3,subprocess
from pathlib import Path
from n3_scratch import Scratch

def exercise(s):
    seat='agent:tabularasa:project:n3-t11839:task:messages/lane:main'
    cases=[('empty-body',None),('primitive',3),('array',[]),('all',{}),('id',{'messageId':'msg-2'}),('from',{'from':{'kind':'entity','entity':'human'}}),('to',{'to':{'kind':'session','sessionRef':seat}}),('participant',{'participant':{'kind':'session','sessionRef':seat}}),('thread',{'thread':{'rootMessageId':'msg-0'}}),('after',{'afterSeq':2}),('kinds',{'kinds':['dm','system']}),('phases',{'phases':['response']}),('generation',{'generation':1}),('reverse-limit',{'order':'desc','limit':2}),('host',{'hostSessionId':'hs-message'}),('run',{'runId':'run-message'}),('reply',{'replyToMessageId':'msg-0'}),('invalid-thread',{'thread':3}),('invalid-after',{'afterSeq':-1}),('invalid-limit',{'limit':0}),('invalid-order',{'order':'random'}),('invalid-kinds',{'kinds':['bad']}),('invalid-phases',{'phases':'response'}),('invalid-reply',{'replyToMessageId':42}),('invalid-generation',{'generation':-1}),('invalid-participant',{'participant':None}),('invalid-entity',{'from':{'kind':'entity','entity':'agent'}}),('invalid-kind',{'to':{'kind':'other'}}),('invalid-ref',{'to':{'kind':'session','sessionRef':'bad'}}),('default-lane',{'to':{'kind':'session','sessionRef':seat.replace('lane:main','lane:default')}}),('empty-lists',{'kinds':[],'phases':[]}),('thread-root-type',{'thread':{'rootMessageId':3}})]
    return {key:s.http('POST','/v1/messages/query',body) for key,body in cases}

def main():
    p=argparse.ArgumentParser()
    for k in ('binary','installed-release','aspd-socket','scratch-root','artifacts'):p.add_argument('--'+k,type=Path,required=True)
    a=p.parse_args();s=Scratch(a.scratch_root,a.installed_release,a.aspd_socket,a.binary,a.artifacts,project_id='n3-t11839')
    try:
        s.init_substrate();bun=s.up('bun','message-wire')
        (a.artifacts/'real-empty-wire.json').write_text(json.dumps(s.http('POST','/v1/messages/query',{}),indent=2)+'\n')
        s.down(bun)
        module=s.release/'packages/hrc-store-sqlite/src/database.ts'
        script='import {openHrcDatabase} from '+json.dumps(str(module))+''';
const db=openHrcDatabase(process.argv[1]);const seat={kind:'session',sessionRef:'agent:tabularasa:project:n3-t11839:task:messages/lane:main'};
for(let i=0;i<7;i++) db.messages.insert({messageId:'msg-'+i,kind:['dm','literal','system'][i%3],phase:['request','response','oneway'][i%3],from:i%2?seat:{kind:'entity',entity:'human'},to:i%2?{kind:'entity',entity:'system'}:seat,body:i===2?'':`body ${i} 漢字\\nnext`,...(i===1?{replyToMessageId:'msg-0',rootMessageId:'msg-0'}:{}),execution:{state:i%2?'completed':'not_applicable',mode:'headless',sessionRef:seat.sessionRef,hostSessionId:'hs-message',generation:i%2,runtimeId:'rt-message',runId:'run-message',transport:'pipe'},metadataJson:{fixture:'real Bun repository',i}});
db.messages.updateExecution('msg-1',{coalescedIntoRunId:'run-other',coalescedPosition:2,errorCode:'fixture',errorMessage:'observed'});db.close();'''
        s.command('seed-production-message-repo',['bun','-e',script,s.db_path])
        bun=s.up('bun','message-baseline');expected=exercise(s)
        snapshot=s.root/'messages.sqlite'
        with sqlite3.connect(s.db_path) as source,sqlite3.connect(snapshot) as target:source.backup(target)
        s.down(bun)
        with sqlite3.connect(snapshot) as source,sqlite3.connect(s.db_path) as target:source.backup(target)
        s.up('native','message-subject');actual=exercise(s)
        for side,v in [('bun',expected),('native',actual)]:
            directory=a.artifacts/side;directory.mkdir(exist_ok=True);(directory/'messages.json').write_text(json.dumps(v,indent=2)+'\n')
        runner=Path(__file__).resolve().parents[3]/'conformance/hrc-parity/run.py'
        result=subprocess.run(['python3',str(runner),'compare','--suite','n3-messages','--baseline',str(a.artifacts/'bun'),'--candidate',str(a.artifacts/'native'),'--out',str(a.artifacts/'compare')],capture_output=True,text=True)
        (a.artifacts/'compare.stdout').write_text(result.stdout);(a.artifacts/'compare.stderr').write_text(result.stderr)
        assert result.returncode==0,(result.stdout,result.stderr)
        print(json.dumps({'pass':True,'cases':len(expected),'artifacts':str(a.artifacts)}))
    finally:s.cleanup('agent:tabularasa:project:n3-t11839:task:')
if __name__=='__main__':main()
