"""Strict two-pair accounting comparison, including full upstream headers."""
import datetime,json,re
from pathlib import Path


def compare(args,checks):
    baseline=json.loads((Path(args.baseline)/'front-accounting.json').read_text())
    native=json.loads((Path(args.candidate)/'front-accounting.json').read_text())
    cases=[]
    def check(name,ok,why):
        row={'id':name,'pass':bool(ok)};cases.append(row)
        checks.append({**row,'reason':why,'failureCode':1})
    check('separate-stores',baseline['stateRoot']!=native['stateRoot'] and baseline['runtimeCount']==native['runtimeCount']==0,'proxy accounting uses separate empty real stores without runtime work')
    requests=native['requests']
    check('request-matrix',len(requests)==4 and {(r['pair'],r['role']) for r in requests}=={(p,r) for p in ['id','no-id'] for r in ['native','forwarded']} and all(r['status']==200 for r in requests),'both low-rate native/forwarded pairs must complete')
    check('rust-file-exclusive',not any(re.fullmatch(r'server-\d{4}-\d{2}-\d{2}\.ndjson',f) for f in native['files']),'Rust may never append the Bun server namespace')
    check('bun-file-exclusive',not any(f.startswith('rusthrc-server-') for f in baseline['files']),'Bun may never append the Rust server namespace')
    populations={}
    for side,report in [('bun',baseline),('native',native)]:
        prefix='server-' if side=='bun' else 'rusthrc-server-'
        population={}
        for pair in ['id','no-id']:
            rows=[x for x in report['metrics'] if x['record'].get('client')=='n1-front/'+pair]
            wanted=[r for r in requests if r['pair']==pair and (side=='native' or r['role']=='forwarded')]
            expected={(r['method'],r['path'],r['reqId']) for r in wanted}
            keys=[(x['record'].get('method'),x['record'].get('route'),x['record'].get('reqId')) for x in rows]
            check(side+':'+pair+':exact-records',len(rows)==len(expected) and len(set(keys))==len(keys) and set(keys)==expected,'each actual request contributes exactly one record on its serving side')
            for row in rows:
                r=row['record'];expected_request=next((q for q in wanted if q['path']==r.get('route')),None)
                try:stamp=datetime.datetime.fromisoformat(r['ts'].replace('Z','+00:00'))
                except (KeyError,ValueError,TypeError):stamp=None
                valid=stamp is not None and expected_request is not None and expected_request['before']-.01<=stamp.timestamp()<=expected_request['after']+.01
                valid=valid and row['file']==prefix+r['ts'][:10]+'.ndjson'
                check(side+':'+pair+':clock-and-file:'+str(r.get('route')),valid,'the record clock must name its actual request interval and writer-owned day file')
                check(side+':'+pair+':sampling:'+str(r.get('route')),r.get('sampleWeight',1)==1 and (('reqId' not in r) if pair=='no-id' else r.get('reqId')==expected_request.get('reqId') if expected_request else False),'requests stay within the unsampled head; absent IDs remain absent')
                if side=='native':
                    served='native' if r.get('route')=='/v1/health' else 'bun'
                    check(side+':'+pair+':served-by:'+str(r.get('route')),r.get('servedBy')==served,'Rust must distinguish native and delegated handling')
                population[(pair,r.get('route'))]=r
        populations[side]=population
        expected_logs=4 if side=='native' else 2
        logs=report['logs']
        check(side+':L3-population',len(logs)==expected_logs,'each selected unsuppressed request belongs to its owner log stream')
        if side=='native':
            check('rust:L3-tags',all(r.get('server')=='rusthrc' and r.get('data',{}).get('servedBy')==('native' if r['data'].get('route')=='/v1/health' else 'bun') for r in logs),'Rust L3 records must identify their stream owner and actual serving branch')
        else:check('bun:L3-owner',all(r.get('server')!='rusthrc' for r in logs),'Rust records must not appear in Bun output')
    for pair in ['id','no-id']:
        a=populations['bun'].get((pair,'/v1/targets'));b=populations['native'].get((pair,'/v1/targets'))
        if pair=='id':ok=a is not None and b is not None and a.get('reqId')==b.get('reqId')=='n1-front-forwarded'
        else:ok=a is not None and b is not None and 'reqId' not in a and 'reqId' not in b and a['ts'][:16]==b['ts'][:16] and a['route']==b['route']=='/v1/targets'
        check('join:'+pair,ok,'client-ID requests join by reqId; absent-ID requests reconcile by route and minute count')
    all_traces=native['upstreamHeaders'];traces=[t for t in all_traces if t['requestLine']=='GET /v1/targets HTTP/1.1'];check('forwarded-head-count',len(traces)==2 and len(all_traces)==3,'only the two delegated requests may reach the actual Bun Unix listener')
    for pair in ['id','no-id']:
        wanted=next((r for r in requests if r['pair']==pair and r['role']=='forwarded'),None)
        matching=[t for t in traces if t['headers'].get('user-agent')==(wanted or {}).get('ua')]
        ok=len(matching)==1 and matching[0]['requestLine']=='GET /v1/targets HTTP/1.1'
        if ok:
            headers=matching[0]['headers'];ok=headers.get('x-hrc-request-id')=='n1-front-forwarded' if pair=='id' else 'x-hrc-request-id' not in headers
        check('verbatim-headers:'+pair,ok,'full User-Agent and optional client request ID must reach Bun unchanged; no ID may be minted')
    native_errors={x['record']['client']:x['record'] for x in native['errorMetrics']}
    bun_errors={x['record']['client']:x['record'] for x in baseline['errorMetrics']}
    backend=native_errors.get('n1-front-error/backend',{});local=native_errors.get('n1-front-error/local',{})
    check('backend-error-attribution',len(native_errors)==2 and backend.get('status')==404 and backend.get('servedBy')=='bun' and local.get('status')==502 and local.get('servedBy')=='native','upstream errors remain Bun-served; local transport failures are native 502s')
    check('failed-forward-not-in-Bun',set(bun_errors)=={'n1-front-error/backend'} and bun_errors['n1-front-error/backend']['status']==404,'a failed connection must create no phantom Bun request record')
    error_logs=native['errorLogs']
    check('error-L3-attribution',len(error_logs)==2 and all(r.get('server')=='rusthrc' and r['data'].get('servedBy')==('bun' if r['data'].get('client')=='n1-front-error/backend' else 'native') for r in error_logs),'L3 must retain the same attribution as the metric on each error path')
    return {'suite':'n1-front-accounting','cases':cases,'behaviorQualified':all(c['pass'] for c in checks)}
