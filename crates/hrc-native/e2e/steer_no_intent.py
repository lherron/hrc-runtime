#!/usr/bin/env python3
"""T-11928: `hrc turn` steers a seat that has a session but no live runtime.

The steer door carries no runtimeIntent; admission replays the session's
lastAppliedIntentJson. Two shapes, each driven against Bun, a base native
binary and the candidate native binary on one private store:

  never-applied  the mail injector mints the session with persistIntent:false
                 and its first birth never launched, so there is nothing to
                 replay. Bun refuses 422 missing_runtime_intent; native must
                 refuse the same way (base native answered 400 malformed_request).
  revive         a born seat whose runtime was terminated; the replayed intent
                 births a fresh runtime that replies (claude and codex).

Failure modes guarded: native deriving a placement Bun never derives (a birth
where Bun refuses), native keeping its 400, the replayed intent losing its
placement (revive refused), and a revive that births but never replies.
"""
import argparse,json,socket
from pathlib import Path
from n3_scratch import Scratch

# A codex provider turn has been seen to take 300s on its own.
PROJECT='n5-t11928'
AGENTS={'claude':'tabularasa','codex':'cody'}

def scope(agent,task):return f'agent:{agent}:project:{PROJECT}:task:{task}'

def steer(s,target,prompt):
    """The request `hrc turn` sends once it has found the session: the steer door,
    which carries no runtimeIntent. (The CLI's read-only resolve that picks the
    door asks the federation registry, which a private no-peer node cannot reach.)"""
    status,body=s.http('POST','/v1/submissions/steer',{'target':target+'/lane:main','body':prompt,'origin':{'principalRef':'agent:clod'},'wait':True},timeout=660)
    error=body.get('error',{}) if isinstance(body,dict) else {}
    return {'status':status,'code':error.get('code'),'message':error.get('message'),'detail':error.get('detail'),'body':body if status<400 else None}

def never_applied(s,tag):
    target=scope('tabularasa','never-'+tag)
    plan=s.command('dry-run-'+tag,['hrc','turn',target,'x','--dry-run'])
    status,ensured=s.http('POST','/v1/targets/ensure',{'sessionRef':target+'/lane:main','runtimeIntent':plan['runtimeIntent'],'persistIntent':False})
    assert status==200,(status,ensured)
    stored=s.rows('SELECT last_applied_intent_json FROM sessions WHERE scope_ref=?',(target,))
    assert stored==[{'last_applied_intent_json':None}],stored
    result=steer(s,target,'Reply with exactly the word NEVER and nothing else. No tools.')
    runtimes=s.rows('SELECT runtime_id FROM runtimes WHERE scope_ref=?',(target,))
    return {'steer':result,'runtimes':len(runtimes)}

def revive(s,tag,harness):
    agent=AGENTS[harness];target=scope(agent,f'revive-{harness}-{tag}')
    start=s.command('birth-'+harness+'-'+tag,['hrc','start',target,'--no-viewer','--project-id',PROJECT,'--project-root',s.project,'--cwd',s.project,'--json','-p','Reply with exactly the word OK and nothing else. No tools.'])
    rt=start['runtime'];s.wait_completed(rt['runId'],timeout=600)
    s.command('terminate-'+harness+'-'+tag,['hrc','runtime','terminate',rt['runtimeId'],'--reason','T-11928 revive probe','--json'])
    word='PONG'+harness.upper()+tag.upper()
    result=steer(s,target,f'Reply with exactly the word {word} and nothing else. No tools.')
    runtimes=s.rows('SELECT runtime_id,status FROM runtimes WHERE scope_ref=? ORDER BY created_at',(target,))
    said=s.rows("SELECT payload_json FROM hrc_events WHERE scope_ref=? AND event_kind='turn.message' ORDER BY hrc_seq",(target,))
    return {'steer':result,'runtimes':runtimes,'replied':any(word in r['payload_json'] for r in said),'word':word}

def exercise(s,tag,harnesses):
    out={'never-applied':never_applied(s,tag)}
    for h in harnesses:out['revive-'+h]=revive(s,tag,h)
    (s.artifacts/f'{tag}.json').write_text(json.dumps(out,indent=2)+'\n')
    return out

def main():
    p=argparse.ArgumentParser()
    for k in ('binary','base-binary','installed-release','aspd-socket','scratch-root','artifacts'):p.add_argument('--'+k,type=Path,required=True)
    p.add_argument('--harness',action='append',choices=sorted(AGENTS))
    a=p.parse_args();harnesses=a.harness or sorted(AGENTS)
    candidate=a.binary.resolve();base=a.base_binary.resolve()
    s=Scratch(a.scratch_root,a.installed_release,a.aspd_socket,candidate,a.artifacts,project_id=PROJECT)
    verdict={}
    try:
        # This physical node's ordinary standalone authority (as target_placement):
        # a project-named node with no peers cannot say where a scope is homed.
        s.root.joinpath('federation.json').write_text(json.dumps({'nodeId':socket.gethostname().split('.')[0].lower(),'peers':{}}))
        s.init_substrate()
        owner=s.up('bun','baseline');bun=exercise(s,'bun',harnesses);s.down(owner)
        s.binary=base;owner=s.up('native','base');nb=exercise(s,'base',[]);s.down(owner)
        s.binary=candidate;owner=s.up('native','candidate');nc=exercise(s,'cand',harnesses);s.down(owner)
        b,n0,n1=(x['never-applied'] for x in (bun,nb,nc))
        shape=lambda r:(r['steer']['status'],r['steer']['code'],r['steer']['message'],r['steer']['detail'],r['runtimes'])
        verdict['bun-refuses-422']=shape(b)[:3]==(422,'missing_runtime_intent','runtimeIntent is required when the session has no prior intent') and b['runtimes']==0
        verdict['base-native-400']=n0['steer']['status']==400 and n0['steer']['message']=='runtimeIntent.placement is required'
        verdict['candidate-matches-bun']=shape(n1)==shape(b)
        for h in harnesses:
            verdict['bun-revive-'+h]=bun['revive-'+h]['steer']['status']==200 and bun['revive-'+h]['replied']
            verdict['candidate-revive-'+h]=nc['revive-'+h]['steer']['status']==200 and nc['revive-'+h]['replied'] and len(nc['revive-'+h]['runtimes'])==2
        (a.artifacts/'verdict.json').write_text(json.dumps(verdict,indent=2)+'\n')
        assert all(verdict.values()),verdict
        print(json.dumps({'pass':True,'verdict':verdict,'artifacts':str(a.artifacts)}))
    finally:
        (a.artifacts/'steps.json').write_text(json.dumps(s.steps,indent=1)+'\n')
        s.cleanup('agent:')
if __name__=='__main__':main()
