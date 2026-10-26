"""Real daemon validation/dry-run baseline; no input is dispatched."""
import json,os,shutil,subprocess,sys
from pathlib import Path
sys.path.insert(0,str(Path.cwd()/'crates/hrc-cli/e2e'))
from metrics_isolation import MetricsIsolation
import argparse
p=argparse.ArgumentParser(description=__doc__)
for key in ('binary','oracle','runtime-root','state-root','token-file','cwd','artifacts'):
 p.add_argument('--'+key,type=Path,required=True)
p.add_argument('--authority',required=True);p.add_argument('--target',required=True);p.add_argument('--project',required=True)
a=p.parse_args();art=a.artifacts;art.mkdir(parents=True,exist_ok=True);target=a.target
env={k:v for k,v in os.environ.items() if not k.startswith(('ASP_','HRC_','WRKQ','HARNESS_BROKER_'))};env.update(HRC_RUNTIME_DIR=str(a.runtime_root),HRC_STATE_DIR=str(a.state_root),WRKQ_DB=a.authority,HRC_WRKQ_DB=a.authority,WRKQD_TOKEN_FILE=str(a.token_file),HRC_WRKQD_TOKEN_FILE=str(a.token_file),NO_COLOR='1',FORCE_COLOR='0')
body=art/'body.txt';body.write_text('fixture prompt Ω😀\n');schema=art/'schema.json';schema.write_text('{"type":"object","properties":{"ok":{"type":"boolean"}}}')
caseargs=[[],[target],[target,''],['', 'hello'],[target,'hello','--file',str(body)],[target,'-','--file',str(body)],[target,'--attach','hello'],[target,'--attach','--file',str(body)]]
for flag in ('--new','--dry-run','--steer','--queue','--preempt','--wait','--ttl','--reply-to','--cross-scope-reply','--response-format-json-schema','--as','--quiet'):
 values={'--wait':'final','--ttl':'1s','--reply-to':'msg-owned','--response-format-json-schema':'{}','--as':'human'}
 caseargs.append([target,'--attach',flag]+([values[flag]] if flag in values else []))
for flags in (['--steer','--queue'],['--queue','--preempt'],['--steer','--preempt'],['--ttl','1s'],['--reply-to','m-owned'],['--cross-scope-reply'],['--wait','started'],['--wait','final','--stacked','1s'],['--wait','final','--follow','1s'],['--wait','final','--pretty'],['--wait','final','--format','tree'],['--wait','final','--format','compact'],['--stacked','1s','--follow','1s'],['--stacked','0'],['--stacked','x'],['--stacked','1s','--pretty'],['--follow','1s','--format','compact'],['--stall-after','x'],['--wait','final','--timeout','0'],['--response-format-json-schema','{broken'],['--response-format-json-schema',str(art/'missing.json')]):
 caseargs.append([target,'hello','--dry-run']+flags)
for flags in ([],['--format','ndjson'],['--format','json'],['--format','tree'],['--format','compact'],['--pretty'],['--stacked','1s'],['--follow','2s'],['--stall-after','5s'],['--wait','final'],['--queue','--reply-to','msg-owned','--cross-scope-reply'],['--preempt','--ttl','1s'],['--new'],['--fresh-context'],['--response-format-json-schema','{"type":"string"}'],['--response-format-json-schema',str(schema)],['--quiet']):
 caseargs.append([target,'hello','--dry-run']+flags)
caseargs += [[target,'--file',str(body),'--dry-run'],[target,'-','--dry-run'],[target,'hello','--dry-run','--format','unknown'],['missing-owned@'+a.project,'hello','--dry-run'],['bad:scope:shape','hello','--dry-run'],['tabularasa','hello','--dry-run'],[target,'--attach'],[target,'--attach','--json']]
# Hidden --json and global --output json exercise semantic usage errors too.
caseargs += [argv+['--json'] for argv in caseargs[:8]]
caseargs += [[target,'--','--json'],[target,'--file','--json'],[target,'--file','--output=json'],[target,'--','--output=json'],[target,'--as','--json','hello','--dry-run']]
results=[]
with MetricsIsolation():
 for argv in caseargs:
  observed=[]
  for label,cmd in [('oracle',[shutil.which('bun'),str(a.oracle.resolve())]),('subject',[str(a.binary.resolve())])]:
   e=dict(env)
   if label=='subject':e['PATH']='/tmp/n5-no-bun'
   c=subprocess.run(cmd+['turn']+argv,env=e,cwd=a.cwd,input='fixture stdin Ω😀\n',capture_output=True,text=True,timeout=30);observed.append(dict(exit=c.returncode,stdout=c.stdout,stderr=c.stderr))
  results.append(dict(argv=['turn']+argv,oracle=observed[0],subject=observed[1],**{'pass':observed[0]==observed[1]}))
 report=dict(cases=results,**{'pass':sum(x['pass'] for x in results),'fail':sum(not x['pass'] for x in results)});(art/'results.json').write_text(json.dumps(report,indent=2));print(json.dumps({k:report[k] for k in ('pass','fail')}))

raise SystemExit(int(bool(report['fail'])))
