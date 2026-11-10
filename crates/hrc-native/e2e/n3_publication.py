#!/usr/bin/env python3
"""Live rusthrc publication, then a from-zero replay with a lost wrkq reply.

A native owner publishes three real turns to a private wrkqd. A scratch owner
does not own its node's production timeline, so it consumes server.started
without publishing it (publication.rs pump_server). Both observation cursors
are then reset to zero on a snapshot, the authority is emptied, and a second
owner republishes while the reply to its first turn.ended post is withheld.
Checks: the live run published no server fact and exactly one session.born,
three turn.started and three turn.ended on this seat, keys unique; the session
cursor does not move past the lost reply; the retry reuses the key and wrkq answers
created=false; every replayed turn fact equals the live one (type, summary,
attributes and their order, principal, scope, time) and a replayed session.born
keeps every live attribute; a restart duplicates
nothing. Failure modes: a restart skips an unacknowledged post, a lost reply
creates duplicate project facts, a replay that drops or reshapes a fact. Only
private wrkqd databases are reset, with the authority stopped first.
"""
import argparse,json,sqlite3,subprocess,time,signal,os
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
    p=argparse.ArgumentParser();p.add_argument('--graceful-lost-ack',action='store_true')
    for k in ('binary','installed-release','aspd-socket','scratch-root','artifacts'):p.add_argument('--'+k,type=Path,required=True)
    a=p.parse_args();s=Scratch(a.scratch_root,a.installed_release,a.aspd_socket,a.binary,a.artifacts,project_id='n3-t11839')
    try:
        s.init_substrate();s.command('server-project',[str(Path.home() / ".local/bin/wrkq"),'mkdir','/hrc-runtime','--kind','project','--json'])
        empty=s.root/'empty-wrkq.sqlite';backup(s.root/'wrkq.db',empty)
        authority=s.owners[0]
        live=s.up('native','publication-live')
        initial={r['stream']:r['high_water'] for r in s.rows('SELECT * FROM wrkq_ledger_cursors')}
        scope='agent:tabularasa:project:n3-t11839:task:publication'
        start=s.command('birth',['hrc','start',scope,'--project-id',s.project_id,'--project-root',s.project,'--cwd',s.project,'--json','-p','Reply with exactly the word OK and nothing else. No tools.'])
        rt=start['runtime'];s.wait_completed(rt['runId'])
        for i in range(2):
            status,turn=s.http('POST','/v1/turns',{'hostSessionId':rt['hostSessionId'],'prompt':'Reply with exactly the word OK and nothing else. No tools.','origin':{'actor':'agent:cody'},'waitFor':'terminal'})
            assert status==200,(status,turn)
        head=s.rows('SELECT MAX(hrc_seq) AS n FROM hrc_events')[0]['n']
        wait_for(s,lambda:len([r for r in facts(s) if r['type']=='turn.ended'])>=3,'native published three turns')
        time.sleep(2);expected=facts(s)
        (a.artifacts/'live-publication.json').write_text(json.dumps(expected,indent=2)+'\n')
        snapshot=s.root/'publication-hrc.sqlite';backup(s.db_path,snapshot)
        s.down(live)
        # Replay from zero at the same session-intent cut as the live run.
        with sqlite3.connect(snapshot) as db:
            db.execute("UPDATE wrkq_ledger_cursors SET high_water=0 WHERE stream IN ('server-project-events','session-project-events')")
        def reset_authority(tag):
            nonlocal authority
            s.down(authority);backup(empty,s.root/'wrkq.db')
            log=(a.artifacts/('wrkqd-'+tag+'.log')).open('w');s.logs.append(log)
            authority=subprocess.Popen(['wrkqd','-addr','127.0.0.1:'+str(s.authority['port']),'-db',str(s.root/'wrkq.db')],env={**s.env,'WRKQ_DB':str(s.root/'wrkq.db'),'WRKQD_TOKEN':(s.root/'wrkqd-token').read_text().strip(),'WRKF_HOOK_CATALOG':str(s.root/'hook-catalog.json')},cwd=s.project,stdout=log,stderr=log);s.owners.append(authority)
            time.sleep(.5);s.command('initialize-'+tag,[str(Path.home() / ".local/bin/wrkq"),'projects','--json'])
        types=[r['type'] for r in expected]
        assert not [k for k in types if k.startswith('server.')],('scratch owner published its server timeline',types)
        assert types.count('session.born')==1 and types.count('turn.started')==3 and types.count('turn.ended')==3,types
        assert all(r['scope_ref']==scope+'/lane:main' for r in expected),expected
        reset_authority('native');backup(snapshot,s.db_path)
        # Fault only the reply from the real private wrkq RPC child, after
        # projectEvent.post has committed. The second daemon retries the key.
        real_wrkq=str(Path.home() / '.local/bin/wrkq')
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
   if frame['params'].get('type')=='turn.ended' and not Path(MARKER).exists() and 'result' in reply:
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
        s.down(native,signal.SIGTERM if a.graceful_lost_ack else signal.SIGKILL)
        # Cursor cannot move before the lost reply, even though wrkqd committed.
        # The key names the turn by its turn.started seq; the fact is the turn.completed after it.
        _,lost_rt,started_seq,_=dropped['request']['params']['idempotencyKey'].split(':')
        lost_seq=s.rows("SELECT MIN(hrc_seq) AS n FROM hrc_events WHERE runtime_id=? AND event_kind='turn.completed' AND hrc_seq>?",(lost_rt,int(started_seq)))[0]['n']
        assert lost_seq,dropped
        assert s.rows("SELECT high_water FROM wrkq_ledger_cursors WHERE stream='session-project-events'")[0]['high_water']<lost_seq
        # Native serve deliberately fails closed on stale owner files. This
        # gate replaces a crashed execution owner after proving its death;
        # server start/lock recovery is owned by N5, not publication.
        if a.graceful_lost_ack:
            assert native.returncode==0,('graceful shutdown depended on the withheld ACK',native.returncode)
            assert not (s.root/'run/server.lock').exists(),'graceful owner retained lock'
        else:
            lock=s.root/'run/server.lock';record=json.loads(lock.read_text())
            assert record['pid']==native.pid and native.poll() is not None,record
            try:os.kill(native.pid,0)
            except ProcessLookupError:pass
            else:raise AssertionError('crashed owner is still live')
            for name in ('server.lock','server.pid','hrc.sock'):(s.root/'run'/name).unlink(missing_ok=True)
        native=s.up('native','publication-after-lost-ack')
        keys={r['idempotency_key'] for r in expected}
        wait_for(s,lambda:keys.issubset({r['idempotency_key'] for r in facts(s)}),'native published all original facts')
        wait_for(s,lambda:s.rows("SELECT high_water FROM wrkq_ledger_cursors WHERE stream='session-project-events'")[0]['high_water']>=lost_seq,'retry ACK advances durable cursor')
        retries=[json.loads(line) for line in journal.read_text().splitlines() if json.loads(line)['request']['params']['idempotencyKey']==dropped['request']['params']['idempotencyKey']]
        assert len(retries)>=2 and retries[1]['response']['result']['created'] is False,retries
        actual={r['idempotency_key']:r for r in facts(s) if r['idempotency_key'] in keys}
        def same(live,replay):
            if replay is None:return False
            if live['type']!='session.born':return live==replay
            # session.born reads the current session at publish time (by design), so a
            # replay may carry what the session gained after birth, never lose a field.
            a,b=json.loads(live['attributes']),json.loads(replay['attributes'])
            return {k:v for k,v in live.items() if k!='attributes'}=={k:v for k,v in replay.items() if k!='attributes'} and all(b.get(k)==v for k,v in a.items())
        compares={r['idempotency_key']:{'live':r,'replay':actual.get(r['idempotency_key']),'pass':same(r,actual.get(r['idempotency_key']))} for r in expected}
        (a.artifacts/'publication-compares.json').write_text(json.dumps(compares,indent=2)+'\n')
        bad=[k for k,v in compares.items() if not v['pass']];assert not bad,bad
        assert len(keys)==len(expected),'live publication duplicate key'
        s.down(native);s.up('native','publication-restart');time.sleep(6)
        assert len([r for r in facts(s) if r['idempotency_key'] in keys])==len(expected),'restart duplicated a publish'
        (a.artifacts/'result.json').write_text(json.dumps({'pass':True,'facts':len(expected),'ledgerHead':head,'initialCursors':initial,'restartDuplicateCount':0,'lostAckRecovered':True,'gracefulWhileAckWithheld':a.graceful_lost_ack},indent=2)+'\n')
        print(json.dumps({'pass':True,'facts':len(expected),'artifacts':str(a.artifacts)}))
    finally:s.cleanup('agent:tabularasa:project:n3-t11839:task:')
if __name__=='__main__':main()
