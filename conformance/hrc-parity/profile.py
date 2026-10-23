#!/usr/bin/env python3
"""Materialize reviewed P0 workflows for an explicitly provisioned real subject.

Does not start a daemon, initialize authority, admit destinations or claim a pass.
The resulting profile still runs preflight. Provisioning commands are in README.
"""
import argparse
import json
from pathlib import Path
import shutil
import sys
import time

ROOT = Path(__file__).resolve().parents[2]


def make_profile(root, release, cli, asp_evidence, node, source=False):
    root, release = Path(root), Path(release)
    for required in ('packages/hrc-sdk/src/index.ts','packages/hrc-store-sqlite/src/index.ts'):
        if not (release/required).is_file():
            raise ValueError('frozen installed release is unavailable: ' + str(release/required))
    authority = json.loads((root / 'authority.json').read_text())
    scope = 'agent:tabularasa:project:hrc-runtime:task:p0-' + str(time.time_ns())
    ref = scope + '/lane:main'
    prompt = 'Reply with exactly the word OK and nothing else. No tools.'
    bun = str(Path(shutil.which('bun')).absolute())
    env = {'HRC_RUNTIME_DIR': str(root/'run'), 'HRC_STATE_DIR': str(root/'state'),
           'ASP_AGENTS_ROOT': str(root/'agents'), 'HRC_PROJECT_SEARCH_ROOTS': str(root/'project'),
           'HRC_PEER_CONFIG_FILE': str(root/'federation.json'),
           'HRC_WRKQ_DB': authority['locator'], 'WRKQ_DB': authority['locator'],
           'HRC_WRKQD_TOKEN_FILE': authority['tokenFile'], 'WRKQD_TOKEN_FILE': authority['tokenFile'],
           'WRKQD_TOKEN': '', 'HRC_ACP_WEBHOOK_URL': '',
           'HRC_BROKER_DURABLE_IPC_ENABLED': '1', 'HRC_HEADLESS_CODEX_BROKER_ENABLED': '1',
           'HRC_CLAUDE_CODE_TMUX_BROKER_ENABLED': '1'}
    def http(method, path, body=None, capture=None, assertions=None):
        a = {'kind':'http', 'method':method, 'path':path}
        if body is not None: a['body']=body
        if capture: a['capture']=capture
        if assertions: a['assertions']=assertions
        return a
    def eq(id, path, value): return {'id':id, 'op':'equals', 'path':path, 'value':value}
    def exists(id, path): return {'id':id, 'op':'exists', 'path':path}
    def command(args, assertions=None, kind='cli', capture=None):
        a={'kind':kind,'args':args,'assertions':assertions or []}
        if capture: a['capture']=capture
        return a
    def terminal(scope):
        return {'kind':'poll','path':'/v1/events/tail?hostSessionId=${host}&generation=${generation}&eventKind=turn.completed&limit=1',
                'timeoutSec':90,'until':[{'op':'count','path':'body.events','value':1}]}
    def invoke(key):
        return http('POST','/v1/submissions/invoke',{'target':ref,'body':prompt,
            'origin':{'principalRef':'agent:cody','scopeRef':scope}, 'idempotencyKey':key,'wait':True},
            {'supportedRunId':'body.runId'}, [eq('two-completed','status',200)])
    cases={}
    cases['identity-isolation']=[
        {**command(['server','status','--json'],[exists('installed-identity','body.release')]),
         'collect':{'status':'body'}},
        http('GET','/v1/status',assertions=[eq('owner-paths','body.dbPath',str(root/'state/state.sqlite')),
              exists('bun-alone','body.binaryPath'),exists('effective-destinations','body.aspd')]),
        http('GET','/v1/health',assertions=[eq('health','body.ok',True)]),
        {'kind':'cursor-observation','capture':{'cursorBefore':'cursors'}},
        {'kind':'owner-observation'}]
    cold=[http('POST','/v1/declarations/resolve',{'agentId':'tabularasa','agentRoot':str(root/'agents/tabularasa'),
            'projectId':'hrc-runtime','projectRoot':str(root/'project'),'cwd':str(root/'project'),
            'agentSources':{'agentsRoot':str(root/'agents')},'runMode':'task','interactive':True,
            'preferredMode':'headless','initialPrompt':prompt}, {'intent':'body.intent'}),
        http('POST','/v1/sessions/resolve',{'sessionRef':ref,'runtimeIntent':'$intent',
            'create':True,'summonIntent':'explicit_local'}, {'host':'body.hostSessionId','generation':'body.generation'}),
        http('POST','/v1/runtimes/start',{'hostSessionId':'$host','intent':'$intent'}, {'runtime':'body.runtimeId'},
            [eq('scope-lane-generation-runtime','status',200)]), terminal(scope),
        invoke('p0-'+str(time.time_ns())),
        {'kind':'turn-ledger','scopeRef':scope,'assertions':[exists('two-real-identities','lifecycleRows'),exists('two-final-messages','brokerRows')]},
        {'kind':'preparation','runtimeId':'$runtime'}]
    cases['cold-second-turn']=cold
    cases['attach-restart-resume-terminate']=[
        {'kind':'pty','path':'/v1/attach?runtimeId=${runtime}','assertions':[
            exists('pty-attached','attachedClient'),eq('pty-detached','detachExit',0)]},
        http('POST','/v1/sessions/restart',{'hostSessionId':'$host','expectedGeneration':'$generation'},
             {'host2':'body.hostSessionId','generation2':'body.generation','runtime2':'body.launch.runtimeId'},
             [eq('restart-generation','status',200)]),
        {'kind':'preparation','runtimeId':'$runtime2'},
        {'kind':'poll','path':'/v1/events/tail?hostSessionId=${host2}&eventKind=turn.completed&limit=1',
         'until':[{'op':'count','path':'body.events','value':1}],'timeoutSec':90},
        http('POST','/v1/terminate',{'runtimeId':'$runtime2'}),
        http('POST','/v1/sessions/resume-continuation',{'sessionRef':ref,'priorHostSessionId':'$host2','intent':'$intent'},
             {'host3':'body.hostSessionId'}),
        http('POST','/v1/runtimes/start',{'hostSessionId':'$host3','intent':'$intent'}, {'runtime3':'body.runtimeId'}),
        {'kind':'preparation','runtimeId':'$runtime3'},
        {'kind':'poll','path':'/v1/events/tail?hostSessionId=${host3}&eventKind=turn.completed&limit=1',
         'until':[{'op':'count','path':'body.events','value':1}],'timeoutSec':90,
         'assertions':[eq('resume-final','body.events.0.payload.success',True)]},
        http('POST','/v1/terminate',{'runtimeId':'$runtime3'}),
        {'kind':'substrate','assertions':[eq('terminated-substrate','processes',[])]}]
    cases['finite-store']=[
        command(['seed','$host',scope,'$runtime'],kind='sdk',assertions=[eq('seed-written','exit',0)]),
        http('GET','/v1/events/page?afterSeq=0&limit=1',capture={'incarnation':'body.ledgerIncarnationId'},
            assertions=[{'id':'nonempty-state','op':'nonempty','path':'body.rows'}]),
        http('GET','/v1/events/page?afterSeq=0&limit=1000',assertions=[exists('full-short-page','body.scannedThrough')]),
        http('GET','/v1/events/page?afterSeq=0&limit=1&ledgerIncarnationId=deliberately-wrong',
             assertions=[eq('cursor-mismatch','body.error.code','cursor_invalid')]),
        {'kind':'store-observation','assertions':[{'id':'holes-spill-highwater','op':'nonempty','path':'holes'}]}]
    errors=[
        {'kind':'stream-open','name':'lifecycle','path':'/v1/events/bounded-stream?hostSessionId=${host}&generation=${generation}&afterSeq=0&ledgerIncarnationId=${incarnation}&follow=true',
         'assertions':[eq('replay-live','status',200)]},
        # A real independent short third turn supplies live frames after replay.
        invoke('p0-stream-'+str(time.time_ns())),
        {'kind':'stream-close','name':'lifecycle','minFrames':1,'waitSec':2,
         'assertions':[{'id':'ordered-unique','op':'nonempty','path':'frames'},eq('abort-timeout','closed',True)]},
        {**http('POST','/v1/sessions/resolve'), 'rawBody':'{', 'assertions':[eq('malformed-uri-json','status',400)]},
        http('POST','/v1/sessions/resolve',{},assertions=[eq('missing-field','status',400)]),
        http('DELETE','/v1/health',assertions=[eq('wrong-method','status',404)]),
        http('GET','/v1/p0-unknown',assertions=[eq('unknown-route','status',404)])]
    for suffix in ['continuation','wrapper-started','child-started','event','exited']:
        errors.append(http('POST','/v1/internal/launches/p0/'+suffix,{},assertions=[eq('retired-callbacks','status',404)]))
    errors.append(http('POST','/v1/internal/hooks/ingest',{},assertions=[eq('retired-hook','status',404)]))
    cases['streams-errors']=errors
    cases['direct-cli-sdk']=[
        command(['--help'],[eq('cli-help-alias','exit',0)]),
        command(['ls','runtimes','--json']), command(['list','runtimes','--json']),
        command(['monitor','show','host:${host}','--json'],[eq('monitor-show-watch-wait','exit',0)]),
        command(['monitor','watch','host:${host}','--last','5','--format','ndjson'],[eq('json-ndjson-exits','exit',0)]),
        command(['monitor','wait','host:${host}','--until','turn-finished','--since','1','--timeout','2s','--json']),
        command(['run','annotate','$supportedRunId','--correlation',json.dumps({'attemptRef':'p0:compatibility'})],
             [eq('run-bearing-export-annotation','exit',0)]),
        command(['run','export','$supportedRunId','--json'],[eq('export-readback','body.correlation.attemptRef','p0:compatibility')]),
        command(['health'],[eq('sdk-real-read','body.ok',True)],kind='sdk')]
    cases['wrkq']=[{'kind':'publication','before':'$cursorBefore','assertions':[{'id':'isolated-real-publication','op':'nonempty','path':'facts'},
        exists('two-cursor-owners','nodeId')]}, {'kind':'authority-unavailable','assertions':[eq('unavailability-cli','exit',1)]},
        {'kind':'hrc-unavailable','assertions':[{'id':'unavailability','op':'nonempty','path':'failures'}]}]
    perf=[http('GET','/v1/status',assertions=[exists('fallback-tuple','body.release')])]
    perf += [http('GET','/v1/events/page?afterSeq=0&limit=100') for _ in range(35)]
    perf += [http('GET','/v1/status',assertions=[exists('bun-alone-repeat','body.release')]),
             {'kind':'resource','assertions':[exists('measured-latency-resource','rssKb')]}]
    cases['fallback-performance']=perf
    cases['jobs-files-listeners']=[{'kind':'inventory','assertions':[eq('inventory-closure','inventoryComplete',True),
        exists('explicit-downstream-gaps','coverage.gaps')]},
        {'kind':'server-log','assertions':[{'id':'startup-stop-effects','op':'contains','path':'events','value':'server.start.ready'}]}]
    return {'schema':1,'status':'admission-required','claim':'bun-compatibility', 'validationSurface':'source' if source else 'installed',
        'implementation':'bun','runId':scope.rsplit(':',1)[-1],'scopePrefix':scope,
        'scratchRoot':str(root),'runtimeRoot':str(root/'run'),'stateRoot':str(root/'state'),
        'agentsRoot':str(root/'agents'),'agentRoot':str(root/'agents/tabularasa'),'projectRoot':str(root/'project'),'peerConfig':str(root/'federation.json'),
        'publicSocket':str(root/'run/hrc.sock'),'dbPath':str(root/'state/state.sqlite'),
        'wrkqLocator':authority['locator'],'wrkqDbPath':authority['dbPath'],'wrkqPort':authority['port'],
        'unavailableRoot':str(root/'unavailable'),'nodeId':node,'aspAdmissionEvidence':str(Path(asp_evidence).absolute()),'env':env,
        'authorityPid':int((root/'authority.pid').read_text()),'ownerPid':int((root/'owner.pid').read_text()),'rustOwnerPids':[],
        'cliArgv':[bun,str(Path(cli).absolute())],
        'sdkArgv':[bun,str(ROOT/'conformance/hrc-parity/probe.ts'),str(release),str(root),str(root/'run/hrc.sock')],
        'wrkqArgv':[str(Path(shutil.which('wrkq')).absolute())], 'serveLog':str(root/'serve.log'),
        'requestTimeoutSec':25,'suiteTimeoutSec':1800,
        'cases':[{'id':id,'actions':actions} for id,actions in cases.items()]}


if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    for flag in ('scratch-root','release-root','cli','asp-evidence','node','out'):
        parser.add_argument('--'+flag, required=True)
    parser.add_argument('--source',action='store_true')
    a=parser.parse_args()
    result=make_profile(a.scratch_root,a.release_root,a.cli,a.asp_evidence,a.node,a.source)
    Path(a.out).write_text(json.dumps(result,indent=2)+'\n')
    print(a.out)
