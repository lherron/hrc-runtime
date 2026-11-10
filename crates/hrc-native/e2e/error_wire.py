#!/usr/bin/env python3
"""T-12063/T-13178: typed HTTP errors and refusal cleanup on native HRC.

Failure modes: an internal error without detail/cause/requestId; a request ID
header differing from the body; a broker capability refusal flattened into
500 or runtime_unavailable; and a false-positive refusal caused by bad input.
A cold codex presentation seat exercises a real broker admission refusal,
terminal settlement, lease disposal and immediate same-session recovery.
All writes and real model calls use the shared isolated scratch driver.
"""
import argparse,json,subprocess,time
from pathlib import Path
from n3_scratch import Scratch,UnixHTTP

FORMAT={'kind':'json_schema','name':'probe','schema':{'type':'object','properties':{'ok':{'type':'boolean'}},'required':['ok'],'additionalProperties':False}}

def refused_state(s):
    """Read committed rows and real processes before the control can repair them."""
    operations=s.rows('SELECT operation_id,status,error_code,error_message,preparation_json FROM runtime_operations')
    paths=[json.loads(row['preparation_json'])['hosting']['paths'] for row in operations]
    processes=subprocess.run(['ps','-axo','pid=,ppid=,command='],capture_output=True,text=True,check=True).stdout.splitlines()
    return {
        'sessions':s.rows('SELECT host_session_id,generation,status FROM sessions'),
        'runtimes':s.rows('SELECT runtime_id,status,transport,lifecycle_terminal_reason,active_run_id,active_operation_id,active_invocation_id FROM runtimes'),
        'runs':s.rows('SELECT run_id,status,completed_at,error_code,error_message FROM runs'),
        'invocations':s.rows('SELECT invocation_id,invocation_state,broker_pid,child_pid FROM broker_invocations'),
        'operations':[{k:v for k,v in row.items() if k!='preparation_json'} for row in operations],
        'events':s.rows('SELECT hrc_seq,run_id,event_kind,error_code,payload_json FROM hrc_events WHERE runtime_id IS NOT NULL ORDER BY hrc_seq'),
        'watches':s.rows('SELECT disarmed_at,disarm_reason FROM runtime_first_turn_watch'),
        'paths':paths,
        'retainedLeaseFiles':[str(f) for p in paths for f in Path(p['ipcDir']).rglob('*') if f.is_file()],
        'remainingLeaseSockets':[str(f) for p in paths for f in Path(p['ipcDir']).rglob('*') if f.is_socket()],
        'leaseProcesses':[line for line in processes if any(p['ipcDir']+'/' in line for p in paths)],
        'scratchProcesses':[line for line in processes if str(s.root)+'/' in line],
        'sockets':[str(p) for p in (s.root/'run').rglob('*') if p.is_socket()],
    }

def settled(state,message):
    return (len(state['runs'])==len(state['runtimes'])==len(state['invocations'])==len(state['operations'])==1
        and state['runs'][0]['status']=='failed' and state['runs'][0]['completed_at'] is not None
        and state['runs'][0]['error_code']=='unsupported_capability' and state['runs'][0]['error_message']==message
        and state['runtimes'][0]['status']=='terminated' and state['runtimes'][0]['lifecycle_terminal_reason']=='broker_start_refused'
        and all(state['runtimes'][0][key] is None for key in ('active_run_id','active_operation_id','active_invocation_id'))
        and state['invocations'][0]['invocation_state']=='disposed' and state['operations'][0]['status']=='failed'
        and len(state['sessions'])==1 and state['sessions'][0]['status']=='active'
        and all(row['disarmed_at'] and row['disarm_reason']=='broker_start_refused' for row in state['watches'])
        and [row['event_kind'] for row in state['events']]==['runtime.created','turn.accepted','turn.failed','runtime.terminated']
        and not state['remainingLeaseSockets'] and not state['leaseProcesses'])

def main():
    p=argparse.ArgumentParser()
    for key in ('binary','installed-release','aspd-socket','scratch-root','artifacts'):
        p.add_argument('--'+key,type=Path,required=True)
    a=p.parse_args()
    s=Scratch(a.scratch_root,a.installed_release,a.aspd_socket,a.binary,a.artifacts,project_id='n6-t12063')
    s.env['HRC_PEER_CONFIG_FILE']=str(s.root/'no-federation.json')
    out={};checks={}
    try:
        s.init_substrate();s.up('native','error-wire')
        for label,request_id in [('generated',None),('supplied','probe:T-12063'),('unsafe','bad id')]:
            c=UnixHTTP(s.socket)
            headers={} if request_id is None else {'x-hrc-request-id':request_id}
            c.request('GET','/v1/runtimes/%ZZ/seat',headers=headers)
            r=c.getresponse();body=json.loads(r.read());rid=r.getheader('x-hrc-request-id');c.close()
            out[label]={'status':r.status,'body':body,'requestIdHeader':rid}
            error=body.get('error',{});detail=error.get('detail',{})
            checks[label]=r.status==500 and error.get('code')=='internal_error' and error.get('message')=='internal server error' and isinstance(detail.get('cause'),str) and bool(detail.get('requestId')) and detail.get('requestId')==rid and (rid==request_id if label=='supplied' else rid!=request_id)
        scope='agent:cody:project:n6-t12063:task:error-wire'
        plan=s.command('dry-run',['hrc','turn',scope,'x','--dry-run'])
        intent=plan['runtimeIntent']
        out['intent']=intent
        status,ensured=s.http('POST','/v1/targets/ensure',{'sessionRef':scope+'/lane:main','runtimeIntent':intent})
        assert status==200,(status,ensured)
        host=s.rows('SELECT host_session_id FROM sessions WHERE scope_ref=?',(scope,))[0]['host_session_id']
        request={'hostSessionId':host,'prompt':'Reply with exactly the word OK and nothing else. No tools.','runtimeIntent':intent,'waitFor':'accepted'}
        status,body=s.http('POST','/v1/turns',{**request,'responseFormat':FORMAT})
        out['cold']={'status':status,'body':body}
        error=body.get('error',{})
        checks['cold']=status==422 and error.get('code')=='unsupported_capability' and error.get('detail',{}).get('capability')=='finalResponse.jsonSchema'
        checks['broker-refusal']=error.get('detail',{}).get('brokerRpcCode')==-32003
        out['after-refusal']=refused_state(s)
        checks['settled-immediately']=settled(out['after-refusal'],error.get('message'))
        time.sleep(5)
        out['after-refusal-5s']=refused_state(s)
        checks['settled-after-5s']=settled(out['after-refusal-5s'],error.get('message'))
        status,body=s.http('POST','/v1/turns',request)
        out['unstructured-control']={'status':status,'body':body}
        checks['control-accepted']=status in (200,202)
        assert status in (200,202),(status,body)
        run=body['runId'];s.wait_completed(run)
        messages=s.rows("SELECT payload_json FROM hrc_events WHERE run_id=? AND event_kind='turn.message'",(run,))
        checks['control']=any('OK' in row['payload_json'] for row in messages)
        out['runs']=s.rows('SELECT run_id,status,error_code,error_message FROM runs')
        out['checks']=checks
        (a.artifacts/'results.json').write_text(json.dumps(out,indent=2)+'\n')
        assert all(checks.values()),checks
        print(json.dumps({'pass':True,'checks':checks}))
    finally:
        (a.artifacts/'results.json').write_text(json.dumps({**out,'checks':checks},indent=2)+'\n')
        (a.artifacts/'steps.json').write_text(json.dumps(s.steps,indent=2)+'\n')
        s.cleanup('agent:')
if __name__=='__main__':main()
