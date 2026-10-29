"""Minimal client for hrc-pty's ops socket (JSON-RPC over NDJSON), for the e2e."""
import base64
import json
import os
import socket
import subprocess
import threading
import time


class Ops:
    def __init__(self, sock_path, token):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.connect(sock_path)
        self.file = self.sock.makefile("rwb")
        self.next_id = 1
        self.call("hello", {"token": token})

    def call(self, method, params=None):
        frame_id = self.next_id
        self.next_id += 1
        frame = {"jsonrpc": "2.0", "id": frame_id, "method": method, "params": params or {}}
        self.file.write(json.dumps(frame).encode() + b"\n")
        self.file.flush()
        while True:
            line = self.file.readline()
            if not line:
                raise RuntimeError(f"{method}: connection closed")
            reply = json.loads(line)
            if reply.get("id") != frame_id:
                continue
            if "error" in reply:
                raise RpcError(method, reply["error"])
            return reply["result"]

    def input(self, data: bytes):
        return self.call("input", {"bytes": base64.b64encode(data).decode()})

    def close(self):
        self.sock.close()


class RpcError(Exception):
    def __init__(self, method, error):
        super().__init__(f"{method}: {error.get('message')}")
        self.error = error


class Events:
    """Collects the `events` push stream in a background thread."""

    def __init__(self, sock_path, token, log_path=None):
        self.ops = Ops(sock_path, token)
        self.ops.call("events")
        self.items = []
        self.log = open(log_path, "a") if log_path else None
        self.cond = threading.Condition()
        threading.Thread(target=self._run, daemon=True).start()

    def _run(self):
        for line in self.ops.file:
            frame = json.loads(line)
            frame["receivedAt"] = time.time()
            with self.cond:
                self.items.append(frame)
                if self.log:
                    self.log.write(json.dumps(frame) + "\n")
                    self.log.flush()
                self.cond.notify_all()

    def wait_for(self, method, timeout=10, after=0):
        deadline = time.time() + timeout
        with self.cond:
            while True:
                for item in self.items[after:]:
                    if item.get("method") == method:
                        return item
                left = deadline - time.time()
                if left <= 0:
                    raise TimeoutError(f"no {method} event in {timeout}s")
                self.cond.wait(left)


def serve(binary, ipc_dir, cols=120, rows=40, broker_argv=None, extra=None):
    """Start `hrc-pty serve` (it daemonizes and prints its pid once bound)."""
    os.makedirs(ipc_dir, exist_ok=True)
    token_path = os.path.join(ipc_dir, "attach.token")
    if not os.path.exists(token_path):
        with open(token_path, "w") as f:
            f.write(base64.b16encode(os.urandom(16)).decode().lower())
        os.chmod(token_path, 0o600)
    args = [binary, "serve", "--socket", os.path.join(ipc_dir, "hrcpty.sock"),
            "--cols", str(cols), "--rows", str(rows), "--runtime-id", "e2e",
            "--broker-stderr", os.path.join(ipc_dir, "broker.err")] + (extra or [])
    if broker_argv:
        args += ["--broker-argv"] + broker_argv
    out = subprocess.run(args, capture_output=True, text=True, timeout=20)
    if out.returncode != 0:
        raise RuntimeError(f"serve failed: {out.stderr}")
    return int(out.stdout.strip()), open(token_path).read().strip()


def pid_alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False


def wait_until(predicate, timeout=10, interval=0.1):
    deadline = time.time() + timeout
    while time.time() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(interval)
    return predicate()


def surface_id(created):
    """The terminal id from `ghostmux new --json`, whatever its nesting."""
    for key in ("id", "uuid"):
        if isinstance(created.get(key), str):
            return created[key]
    for value in created.values():
        if isinstance(value, dict):
            found = surface_id(value)
            if found:
                return found
    return None
