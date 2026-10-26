"""Strict history-aware session projection comparison on scratch fixtures."""
import json
from pathlib import Path

REQUIRED={'system-summary','default','kernel','all','yes','all-invalid-since','scoped-history',
          'scoped-invalid-since','lane','latest-scoped','latest-status',
          'status-trimmed','hex-limit','invalid-since','invalid-status-first',
          'invalid-limit-first','date-only','offset','config-zero','config-prefix','config-invalid'}


def compare(args, checks):
    def check(name, passed, reason):
        checks.append({'id':name,'pass':bool(passed),'reason':reason,'failureCode':1})
    sides={}
    for kind,directory in [('bun',args.baseline),('native',args.candidate)]:
        report=json.loads((Path(directory)/'projection.json').read_text())
        rows=report['observations'];side={r['case']:r for r in rows};sides[kind]=side
        check(kind+':matrix',set(side)==REQUIRED and len(rows)==len(REQUIRED),'all history, lane, status, parser and ordering cases must be present exactly once')
        check(kind+':no-writes',report['unchanged'],'session projection must preserve session/runtime/index rows')
        expected={'default':['recent','index','runtime','live','active-run','prior'],
                  'kernel':['recent','index','runtime','live','active-run','prior'],
                  'all':['recent','index','runtime','live','active-run','alternate','prior','head','cold','summary'],
                  'system-summary':['summary'],'lane':['alternate'],'latest-scoped':['alternate','head'],'latest-status':[],
                  'status-trimmed':['prior'],'hex-limit':['recent','index']}
        expected.update({'config-zero':['live','active-run'],'config-prefix':expected['all'],'config-invalid':expected['default']})
        for case,hosts in expected.items():
            response=side.get(case,{}).get('response',{});body=response.get('body')
            actual=[r.get('hostSessionId') for r in body] if isinstance(body,list) else None
            check(kind+':control:'+case,response.get('status')==200 and actual==['hsid-n1-'+h for h in hosts],'fixture controls must discriminate recency, liveness, ordering and collapse semantics')
    cases=[]
    for name in sorted(REQUIRED):
        a=sides['bun'].get(name);b=sides['native'].get(name)
        passed=a is not None and a==b
        check('compare:'+name,passed,'path, status, entire ordered body and count headers must match Bun')
        cases.append({'id':name,'pass':passed})
    return {'suite':'n1-session-projection','cases':cases,'behaviorQualified':all(c['pass'] for c in checks)}
