"""Private deterministic lifecycle actors, credentials minted by the scratch owner."""
import copy
import json
import os
from pathlib import Path
import signal
import sys
import threading

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'crates/hrc-cli/e2e'))
from native_seat import Fixture
from foundation import UnixHTTP


class LifecycleFixture(Fixture):
    agents = ('tabularasa', 'mable')
    awaiting_restart = None

    def __enter__(self):
        super().__enter__()
        threading.Thread(target=self.s.owners[-1].wait, daemon=True).start()
        return self

    def boot(self, tag):
        proc = self.s.up('native', tag)
        # The restart successor waits for kill -0(oldPid) to fail; reap the
        # exited child immediately so a zombie cannot delay its successor.
        threading.Thread(target=proc.wait, daemon=True).start()
        return proc

    def actor(self, agent, task='primary'):
        intent = copy.deepcopy(self.intent)
        intent['placement']['agentRoot'] = str(self.root / 'agents' / agent)
        ref = f'agent:{agent}:project:n5-t11819:task:{task}/lane:main'
        session = self.call('/v1/sessions/resolve', dict(sessionRef=ref, create=True,
                            summonIntent='explicit_local', runtimeIntent=intent))
        turn = self.call('/v1/turns', dict(hostSessionId=session['hostSessionId'],
                         prompt='fixture turn CONT', runtimeIntent=intent))
        self.s.wait_completed(turn['runId'], 30)
        self.broker(turn['runtimeId'])
        return dict(sessionRef=ref, **turn)

    def headers(self, actor):
        path = self.root / 'run/lifecycle' / (actor['runtimeId'] + '.credential')
        self.s.wait(path.is_file, 15, 'minted lifecycle credential')
        token = path.read_text().strip()
        assert len(token) == 64
        return {'x-hrc-lifecycle-runtime-id': actor['runtimeId'],
                'x-hrc-lifecycle-session-ref': actor['sessionRef'],
                'x-hrc-lifecycle-credential': token}

    def lifecycle(self, body, actor):
        previous = int((self.root / 'run/server.pid').read_text())
        h = UnixHTTP(self.s.socket)
        h.request('POST', '/v1/server/lifecycle', json.dumps(body),
                  {**self.headers(actor), 'Content-Type': 'application/json'})
        response = h.getresponse()
        value = json.loads(response.read())
        h.close()
        if body.get('action') == 'restart' and not body.get('targetNode') and value.get('accepted') is True:
            self.awaiting_restart = previous
        return response.status, value

    def facts(self):
        return self.s.rows("SELECT hrc_seq,event_kind,payload_json FROM hrc_events WHERE scope_ref='server:hrc' ORDER BY hrc_seq")

    def ready(self, previous=None):
        def read():
            try:
                value = self.call('/v1/status')
                pid = int((self.root / 'run/server.pid').read_text())
                if previous is not None and previous == pid:
                    return False
                assert value['runtimeRoot'] == str(self.root / 'run')
                assert value['stateRoot'] == str(self.root / 'state')
                assert value['release']['mode'] == 'unmanaged'
                if self.awaiting_restart is not None and pid != self.awaiting_restart:
                    self.awaiting_restart = None
                return pid, value
            except (OSError, ValueError):
                return False
        result = []
        self.s.wait(lambda: result.append(read()) or result[-1], 20, 'healthy successor')
        return result[-1]

    def stopped(self):
        self.s.wait(lambda: not self.s.socket.exists() and not (self.root / 'run/server.lock').exists(),
                    20, 'released socket and owner lock')

    def stop_owner(self):
        if self.awaiting_restart is not None or self.s.socket.exists():
            pid, _ = self.ready(self.awaiting_restart)
            os.kill(pid, signal.SIGTERM)
            self.stopped()

    def configure(self, config):
        self.stop_owner()
        path = self.root / 'federation.json'
        path.write_text(json.dumps(config))
        path.chmod(0o600)
        self.boot('configured')

    def __exit__(self, *exc):
        try:
            self.stop_owner()
        finally:
            super().__exit__(*exc)


def prove_delta(f, initial, action, grant, old, new):
    delta = [r for r in f.facts() if not initial or r['hrc_seq'] > initial[-1]['hrc_seq']]
    expected = ['server.shutting_down', 'server.stopped'] + (['server.started'] if action == 'restart' else [])
    assert [r['event_kind'] for r in delta] == expected, delta
    for row in delta[:2]:
        payload = json.loads(row['payload_json'])
        assert payload['reason'] == 'lifecycle:' + action and payload['grant'] == grant, payload
        assert payload['pid'] == old, payload
        assert 'ungranted' not in payload
    assert json.loads(delta[1]['payload_json'])['shuttingDownHrcSeq'] == delta[0]['hrc_seq']
    if action == 'restart':
        started = json.loads(delta[2]['payload_json'])
        assert started['pid'] == new and started['previousPid'] == old, started
    return delta
