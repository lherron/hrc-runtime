#!/usr/bin/env python3
"""Linux fixture daemon proof for idle monitor wait/watch.

Counts actual SQLite opens with an LD_PRELOAD observer (never a production
counter). A control binary must poll; the changed binary must stay at zero.
Also drives committed events, backlog, message responses, deadlines and gaps.
Run on build1; no installed service or model calls are involved.
"""
import argparse
import http.server
import http.client
import socket
import json
import os
from pathlib import Path
import queue
import socketserver
import sqlite3
import subprocess
import tempfile
import threading
import time
import urllib.parse

ROOT = Path(__file__).resolve().parents[3]
SCOPE = 'agent:idlefixture:project:hrc-runtime'
OBSERVER = r'''
#define _GNU_SOURCE
#include <dlfcn.h>
#include <fcntl.h>
#include <stdarg.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/syscall.h>
static void note(const char *path) {
 const char *db=getenv("IDLE_DB"), *log=getenv("IDLE_OPENS");
 if(db && log && !strcmp(path,db)) {
  int fd=syscall(SYS_openat,AT_FDCWD,log,O_WRONLY|O_CREAT|O_APPEND,0600);
  if(fd>=0){write(fd,"open\n",5);close(fd);}
 }
}
int open64(const char *p,int flags,...) {
 mode_t mode=0; if(flags&O_CREAT){va_list a;va_start(a,flags);mode=va_arg(a,int);va_end(a);}
 int (*real)(const char*,int,...)=dlsym(RTLD_NEXT,"open64");note(p);return real(p,flags,mode);
}
int open(const char *p,int flags,...) {
 mode_t mode=0; if(flags&O_CREAT){va_list a;va_start(a,flags);mode=va_arg(a,int);va_end(a);}
 int (*real)(const char*,int,...)=dlsym(RTLD_NEXT,"open");note(p);return real(p,flags,mode);
}
'''


class Server(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True


class Fixture:
    def __init__(self, root, binary):
        self.root, self.queues, self.requests = root, [], []
        self.lock = threading.Lock()
        self.db = root / 'state.sqlite'
        subprocess.run([str(binary.resolve()), 'store', 'migrate', str(self.db)], cwd=ROOT, check=True, capture_output=True)
        self.conn = sqlite3.connect(self.db)
        self.incarnation = self.conn.execute('SELECT ledger_incarnation_id FROM hrc_event_ledger_metadata').fetchone()[0]
        now = '2026-11-04T19:00:00.000Z'
        self.conn.execute('INSERT INTO sessions(host_session_id,scope_ref,lane_ref,generation,status,created_at,updated_at) VALUES (?,?,?,1,?,?,?)', ('host', SCOPE, 'main', 'active', now, now))
        self.conn.execute("INSERT INTO runtimes(runtime_id,host_session_id,scope_ref,lane_ref,generation,transport,status,supports_inflight_input,created_at,updated_at,status_changed_at) VALUES ('rt','host',?,'main',1,'tmux','ready',0,?,?,?)", (SCOPE, now, now, now))
        self.conn.execute("INSERT INTO continuities(scope_ref,lane_ref,active_host_session_id,updated_at,scope_kind,agent_id,project_id) VALUES (?,'main','host',?,'agent','idlefixture','hrc-runtime')", (SCOPE, now))
        self.conn.execute("INSERT INTO messages(message_id,created_at,kind,phase,from_kind,from_ref,to_kind,to_ref,root_message_id,body,body_format,execution_state,session_ref,host_session_id,generation,runtime_id) VALUES ('request',?,'dm','request','entity','a','entity','b','request','hello','text/plain','started',?,'host',1,'rt')", (now, SCOPE+'/lane:main'))
        self.conn.commit()
        fixture = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                assert self.path == '/v1/runtimes/inspect', self.path
                self.rfile.read(int(self.headers['Content-Length']))
                body = json.dumps(dict(runtimeId='rt',hostSessionId='host',scopeRef=SCOPE,laneRef='main',generation=1,transport='tmux',status='ready')).encode()
                self.send_response(200)
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self):
                url = urllib.parse.urlsplit(self.path)
                with fixture.lock:
                    fixture.requests.append(self.path)
                if url.path == '/v1/status':
                    body = json.dumps(dict(dbPath=str(fixture.db), sessionCount=1, runtimeCount=1)).encode()
                    self.send_response(200)
                    self.send_header('Content-Length', str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
                    return
                assert url.path == '/v1/events/bounded-stream', self.path
                query = urllib.parse.parse_qs(url.query)
                assert query['ledgerIncarnationId'] == [fixture.incarnation]
                after = int(query['afterSeq'][0])
                q = queue.Queue()
                with fixture.lock:
                    fixture.queues.append(q)
                self.send_response(200)
                self.end_headers()
                try:
                    self.wfile.write(json.dumps(dict(type='ready', ledgerIncarnationId=fixture.incarnation, acceptedAfterHrcSeq=after, replayHeadHrcSeq=after)).encode()+b'\n')
                    self.wfile.flush()
                    while True:
                        try:
                            item = q.get(timeout=.05)
                        except queue.Empty:
                            item = b'\n'  # Heartbeats must never open SQLite.
                        if item is None:
                            return
                        self.wfile.write(item)
                        self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError):
                    pass
                finally:
                    with fixture.lock:
                        fixture.queues.remove(q)

            def log_message(self, *args):
                pass

        self.server = Server(str(root/'hrc.sock'), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def broadcast(self, value):
        wire = None if value is None else json.dumps(value).encode()+b'\n'
        with self.lock:
            for q in self.queues:
                q.put(wire)

    def event(self, kind='turn.started', notify=True):
        now = '2026-11-04T19:01:00.000Z'
        seq = self.conn.execute('UPDATE event_stream_cursor SET next_seq=next_seq+1 WHERE id=1 RETURNING next_seq-1').fetchone()[0]
        payload = {}
        if kind == 'message.response':
            payload = dict(messageId='response', replyToMessageId='request', rootMessageId='request', messageSeq=2, createdAt=now, execution=dict(sessionRef=SCOPE+'/lane:main', hostSessionId='host', runtimeId='rt', generation=1), body='done')
            self.conn.execute("INSERT INTO messages(message_id,created_at,kind,phase,from_kind,from_ref,to_kind,to_ref,reply_to_message_id,root_message_id,body,body_format,execution_state,session_ref,host_session_id,generation,runtime_id) VALUES ('response',?,'dm','response','entity','b','entity','a','request','request','done','text/plain','completed',?,'host',1,'rt')", (now, SCOPE+'/lane:main'))
        cur = self.conn.execute("INSERT INTO hrc_events(stream_seq,ts,host_session_id,scope_ref,lane_ref,generation,runtime_id,category,event_kind,replayed,payload_json) VALUES (?,?,'host',?,'main',1,'rt',?,?,0,?)", (seq, now, SCOPE, 'message' if kind == 'message.response' else 'turn', kind, json.dumps(payload)))
        self.conn.commit()
        if notify:
            self.broadcast(dict(type='event', ledgerIncarnationId=self.incarnation, event=dict(hrcSeq=cur.lastrowid)))


def lag_snapshot(binary, root, artifacts, interval=1000):
    """Check the reported resolution on an actual debug owner, isolated from live."""
    (root/'state').mkdir(parents=True)
    (root/'run').mkdir()
    subprocess.run([str(binary.resolve()), 'store', 'migrate', str(root/'state/state.sqlite')], cwd=ROOT, check=True, capture_output=True)
    prefixes = ('HRC_', 'HARNESS', 'AGENT', 'ASP_', 'CLAUDE', 'CODEX', 'WRKQ', 'TMUX', 'XPC_SERVICE_NAME')
    env = {k:v for k,v in os.environ.items() if not k.startswith(prefixes)}
    env.update(HRC_RUNTIME_DIR=str(root/'run'), HRC_STATE_DIR=str(root/'state'), HRC_WRKQ_DB=str(root/'private-wrkq.sqlite'), HRC_LAUNCHD_LABEL='fixture.idle')
    with (artifacts/'lag-owner.log').open('w') as log:
        proc = subprocess.Popen([str(binary.resolve()), 'server'], env=env, stdout=log, stderr=log)
        try:
            for _ in range(100):
                assert proc.poll() is None, (artifacts/'lag-owner.log').read_text()
                if (root/'run/hrc.sock').exists():
                    break
                time.sleep(.05)
            time.sleep(1.1)
            conn = http.client.HTTPConnection('localhost', timeout=5)
            conn.sock = socket.socket(socket.AF_UNIX)
            conn.sock.settimeout(5)
            conn.sock.connect(str(root/'run/hrc.sock'))
            conn.request('GET', '/v1/status?includeSessions=false')
            response = conn.getresponse()
            status = json.loads(response.read())
            conn.close()
            assert response.status == 200, status
            lag = status['eventLoop']
            assert lag['intervalMs'] == interval and lag['stallThresholdMs'] == 1000, lag
            assert 'maxLagAt' in lag, lag
            (artifacts/'lag-status.json').write_text(json.dumps(lag, indent=2)+'\n')
        finally:
            proc.terminate()
            proc.wait(timeout=10)


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--binary', type=Path, required=True)
    p.add_argument('--artifacts', type=Path, required=True)
    p.add_argument('--expect-polling', action='store_true')
    args = p.parse_args()
    args.artifacts.mkdir(parents=True, exist_ok=True)
    results = []
    with tempfile.TemporaryDirectory(prefix='hrc-idle-') as scratch:
        scratch = Path(scratch)
        (scratch/'observer.c').write_text(OBSERVER)
        subprocess.run(['cc', '-shared', '-fPIC', '-o', str(scratch/'observer.so'), str(scratch/'observer.c'), '-ldl'], check=True)
        cases = ['event'] if args.expect_polling else ['event', 'timeout', 'stall', 'backlog', 'response', 'gap', 'reconnect', 'replaced', 'watch', 'response-watch', 'watch-condition', 'watch-no-follow-condition']
        for name in cases:
            root = scratch/name
            root.mkdir()
            fixture = Fixture(root, args.binary)
            if name == 'response':
                for _ in range(5):
                    fixture.event('turn.message', notify=False)
            log = root/'opens'
            env = dict(os.environ, HRC_RUNTIME_DIR=str(root), HRC_STATE_DIR=str(root), IDLE_DB=str(fixture.db), IDLE_OPENS=str(log), LD_PRELOAD=str(scratch/'observer.so'))
            argv = ['monitor', 'wait', 'scope:'+SCOPE, '--until', 'busy', '--timeout', '5s', '--json']
            if name == 'response':
                argv = ['monitor', 'wait', 'msg:request', '--until', 'response', '--timeout', '5s', '--json']
            if name in ('watch', 'response-watch'):
                argv = ['monitor', 'watch', 'scope:'+SCOPE, '--follow', '--forever', '--timeout', '1700ms', '--json']
            if name == 'response-watch':
                argv[2] = 'msg:request'
            if name in ('watch-condition', 'watch-no-follow-condition'):
                argv = ['monitor', 'watch', 'scope:'+SCOPE, '--until', 'busy', '--timeout', '5s', '--json']
                if name == 'watch-condition':
                    argv += ['--follow']
            if name == 'timeout':
                argv[argv.index('5s')] = '1700ms'
            if name == 'stall':
                argv += ['--stall-after', '1700ms']
            proc = subprocess.Popen([str(args.binary.resolve())]+argv, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            time.sleep(.3)
            assert proc.poll() is None, proc.communicate()
            assert log.exists(), 'observer must see startup store open'
            before = len(log.read_text().splitlines())
            time.sleep(1)
            idle_opens = len(log.read_text().splitlines())-before
            trigger = time.monotonic()
            if name == 'backlog':
                for _ in range(300):
                    fixture.event('turn.message', notify=False)
                fixture.event()
            elif name in ('response', 'response-watch'):
                fixture.event('message.response')
            elif name == 'gap':
                fixture.event(notify=False)
                fixture.broadcast(dict(type='gap', beforeHrcSeq=1, reason='live_queue'))
            elif name == 'reconnect':
                fixture.broadcast(None)
                time.sleep(.2)
                fixture.event()
            elif name == 'replaced':
                fixture.broadcast(dict(type='ledger_replaced'))
            elif name in ('event', 'watch', 'watch-condition', 'watch-no-follow-condition'):
                fixture.event()
            out, err = proc.communicate(timeout=8)
            latency = (time.monotonic()-trigger)*1000
            expected = 20 if name in ('timeout', 'watch', 'response-watch') else 21 if name == 'stall' else 23 if name == 'replaced' else 0
            assert proc.returncode == expected, (name, proc.returncode, out, err)
            assert idle_opens >= 8 if args.expect_polling else idle_opens == 0, (name, idle_opens)
            if name in ('event', 'response', 'gap'):
                assert latency < 150, (name, latency)
            if name == 'watch':
                assert 'turn.started' in out, out
            if name == 'response-watch':
                assert sum(json.loads(line).get('event') == 'message.response' for line in out.splitlines()) == 1, out
            result = dict(case=name, idleWindowMs=1000, idleSqliteOpens=idle_opens, latencyMs=round(latency, 2), exit=proc.returncode, stdout=out, stderr=err, requests=fixture.requests)
            results.append(result)
            (args.artifacts/'result.json').write_text(json.dumps(dict(passAll=False, cases=results), indent=2)+'\n')
            print(json.dumps({k:v for k,v in result.items() if k not in ('stdout','stderr','requests')}), flush=True)
            fixture.server.shutdown()
            fixture.server.server_close()
            fixture.conn.close()
        lag_snapshot(args.binary, scratch/'lag-owner', args.artifacts, 250 if args.expect_polling else 1000)
    (args.artifacts/'result.json').write_text(json.dumps(dict(passAll=True, cases=results), indent=2)+'\n')


if __name__ == '__main__':
    main()
