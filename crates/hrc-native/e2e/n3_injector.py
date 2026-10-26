#!/usr/bin/env python3
"""Unchanged injector + wrkc reply, with the Rust owner replaced mid-delivery.

Failure modes: wrong wrkq authority, subscriber receipt loss on reconnect,
delivery repeated after owner restart, Stop allowing presented reply debt,
losing the still-running broker/tool, or reply discharge never clearing Stop.
"""
import argparse,json,shlex,sqlite3,subprocess,time
from pathlib import Path
from n3_scratch import Scratch

def main():
    p=argparse.ArgumentParser();p.add_argument('--injector',default='0.1.0-dev.20261023155744')
    for k in ('binary','installed-release','aspd-socket','scratch-root','artifacts'):p.add_argument('--'+k,type=Path,required=True)
    a=p.parse_args();s=Scratch(a.scratch_root,a.installed_release,a.aspd_socket,a.binary,a.artifacts,project_id='n3-t11839')
    try:
        s.init_substrate();bun=s.up('bun','injector-birth')
        scope='agent:tabularasa:project:n3-t11839:task:injector';seat='tabularasa@n3-t11839:injector';sender='cody@n3-t11839:primary'
        start=s.command('birth',['hrc','start',scope,'--project-id',s.project_id,'--project-root',s.project,'--cwd',s.project,'--json','-p','Reply with exactly the word READY and nothing else. No tools.'])
        rt=start['runtime'];s.wait_completed(rt['runId']);s.down(bun);native=s.up('native','injector-subject')
        env={**s.env,'HRC_SOCKET_PATH':str(s.socket),'HRC_NODE_ID':s.project_id,'HRC_MAIL_INJECTOR_STATE_PATH':str(s.root/'state/injector.sqlite')}
        argv=['bunx','--bun','--silent','hrc-mail-injector@'+a.injector]
        unmarked=subprocess.run(argv,env=env,cwd=s.project,capture_output=True,text=True,timeout=120)
        (a.artifacts/'injector-unmarked.stderr').write_text(unmarked.stderr)
        assert unmarked.returncode!=0 and 'import marker' in unmarked.stderr,unmarked.stderr
        with sqlite3.connect(s.root/'state/injector.sqlite') as db:db.execute('INSERT INTO injector_store_imports(source_path,imported_at) VALUES(?,?)',('scratch:none',time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())))
        log=(a.artifacts/'injector.log').open('w');s.logs.append(log)
        injector=subprocess.Popen(argv,env=env,cwd=s.project,stdout=log,stderr=log);s.owners.append(injector)
        ready=s.root/'reply-ready';release=s.root/'release-reply'
        command='touch '+shlex.quote(str(ready))+'; while [ ! -f '+shlex.quote(str(release))+' ]; do sleep 0.1; done; wrkc say /n3-t11839 --scope-ref '+shlex.quote(seat)+' --as agent:tabularasa --to '+shlex.quote(sender)+' --fyi -m N3_PRIVATE_ACK --json'
        body='Private N3 mail gate. Use your Bash tool to run exactly this command once. It intentionally waits for a local test marker; keep waiting until the file exists. The command replies to this mail. Do not run another wrkc reply. After it finishes, respond only DONE.\n\n'+command
        said=s.command('private-wrkc-say',['wrkc','say','/n3-t11839','--scope-ref',sender,'--as','agent:cody','--to',seat,'-m',body,'--json'])
        envelope=said['envelopes'][0]['id']
        until=time.monotonic()+180
        while not ready.exists():
            assert injector.poll() is None,(a.artifacts/'injector.log').read_text()[-4000:]
            assert time.monotonic()<until,'injector/recipient did not reach reply hold'
            time.sleep(.1)
        status,blocked=s.http('POST','/v1/internal/mail/stop-decision',{'runtimeId':rt['runtimeId']})
        assert status==200 and blocked['decision']=='block' and blocked['unackedCount']==1,(status,blocked)
        before=s.rows('SELECT COUNT(*) AS n FROM broker_invocation_events')[0]['n']
        s.down(native);native=s.up('native','injector-restart')
        release.write_text('release after native owner restart\n')
        replies=[];until=time.monotonic()+180
        while time.monotonic()<until:
            room=s.command('private-room-read',['wrkc','log','/n3-t11839','--limit','100','--json'])
            replies=[row for row in room['items'] if row.get('body')=='N3_PRIVATE_ACK']
            if replies:break
            time.sleep(.2)
        assert len(replies)==1,replies
        s.wait(lambda:s.rows("SELECT * FROM hrc_events WHERE event_kind='turn.completed' AND run_id<>?",(rt['runId'],)),60,'mail turn completed after reply')
        status,clear=s.http('POST','/v1/internal/mail/stop-decision',{'runtimeId':rt['runtimeId']})
        assert status==200 and clear['decision']=='allow' and clear['reason']=='clear',(status,clear)
        time.sleep(3)
        room=s.command('private-room-final',['wrkc','log','/n3-t11839','--limit','100','--json'])
        assert len([row for row in room['items'] if row.get('body')=='N3_PRIVATE_ACK'])==1,room
        s.assert_no_duplicate_turn_messages()
        result={'pass':True,'injectorVersion':a.injector,'envelope':envelope,'replyCount':1,'blockedBeforeRestart':blocked,'clearAfterReply':clear,'brokerRowsBeforeRestart':before,'brokerRowsAfterRestart':s.rows('SELECT COUNT(*) AS n FROM broker_invocation_events')[0]['n'],'authority':s.authority}
        (a.artifacts/'result.json').write_text(json.dumps(result,indent=2)+'\n');s.dump('after-reply')
        print(json.dumps({'pass':True,'replyCount':1,'artifacts':str(a.artifacts)}))
    finally:
        if 'release' in locals():release.touch(exist_ok=True)
        s.cleanup('agent:tabularasa:project:n3-t11839:task:')
if __name__=='__main__':main()
