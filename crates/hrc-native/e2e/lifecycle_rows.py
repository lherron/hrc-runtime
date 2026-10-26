#!/usr/bin/env python3
"""Compare real boot/stop ledger rows over clean, malformed and foreign history.

Failure modes: classifying a foreign/retained fact as the predecessor; unsafe
numeric PIDs; wrong sentinels/category; claiming clean stop without initiation;
changing seeded history; a matching empty ledger passing a comparison.
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT/'crates/hrc-cli/e2e'))
from copied_release import copied_bun_cli, preflight_unmanaged
from metrics_isolation import isolated_suite
from foundation import UnixHTTP


@isolated_suite
def main():
    p = argparse.ArgumentParser()
    for flag in ('binary', 'oracle', 'environment', 'artifacts'):
        p.add_argument('--'+flag, type=Path, required=True)
    p.add_argument('--boot-only', action='store_true')
    a = p.parse_args()
    a.artifacts.mkdir(parents=True, exist_ok=True)
    source = json.loads(a.environment.read_text())
    assert source['HRC_WRKQ_DB'].startswith('rpc://127.0.0.1:')
    assert str(a.environment.resolve()).startswith('/private/tmp/n5-server-owned-11819/')
    env = {k:v for k,v in os.environ.items() if not k.startswith(('ASP_', 'HRC_', 'WRKQ', 'HARNESS_BROKER_'))}
    env.update(source)
    env.pop('XPC_SERVICE_NAME', None)
    env.pop('HRC_LAUNCHD_LABEL', None)
    cases = []
    with tempfile.TemporaryDirectory(prefix='r-', dir='/tmp/n5-server-owned-11819') as tmp:
        root = Path(tmp)
        env['HRC_RUNTIME_DIR'] = str(root/'run')
        oracle = copied_bun_cli(a.oracle, root/'release')
        bun = shutil.which('bun')
        proc = None
        def status():
            h = UnixHTTP(root/'run/hrc.sock')
            h.request('GET', '/v1/status')
            r = h.getresponse()
            value = json.loads(r.read())
            h.close()
            assert r.status == 200, value
            return value
        def up(owner, state, name):
            nonlocal proc
            child_env = dict(env, HRC_STATE_DIR=str(state))
            if owner == 'bun':
                preflight_unmanaged(oracle, child_env, a.artifacts/(name+'-preflight.json'))
            log = (a.artifacts/(name+'-'+owner+'.log')).open('w')
            command = [bun,str(oracle)] if owner == 'bun' else [str(a.binary.resolve())]
            proc = subprocess.Popen(command+['server','serve'],env=child_env,cwd=root,
                                    stdin=subprocess.DEVNULL,stdout=log,stderr=log)
            log.close()
            for _ in range(200):
                assert proc.poll() is None, (owner,'daemon exited; see log')
                try:
                    value = status()
                    assert value['runtimeRoot'] == str(root/'run')
                    if owner == 'bun':assert value['release']['mode'] != 'atomic'
                    return value
                except (OSError,json.JSONDecodeError):pass
                time.sleep(.05)
            raise AssertionError('owned daemon failed to start')
        def down():
            if proc is not None and proc.poll() is None:
                proc.terminate()
                proc.wait(timeout=15)
        def rows(db):
            with sqlite3.connect('file:'+str(db)+'?mode=ro',uri=True) as c:
                c.row_factory = sqlite3.Row
                return [dict(r) for r in c.execute("SELECT * FROM hrc_events WHERE scope_ref='server:hrc' ORDER BY hrc_seq")]
        def seed(db, records):
            with sqlite3.connect(db) as c:
                c.execute('DELETE FROM hrc_events')
                c.execute("DELETE FROM sqlite_sequence WHERE name='hrc_events'")
                for i, (kind,payload,source,evidence) in enumerate(records,1):
                    c.execute("INSERT INTO hrc_events(hrc_seq,stream_seq,ts,host_session_id,scope_ref,lane_ref,generation,category,event_kind,payload_json,source_ref,origin_seq,evidence_origin) VALUES (?,?,'2020-01-01T00:00:00.000Z','hrc-server','server:hrc','main',0,'server',?,?,?,?,?)",
                              (i,i,kind,json.dumps(payload),source,1 if source else None,evidence))
                c.execute('UPDATE event_stream_cursor SET next_seq=? WHERE id=1',(len(records)+1,))
        def normalized(observed, owned_pid, started_at, seed_count):
            sequences = {row['hrc_seq']: i+1 for i,row in enumerate(observed)}
            out = []
            for i,row in enumerate(observed):
                row = dict(row)
                payload = json.loads(row.pop('payload_json'))
                assert row['host_session_id']=='hrc-server' and row['scope_ref']=='server:hrc'
                assert row['lane_ref']=='main' and type(row['generation']) is int and row['generation']==0
                if i >= seed_count:
                    assert row['category']=='server'
                    assert all(row[k] is None for k in ('runtime_id','run_id','transport','error_code','source_ref','origin_seq','evidence_origin'))
                    assert row['hrc_seq']==row['stream_seq']
                    if row['event_kind'] in ('server.started','server.shutting_down','server.stopped'):
                        assert payload['pid']==owned_pid
                        payload['pid']='<owner pid>'
                    if row['event_kind']=='server.started':
                        assert payload['processStartedAt']==started_at
                        assert payload['release'] is None and payload['sourceCommit'] is None
                        assert payload['storeSchema']=='0127_permission_audit_removal'
                        payload['processStartedAt']='<owner startedAt>'
                    if row['event_kind']=='server.stopped':
                        seq = payload['shuttingDownHrcSeq']
                        assert any(r['hrc_seq']==seq and r['event_kind']=='server.shutting_down' for r in observed)
                        payload['shuttingDownHrcSeq']=sequences[seq]
                    row['ts']='<fact timestamp>'
                row['hrc_seq']=sequences[row['hrc_seq']]
                row['stream_seq']=row['hrc_seq']
                row['payload']=payload
                out.append(row)
            return out
        try:
            bootstrap=root/'bootstrap'
            up('bun',bootstrap,'bootstrap')
            down()
            snapshot=root/'schema.sqlite'
            with sqlite3.connect(bootstrap/'state.sqlite') as src,sqlite3.connect(snapshot) as dst:src.backup(dst)
            variants={
                'empty':[],
                'clean':[('server.stopped',{'pid':3133700,'grant':None,'ungranted':True},None,None)],
                'clean-legacy':[('server.stopped',{'pid':3133700,'requestedBy':'agent:mable:project:n5-t11819:task:primary','requestedReason':'owned prior legacy stop'},None,None)],
                'clean-grant':[('server.stopped',{'pid':3133700,'grant':{'requestedBy':'agent:mable:project:n5-t11819:task:primary','reason':'owned prior grant'}},None,None)],
                'unclosed-start':[('server.started',{'pid':3133700},None,None)],
                'unclosed-shutdown':[('server.shutting_down',{'pid':3133700},None,None)],
                'unattributed':[('server.previous_exit_unattributed',{'previousPid':3133700},None,None)],
                'unsafe-pid':[('server.started',{'pid':9007199254740992},None,None)],
                'nonobject':[('server.started',['not a record'],None,None)],
                'foreign-latest':[('server.started',{'pid':3133700},None,None),('server.stopped',{'pid':4141400},'node:foreign',None)],
                'retained-latest':[('server.started',{'pid':3133700},None,None),('server.stopped',{'pid':4141400},None,'retained')],
            }
            for name,records in variants.items():
                observed=[]
                for owner in ('bun','native'):
                    state=root/(name+'-'+owner)
                    state.mkdir()
                    db=state/'state.sqlite'
                    with sqlite3.connect(snapshot) as src,sqlite3.connect(db) as dst:src.backup(dst)
                    seed(db,records)
                    before=rows(db)
                    live=up(owner,state,name)
                    live_rows=rows(db)
                    down()
                    after=rows(db)
                    (a.artifacts/(name+'-'+owner+'.json')).write_text(json.dumps(dict(before=before,live=live_rows,after=after,status=live,pid=proc.pid),indent=2)+'\n')
                    assert before==after[:len(before)],'boot or stop changed seeded history'
                    assert live_rows and live_rows[-1]['event_kind']=='server.started','missing new boot fact'
                    assert len(live_rows)>len(records),'only historical rows were observed'
                    assert live['lastRestart']['at']==live_rows[-1]['ts']
                    if not a.boot_only:
                        assert after[-1]['event_kind']=='server.stopped','missing durable completed stop'
                        assert after[-2]['event_kind']=='server.shutting_down'
                    restart=dict(live['lastRestart'],at='<boot fact ts>')
                    observed.append(dict(rows=normalized(live_rows if a.boot_only else after,proc.pid,live['startedAt'],len(records)),lastRestart=restart))
                good=observed[0]==observed[1]
                cases.append(dict(case=name,oracle=observed[0],subject=observed[1],**{'pass':good}))
                assert good, name
        finally:
            down()
            report=dict(mode='boot-only' if a.boot_only else 'boot-and-clean-stop',cases=cases,**{'pass':len(cases)==11 and all(c['pass'] for c in cases)},cleanup=dict(socketAbsent=not(root/'run/hrc.sock').exists(),lockAbsent=not(root/'run/server.lock').exists()))
            (a.artifacts/'results.json').write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps(dict(pass_=report['pass'],cases=len(cases))))
    return int(not report['pass'])


if __name__=='__main__':raise SystemExit(main())
