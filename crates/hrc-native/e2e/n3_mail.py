#!/usr/bin/env python3
"""Stop gate on real private wrkc obligations, with identical Bun/native drives.

Proves unseen pending mail does not block, presented unanswered mail does block,
refusal caps/reset survive in HRC execution state, and wrkc replies clear the
wrkq-owned obligation. This is not the injector delivery/restart gate.
"""
import argparse,json,sqlite3,time
from pathlib import Path
from n3_scratch import Scratch

def rpc(s,method,params):
    frame={'jsonrpc':'2.0','id':1,'method':method,'params':{'principalRef':'agent:hrc',**params}}
    out=s.command(method,['wrkq','rpc','--stdio'],stdin=json.dumps(frame)+'\n')
    if isinstance(out,str):out=json.loads(out.splitlines()[-1])
    assert 'error' not in out,out
    return out['result']

def exercise(s,scope,runtime,host,generation):
    sender='cody@n3-t11839:primary';seat='tabularasa@n3-t11839:mail';out={}
    def say(body):
        result=s.command('private-wrkc-say',['wrkc','say','/n3-t11839','--scope-ref',sender,'--as','agent:cody','--to',seat,'-m',body,'--json'])
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
        s.command('private-wrkc-reply',['wrkc','say',id,'--scope-ref',seat,'--as','agent:tabularasa','--to',sender,'--fyi','-m','Private gate answered.','--json'])
    assert stop('answered')['reason']=='clear'
    for label,body in [('array',[]),('empty',{}),('missing-runtime',{'runtimeId':'missing'}),('not-string',{'runtimeId':42})]:out[label]=s.http('POST','/v1/internal/mail/stop-decision',body)
    return out

def main():
    p=argparse.ArgumentParser()
    for k in ('binary','installed-release','aspd-socket','scratch-root','artifacts'):p.add_argument('--'+k,type=Path,required=True)
    a=p.parse_args();s=Scratch(a.scratch_root,a.installed_release,a.aspd_socket,a.binary,a.artifacts,project_id='n3-t11839')
    try:
        s.init_substrate();bun=s.up('bun','mail')
        scope='agent:tabularasa:project:n3-t11839:task:mail'
        start=s.command('birth',['hrc','start',scope,'--project-id',s.project_id,'--project-root',s.project,'--cwd',s.project,'--json','-p','Reply with exactly the word OK and nothing else. No tools.'])
        rt=start['runtime'];runtime=rt['runtimeId'];s.wait_completed(rt['runId']);host=rt['hostSessionId'];generation=rt['generation']
        snapshot=s.root/'before-mail.sqlite'
        with sqlite3.connect(s.db_path) as source,sqlite3.connect(snapshot) as target:source.backup(target)
        expected=exercise(s,scope,runtime,host,generation)
        s.down(bun)
        with sqlite3.connect(snapshot) as source,sqlite3.connect(s.db_path) as target:source.backup(target)
        s.up('native','mail');actual=exercise(s,scope,runtime,host,generation)
        s.assert_no_duplicate_turn_messages()
        cases={k:{'bun':v,'native':actual[k],'pass':v==actual[k]} for k,v in expected.items()}
        (a.artifacts/'mail-compares.json').write_text(json.dumps(cases,indent=2)+'\n')
        for side,observations in [('bun',expected),('native',actual)]:
            directory=a.artifacts/side;directory.mkdir(exist_ok=True)
            (directory/'mail.json').write_text(json.dumps(observations,indent=2)+'\n')
        import subprocess
        runner=Path(__file__).resolve().parents[3]/'conformance/hrc-parity/run.py'
        compared=subprocess.run(['python3',str(runner),'compare','--suite','n3-mail','--baseline',str(a.artifacts/'bun'),'--candidate',str(a.artifacts/'native'),'--out',str(a.artifacts/'compare')],capture_output=True,text=True)
        (a.artifacts/'compare.stdout').write_text(compared.stdout);(a.artifacts/'compare.stderr').write_text(compared.stderr)
        assert compared.returncode==0,(compared.stdout,compared.stderr)
        bad=[k for k,v in cases.items() if not v['pass']];assert not bad,bad
        print(json.dumps({'pass':True,'compared':len(cases),'artifacts':str(a.artifacts)}))
    finally:s.cleanup('agent:tabularasa:project:n3-t11839:task:')
if __name__=='__main__':main()
