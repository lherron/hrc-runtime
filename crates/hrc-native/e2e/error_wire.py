#!/usr/bin/env python3
"""T-12063: real native HTTP errors remain consumable by the TS SDK.

Failure modes: an internal error without detail/cause/requestId; a request ID
header differing from the body; a broker capability refusal flattened into
500 or runtime_unavailable; and a false-positive refusal caused by bad input.
A cold codex presentation seat exercises a real broker admission refusal.
All writes and real model calls use the shared isolated scratch driver.
"""
import argparse,json
from pathlib import Path
from n3_scratch import Scratch,UnixHTTP

FORMAT={'kind':'json_schema','name':'probe','schema':{'type':'object','properties':{'ok':{'type':'boolean'}},'required':['ok'],'additionalProperties':False}}

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
        status,body=s.http('POST','/v1/turns',request)
        out['unstructured-control']={'status':status,'body':body}
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
