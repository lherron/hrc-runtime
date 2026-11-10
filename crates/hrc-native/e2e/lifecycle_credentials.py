#!/usr/bin/env python3
"""Native credential rotation/revocation and real credential authorization.

Every presented credential comes from the scratch daemon for a live hrcpty
runtime. Refusals must preserve both the owner and durable lifecycle facts.
"""
import json
from pathlib import Path
import stat
import sys

ROOT=Path(__file__).resolve().parents[3]
sys.path.insert(0,str(ROOT/'crates/hrc-cli/e2e'))
from native_seat import suite, report


@suite
def main(f,a):
    seat=f.birth()
    rid=seat['runtimeId']
    path=f.root/'run/lifecycle'/(rid+'.credential')
    def credential(previous=None):
        f.s.wait(lambda:path.exists() and path.read_text().strip()!=previous,15,'fresh credential')
        value=path.read_text().strip()
        assert len(value)==64 and all(c in '0123456789abcdef' for c in value)
        assert stat.S_IMODE(path.stat().st_mode)==0o600
        assert stat.S_IMODE(path.parent.stat().st_mode)==0o700
        return value
    first=credential()
    results=[]
    for i in range(2):
        f.s.down(f.s.owners[-1]);f.s.up('native','rotate-'+str(i))
        second=credential(first)
        results.append({'case':'rotation-'+str(i),'pass':first!=second})
        first=second
    auth={'x-hrc-lifecycle-runtime-id':rid,'x-hrc-lifecycle-credential':first,
          'x-hrc-lifecycle-session-ref':seat['sessionRef']}
    body={'action':'restart','reason':'private authority refusal'}
    cases=[('missing',body,{},'credential_missing'),
           ('unknown',body,{**auth,'x-hrc-lifecycle-credential':'0'*64},'credential_unknown'),
           ('mismatch',body,{**auth,'x-hrc-lifecycle-session-ref':'agent:other:project:n5-t11819:task:primary/lane:main'},'credential_mismatch'),
           ('not-authorized',body,auth,'not_authorized')]
    cases += [('invalid-'+str(i),v,{},None) for i,v in enumerate((None,[],{}, {'action':'wat'}, {**body,'bogus':True}, {**body,'force':'yes'}, {**body,'wait':True,'drain':True}, {**body,'action':'stop','drain':True}, {**body,'waitTimeoutMs':0}, {**body,'proofTimeoutMs':1.5}))]
    facts=f.s.rows("SELECT * FROM hrc_events WHERE scope_ref='server:hrc'")
    assert facts, 'empty lifecycle ledger'
    owner=f.call('/v1/status')['startedAt']
    from foundation import UnixHTTP
    for name,request,headers,refusal in cases:
        h=UnixHTTP(f.s.socket)
        h.request('POST','/v1/server/lifecycle',json.dumps(request),{**headers,'Content-Type':'application/json'})
        r=h.getresponse();value=json.loads(r.read());h.close()
        assert r.status==(403 if refusal else 400),(name,r.status,value)
        if refusal:
            assert value['error']['code']=='server_lifecycle_refused',value
            assert value['error']['detail']['refusal']==refusal,(name,value)
        else:assert value['error']['code']=='malformed_request',value
        assert f.s.rows("SELECT * FROM hrc_events WHERE scope_ref='server:hrc'")==facts
        assert f.call('/v1/status')['startedAt']==owner
        results.append({'case':name,'status':r.status,'body':value,'pass':True})
    f.call('/v1/terminate',{'runtimeId':rid})
    f.s.wait(lambda:not path.exists(),10,'credential revoked')
    results.append({'case':'termination-revokes','pass':True})
    f.s.down(f.s.owners[-1])
    directory=path.parent
    for name in ('rt-orphan.credential','.orphan.tmp'):(directory/name).write_text('not authority')
    f.s.up('native','orphan')
    assert not list(directory.iterdir())
    results.append({'case':'boot-removes-orphans','pass':True})
    return report(a,results)


if __name__=='__main__':raise SystemExit(main())
