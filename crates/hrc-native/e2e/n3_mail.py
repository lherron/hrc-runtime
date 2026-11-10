#!/usr/bin/env python3
"""Stop gate on real private wrkc obligations, driven against rusthrc.

Proves unseen pending mail does not block, presented unanswered mail does block,
refusal caps/reset survive in HRC execution state, and wrkc replies clear the
wrkq-owned obligation. This is not the injector delivery/restart gate.
"""
import argparse,json
from pathlib import Path
from n3_scratch import Scratch

def rpc(s,method,params):
    frame={'jsonrpc':'2.0','id':1,'method':method,'params':{'principalRef':'agent:hrc',**params}}
    out=s.command(method,[str(Path.home() / ".local/bin/wrkq"),'rpc','--stdio'],stdin=json.dumps(frame)+'\n')
    if isinstance(out,str):out=json.loads(out.splitlines()[-1])
    assert 'error' not in out,out
    return out['result']

def exercise(s,scope,runtime,host,generation):
    sender='cody@n3-t11839:primary';seat='tabularasa@n3-t11839:mail';out={}
    def say(body):
        result=s.command('private-wrkc-say',[str(Path.home() / ".local/bin/wrkc"),'say','/n3-t11839','--scope-ref',sender,'--as','agent:cody','--to',seat,'-m',body,'--json'])
        envelope=result['envelopes'][0];return envelope['id']
    def stop(name):
        status,v=s.http('POST','/v1/internal/mail/stop-decision',{'runtimeId':runtime});assert status==200,(status,v);out[name]=v;return v
    def present(id):
        return rpc(s,'wrkq.envelope.present',{'envelope':id,'memberRef':seat,'node':s.project_id,'runtimeId':runtime,'hostSessionId':host,'generation':str(generation),'driveAttemptId':'drive-'+id})
    id=say('Please answer the private N3 gate.\nWhitespace   is normalized.')
    assert stop('unseen')['reason']=='clear'
    present(id)
    assert stop('block-first')['decision']=='block'
    assert stop('block-second')['decision']=='block'
    assert stop('cap-third')['reason']=='refusal_cap'
    next_id=say('New private obligation resets the refusal cycle.')
    present(next_id)
    assert stop('new-obligation')['refusalCount']==1
    for id in (id,next_id):
        s.command('private-wrkc-reply',[str(Path.home() / ".local/bin/wrkc"),'say',id,'--scope-ref',seat,'--as','agent:tabularasa','--to',sender,'--fyi','-m','Private gate answered.','--json'])
    assert stop('answered')['reason']=='clear'
    for label,body in [('array',[]),('empty',{}),('missing-runtime',{'runtimeId':'missing'}),('not-string',{'runtimeId':42})]:out[label]=s.http('POST','/v1/internal/mail/stop-decision',body)
    return out

def main():
    p=argparse.ArgumentParser()
    for k in ('binary','installed-release','aspd-socket','scratch-root','artifacts'):p.add_argument('--'+k,type=Path,required=True)
    a=p.parse_args();s=Scratch(a.scratch_root,a.installed_release,a.aspd_socket,a.binary,a.artifacts,project_id='n3-t11839')
    try:
        s.init_substrate();s.up('native','mail')
        scope='agent:tabularasa:project:n3-t11839:task:mail'
        start=s.command('birth',['hrc','start',scope,'--project-id',s.project_id,'--project-root',s.project,'--cwd',s.project,'--json','-p','Reply with exactly the word OK and nothing else. No tools.'])
        rt=start['runtime'];runtime=rt['runtimeId'];s.wait_completed(rt['runId']);host=rt['hostSessionId'];generation=rt['generation']
        out=exercise(s,scope,runtime,host,generation)
        s.assert_no_duplicate_turn_messages()
        (a.artifacts/'mail.json').write_text(json.dumps(out,indent=2)+'\n')
        assert out['block-first']['unackedCount']==1 and out['block-second']['refusalCount']==2,(out['block-first'],out['block-second'])
        assert out['answered']['decision']=='allow' and out['unseen']['decision']=='allow',(out['unseen'],out['answered'])
        refused={k:out[k][0] for k in ('array','empty','not-string')}
        assert refused=={'array':400,'empty':400,'not-string':400},refused
        # An unknown runtime fails open: a Stop hook must never block on it.
        assert tuple(out['missing-runtime'])==(200,{'decision':'allow','reason':'no_runtime'}),out['missing-runtime']
        print(json.dumps({'pass':True,'cases':len(out),'artifacts':str(a.artifacts)}))
    finally:s.cleanup('agent:tabularasa:project:n3-t11839:task:')
if __name__=='__main__':main()
