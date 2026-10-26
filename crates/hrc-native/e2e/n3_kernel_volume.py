#!/usr/bin/env python3
"""Real multi-turn ledger coverage by an unchanged kernel over owner restart.

Failure modes: replay/live or reconnect duplicates/gaps; kernel cursor advance
without applying its returned page; a weak three-event proof; restarting only
after the producer stopped. A transparent HTTP observer records the kernel's
actual pages. Its ingest.settled causes certify committed prefixes of those
pages, rather than treating a successful HTTP read as a projection commit.
"""
import argparse,http.server,json,queue,socket,socketserver,subprocess,threading,time
from pathlib import Path
from urllib.parse import parse_qs,urlsplit
from n3_scratch import Scratch,UnixHTTP

class Wire:
    def __init__(self,path):
        self.sock=socket.socket(socket.AF_UNIX);self.sock.settimeout(10);self.sock.connect(str(path));self.file=self.sock.makefile('rwb',buffering=0)
    def call(self,op,args=None):
        self.file.write((json.dumps({'id':op,'op':op,'args':args or {}})+'\n').encode());answer=json.loads(self.file.readline());assert answer.get('ok'),answer;return answer['result']
    def close(self):self.sock.close()

class Observer(socketserver.ThreadingMixIn,socketserver.UnixStreamServer):
    daemon_threads=True
    def __init__(self,path,scratch):
        self.scratch=scratch;self.pages=[];self.lock=threading.Lock()
        super().__init__(str(path),Forward)

class Forward(http.server.BaseHTTPRequestHandler):
    def do_GET(self):self.forward()
    def do_POST(self):self.forward()
    def log_message(self,*_):pass
    def forward(self):
        c=UnixHTTP(self.server.scratch.socket,30)
        try:
            body=self.rfile.read(int(self.headers.get('Content-Length','0')))
            c.request(self.command,self.path,body or None,{'Content-Type':'application/json'})
            response=c.getresponse()
            if urlsplit(self.path).path=='/v1/events/bounded-stream' and response.status==200:
                self.send_response(200);self.send_header('Content-Type','application/x-ndjson');self.end_headers()
                while line:=response.readline():self.wfile.write(line);self.wfile.flush()
                return
            data=response.read()
            if urlsplit(self.path).path=='/v1/events/page' and response.status==200:
                with self.server.lock:self.server.pages.append({'query':parse_qs(urlsplit(self.path).query),'response':json.loads(data)})
            self.send_response(response.status);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
        except (OSError,TimeoutError):
            # During replacement the unchanged kernel receives the same failed
            # read it would receive on the real daemon socket and retries it.
            try:self.send_error(503,'scratch owner unavailable')
            except OSError:pass
        finally:c.close()

class KernelCommits:
    def __init__(self,path):
        self.wire=Wire(path);self.events=[];self.failure=None
        self.wire.call('events.subscribe',{'after':0,'kinds':['ingest.settled']})
        self.wire.sock.settimeout(None)
        def read():
            try:
                while line:=self.wire.file.readline():self.events.append(json.loads(line))
            except OSError as error:self.failure=str(error)
        self.thread=threading.Thread(target=read,daemon=True);self.thread.start()
    def close(self):
        try:self.wire.sock.shutdown(socket.SHUT_RDWR)
        except OSError:pass
        self.thread.join(2);self.wire.close()

def committed_sequences(pages,events,start,incarnation):
    previous=start;seen=[];commits=[]
    for envelope in events:
        event=envelope.get('event',{});detail=event.get('detail') or {};cause=detail.get('cause')
        if detail.get('result')!='committed' or not cause:continue
        assert cause['source']=='hrc' and cause['incarnation']==incarnation,cause
        end=cause['seq'];assert end>previous,('duplicate/regressing committed prefix',previous,cause)
        candidates=[p for p in pages if p['query'].get('afterSeq')==[str(previous)] and p['query'].get('limit')==['200'] and any(r['hrcSeq']==end for r in p['response']['rows'])]
        assert candidates,('commit has no kernel page from its previous cursor',previous,end)
        seqs=[r['hrcSeq'] for r in candidates[-1]['response']['rows'] if r['hrcSeq']<=end]
        assert seqs and seqs==sorted(set(seqs)) and min(seqs)>previous,seqs
        seen.extend(seqs);commits.append({'after':previous,'through':end,'sequences':seqs,'receiptId':detail['receipt_id']});previous=end
    return seen,commits

def main():
    p=argparse.ArgumentParser();p.add_argument('--owner',choices=['bun','native'],required=True);p.add_argument('--kernel',type=Path,required=True)
    for k in ('binary','installed-release','aspd-socket','scratch-root','artifacts'):p.add_argument('--'+k,type=Path,required=True)
    a=p.parse_args();s=Scratch(a.scratch_root,a.installed_release,a.aspd_socket,a.binary,a.artifacts,project_id='n3-t11839');observer=None;commits=None
    try:
        s.init_substrate();owner=s.up(a.owner,'volume')
        proxy=s.root/'kernel-api.sock';observer=Observer(proxy,s);threading.Thread(target=observer.serve_forever,daemon=True).start()
        kernel_root=s.root/'kernel';kernel_root.mkdir();log=(a.artifacts/'kernel.log').open('w');s.logs.append(log)
        kernel=subprocess.Popen([str(a.kernel.resolve()),'--runtime-root',str(kernel_root),'--hrc-socket',str(proxy)],env=s.env,cwd=s.project,stdout=log,stderr=log);s.owners.append(kernel)
        socket_path=kernel_root/'hrc-kernel.sock';s.wait(socket_path.exists,30,'unchanged kernel ready');wire=Wire(socket_path)
        initial=wire.call('ingest.status',{'document_id':'hrc'})['bindings'][0]['cursor'];assert initial and 'seq' in initial,initial
        commits=KernelCommits(socket_path)
        scope='agent:tabularasa:project:n3-t11839:task:volume'
        birth=s.command('birth',['hrc','start',scope,'--no-viewer','--project-id',s.project_id,'--project-root',s.project,'--cwd',s.project,'--json','-p','Reply with exactly READY. No tools.'])
        rt=birth['runtime'];s.wait_completed(rt['runId']);receipts=[];restart=None
        for turn in range(3):
            before=s.rows('SELECT COALESCE(MAX(hrc_seq),0) AS n FROM hrc_events')[0]['n']
            prompt=f'Private stream coverage turn {turn}. Make exactly 32 separate Bash tool calls, sequentially, each running printf with the call number. Do not combine calls. After all 32 calls reply with exactly VOLUME_{turn}.'
            # The legacy headless enqueue door waits internally even with its
            # public wait=false. The turns door's accepted stage returns while
            # the producer is active, so the restart can overlap real traffic.
            status,receipt=s.http('POST','/v1/turns',{'hostSessionId':rt['hostSessionId'],'prompt':prompt,'waitFor':'accepted'})
            assert status==202 and receipt.get('admission')=='admitted' and receipt.get('stage')=='accepted',(status,receipt);receipts.append(receipt)
            if turn==1:
                s.wait(lambda:s.rows("SELECT COUNT(*) AS n FROM hrc_events WHERE hrc_seq>? AND event_kind='turn.tool_call'",(before,))[0]['n']>=3,180,'turn producing multiple tool calls')
                start=s.rows('SELECT MAX(hrc_seq) AS n FROM hrc_events')[0]['n']
                assert not s.rows("SELECT 1 FROM hrc_events WHERE run_id=? AND event_kind='turn.completed'",(receipt['runId'],)),'producer finished before restart'
                s.down(owner);owner=s.up(a.owner,'volume-restarted')
                restart={'beforeHrcSeq':start,'afterReattachHrcSeq':s.rows('SELECT MAX(hrc_seq) AS n FROM hrc_events')[0]['n'],'runId':receipt['runId']}
            s.wait_completed(receipt['runId'])
        rows=s.rows('SELECT hrc_seq,event_kind FROM hrc_events WHERE hrc_seq>? ORDER BY hrc_seq',(initial['seq'],));expected=[r['hrc_seq'] for r in rows]
        assert len(expected)>=200,('insufficient real event volume',len(expected))
        head=expected[-1]
        status=s.wait(lambda:(v if (v:=wire.call('ingest.status',{'document_id':'hrc'})['bindings'][0])['cursor']['seq']>=head else None),120,'kernel commit through real ledger head')
        s.wait(lambda:any(((e.get('event',{}).get('detail') or {}).get('cause') or {}).get('seq',-1)>=head for e in commits.events),15,'kernel settled receipt through ledger head')
        with observer.lock:pages=list(observer.pages)
        all_applied,ranges=committed_sequences(pages,commits.events,initial['seq'],initial['incarnation'])
        applied=[seq for seq in all_applied if seq<=head]
        assert applied==expected,('kernel projection sequence difference',sorted(set(expected)-set(applied)),sorted(set(applied)-set(expected)))
        assert len(applied)==len(set(applied)),('duplicate projection sequences',applied)
        assert restart and any(seq>restart['beforeHrcSeq'] for seq in applied),restart
        s.assert_no_duplicate_turn_messages()
        result={'pass':True,'owner':a.owner,'unchangedKernel':str(a.kernel),'bootstrapCursor':initial,'restart':restart,'ledgerSequences':expected,'kernelCommittedSequences':applied,'committedPrefixes':ranges,'finalKernelStatus':status,'turns':receipts}
        (a.artifacts/'result.json').write_text(json.dumps(result,indent=2)+'\n');(a.artifacts/'kernel-pages.json').write_text(json.dumps(pages,indent=2)+'\n');(a.artifacts/'kernel-events.json').write_text(json.dumps(commits.events,indent=2)+'\n')
        wire.close();print(json.dumps({'pass':True,'events':len(expected),'turns':3,'restartDuringTurn':True}))
    finally:
        if observer:
            with observer.lock:(a.artifacts/'kernel-pages.json').write_text(json.dumps(observer.pages,indent=2)+'\n')
        if commits:(a.artifacts/'kernel-events.json').write_text(json.dumps(commits.events,indent=2)+'\n')
        if observer:observer.shutdown();observer.server_close()
        if commits:commits.close()
        s.cleanup('agent:tabularasa:project:n3-t11839:task:')
if __name__=='__main__':main()
