#!/usr/bin/env python3
"""Real HTTP submission doors: parser order, unavailable target, broker withdraw.

Failures include a missing route returning a convenient 404, withdrawal by the
wrong identifier, a parser skipping ownerRunId, and bypassing N2 admission.
"""
import argparse,json,sys,time
from pathlib import Path
from n3_scratch import Scratch

def exercise(s,runtime):
    out={};cuts={}
    base={'target':'agent:tabularasa:project:n3-t11839:task:absent/lane:main','body':'Private submission probe','origin':{'principalRef':'agent:cody'}}
    for door in ('steer','enqueue','preempt','preempt/admission'):
        path='/v1/submissions/'+door
        for label,body in [('null',None),('primitive',3),('array',[]),('empty',{}),('missing-body',{'target':base['target']}),('missing-origin',{'target':base['target'],'body':'x'}),('unknown-field',{**base,'extra':1}),('origin-extra',{**base,'origin':{'principalRef':'agent:cody','extra':1}}),('wait-string',{**base,'wait':'yes'}),('absent-target',base)]:
            out[door+':'+label]=s.http('POST',path,body)
    withdraw='/v1/submissions/withdraw'
    seed={'runtimeId':runtime,'submissionId':'n3-not-held','reason':'Private N3 withdrawal'}
    for label,body in [('null',None),('primitive',3),('array',[]),('empty',{}),('owner-error',{**seed,'ownerRunId':42}),('neither',{'runtimeId':runtime,'reason':'x'}),('both',{**seed,'envelopeId':'EN-private'}),('id-empty',{**seed,'submissionId':' '}),('reason-missing',{'runtimeId':runtime,'submissionId':'x'}),('unknown-runtime',{**seed,'runtimeId':'n3-missing-runtime'}),('submission-not-held',seed),('envelope-not-held',{'runtimeId':runtime,'envelopeId':'EN-private-absent','reason':'probe'})]:
        out['withdraw:'+label]=s.http('POST',withdraw,body)
    for principal in ('agent:cody','agent:lance'):
        out['preempt-active:'+principal]=s.http('POST','/v1/submissions/preempt/admission',{**base,'target':'agent:tabularasa:project:n3-t11839:task:submission/lane:main','origin':{'principalRef':principal}})
        assert out['preempt-active:'+principal][0]==200,out
    for door in ('enqueue','steer'):
        head=s.rows('SELECT COALESCE(MAX(hrc_seq),0) AS n FROM hrc_events')[0]['n']
        broker=s.rows('SELECT COALESCE(MAX(seq),0) AS n FROM broker_invocation_events')[0]['n']
        status,received=s.http('POST','/v1/submissions/'+door,{**base,'target':'agent:tabularasa:project:n3-t11839:task:submission/lane:main','body':'Reply with exactly the word OK and nothing else. No tools.','wait':True})
        out[door+':real-turn']=[status,json.loads(json.dumps(received))];assert status==200,(door,status,received)
        observation=out[door+':real-turn'][1]['observation']
        cuts[door]={'beforeLifecycle':head,'beforeBroker':broker,'reported':received['observation']}
        observation['lifecycle']['fromSeq']-=head
        observation['broker']['afterSeq']-=broker
        assert observation['lifecycle']['fromSeq']>=1 and observation['broker']['afterSeq']>=0,cuts

    (s.artifacts/('submission-cuts-'+str(time.time_ns())+'.json')).write_text(json.dumps(cuts,indent=2)+'\n')
    s.assert_no_duplicate_turn_messages()
    return out

def main():
    p=argparse.ArgumentParser()
    for k in ('binary','installed-release','aspd-socket','scratch-root','artifacts'):p.add_argument('--'+k,type=Path,required=True)
    a=p.parse_args();s=Scratch(a.scratch_root,a.installed_release,a.aspd_socket,a.binary,a.artifacts,project_id='n3-t11839')
    try:
        s.init_substrate();bun=s.up('bun','submission-baseline')
        scope='agent:tabularasa:project:n3-t11839:task:submission'
        start=s.command('birth',['hrc','start',scope,'--no-viewer','--project-id',s.project_id,'--project-root',s.project,'--cwd',s.project,'--json','-p','Reply with exactly the word OK and nothing else. No tools.'])
        rt=start['runtime'];s.wait_completed(rt['runId'])
        import sqlite3
        snapshot=s.root/'before-submissions.sqlite'
        with sqlite3.connect(s.db_path) as source,sqlite3.connect(snapshot) as target:source.backup(target)
        expected=exercise(s,rt['runtimeId'])
        (a.artifacts/'submissions-baseline.json').write_text(json.dumps(expected,indent=2)+'\n')
        s.down(bun)
        with sqlite3.connect(snapshot) as source,sqlite3.connect(s.db_path) as target:source.backup(target)
        s.up('native','submission-subject');actual=exercise(s,rt['runtimeId'])
        for side,v in [('bun',expected),('native',actual)]:
            directory=a.artifacts/side;directory.mkdir(exist_ok=True);(directory/'submissions.json').write_text(json.dumps(v,indent=2)+'\n')
        import subprocess
        runner=Path(__file__).resolve().parents[3]/'conformance/hrc-parity/run.py'
        compared=subprocess.run(['python3',str(runner),'compare','--suite','n3-submissions','--baseline',str(a.artifacts/'bun'),'--candidate',str(a.artifacts/'native'),'--out',str(a.artifacts/'compare')],capture_output=True,text=True)
        (a.artifacts/'compare.stdout').write_text(compared.stdout);(a.artifacts/'compare.stderr').write_text(compared.stderr)
        assert compared.returncode==0,(compared.stdout,compared.stderr)
        assert expected['withdraw:submission-not-held'][0]==200,expected
        print(json.dumps({'pass':True,'cases':len(expected),'artifacts':str(a.artifacts)}))
    finally:s.cleanup('agent:tabularasa:project:n3-t11839:task:')
if __name__=='__main__':main()
