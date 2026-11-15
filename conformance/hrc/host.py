"""An isolated rusthrc host for cardo's imported suites. No upstream fakes needed:
HRC declares only owner operations, and the generic suite doesn't birth seats.
"""
import os
from pathlib import Path
import signal
import subprocess


class Host:
    def __init__(self, binary, root, log):
        self.binary, self.root, self.log = Path(binary), Path(root), Path(log)
        self.runtime = self.root / 'run/hrc'
        self.socket = self.runtime / 'kernel.sock'
        self.record = self.root / 'run/cardo/kernels/hrc.json'
        self.process = self.output = None

    def start(self):
        self.runtime.mkdir(parents=True, exist_ok=True)
        self.log.parent.mkdir(parents=True, exist_ok=True)
        env = {k: v for k, v in os.environ.items() if not k.startswith(
            ('HARNESS', 'TMUX', 'HRC_', 'AGENT', 'ASP_', 'CLAUDE', 'CODEX', 'WRKQ', 'XPC_SERVICE_NAME'))}
        env.update(HRC_RUNTIME_DIR=str(self.runtime), HRC_STATE_DIR=str(self.root / 'state'),
                   HRC_WRKQ_DB=str(self.root / 'private-wrkq.sqlite'), HRC_ASPD_SOCKET=str(self.root / 'absent-aspd.sock'),
                   HRC_PEER_CONFIG_FILE=str(self.root / 'absent-federation.json'), HRC_ACP_WEBHOOK_URL='')
        self.output = self.log.open('a')
        self.process = subprocess.Popen([str(self.binary), 'server'], env=env, stdout=self.output, stderr=self.output)
        return self.process

    def stop(self, process=None):
        process = process or self.process
        if process and process.poll() is None:
            process.send_signal(signal.SIGTERM)
            process.wait(timeout=30)
        if self.output:
            self.output.close()
