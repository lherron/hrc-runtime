"""A transparent NDJSON proxy in front of the shared aspd that records every
request the daemon sends (one JSON line per frame in `log`). It forwards
bytes unchanged in both directions, so aspd answers exactly as it would.
"""
import json
import os
import socket
import threading


class AspdProxy:
    def __init__(self, listen, upstream, log):
        self.listen, self.upstream, self.log = str(listen), str(upstream), log
        self.lock = threading.Lock()
        if os.path.exists(self.listen):
            os.unlink(self.listen)
        self.server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.server.bind(self.listen)
        self.server.listen(16)
        threading.Thread(target=self.accept, daemon=True).start()

    def accept(self):
        while True:
            try:
                client, _ = self.server.accept()
            except OSError:
                return
            up = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            up.connect(self.upstream)
            threading.Thread(target=self.pump, args=(client, up, True), daemon=True).start()
            threading.Thread(target=self.pump, args=(up, client, False), daemon=True).start()

    def pump(self, src, dst, record):
        buffer = b''
        try:
            while True:
                chunk = src.recv(65536)
                if not chunk:
                    break
                dst.sendall(chunk)
                if record:
                    buffer += chunk
                    while b'\n' in buffer:
                        line, buffer = buffer.split(b'\n', 1)
                        try:
                            frame = json.loads(line)
                        except ValueError:
                            continue
                        with self.lock, open(self.log, 'a') as f:
                            f.write(json.dumps(frame) + '\n')
        except OSError:
            pass
        finally:
            for s in (src, dst):
                try:
                    s.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass

    def requests(self, method):
        if not os.path.exists(self.log):
            return []
        frames = [json.loads(l) for l in open(self.log) if l.strip()]
        return [f for f in frames if f.get('method') == method]

    def close(self):
        self.server.close()
