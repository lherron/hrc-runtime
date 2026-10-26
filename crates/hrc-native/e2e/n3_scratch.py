"""N3 scratch guard on the shared copied-release helper.

Broker hook addresses are daemon-process identity too. A headless broker must
never inherit this task seat's live observer/callback socket from the shell.
"""
import json,os,secrets,socket,subprocess,time,datetime
from n2_scratch import Scratch as BaseScratch,UnixHTTP
class Scratch(BaseScratch):
    def __init__(self,*args,**kwargs):
        super().__init__(*args,**kwargs)
        for key in list(self.env):
            if key.startswith('HARNESS_') or key in ('TMUX','TMUX_PANE'):
                del self.env[key]

    def up(self,kind,tag):
        self.current_owner=kind
        return super().up(kind,tag)

    def command(self,*args,**kwargs):
        try:return super().command(*args,**kwargs)
        except AssertionError as error:
            if 'launch-carried submission identity timed out' in str(error):
                load=subprocess.run(['sysctl','-n','vm.loadavg'],capture_output=True,text=True)
                event={'time':datetime.datetime.now(datetime.timezone.utc).isoformat(),'owner':getattr(self,'current_owner','unknown'),'load':load.stdout.strip(),'bipcPath':str(self.root/'run/bipc'),'command':str(args[0]) if args else 'unknown'}
                (self.artifacts/'birth-flake.json').write_text(json.dumps(event,indent=2)+'\n')
            raise

    def init_substrate(self):
        super().init_substrate()
        catalog=self.root/'hook-catalog.json'
        catalog.write_text(json.dumps({'schemaVersion':'wrkf.hook-catalog.v0','hooks':{},'effectHandlers':{}}))
        token=secrets.token_hex(32)
        token_file=self.root/'wrkqd-token'
        token_file.write_text(token+'\n');token_file.chmod(0o600)
        # Keep the scratch listener outside the fleet's standard daemon ports.
        for _ in range(100):
            port=30001+secrets.randbelow(30000)
            probe=socket.socket()
            try: probe.bind(('127.0.0.1',port));break
            except OSError: pass
            finally: probe.close()
        env={**self.env,'WRKQ_DB':str(self.root/'wrkq.db'),'WRKF_HOOK_CATALOG':str(catalog),'WRKQD_TOKEN':token}
        log=(self.artifacts/'wrkqd.log').open('w');self.logs.append(log)
        proc=subprocess.Popen(['wrkqd','-addr',f'127.0.0.1:{port}','-db',str(self.root/'wrkq.db')],env=env,cwd=self.project,stdout=log,stderr=log)
        self.owners.append(proc)
        self.env.update(HRC_WRKQ_DB=f'rpc://127.0.0.1:{port}',WRKQ_DB=f'rpc://127.0.0.1:{port}',HRC_WRKQD_TOKEN_FILE=str(token_file),WRKQD_TOKEN_FILE=str(token_file),WRKQD_TOKEN='')
        for _ in range(100):
            assert proc.poll() is None,'private wrkqd exited'
            try:
                with socket.create_connection(('127.0.0.1',port),timeout=.1):break
            except OSError:time.sleep(.1)
        projects=self.command('verify-private-authority',['wrkq','projects','--json'])
        assert any(p.get('slug')==self.project_id or p.get('path')==self.project_id for p in projects),projects
        self.authority={'locator':self.env['HRC_WRKQ_DB'],'dbPath':str(self.root/'wrkq.db'),'pid':proc.pid,'port':port}
        (self.artifacts/'authority.json').write_text(json.dumps(self.authority,indent=2)+'\n')

    def assert_no_duplicate_turn_messages(self):
        # Mable: aspd's Stop-fallback fix is live for births after 08:39Z.
        duplicates=self.rows("SELECT e.runtime_id,e.run_id,e.payload_json,COUNT(*) AS count FROM hrc_events e JOIN runtimes r ON r.runtime_id=e.runtime_id WHERE e.event_kind='turn.message' AND e.source_ref IS NULL AND julianday(r.created_at)>=julianday('2026-10-26T08:39:00Z') GROUP BY e.runtime_id,(SELECT MAX(t.hrc_seq) FROM hrc_events t WHERE t.runtime_id=e.runtime_id AND t.event_kind='turn.started' AND t.hrc_seq<=e.hrc_seq),e.payload_json HAVING COUNT(*)>1")
        assert not duplicates,('post-fix duplicate turn.message',duplicates)
