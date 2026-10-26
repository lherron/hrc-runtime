#!/usr/bin/env python3
"""SQLite observation parity, key order included, with daemon-only registration.

Failures: execution errors suppress telemetry; callbacks change SQL outcomes;
iterator exits emit zero or duplicate samples; threshold is ignored; caller
frames are empty; daemon loses WARN/metric fields; CLI opens instrument too.
"""
import argparse
import json
import math
from pathlib import Path
import subprocess
import sys
import time
ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'crates/hrc-native/e2e'))
from n3_scratch import Scratch
GROUPS={
 'n4-sqlite-execution':('query-get','prepare-get','all','values','raw','bound','as-chain','database-run','database-exec','batch'),
 'n4-sqlite-iterator':('iterator-drain','iterator-return','iterator-throw','symbol-iterator'),
 'n4-sqlite-observational':('execution-error','batch-error','callback-throws','high-threshold','plain-open')}

def canonical(v):
    if isinstance(v,dict):return [(k,'<measured>' if k in ('durationMs','callerTag','ts','ms') else canonical(x)) for k,x in v.items()]
    if isinstance(v,list):return [canonical(x) for x in v]
    return v

def compare(args,checks):
    a=json.loads((Path(args.baseline)/'telemetry.json').read_text());b=json.loads((Path(args.candidate)/'telemetry.json').read_text())
    checks.append({'id':'owners-complete','pass':a.get('pass') is True and b.get('pass') is True and a['owner']=='bun' and b['owner']=='native','reason':'both real-owner workflows completed','failureCode':1})
    cases=[]
    for group,names in GROUPS.items():
        passed=all(name in a['statements'] and name in b['statements'] and canonical(a['statements'][name])==canonical(b['statements'][name]) for name in names)
        cases.append({'id':group,'pass':passed});checks.append({'id':group,'pass':passed,'reason':'statement outcomes, SQL, sample counts, fields and key order','failureCode':1})
    passed=canonical(a['daemon'])==canonical(b['daemon'])
    cases.append({'id':'n4-sqlite-daemon-only','pass':passed});checks.append({'id':'n4-sqlite-daemon-only','pass':passed,'reason':'daemon WARN/metric shape and uninstrumented direct CLI opens','failureCode':1})
    return {'suite':args.suite,'cases':cases,'behaviorQualified':all(c['pass'] for c in checks)}

def logs(path):
    out=[]
    for line in path.read_text().splitlines():
        try:out.append(json.loads(line))
        except ValueError:pass
    return out

def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--owner',choices=['bun','native'],required=True)
    for name in ('binary','installed-release','aspd-socket','scratch-root','artifacts'):p.add_argument('--'+name,type=Path,required=True)
    p.add_argument('--statements-helper',type=Path);p.add_argument('--daemon-only',action='store_true',help='reproduce missing daemon instrumentation without the fixture helper')
    a=p.parse_args();s=Scratch(a.scratch_root,a.installed_release,a.aspd_socket,a.binary,a.artifacts,project_id='n4b-telemetry')
    result={'owner':a.owner,'pass':False,'statements':{},'daemon':{}}
    try:
        s.init_substrate()
        if not a.daemon_only:
            if a.owner=='bun':
                observations=s.command('statement-fixtures',['bun',ROOT/'conformance/hrc-parity/n4_telemetry.mjs',s.release/'packages/hrc-store-sqlite/src/statement-telemetry.ts'])
            else:
                assert a.statements_helper,'--statements-helper required for native'
                observations=s.command('statement-fixtures',[a.statements_helper.resolve(),s.db_path])
            assert set(observations)==set(sum(GROUPS.values(),())),observations
            for name,v in observations.items():
                assert v['ok'],(name,v)
                expected=0 if name in ('high-threshold','plain-open') else 1
                assert len(v['events'])==expected,(name,v)
                for e in v['events']:
                    assert list(e)==['sql','durationMs','callerTag'],(name,e)
                    assert isinstance(e['sql'],str) and e['sql'] and isinstance(e['callerTag'],str) and ':' in e['callerTag'] and 'hrc_store::statement_telemetry::' not in e['callerTag'],(name,e)
                    assert isinstance(e['durationMs'],(float,int)) and math.isfinite(e['durationMs']) and e['durationMs']>=0,(name,e)
            result['statements']=observations
        s.env['HRC_SQLITE_SLOW_STATEMENT_MS']='0'
        proc=s.up(a.owner,'telemetry')
        for _ in range(3):assert s.http('GET','/v1/status')[0]==200
        time.sleep(1.1)
        s.down(proc)
        events=[v for v in logs(a.artifacts/f'{a.owner}-telemetry.log') if v.get('event')=='sqlite.slow_statement']
        assert events,'daemon did not instrument SQLite statements at zero threshold'
        metrics=[]
        for file in (s.root/'state/metrics').glob('*.ndjson'):metrics += [v for v in logs(file) if v.get('kind')=='sqlite_slow_statement']
        assert metrics,'daemon did not persist sqlite_slow_statement metrics'
        for event in events:
            assert list(event)==['ts','level','component','event','data'],event
            assert ':' in event['data']['callerTag'],event
            assert event['level']=='warn' and event['component']=='sqlite' and list(event['data'])==['sql','durationMs','callerTag'],event
        for metric in metrics:assert list(metric)==['v','kind','ts','sql','ms','callerTag'] and metric['v']==1,metric
        cli=[s.binary,'admin','broker-verify','candidates','agent:tabularasa:project:n4b-telemetry:task:absent','--json'] if a.owner=='native' else ['bun',s.release/'packages/hrc-cli/src/cli.ts','admin','broker-verify','candidates','agent:tabularasa:project:n4b-telemetry:task:absent','--json']
        s.command('direct-cli-open',cli)
        assert 'sqlite.slow_statement' not in s.steps[-1]['stdout']+s.steps[-1]['stderr'],s.steps[-1]
        # Query text and actual timing differ between implementations; this
        # records daemon wire schemas without disguising fixture SQL changes.
        result['daemon']={'warn':{k: '<observed>' if k=='ts' else {'sql':'<statement>','durationMs':0,'callerTag':'<caller>'} if k=='data' else v for k,v in events[0].items()},
                          'metric':{k:'<observed>' if k=='ts' else '<statement>' if k=='sql' else '<caller>' if k=='callerTag' else 0 if k=='ms' else v for k,v in metrics[0].items()},'cliInstrumented':False}
        # Disabling metrics must not disable WARN logging. A high threshold
        # then suppresses both without any registration in a CLI process.
        before_metrics=len(metrics)
        s.env['HRC_METRICS']='0'
        proc=s.up(a.owner,'metrics-off');s.http('GET','/v1/status');s.down(proc)
        quiet_metrics=[]
        for file in (s.root/'state/metrics').glob('*.ndjson'):quiet_metrics += [v for v in logs(file) if v.get('kind')=='sqlite_slow_statement']
        assert len(quiet_metrics)==before_metrics,'HRC_METRICS=0 still emitted slow-statement samples'
        assert any(v.get('event')=='sqlite.slow_statement' for v in logs(a.artifacts/f'{a.owner}-metrics-off.log')),'metrics disablement suppressed WARN'
        s.env['HRC_SQLITE_SLOW_STATEMENT_MS']='0x100000000'
        proc=s.up(a.owner,'threshold-high');s.http('GET','/v1/status');s.down(proc)
        assert not any(v.get('event')=='sqlite.slow_statement' for v in logs(a.artifacts/f'{a.owner}-threshold-high.log')),'high threshold ignored'
        result['daemon'].update(metricsDisabledStillWarns=True,metricsDisabledNoSamples=True,highThresholdSuppresses=True)
        (a.artifacts/'slow-events.json').write_text(json.dumps(events,indent=2)+'\n');(a.artifacts/'slow-metrics.json').write_text(json.dumps(metrics,indent=2)+'\n')
        result['pass']=not a.daemon_only
    finally:
        s.cleanup('agent:');(a.artifacts/'telemetry.json').write_text(json.dumps(result,indent=2)+'\n');(a.artifacts/'drive.json').write_text(json.dumps(s.steps,indent=2)+'\n')
    print(json.dumps({'pass':result['pass'],'owner':a.owner,'groups':len(GROUPS)+1}))
if __name__=='__main__':main()
