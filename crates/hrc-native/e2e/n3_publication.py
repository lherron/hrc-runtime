#!/usr/bin/env python3
"""Replay real Bun lifecycle rows through both publication observers.

Failure modes: cursor starts at zero and backfills, imported/retained rows
publish, task affiliation loses a fact, attribute order changes, a restart
skips an unacknowledged post, or a lost reply creates duplicate project facts.
Only private wrkqd databases are reset, with the authority stopped first.
"""
import argparse,json,sqlite3,subprocess,time,shutil,signal,os
from pathlib import Path
from n3_scratch import Scratch

def backup(source,target):
    with sqlite3.connect(source) as a,sqlite3.connect(target) as b:a.backup(b)
def facts(s):
    with sqlite3.connect(s.root/'wrkq.db') as db:
        db.row_factory=sqlite3.Row
        return [dict(r) for r in db.execute('SELECT type,summary,attributes,principal_ref,scope_ref,idempotency_key,occurred_at FROM project_events ORDER BY id')]
def wait_for(s,predicate,what,timeout=45):
    until=time.monotonic()+timeout
    while time.monotonic()<until:
        if predicate():return
        time.sleep(.1)
    raise AssertionError(what)
def main():
    p=argparse.ArgumentParser()
    for k in ('binary','installed-release','aspd-socket','scratch-root','artifacts'):p.add_argument('--'+k,type=Path,required=True)
    a=p.parse_args();s=Scratch(a.scratch_root,a.installed_release,a.aspd_socket,a.binary,a.artifacts,project_id='n3-t11839')
    try:
        s.init_substrate();s.command('server-project',['wrkq','mkdir','/hrc-runtime','--kind','project','--json'])
        empty=s.root/'empty-wrkq.sqlite';backup(s.root/'wrkq.db',empty)
        authority=s.owners[0]
        bun=s.up('bun','publication-baseline')
        initial={r['stream']:r['high_water'] for r in s.rows('SELECT * FROM wrkq_ledger_cursors')}
        scope='agent:tabularasa:project:n3-t11839:task:publication'
        start=s.command('birth',['hrc','start',scope,'--project-id',s.project_id,'--project-root',s.project,'--cwd',s.project,'--json','-p','Reply with exactly the word OK and nothing else. No tools.'])
        rt=start['runtime'];s.wait_completed(rt['runId'])
        for i in range(2):
            status,turn=s.http('POST','/v1/turns',{'hostSessionId':rt['hostSessionId'],'prompt':'Reply with exactly the word OK and nothing else. No tools.','origin':{'actor':'agent:cody'},'waitFor':'terminal'})
            assert status==200,(status,turn)
        head=s.rows('SELECT MAX(hrc_seq) AS n FROM hrc_events')[0]['n']
        wait_for(s,lambda:any(r['type']=='server.started' for r in facts(s)) and len([r for r in facts(s) if r['type']=='turn.ended'])>=3,'Bun published real boot and three turns')
        snapshot=s.root/'publication-hrc.sqlite';backup(s.db_path,snapshot)
        s.down(bun)
        # Replay both implementations at the same session-intent cut. Bun's
        # publisher intentionally reads the current session at publish time.
        with sqlite3.connect(snapshot) as db:
            db.execute("UPDATE wrkq_ledger_cursors SET high_water=0 WHERE stream IN ('server-project-events','session-project-events')")
        def reset_authority(tag):
            nonlocal authority
            s.down(authority);backup(empty,s.root/'wrkq.db')
            log=(a.artifacts/('wrkqd-'+tag+'.log')).open('w');s.logs.append(log)
            authority=subprocess.Popen(['wrkqd','-addr','127.0.0.1:'+str(s.authority['port']),'-db',str(s.root/'wrkq.db')],env={**s.env,'WRKQ_DB':str(s.root/'wrkq.db'),'WRKQD_TOKEN':(s.root/'wrkqd-token').read_text().strip(),'WRKF_HOOK_CATALOG':str(s.root/'hook-catalog.json')},cwd=s.project,stdout=log,stderr=log);s.owners.append(authority)
            time.sleep(.5);s.command('initialize-'+tag,['wrkq','projects','--json'])
        reset_authority('baseline-replay');backup(snapshot,s.db_path)
        # Exact production classes from the copied Bun release; they own only
        # observation cursors, with the execution owner down for this replay.
        script='import {openHrcDatabase} from '+json.dumps(str(s.release/'packages/hrc-store-sqlite/src/database.ts'))+';'
        script+='import {SessionProjectEventPublisher} from '+json.dumps(str(s.release/'packages/hrc-server/src/wrkq/session-project-events.ts'))+';'
        script+='import {ServerProjectEventPublisher} from '+json.dumps(str(s.release/'packages/hrc-server/src/wrkq/server-project-events.ts'))+';'
        script+='import {WrkqStdioLedgerClient} from '+json.dumps(str(s.release/'packages/hrc-server/src/wrkq/ledger-client.ts'))+';'
        script+="const db=openHrcDatabase(process.argv[1]); const ledger=new WrkqStdioLedgerClient(); const post=p=>ledger.projectEventPost(p); const session=new SessionProjectEventPublisher({db,post,node:'n3-t11839',pollIntervalMs:0}); const server=new ServerProjectEventPublisher({db,post,nodeId:'n3-t11839',pollIntervalMs:0}); await session.drain();await server.drain();session.stop();server.stop();await ledger.close();db.close();"
        s.command('bun-production-publication-replay',['bun','-e',script,s.db_path])
        s.assert_no_duplicate_turn_messages()
        expected=facts(s)
        (a.artifacts/'bun-publication.json').write_text(json.dumps(expected,indent=2)+'\n')
        reset_authority('native');backup(snapshot,s.db_path)
        # Fault only the reply from the real private wrkq RPC child, after
        # projectEvent.post has committed. The second daemon retries the key.
        real_wrkq=shutil.which('wrkq',path=s.env['PATH'])
        marker=s.root/'lost-ack.json'; journal=a.artifacts/'publication-rpc.jsonl'
        wrapper=s.root/'bin/wrkq'
        script=r"""#!/usr/bin/env python3
import json,subprocess,sys
from pathlib import Path
peer=subprocess.Popen([REAL,*sys.argv[1:]],stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True)
try:
 for line in sys.stdin:
  peer.stdin.write(line);peer.stdin.flush()
  response=peer.stdout.readline()
  if not response:break
  frame=json.loads(line);reply=json.loads(response)
  if frame.get('method')=='wrkq.projectEvent.post':
   with Path(JOURNAL).open('a') as out:out.write(json.dumps({'request':frame,'response':reply})+'\n')
   if frame['params'].get('type')=='server.started' and not Path(MARKER).exists() and 'result' in reply:
    Path(MARKER).write_text(json.dumps({'request':frame,'response':reply}));continue
  sys.stdout.write(response);sys.stdout.flush()
finally:
 peer.terminate();peer.wait()
"""
        script=script.replace('REAL',repr(real_wrkq)).replace('JOURNAL',repr(str(journal))).replace('MARKER',repr(str(marker)))
        wrapper.write_text(script);wrapper.chmod(0o700)
        native=s.up('native','publication-subject')
        wait_for(s,marker.exists,'real post committed with ACK withheld')
        dropped=json.loads(marker.read_text());assert dropped['response']['result']['created'] is True,dropped
        s.down(native,signal.SIGKILL)
        # Cursor cannot move before the lost reply, even though wrkqd committed.
        server_seq=int(dropped['request']['params']['idempotencyKey'].rsplit(':',1)[1])
        assert s.rows("SELECT high_water FROM wrkq_ledger_cursors WHERE stream='server-project-events'")[0]['high_water']<server_seq
        # Native serve deliberately fails closed on stale owner files. This
        # gate replaces a crashed execution owner after proving its death;
        # server start/lock recovery is owned by N5, not publication.
        lock=s.root/'run/server.lock';record=json.loads(lock.read_text())
        assert record['pid']==native.pid and native.poll() is not None,record
        try:os.kill(native.pid,0)
        except ProcessLookupError:pass
        else:raise AssertionError('crashed owner is still live')
        for name in ('server.lock','server.pid','hrc.sock'):(s.root/'run'/name).unlink(missing_ok=True)
        native=s.up('native','publication-after-lost-ack')
        keys={r['idempotency_key'] for r in expected}
        wait_for(s,lambda:keys.issubset({r['idempotency_key'] for r in facts(s)}),'native published all original facts')
        wait_for(s,lambda:s.rows("SELECT high_water FROM wrkq_ledger_cursors WHERE stream='server-project-events'")[0]['high_water']>=server_seq,'retry ACK advances durable cursor')
        retries=[json.loads(line) for line in journal.read_text().splitlines() if json.loads(line)['request']['params']['idempotencyKey']==dropped['request']['params']['idempotencyKey']]
        assert len(retries)>=2 and retries[1]['response']['result']['created'] is False,retries
        actual={r['idempotency_key']:r for r in facts(s) if r['idempotency_key'] in keys}
        compares={r['idempotency_key']:{'bun':r,'native':actual.get(r['idempotency_key']),'pass':r==actual.get(r['idempotency_key'])} for r in expected}
        (a.artifacts/'publication-compares.json').write_text(json.dumps(compares,indent=2)+'\n')
        for side,observations in [('bun',{r['idempotency_key']:r for r in expected}),('native',actual)]:
            directory=a.artifacts/side;directory.mkdir(exist_ok=True)
            (directory/'publication.json').write_text(json.dumps(observations,indent=2)+'\n')
        runner=Path(__file__).resolve().parents[3]/'conformance/hrc-parity/run.py'
        compared=subprocess.run(['python3',str(runner),'compare','--suite','n3-publication','--baseline',str(a.artifacts/'bun'),'--candidate',str(a.artifacts/'native'),'--out',str(a.artifacts/'compare')],capture_output=True,text=True)
        (a.artifacts/'compare.stdout').write_text(compared.stdout);(a.artifacts/'compare.stderr').write_text(compared.stderr)
        assert compared.returncode==0,(compared.stdout,compared.stderr)
        bad=[k for k,v in compares.items() if not v['pass']];assert not bad,bad
        assert len(keys)==len(expected),'Bun baseline duplicate key'
        s.down(native);s.up('native','publication-restart');time.sleep(6)
        assert len([r for r in facts(s) if r['idempotency_key'] in keys])==len(expected),'restart duplicated a publish'
        (a.artifacts/'result.json').write_text(json.dumps({'pass':True,'facts':len(expected),'ledgerHead':head,'initialCursors':initial,'restartDuplicateCount':0,'lostAckRecovered':True},indent=2)+'\n')
        print(json.dumps({'pass':True,'facts':len(expected),'artifacts':str(a.artifacts)}))
    finally:s.cleanup('agent:tabularasa:project:n3-t11839:task:')
if __name__=='__main__':main()
