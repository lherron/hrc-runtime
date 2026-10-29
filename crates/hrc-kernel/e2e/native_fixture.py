"""Private real-schema ledgers for deterministic kernel failure cases.

The daemon conformance gate proves real-born rows. This fixture uses that same
installed schema to exercise sparse cursors, replacement, outage and UTF-16
recovery without putting a fake HTTP read provider in front of native code.
"""
import datetime
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import threading
import time


def clean_env():
    return {k:v for k,v in os.environ.items() if not k.startswith(('HRC_','ASP_','WRKQ','HARNESS_','TMUX','CLAUDE','CODEX','AGENT_'))}

class NativeFixture:
    def __init__(self,root):
        self.root=Path(root);self.path=self.root/'state.sqlite'
        original=Path(os.environ.get('HRC_KERNEL_TEST_RELEASE',str(Path.home()/'.bun/install/hrc-runtime-current'))).resolve()
        self.release=self.root/'schema-release'
        subprocess.run(['/bin/cp','-R',str(original),str(self.release)],check=True,env=clean_env())
        module=self.release/'packages/hrc-store-sqlite/src/database.ts'
        subprocess.run(['bun','-e','import {openHrcDatabase} from '+json.dumps(str(module))+';openHrcDatabase(process.argv[1]).close()',str(self.path)],check=True,env=clean_env(),capture_output=True)
        self.stopped=False;self.thread=None;self.failure=None

    def replace(self,state):
        now=datetime.datetime.now(datetime.timezone.utc).isoformat()
        with sqlite3.connect(self.path) as db:
            db.execute('PRAGMA foreign_keys=OFF')
            for table in ('session_index','runtimes','continuities','sessions','hrc_events'):db.execute('DELETE FROM '+table)
            db.execute('UPDATE hrc_event_ledger_metadata SET ledger_incarnation_id=? WHERE id=1',(state['incarnation'],))
            for s in state.get('sessions',[]):
                host=s['hostSessionId'];scope=s['scopeRef'];lane=s.get('laneRef','main').removeprefix('lane:');generation=s.get('generation',1)
                created=s.get('createdAt',s.get('updatedAt',now))
                db.execute('INSERT INTO sessions(host_session_id,scope_ref,lane_ref,generation,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',(host,scope,lane,generation,s.get('status','active'),created,s.get('updatedAt',now)))
                identity=s.get('identity',{})
                db.execute('INSERT INTO continuities(scope_ref,lane_ref,active_host_session_id,updated_at,scope_kind,agent_id,project_id,task_id) VALUES(?,?,?,?,?,?,?,?)',(scope,lane,host,now,'project-task',identity.get('agentId','test'),identity.get('projectId','test'),identity.get('taskId','primary')))
            for r in state.get('runtimes',[]):
                tmux=r.get('tmux',{});target=tmux.get('attachTarget','seat:tui');session,_,window=target.partition(':')
                broker={'endpoint':{'kind':'stdio-jsonrpc-ndjson'},'substrate':{'kind':'daemon-child'},'presentation':{'kind':'none'}}
                t={}
                if tmux:
                    t={'socketPath':tmux['socketPath'],'sessionName':session}
                    if window:t['windowName']=window
                    broker['presentation']={'kind':'tmux-tui','tuiWindow':{'sessionId':'$0','windowId':'@0','paneId':'%0'}}
                pty=r.get('hrcpty')
                if pty:  # rusthrc's leased-hrcpty hosting (T-12049)
                    broker['substrate']={'kind':'leased-hrcpty','socketPath':pty['socketPath'],'pid':pty['supervisorPid'],'generation':r.get('generation',1)}
                    broker['presentation']={'kind':'hrcpty','socketPath':pty['socketPath'],'attachCommand':pty['attachCommand']}
                runtime_state={'broker':broker}
                if r.get('contextReading'):runtime_state['contextReading']=r['contextReading']
                db.execute('INSERT INTO runtimes(runtime_id,host_session_id,scope_ref,lane_ref,generation,transport,status,supports_inflight_input,created_at,updated_at,tmux_json,runtime_state_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',(r['runtimeId'],r['hostSessionId'],r['scopeRef'],r.get('laneRef','main').removeprefix('lane:'),r.get('generation',1),'hrcpty' if r.get('hrcpty') else 'tmux',r.get('status','idle'),1,now,now,json.dumps(t),json.dumps(runtime_state)))
            for e in state.get('events',[]):
                db.execute('INSERT INTO hrc_events(hrc_seq,stream_seq,ts,host_session_id,scope_ref,lane_ref,generation,category,event_kind,runtime_id,payload_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)',(e['hrcSeq'],e['hrcSeq'],e.get('ts',now),e.get('hostSessionId','hrc-server'),e.get('scopeRef','server:hrc'),e.get('laneRef','main'),e.get('generation',0),e.get('category','server'),e['eventKind'],e.get('runtimeId'),json.dumps(e.get('payload',{}),ensure_ascii=True)))
            db.execute("DELETE FROM sqlite_sequence WHERE name='hrc_events'")
            db.execute("INSERT INTO sqlite_sequence(name,seq) VALUES('hrc_events',?)",(state['head'],))
        # Durability is the fixture, not a daemon or an API response.
        with sqlite3.connect(self.path) as db:assert db.execute('SELECT ledger_incarnation_id FROM hrc_event_ledger_metadata WHERE id=1').fetchone()[0]==state['incarnation']

    def mirror(self,state,lock,outage=None):
        import copy
        previous=None
        def sync():
            nonlocal previous
            try:
                while not self.stopped:
                    with lock:current=copy.deepcopy(state)
                    if current.get('down'):
                        if outage:outage.set()
                        # Refuse admission while preserving the old durable rows.
                        with sqlite3.connect(self.path) as db:db.execute("INSERT OR IGNORE INTO hrc_migrations(id,applied_at) VALUES('native-fixture-unreadable','2026-01-01T00:00:00.000Z')")
                    else:
                        with sqlite3.connect(self.path) as db:db.execute("DELETE FROM hrc_migrations WHERE id='native-fixture-unreadable'")
                        fingerprint=json.dumps({k:current.get(k) for k in ('sessions','runtimes','events','head','incarnation')},sort_keys=True)
                        if fingerprint!=previous:self.replace(current);previous=fingerprint
                    time.sleep(.05)
            except Exception as e:self.failure=e
        self.replace(state);self.thread=threading.Thread(target=sync,daemon=True);self.thread.start()

    def argv(self,binary,root):return [str(binary),'--runtime-root',str(root),'--ledger-path',str(self.path)]
    def close(self):
        self.stopped=True
        if self.thread:self.thread.join(2)
        if self.failure:raise self.failure
