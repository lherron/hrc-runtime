#!/usr/bin/env python3
"""Real restart-self workflow on Bun first, then native, using copied releases.

Failure modes: missing-handoff refusal lost, arm fires before its bound turn,
cancel still rotates, terminal's zero-delay timer never fires, duplicate
successor delivery, or the new generation compiles with the old continuation.
The negative control cancels the final arm; the execution assertion must fail.
"""
import argparse
import json
import shlex
import time
from pathlib import Path

from n2_aspd_proxy import AspdProxy
from n3_scratch import Scratch


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--owner', choices=['bun', 'native'], required=True)
    for key in ('binary', 'installed-release', 'aspd-socket', 'scratch-root', 'artifacts'):
        p.add_argument('--' + key, type=Path, required=True)
    p.add_argument('--negative-control', action='store_true')
    a = p.parse_args()
    assert a.scratch_root.resolve().is_relative_to(Path('/tmp').resolve()), 'scratch must be under /tmp'
    a.artifacts.mkdir(parents=True, exist_ok=True)
    proxy = AspdProxy(str(a.scratch_root) + '-aspd.sock', a.aspd_socket,
                      a.artifacts / 'aspd.ndjson')
    s = Scratch(a.scratch_root, a.installed_release, Path(proxy.listen), a.binary, a.artifacts)
    prefix = 'agent:tabularasa:project:n2-t11823:task:'
    scope = prefix + 'restart-self'
    checks = {}
    gates = []
    try:
        s.init_substrate()
        # A genuinely unfederated scratch has no registry to consult. An
        # existing config with zero peers instead refuses scoped reads.
        (s.root / 'federation.json').unlink()
        s.up(a.owner, 'restart-self')
        status, observed = s.http('GET', '/v1/status')
        assert status == 200 and observed['capabilities']['selfRestart'] is True, observed
        s.steps.append({'name': 'observed-status', 'value': observed})
        start = ['hrc', 'start', scope, '--project-id', s.project_id,
                 '--project-root', s.project, '--cwd', s.project, '--json', '-p']

        def held_turn(name):
            ready, gate = s.root / (name + '-ready'), s.root / (name + '-release')
            gates.append(gate)
            shell = 'touch ' + shlex.quote(str(ready)) + '; while [ ! -f ' + shlex.quote(str(gate)) + ' ]; do sleep 0.1; done'
            birth = s.command(name, start + ['Use Bash once to run this exact command. Wait for it to finish, then reply with exactly OK.\n' + shell])
            s.wait(ready.exists, 180, name + ' tool held')
            return birth['runtime'], gate

        seat, gate = held_turn('cancel')
        s.env.update(HRC_SESSION_REF=scope + '/lane:main', HRC_RUNTIME_ID=seat['runtimeId'])
        handoff = s.command('handoff-create', ['wrkq', 'handoff', 'create', '--scope',
                            'tabularasa@' + s.project_id, '-t', 'Restart self probe', '--body-file', '-', '--json'],
                            stdin='After reading and acknowledging this handoff, reply with exactly SUCCESSOR_OK. Do not restart yourself.\n')
        handoff = handoff.get('handoff', handoff)
        hid = handoff['id']

        def cli(name, argv, expected, exit_code=0):
            s.command(name, ['hrc', 'restartme'] + argv, check=False)
            step = s.steps[-1]
            assert step['exit'] == exit_code and expected in step['stdout'] + step['stderr'], step
            return {'exit': step['exit'], 'matched': expected}

        checks['handoffRequired'] = cli('missing-handoff', [], 'handoff_required', 1)
        consumed = s.command('consumed-handoff-create', ['wrkq', 'handoff', 'create', '--scope',
                             'tabularasa@' + s.project_id, '-t', 'Consumed probe', '--body-file', '-', '--json'], stdin='Already consumed.\n')
        consumed = consumed.get('handoff', consumed)
        s.command('consume-handoff', ['wrkq', 'handoff', 'acknowledge', consumed['id'], '--if-match',
                                    str(consumed['etag']), '--note', 'E2E refusal probe', '--json'])
        checks['handoffNotPending'] = cli('consumed-handoff', ['--handoff', consumed['id']], 'handoff_not_pending', 1)
        checks['armCancel'] = cli('arm-cancel', ['--handoff', hid], 'restart armed')
        assert not s.rows("SELECT 1 FROM hrc_events WHERE event_kind='session.restart_executed'")
        checks['cancel'] = cli('cancel', ['--cancel'], 'restart cancelled')
        gate.touch()
        s.wait_completed(seat['runId'])
        time.sleep(2)
        original = s.rows('SELECT * FROM sessions WHERE host_session_id=?', (seat['hostSessionId'],))[0]
        checks['cancelPreservesGeneration'] = original['generation'] == 1
        assert checks['cancelPreservesGeneration']
        assert not s.rows("SELECT 1 FROM hrc_events WHERE event_kind='session.restart_executed'")
        checks['cancelAgain'] = cli('cancel-again', ['--cancel'], 'no restart was armed')

        active, gate = held_turn('execute')
        assert active['runtimeId'] == seat['runtimeId'], active
        checks['armExecute'] = cli('arm-execute', ['--handoff', hid], 'restart armed')
        time.sleep(1)
        assert not s.rows("SELECT 1 FROM hrc_events WHERE event_kind='session.restart_executed'")
        checks['deferredUntilTerminal'] = True
        if a.negative_control:
            cli('negative-cancel-execution', ['--cancel'], 'restart cancelled')
        gate.touch()
        s.wait_completed(active['runId'])
        executed = s.wait(lambda: s.rows("SELECT * FROM hrc_events WHERE event_kind='session.restart_executed'"),
                          20 if a.negative_control else 180, 'self-restart timer execution')
        payload = json.loads(executed[0]['payload_json'])
        delivery = payload['delivery']
        assert 'error' not in delivery, delivery
        s.wait_completed(delivery['runId'])
        time.sleep(3)
        executed = s.rows("SELECT * FROM hrc_events WHERE event_kind='session.restart_executed'")
        terminal = s.rows('SELECT * FROM hrc_events WHERE hrc_seq=?', (payload['terminalHrcSeq'],))[0]
        checks['timerFiredOnce'] = len(executed) == 1
        checks['boundTerminal'] = terminal['run_id'] == active['runId'] and terminal['event_kind'] == 'turn.completed'
        checks['nextGeneration'] = payload['nextGeneration'] == payload['priorGeneration'] + 1
        checks['freshRuntime'] = delivery['runtimeId'] != active['runtimeId']
        messages = s.rows("SELECT * FROM messages WHERE phase='request'")
        successor = [m for m in messages if hid in m['body'] and 'Fresh context after self-restart' in m['body']]
        checks['oneSemanticHandoff'] = len(successor) == 1 and successor[0]['message_id'] == delivery['messageId']
        checks['oneSuccessorTurn'] = len(s.rows("SELECT * FROM hrc_events WHERE run_id=? AND event_kind='turn.started'", (delivery['runId'],))) == 1
        compiles = proxy.requests('aspc.compileHarnessInvocation')
        checks['freshCompile'] = len(compiles) == 2 and 'continuation' not in compiles[-1]['params']['compileRequest']
        assert all(v is True for v in checks.values() if isinstance(v, bool)), checks
        result = {'owner': a.owner, 'checks': checks, 'execution': payload,
                  'compiles': [c['params'] for c in compiles], 'negativeControl': a.negative_control}
        (a.artifacts / (a.owner + '.json')).write_text(json.dumps(result, indent=2) + '\n')
        s.dump(a.owner + '-rows', {'messages': s.rows('SELECT * FROM messages')})
        print(json.dumps({'owner': a.owner, 'pass': True, 'checks': checks}))
    finally:
        for gate in gates:
            gate.touch(exist_ok=True)
        (a.artifacts / (a.owner + '-steps.json')).write_text(json.dumps({'checks': checks, 'steps': s.steps}, indent=2) + '\n')
        s.dump(a.owner + '-rows', {'messages': s.rows('SELECT * FROM messages')})
        s.cleanup(prefix)
        proxy.close()


if __name__ == '__main__':
    main()
