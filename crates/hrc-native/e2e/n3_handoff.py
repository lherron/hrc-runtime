#!/usr/bin/env python3
"""Semantic handoff's refusal order, before any durable target/message write.

Failure modes: parser precedence drift, denied provisioning escaping through
this door, intent materialization before refusal, or an absent native route
being mistaken for a valid unknown-session refusal, or losing/repeating the
durable semantic response across owner replacement while its tool is running.
"""
import argparse,json,shlex,time,subprocess
from pathlib import Path
from n3_scratch import Scratch

def refusals(s):
    base={'from':{'kind':'entity','entity':'human'},'to':{'kind':'session','sessionRef':'agent:tabularasa:project:n3-t11839:task:handoff/lane:main'},'body':'Private handoff probe','createIfMissing':False}
    cases=[('null',None),('primitive',42),('array',[]),('empty',{}),('body-number',{**base,'body':42}),('mode',{**base,'mode':'interactive'}),('reply-type',{**base,'replyToMessageId':3}),('respond-to',{**base,'respondTo':None}),('provision-null',{**base,'runtimeIntent':{'provision':None}}),('provision-array',{**base,'runtimeIntent':{'provision':[]}}),('provision-nested',{**base,'runtimeIntent':{'provision':{'claude':{}}}}),('provision-null-member',{**base,'runtimeIntent':{'provision':{'model':None}}}),('provision-denied-yolo',{**base,'runtimeIntent':{'provision':{'yolo':False}}}),('provision-denied-sandbox',{**base,'runtimeIntent':{'provision':{'sandbox':'off'}}}),('provision-shape-first',{**base,'runtimeIntent':{'provision':{'yolo':False,'nested':[]}}}),('fresh-type',{**base,'freshContext':'true'}),('response-format',{**base,'responseFormat':3}),('from-kind',{**base,'from':{'kind':'agent'}}),('from-entity',{**base,'from':{'kind':'entity','entity':'cody'}}),('from-ref',{**base,'from':{'kind':'session','sessionRef':'bad'}}),('to-kind',{**base,'to':None}),('to-ref',{**base,'to':{'kind':'session','sessionRef':'bad'}}),('directive-intent',{**base,'runtimeIntent':{}}),('directive-provision',{**base,'runtimeIntent':{'provision':{'model':'future-model'}}}),('entity-target',{**base,'to':{'kind':'entity','entity':'system'}}),('unknown-parent',{**base,'replyToMessageId':'msg-absent'}),('unknown-target',base),('empty-text',{**base,'body':''}),('ignored-intent-type',{**base,'runtimeIntent':3}),('ignored-option-types',{**base,'createIfMissing':'yes','wait':'yes','allowStaleGeneration':'yes','allowCrossScopeReply':'yes'}),('precedence-mode',{**base,'mode':3,'replyToMessageId':3}),('precedence-respond',{**base,'respondTo':None,'runtimeIntent':{'provision':None}}),('precedence-fresh',{**base,'freshContext':3,'from':None}),('precedence-intent',{**base,'runtimeIntent':{},'replyToMessageId':'msg-absent'})]
    before=s.rows('SELECT (SELECT COUNT(*) FROM messages) AS messages,(SELECT COUNT(*) FROM sessions) AS sessions')[0]
    observed={name:s.http('POST','/v1/messages/turn-handoff',body) for name,body in cases}
    after=s.rows('SELECT (SELECT COUNT(*) FROM messages) AS messages,(SELECT COUNT(*) FROM sessions) AS sessions')[0]
    assert before==after,('refusal persisted target/message',before,after)
    assert all(v[0]>=400 for v in observed.values()),observed
    return observed

def turns(s,owner,process):
    scope='agent:tabularasa:project:n3-t11839:task:handoff'
    birth=s.command('birth',['hrc','start',scope,'--no-viewer','--project-id',s.project_id,'--project-root',s.project,'--cwd',s.project,'--json','-p','Reply with exactly READY. No tools.'])
    rt=birth['runtime'];s.wait_completed(rt['runId'])
    base={'from':{'kind':'entity','entity':'human'},'to':{'kind':'session','sessionRef':scope+'/lane:main'}}
    observed={}
    def send(name,body):
        before=s.rows('SELECT COALESCE(MAX(hrc_seq),0) AS n FROM hrc_events')[0]['n']
        response=s.http('POST','/v1/messages/turn-handoff',body)
        observed[name]={'response':response,'beforeHrcSeq':before}
        (s.artifacts/'handoff-turns.json').write_text(json.dumps(observed,indent=2)+'\n')
        assert response[0]==200,response
        assert response[1]['fromSeq']>before,(before,response)
        return response[1]
    def final(name,receipt,word):
        s.wait_completed(receipt['runId'])
        response=s.wait(lambda:s.rows("SELECT * FROM messages WHERE reply_to_message_id=? AND phase='response'",(receipt['messageId'],)),120,'durable handoff response')
        assert len(response)==1 and response[0]['body']==word,response
        status,result=s.http('POST','/v1/messages/query',{'messageId':receipt['messageId']})
        assert status==200 and len(result['messages'])==1,(status,result)
        request=result['messages'][0]
        assert request['execution']['state']=='completed',request
        assert request['execution']['runId']==receipt['runId'],request
        observed[name].update(request=request,responseRows=response)
    warm=send('warm',{**base,'body':'Reply with exactly HANDOFF_WARM. No tools.'})
    final('warm',warm,'HANDOFF_WARM')
    ready=s.root/'handoff-ready';release=s.root/'handoff-release'
    command='touch '+shlex.quote(str(ready))+'; while [ ! -f '+shlex.quote(str(release))+' ]; do sleep 0.1; done'
    try:
        held=send('restart',{**base,'body':'Use Bash once to run this exact command, wait until it finishes, then reply with exactly HANDOFF_RESTART.\n'+command})
        s.wait(ready.exists,120,'handoff tool held before restart')
        before=s.rows('SELECT COUNT(*) AS n FROM broker_invocation_events')[0]['n']
        s.down(process);process=s.up(owner,'handoff-restarted');release.touch()
        final('restart',held,'HANDOFF_RESTART')
        observed['restart']['brokerRowsBeforeRestart']=before
        intent=json.loads(s.rows('SELECT last_applied_intent_json FROM sessions WHERE host_session_id=?',(rt['hostSessionId'],))[0]['last_applied_intent_json'])
        intent.pop('selection',None)
        if isinstance(intent.get('placement'),dict):intent['placement'].pop('correlation',None)
        cold=send('cold',{**base,'to':{'kind':'session','sessionRef':scope+'-cold/lane:main'},'runtimeIntent':intent,'body':'Reply with exactly HANDOFF_COLD. No tools.'})
        final('cold',cold,'HANDOFF_COLD')
        s.down(process);process=s.up(owner,'handoff-final-restart');time.sleep(2)
        for name in ('warm','restart','cold'):
            message_id=observed[name]['response'][1]['messageId']
            assert len(s.rows("SELECT * FROM messages WHERE reply_to_message_id=? AND phase='response'",(message_id,)))==1,('duplicate response after restart',name)
        s.assert_no_duplicate_turn_messages()
        (s.artifacts/'handoff-turns.json').write_text(json.dumps(observed,indent=2)+'\n')
        return observed
    finally:release.touch(exist_ok=True)

def main():
    p=argparse.ArgumentParser();p.add_argument('--owner',choices=['bun','native'],required=True);p.add_argument('--turns',action='store_true');p.add_argument('--baseline',type=Path)
    for k in ('binary','installed-release','aspd-socket','scratch-root','artifacts'):p.add_argument('--'+k,type=Path,required=True)
    a=p.parse_args();s=Scratch(a.scratch_root,a.installed_release,a.aspd_socket,a.binary,a.artifacts,project_id='n3-t11839')
    try:
        s.init_substrate();process=s.up(a.owner,'handoff-refusals');observed=refusals(s)
        (a.artifacts/'handoff-refusals.json').write_text(json.dumps(observed,indent=2)+'\n')
        assert observed['body-number'][0]==400,('missing real handoff handler',observed['body-number'])
        assert observed['unknown-target'][0]==404 and observed['unknown-target'][1]['error']['code']=='unknown_session',observed['unknown-target']
        result={'pass':True,'owner':a.owner,'cases':len(observed),'noTargetOrMessageWrite':True}
        matrix={'refusal:'+name:value for name,value in observed.items()}
        if a.turns:
            flows=turns(s,a.owner,process)
            aliases={}
            for name,flow in flows.items():
                receipt=flow['response'][1]
                for key in ('messageId','runId'):aliases[receipt[key]]=name+':'+key
                for key in ('runtimeId','hostSessionId'):
                    aliases.setdefault(receipt[key],name+':'+key)
                aliases[flow['responseRows'][0]['message_id']]=name+':reply'
            def normalize(v):
                if isinstance(v,dict):return {k:'<time>' if k in ('created_at','createdAt') else normalize(x) for k,x in v.items()}
                if isinstance(v,list):return [normalize(x) for x in v]
                if isinstance(v,str):return aliases.get(v,v.replace(str(s.root),'<scratch>'))
                return v
            for name,flow in flows.items():
                receipt=json.loads(json.dumps(flow['response']));receipt[1]['fromSeq']-=flow['beforeHrcSeq']
                matrix['turn:'+name]=normalize({'response':receipt,'request':flow['request'],'responseRows':flow['responseRows']})
            result.update(realTurns=3,restartBetweenDispatchAndReply=True,oneDurableResponsePerRequest=True)
        (a.artifacts/'handoff.json').write_text(json.dumps(matrix,indent=2)+'\n')
        if a.baseline:
            assert a.turns,'full runner compare requires the three real turn paths'
            runner=Path(__file__).resolve().parents[3]/'conformance/hrc-parity/run.py'
            compared=subprocess.run(['python3',str(runner),'compare','--suite','n3-handoff','--baseline',str(a.baseline),'--candidate',str(a.artifacts),'--out',str(a.artifacts/'compare')],capture_output=True,text=True)
            (a.artifacts/'compare.stdout').write_text(compared.stdout);(a.artifacts/'compare.stderr').write_text(compared.stderr)
            assert compared.returncode==0,(compared.stdout,compared.stderr)
        (a.artifacts/'result.json').write_text(json.dumps(result,indent=2)+'\n')
        print(json.dumps(result))
    finally:s.cleanup('agent:tabularasa:project:n3-t11839:task:')
if __name__=='__main__':main()
