#!/usr/bin/env python3
"""T-11928: the real `hrc turn` births a session that never applied an intent.

The mail injector mints sessions with persistIntent:false; when that seat's
first birth fails, its session has no intent, the steer door has nothing to
replay, and every server refuses 422 missing_runtime_intent. The candidate CLI
falls through to the handoff door with the intent it resolved, which persists
the intent and births. Driven against a Bun owner and a native owner on one
private store, with the base CLI (current main) as the negative control on the
very same session.

Failure modes guarded: the base CLI succeeding (no control), the candidate CLI
still refusing, a fall-through that births a different session or never
replies, and an intent that births but is not persisted for the next steer.
"""
import argparse,json
from pathlib import Path
from n3_scratch import Scratch

PROJECT='n6-t11928'
AGENTS={'claude':'tabularasa','codex':'cody'}
REPO=Path(__file__).resolve().parents[3]

def scope(agent,task):return f'agent:{agent}:project:{PROJECT}:task:{task}'

def turn(s,name,cli,target,word):
    argv=[*cli,'turn',target,f'Reply with exactly the word {word} and nothing else. No tools.','--as','agent:clod','--wait','final','--timeout','10m']
    s.command(name,argv,timeout=660,check=False)
    step=s.steps[-1]
    return {'exit':step['exit'],'stdout':step['stdout'][-3000:],'stderr':step['stderr'][-3000:]}

def case(s,tag,harness,candidate_cli):
    target=scope(AGENTS[harness],f'never-{harness}-{tag}')
    plan=s.command('dry-run-'+harness+'-'+tag,['hrc','turn',target,'x','--dry-run'])
    status,ensured=s.http('POST','/v1/targets/ensure',{'sessionRef':target+'/lane:main','runtimeIntent':plan['runtimeIntent'],'persistIntent':False})
    assert status==200,(status,ensured)
    host=ensured['hostSessionId'] if 'hostSessionId' in ensured else s.rows('SELECT host_session_id FROM sessions WHERE scope_ref=?',(target,))[0]['host_session_id']
    intent=lambda:s.rows('SELECT last_applied_intent_json AS i FROM sessions WHERE scope_ref=?',(target,))
    assert intent()==[{'i':None}],intent()
    base=turn(s,f'base-{harness}-{tag}',['hrc'],target,'BASE'+harness.upper()+tag.upper())
    after_base=len(s.rows('SELECT runtime_id FROM runtimes WHERE scope_ref=?',(target,)))
    word='BORN'+harness.upper()+tag.upper()
    cand=turn(s,f'cand-{harness}-{tag}',candidate_cli,target,word)
    sessions=s.rows('SELECT host_session_id,last_applied_intent_json AS i FROM sessions WHERE scope_ref=?',(target,))
    runtimes=s.rows('SELECT runtime_id,status FROM runtimes WHERE scope_ref=?',(target,))
    said=s.rows("SELECT payload_json FROM hrc_events WHERE scope_ref=? AND event_kind='turn.message'",(target,))
    stored=json.loads(sessions[0]['i']) if sessions and sessions[0]['i'] else None
    return {'base':base,'runtimesAfterBase':after_base,'candidate':cand,'word':word,
            'sameSession':[r['host_session_id'] for r in sessions]==[host],
            'runtimes':runtimes,'replied':any(word in r['payload_json'] for r in said),
            'storedPlacement':isinstance(stored,dict) and isinstance(stored.get('placement'),dict)}

def main():
    p=argparse.ArgumentParser()
    for k in ('binary','installed-release','aspd-socket','scratch-root','artifacts'):p.add_argument('--'+k,type=Path,required=True)
    p.add_argument('--harness',action='append',choices=sorted(AGENTS))
    a=p.parse_args();harnesses=a.harness or ['claude']
    s=Scratch(a.scratch_root,a.installed_release,a.aspd_socket,a.binary,a.artifacts,project_id=PROJECT)
    # Standalone node: no federation file, so read-only resolves answer locally
    # instead of asking a binding registry this private node cannot reach.
    s.env['HRC_PEER_CONFIG_FILE']=str(s.root/'absent-federation.json')
    candidate_cli=['bun',str(REPO/'packages/hrc-cli/src/cli.ts')]
    verdict={};out={}
    try:
        s.init_substrate()
        for kind in ('bun','native'):
            owner=s.up(kind,'owner')
            out[kind]={h:case(s,kind,h,candidate_cli) for h in harnesses}
            s.down(owner)
            for h,r in out[kind].items():
                verdict[f'{kind}-{h}-base-refused']=r['base']['exit']!=0 and 'missing_runtime_intent' in r['base']['stderr'] and r['runtimesAfterBase']==0
                verdict[f'{kind}-{h}-candidate-born']=r['candidate']['exit']==0 and r['replied'] and r['sameSession'] and len(r['runtimes'])==1 and r['storedPlacement']
        (a.artifacts/'results.json').write_text(json.dumps(out,indent=2)+'\n')
        (a.artifacts/'verdict.json').write_text(json.dumps(verdict,indent=2)+'\n')
        assert verdict and all(verdict.values()),verdict
        print(json.dumps({'pass':True,'verdict':verdict,'artifacts':str(a.artifacts)}))
    finally:
        (a.artifacts/'steps.json').write_text(json.dumps(s.steps,indent=1)+'\n')
        s.cleanup('agent:')
if __name__=='__main__':main()
