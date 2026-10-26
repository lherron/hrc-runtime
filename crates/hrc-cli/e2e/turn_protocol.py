#!/usr/bin/env python3
"""Turn wire/renderer differential using captures from a real owned daemon.

Capture inputs retain daemon declarations and event shapes, while controlled
fault vectors exercise receipts, partial streams, attach fences and failures.
This suite never starts a runtime. Positive real/PTY turns are separate gates.
"""
import argparse, atexit, copy, http.server, json, os, re, shutil, signal
import socketserver, subprocess, tempfile, threading, time, urllib.parse
from pathlib import Path
from metrics_isolation import MetricsIsolation
from metrics import records, normalized as normalize_metrics

parser = argparse.ArgumentParser(description=__doc__)
for key in ('binary', 'oracle', 'launch-wire', 'attach-wire', 'summary-wire', 'artifacts', 'token-file'):
    parser.add_argument('--' + key, type=Path, required=True)
parser.add_argument('--authority', required=True)
parser.add_argument('--cwd', type=Path, required=True)
parser.add_argument('--suite', choices=('basic', 'rich', 'stacked', 'summary', 'attach', 'dispatch', 'task-state', 'metrics', 'stacked-errors'), required=True)
args = parser.parse_args()
art = args.artifacts
art.mkdir(parents=True, exist_ok=True)
capture = args.launch_wire
resolution = json.loads((capture/'resolution.json').read_text())
dispatch = json.loads((capture/'dispatch.json').read_text())
events = json.loads((capture/'events.json').read_text())['events']
handoff = dispatch['response']
summary_resolution = json.loads((capture/'summarizer-resolution.json').read_text())
ensured = json.loads((args.summary_wire/'ensure.json').read_text())['response']
invoked = json.loads((args.summary_wire/'invoke.json').read_text())['response']
active = json.loads((args.attach_wire/'inspect-active.json').read_text())
runs = json.loads((args.attach_wire/'run-active.json').read_text())
if args.suite == 'attach':
    events = json.loads((args.attach_wire/'events.json').read_text())['events']
    handoff = {k: active[k] for k in ('runtimeId', 'hostSessionId', 'scopeRef', 'laneRef', 'generation')}
    handoff.update(runId=runs[0]['runId'], sessionRef=active['scopeRef']+'/lane:'+active['laneRef'], fromSeq=events[0]['hrcSeq'])
assert events and any(e['eventKind']=='turn.completed' for e in events)
scratch = tempfile.TemporaryDirectory(prefix='n5-turn-wire-', dir='/tmp')
atexit.register(scratch.cleanup)
root = Path(scratch.name)
(root/'state').mkdir()
if args.suite in ('stacked', 'task-state', 'stacked-errors'):
    resolution = summary_resolution
agent = 'summarizer' if args.suite in ('stacked', 'task-state', 'stacked-errors') else 'tabularasa'
target = active['scopeRef'] if args.suite == 'attach' else agent+'@'+resolution['placementRequest']['projectId']+':'+resolution['placementRequest']['taskId']+'+remote=false'
template = next(e for e in events if e['eventKind']=='turn.completed')
def event(kind,payload,seq=10000):
 e=copy.deepcopy(template);e.update(eventKind=kind,payload=payload,hrcSeq=seq);return e
class Server(socketserver.ThreadingMixIn,socketserver.UnixStreamServer):
 daemon_threads=True
class Handler(http.server.BaseHTTPRequestHandler):
 protocol_version='HTTP/1.1'
 def log_message(self,*args):pass
 def handle(self):
  try:super().handle()
  except (BrokenPipeError,ConnectionResetError):pass
 def json(self,value,status=200,cursor=None):
  b=json.dumps(value,separators=(',',':')).encode();self.send_response(status);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(b)));
  if cursor:self.send_header('x-hrc-next-cursor',cursor)
  self.end_headers();self.wfile.write(b)
 def do_POST(self):
  body=json.loads(self.rfile.read(int(self.headers.get('Content-Length','0'))));self.server.calls.append(dict(method='POST',path=self.path,body=body))
  if self.path=='/v1/placements/resolve':return self.json((summary_resolution if body['agentId']=='summarizer' else resolution)['placement'])
  if self.path=='/v1/declarations/resolve':return self.json((summary_resolution if body['agentId']=='summarizer' else resolution)['declaration'])
  if self.path=='/v1/sessions/resolve':return self.json(dict(found=self.server.scenario!='session-missing',hostSessionId=active['hostSessionId']) if args.suite=='attach' else dict(found=self.server.scenario.startswith('steer')))
  if self.path=='/v1/runtimes/inspect':
   value=copy.deepcopy(active)
   if self.server.scenario=='inactive':value['activeRunId']=None
   return self.json(value)
  if self.path.startswith('/v1/submissions/') and args.suite!='summary':
   if 'timeout' in self.server.scenario:time.sleep(.35)
   value=copy.deepcopy(handoff);value.update(admission='admitted',requestedDoor=self.path.rsplit('/',1)[-1],effectiveDoor='enqueue' if 'downgrade' in self.server.scenario else self.path.rsplit('/',1)[-1],observation=dict(lifecycle=dict(fromSeq=handoff['fromSeq'])))
   if 'receipt' in self.server.scenario:value=dict(admission='accepted',inputId='input-fixture',requestedDoor=value['requestedDoor'],effectiveDoor=value['effectiveDoor'])
   if 'failed' in self.server.scenario:value.update(status='failed',error=dict(code='runtime_unavailable',message='controlled broker start failure'))
   if 'terminalfailed' in self.server.scenario:value.update(status='accepted',terminal=dict(status='failed'))
   return self.json(value)
  if self.path=='/v1/messages/turn-handoff':
   value=copy.deepcopy(handoff)
   if self.server.scenario=='pending':value=dict(status='pending',messageId='message-fixture')
   if self.server.scenario=='warnings':value['warnings']=[dict(code='fixture_warning',message='controlled warning')]
   return self.json(value)
  if self.path=='/v1/targets/ensure':
   self.server.ensure_started.set()
   if self.server.scenario=='ensure-cancel':time.sleep(.5)
   if self.server.scenario=='ensure-failure':return self.json(dict(error=dict(code='internal_error',message='controlled ensure failure',detail={})),500)
   self.server.ensured=True
   return self.json(ensured)
  if self.path=='/v1/submissions/invoke':
   value=copy.deepcopy(invoked);value['terminal']['finalMessage']='Fixture summary'
   if self.server.scenario=='slow-invoke':time.sleep(.35)
   if self.server.scenario=='invoke-failure':return self.json(dict(error=dict(code='runtime_unavailable',message='controlled invoke failure',detail={})),503)
   if self.server.scenario=='not-admitted':value['admission']='refused'
   if self.server.scenario=='empty-summary':value['terminal']['finalMessage']='  '
   if self.server.scenario=='pagination':value.pop('runtimeId',None)
   return self.json(value)
  if self.path in ('/v1/terminate','/v1/sessions/drop-continuation'):return self.json(dict(ok=True))
  if self.path=='/v1/subscribers/fixture/ack':
   self.server.acks.append(body['seq']);return self.json(dict(ok=True),500 if self.server.scenario=='ack-error' else 200)
  return self.json(dict(error=dict(code='internal_error',message='Unexpected fixture path',detail={})),500)
 def do_GET(self):
  parsed=urllib.parse.urlsplit(self.path);self.server.calls.append(dict(method='GET',path=parsed.path,query=urllib.parse.parse_qs(parsed.query)))
  if parsed.path=='/v1/runtimes':
   if self.server.scenario=='pagination' and not urllib.parse.parse_qs(parsed.query).get('cursor'):return self.json([],cursor=' page+ /alpha ')
   if args.suite=='attach':return self.json([] if self.server.scenario=='no-runtime' else [active,active] if self.server.scenario=='multiple' else [active])
   return self.json([dict(runtimeId=invoked['runtimeId'],hostSessionId=invoked['hostSessionId'])] if self.server.ensured else [])
  if parsed.path=='/v1/runs':
   value=copy.deepcopy(runs)
   if self.server.scenario=='run-missing':value=[]
   if self.server.scenario=='run-ended':value[0]['status']='completed'
   return self.json(value)
  if parsed.path!='/v1/events':return self.json({},404)
  values=copy.deepcopy(events);scenario=self.server.scenario
  if scenario=='duplicate':values=[values[0]]+values
  if scenario=='runtime-dead':values=[event('runtime_exited',{})]
  if scenario=='turn-failed':values=[event('turn.failed',dict(code='fixture_failure',message='controlled failure'))]
  if scenario=='first-turn-missing':values=[event('first_turn_missing',dict(code='missing',message='controlled missing'))]
  if scenario=='completion-failed':values=[event('turn.completed',dict(success=False,error='controlled terminal'))]
  if scenario=='foreign':
   foreign=event('turn.completed',dict(success=True),9999);foreign['runId']='run-foreign';values=[foreign]+values

  tool_call=event('turn.tool_call',dict(toolUseId='tool-observed',toolName='Bash',input=dict(command='echo Ω😀',description='owned protocol command')),10001)
  tool_result=event('turn.tool_result',dict(toolUseId='tool-observed',toolName='Bash',result=dict(content=[dict(type='text',text='line1\nline2\nline3\nline4'),dict(type='image',data='synthetic-fixture-image',mimeType='image/png'),dict(type='media_ref',url='https://fixture.invalid/owned',filename='owned.png',mimeType='image/png')]),isError=False),10002)
  if scenario in ('tool-chain','tool-repeat','tool-orphan','tool-failed'):
   values=[tool_call,tool_result]
   if scenario=='tool-repeat':values += [event('turn.tool_call',tool_call['payload'],10003),event('turn.tool_result',dict(toolUseId='tool-observed',toolName='Bash',result=dict(content=[dict(type='text',text='updated')]),isError=False),10004)]
   if scenario=='tool-orphan':values=[tool_result]
   if scenario=='tool-failed':values[-1]['payload']['isError']=True
  if scenario in ('message-stream','message-content','message-anonymous'):
   values=[event('message_start',dict(messageId='message-owned',message=dict(role='assistant',content='Hello')),10001),event('message_update',dict(messageId='message-owned',textDelta=' Ω😀'),10002),event('message_end',dict(messageId='message-owned',message=dict(role='assistant',content='Final Ω😀')),10003)]
   if scenario=='message-content':values[1]['payload']=dict(messageId='message-owned',contentBlocks=[dict(type='text',text='Replacement')])
   if scenario=='message-anonymous':
    for value in values:value['payload'].pop('messageId',None)
  if scenario=='notice':values=[event('unknown.event',dict(type='notice',level='warn',message='controlled warning')),event('turn.completed',dict(type='notice',level='info',message='terminal notice'),10001)]
  if scenario=='admission':values=[event(k,dict(reason='contribution_unsupported_fallback_queued'),10000+i) for i,k in enumerate(('input.application.accepted','input.application.pending','input.application.ambiguous','input.application.failed','input.rejected','input.queued','input.admitted','input.dispatching','input.started','input.queue.expired'))]
  if scenario in ('tool-chain','tool-repeat','tool-orphan','tool-failed','message-stream','message-content','message-anonymous','admission'):values.append(event('turn.completed',dict(finalOutput='Final answer'),11000))
  if scenario=='unsafe-ack':
   extra=[event('unknown',{},seq) for seq in (0,1.5,9007199254740992)]
   for value in extra:value['runId']='run-foreign'
   values=extra+values
  if scenario.startswith('permission'):
   permission=event('permission_request',dict(requestId='permission-owned',toolUseId='tool-owned',toolName='Bash',toolInput={'command':'echo fixture','token':'synthetic-public-fixture'},actions=[dict(id='allow',label='Allow once')]),10001)
   values=[permission]
   if scenario=='permission-repeat':values += [copy.deepcopy(permission)]
   if scenario=='permission-missing-id':values[0]['payload'].pop('requestId')
   if scenario=='permission-final':values.append(event('turn.completed',dict(success=True,body='OK'),10002))
  if scenario=='error-meta':values=[event('turn.error',dict(code='fixture_failure',message='controlled error'))]
  if scenario=='final-body':values=[event('turn.completed',dict(success=True,body='Ω😀'*2500,replyMessageId='reply-owned'))]
  if scenario=='nonbool-success':values=[event('turn.completed',dict(success='false',body='OK'))]
  if scenario=='float-generation':
   for value in values:value['generation']=float(value['generation'])

  if args.suite=='attach':
   follow=urllib.parse.parse_qs(parsed.query).get('follow')==['true']
   if scenario=='ledger-empty':values=[]
   elif not follow and scenario!='terminal-during-replay':values=values[:10]
   elif scenario=='catchup-loss' and follow:values=values[:1]
  if scenario=='ensure-cancel':values=values[:1]
  if scenario in ('stall','sigint','empty-eof'):values=[]
  if scenario=='sigint':
   marker=event('unknown',{},99999);marker['runId']='run-foreign';values=[marker]
  payload=b'\n'.join(json.dumps(e,ensure_ascii=False,separators=(',',':')).encode() for e in values)+b'\n'
  if scenario=='malformed':payload=b'\nnot-json\n'+payload
  if scenario=='eof-remainder':payload=payload.rstrip(b'\n')
  if scenario=='lossy-utf8':payload=payload.replace(b'OK',b'OK \xff')
  self.send_response(200);self.send_header('Content-Type','application/x-ndjson');self.send_header('x-hrc-subscriber-id','fixture');self.send_header('x-hrc-receipt-token','synthetic-fixture-only');self.send_header('x-hrc-receipt-ack-path','/v1/subscribers/fixture/ack')
  if scenario not in ('stall','sigint','ensure-cancel'):self.send_header('Content-Length',str(len(payload)))
  else:self.send_header('Connection','close')
  self.end_headers();self.server.streaming.set()
  try:
   if scenario=='split-utf8':
    for byte in payload:self.wfile.write(bytes([byte]));self.wfile.flush()
   else:self.wfile.write(payload);self.wfile.flush()
   if scenario in ('stall','sigint','ensure-cancel'):self.server.release.wait(5)
  except (BrokenPipeError,ConnectionResetError):pass

def normalize(observed):
 result=dict(observed);lines=[]
 for line in result['stdout'].splitlines():
  try:
   value=json.loads(line)
   if value.get('type')=='turn_stacked':
    assert value['at'] and value['window']['ms']>=0
    value['at']='<clock>';value['window']={'startedAt':'<clock>','endedAt':'<clock>','ms':'<duration>'}
   if value.get('type')=='render_frame':
    assert isinstance(value['updatedAt'],(int,float)) and value['updatedAt']>0;value['updatedAt']='<clock>'
   lines.append(json.dumps(value,ensure_ascii=False,separators=(',',':')))
  except (ValueError,AttributeError):
   line=re.sub(r'(\x1b\[2m)\d+ms(?=\x1b\[22m)',r'\1<elapsed>',line)
   lines.append(re.sub(r'(?<![\w])\d+ms(?=\s|$|\x1b)', '<elapsed>',line))
 result['stdout']='\n'.join(lines)+ ('\n' if result['stdout'].endswith('\n') else '')
 return result
basic = [(s, []) for s in ('actual','duplicate','foreign','malformed','eof-remainder','split-utf8','ack-error','runtime-dead','turn-failed','first-turn-missing','completion-failed','empty-eof','stall','sigint')]
basic += [('actual', flags) for flags in (['--format','tree'], ['--format','compact'], ['--pretty'], ['--json'], ['--format','json'])]
rich = [(s, flags) for s in ('tool-chain','tool-repeat','tool-orphan','tool-failed','message-stream','message-content','message-anonymous','notice','admission','unsafe-ack','float-generation','lossy-utf8') for flags in ([],['--format','tree'],['--pretty'])]
stacked = [(s, ['--stacked','100ms']) for s in ('actual','empty-eof','runtime-dead','turn-failed','first-turn-missing','completion-failed','stall','sigint')]
stacked += [(s, ['--follow','100ms','--json']) for s in ('actual','empty-eof','runtime-dead','turn-failed','first-turn-missing','completion-failed','stall','sigint')]
summary = [(s, ['--stacked','100ms']) for s in ('actual','ensure-failure','invoke-failure','not-admitted','empty-summary','slow-invoke','ensure-cancel','pagination')]
attach = [(s, flags) for s in ('actual','session-missing','no-runtime','inactive','multiple','run-missing','run-ended','ledger-empty','catchup-loss','terminal-during-replay','pagination') for flags in ([],['--json'])]
doors=[('preempt',['--preempt']),('preemptfailed',['--preempt']),('preemptterminalfailed',['--preempt']),('preemptwait',['--preempt','--wait','final','--timeout','2s']),('preempttimeout',['--preempt','--wait','final','--timeout','100ms']),('queuewait',['--queue','--wait','final','--timeout','2s']),('queuefailed',['--queue','--wait','final','--timeout','2s']),('queuettl',['--queue','--ttl','2s']),('queuetimeout',['--queue','--wait','final','--timeout','100ms']),('actual',['--queue']),('pending',[]),('warnings',[]),('warnings',['--quiet']),('steer',[]),('steerdowngrade',[]),('steerreceipt',[]),('steerreceiptfailed',[]),('steerwait',['--wait','final','--timeout','2s']),('steerwaitfailed',['--wait','final','--timeout','2s']),('steertimeout',['--wait','final','--timeout','100ms']),('actual',['--queue','--new','--reply-to','message-fixture','--cross-scope-reply','--response-format','text']),('actual',['--queue','--format','invalid'])]
dispatch_cases=[(scenario,flags+mode) for scenario,flags in doors for mode in ([],['--json'])]
task_state = [(s, ['--stacked','30s']) for s in ('owner','subtask','bad-subtask','object','bad-json','failure','hang','orphan-pipes')]
stacked_errors=[(s,['--stacked','30s']) for s in ('permission','permission-repeat','permission-missing-id','permission-final','error-meta','final-body','nonbool-success')]
metric_cases=[(s, []) for s in ('actual','ack-error','malformed')]
cases = dict(stacked_errors=stacked_errors, metrics=metric_cases, task_state=task_state, basic=basic, rich=rich, stacked=stacked, summary=summary, attach=attach, dispatch=dispatch_cases)[args.suite.replace('-', '_')]
env={k:v for k,v in os.environ.items() if not k.startswith(('ASP_','HRC_','WRKQ','HARNESS_BROKER_'))};env.update(HRC_RUNTIME_DIR=str(root),HRC_STATE_DIR=str(root/'state'),WRKQ_DB=args.authority,HRC_WRKQ_DB=args.authority,WRKQD_TOKEN_FILE=str(args.token_file),HRC_WRKQD_TOKEN_FILE=str(args.token_file),NO_COLOR='1',FORCE_COLOR='0')
results=[]
with MetricsIsolation():
 for scenario,flags in cases:
  if args.suite=='task-state':
   task='T-00001.valid-slug' if scenario=='subtask' else 'T-00001.Bad' if scenario=='bad-subtask' else 'T-00001'
   target='summarizer@'+resolution['placementRequest']['projectId']+':'+task
  observed=[];wires=[];usage=[]
  for label,cmd in [('oracle',[shutil.which('bun'),str(args.oracle.resolve())]),('subject',[str(args.binary.resolve())])]:
   path=root/'hrc.sock';path.unlink(missing_ok=True);server=Server(str(path),Handler);server.scenario=scenario;server.calls=[];server.acks=[];server.ensured=False;server.ensure_started=threading.Event();server.streaming=threading.Event();server.release=threading.Event();thread=threading.Thread(target=lambda:server.serve_forever(poll_interval=.02),daemon=True);thread.start()
   e=dict(env)
   if label=='subject':e['PATH']=str(root/'no-bun')
   if args.suite=='task-state':
    bin_dir=root/'task-bin';bin_dir.mkdir(exist_ok=True);e['PATH']=str(bin_dir)
    log=root/'task-argv';log.unlink(missing_ok=True)
    text='#!/bin/sh\nprintf "%s\\n" "$*" > '+str(log)+'\n'
    text += {'bad-json':'echo invalid', 'failure':'exit 1', 'hang':'/bin/sleep 20', 'orphan-pipes':'/bin/sleep 20 &\nexit 0', 'object':'''echo '{"state":"open"}' '''}.get(scenario, '''echo '[{"state":"completed"}]' ''')
    shim=bin_dir/'wrkq';shim.write_text(text+'\n');shim.chmod(0o755)
   c=None
   try:
    c=subprocess.Popen(cmd+['turn',target]+(['--attach'] if args.suite=='attach' else ['Reply with exactly OK and nothing else. No tools.','--as','human'])+['--stall-after','90s' if args.suite in ('task-state','stacked-errors') else '2s' if args.suite=='summary' else '300ms']+flags,env=e,cwd=args.cwd,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
    if scenario=='ensure-cancel' and server.ensure_started.wait(3):time.sleep(.15);c.send_signal(signal.SIGINT)
    if scenario=='sigint':
     for _ in range(300):
      if server.acks:break
      time.sleep(.01)
     assert server.acks,'SIGINT must follow an observed consumer ACK'
     time.sleep(.05);c.send_signal(signal.SIGINT)
    out,err=c.communicate(timeout=10);
    if args.suite=='task-state':
     expected_task='T-00001.valid-slug' if scenario=='subtask' else 'T-00001'
     assert log.read_text().strip()=='cat '+expected_task+' --json',log.read_text()
     frame=json.loads(out.splitlines()[-1]);assert frame['taskId']==expected_task
     assert frame['taskState']==('open' if scenario=='object' else None if scenario in ('bad-json','failure','hang','orphan-pipes') else 'completed'),frame
    if args.suite=='metrics':
     observed_usage=[r for r in records(root/'state') if r.get('pid')==c.pid]
     assert len(observed_usage)==1,observed_usage
     u=observed_usage[0];assert u['stdoutBytes']==len(out.encode()) and u['exitCode']==c.returncode,u
     assert u['bin']==('hrc' if label=='oracle' else 'rusthrc'),u
     u=normalize_metrics(u);u['stdoutBytes']='<clocked-output-length>';usage.append(u)
    observed.append(dict(exit=c.returncode,stdout=out,stderr=err));wires.append(dict(calls=server.calls,acks=server.acks))
   finally:
    if c is not None and c.poll() is None:c.kill();c.communicate(timeout=5)
    server.release.set();server.shutdown();server.server_close();thread.join();path.unlink(missing_ok=True)
  n=[normalize(x) for x in observed];results.append(dict(scenario=scenario,flags=flags,oracle=observed[0],subject=observed[1],wires=wires,metrics=usage,**{'pass':n[0]==n[1] and wires[0]==wires[1] and (not usage or usage[0]==usage[1])}));(art/'progress.json').write_text(json.dumps(results,indent=2))
 report=dict(cases=results,**{'pass':sum(x['pass'] for x in results),'fail':sum(not x['pass'] for x in results)});(art/'results.json').write_text(json.dumps(report,indent=2));print(json.dumps({k:report[k] for k in ('pass','fail')}))

scratch.cleanup()
raise SystemExit(int(bool(report['fail'])))
