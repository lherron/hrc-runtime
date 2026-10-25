#!/usr/bin/env python3
"""Real ASP declaration workflow; no broker or model starts.

Failures to fence: missing/invalid endpoint, incompatible hello, absent profile,
invalid request, producer refusal, and accidental hosting during observation.
The transport's protocol tests are supplied by the real installed aspd.
"""
import argparse
import http.client
import json
import os
from pathlib import Path
import socket
import sqlite3
import subprocess
import tempfile
import time


class UnixHTTP(http.client.HTTPConnection):
    def __init__(self, path):
        super().__init__('localhost', timeout=90)
        self.path = path

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX)
        self.sock.settimeout(self.timeout)
        self.sock.connect(str(self.path))


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--binary', type=Path, required=True)
    p.add_argument('--aspd-socket', type=Path, required=True)
    p.add_argument('--artifacts', type=Path, required=True)
    args = p.parse_args()
    args.artifacts.mkdir(parents=True, exist_ok=True)
    observations = []
    repo = Path(__file__).resolve().parents[3]
    with tempfile.TemporaryDirectory(prefix='n1-asp-', dir='/tmp') as tmp:
        root = Path(tmp)
        agent = root / 'agents/tabularasa'
        agent.mkdir(parents=True)
        (agent / 'agent-profile.toml').write_text('version = 4\n[identity]\ndisplay = "N1"\n[provisioning]\nharness = "claude"\n[spaces]\nbase = []\n')
        project = root / 'n1-asp-test'
        project.mkdir()
        state = root / 'state'
        state.mkdir()
        subprocess.run(['bun', '-e',
            'import {openHrcDatabase} from "./packages/hrc-store-sqlite/src/database.ts";openHrcDatabase(process.argv[1]).close()',
            str(state / 'state.sqlite')], cwd=repo, capture_output=True, check=True)
        env = dict(os.environ, HRC_RUNTIME_DIR=str(root / 'run'), HRC_STATE_DIR=str(state),
                   HRC_ASPD_SOCKET=str(args.aspd_socket.resolve()), ASP_AGENTS_ROOT=str(root / 'agents'),
                   ASP_PROJECT_ROOT_OVERRIDE=str(project))
        env.pop('HRC_PEER_CONFIG_FILE', None)
        log = (args.artifacts / 'serve.log').open('w')
        proc = subprocess.Popen([args.binary.resolve(), 'server'], env=env, stdout=log, stderr=log)
        sock = root / 'run/hrc.sock'
        def request(path, body):
            c = UnixHTTP(sock)
            c.request('POST', path, json.dumps(body), {'Content-Type': 'application/json'})
            res = c.getresponse()
            value = json.loads(res.read())
            c.close()
            observations.append({'path': path, 'body': body, 'status': res.status, 'response': value})
            return res.status, value
        try:
            for _ in range(100):
                if proc.poll() is not None:
                    raise AssertionError('daemon exited')
                if sock.exists():
                    break
                time.sleep(.05)
            body = {'agentId': 'tabularasa', 'agentRoot': str(agent), 'projectId': 'n1-asp-test',
                    'projectRoot': str(project), 'cwd': str(project), 'agentSources': {'agentsRoot': str(root / 'agents')},
                    'preferredMode': 'headless', 'interactive': False, 'initialPrompt': 'Reply OK. No tools.'}
            status, answer = request('/v1/declarations/resolve', body)
            assert status == 200, answer
            assert answer['intent']['harness'] == {'interactive': False}, answer
            assert answer['intent']['execution'] == {'preferredMode': 'headless'}, answer
            assert Path(answer['intent']['placement']['agentRoot']).resolve() == agent.resolve()
            assert answer['intent']['initialPrompt'] == body['initialPrompt']
            assert answer['declaration']['source']['agentProfile'] == 'valid'
            assert len(answer['declaration']['release']['sourceCommit']) == 40
            status, placement = request('/v1/placements/resolve', {
                'scopeRef': 'agent:tabularasa:project:n1-asp-test:task:probe',
                'cwd': str(project), 'projectRoot': str(project), 'agentRoot': str(agent)})
            assert status == 200 and Path(placement['agentRoot']).resolve() == agent.resolve(), placement
            missing = root / 'empty-agents/tabularasa'
            missing.mkdir(parents=True)
            status, invalid = request('/v1/declarations/resolve', {**body, 'agentRoot': str(missing)})
            assert status == 422 and invalid['error']['code'] == 'declaration_invalid', invalid
            status, invalid = request('/v1/declarations/resolve', {**body, 'interactive': 'yes'})
            assert status == 400 and invalid['error']['detail']['field'] == 'interactive', invalid
            with sqlite3.connect(state / 'state.sqlite') as db:
                assert db.execute('SELECT COUNT(*) FROM runtimes').fetchone()[0] == 0
                assert db.execute('SELECT COUNT(*) FROM runtime_operations').fetchone()[0] == 0
            assert not (root / 'run/bipc').exists()
        finally:
            proc.terminate()
            proc.wait(timeout=10)
            log.close()
    (args.artifacts / 'observations.json').write_text(json.dumps(observations, indent=2) + '\n')
    print(json.dumps({'pass': len(observations), 'artifacts': str(args.artifacts)}))


if __name__ == '__main__':
    main()
