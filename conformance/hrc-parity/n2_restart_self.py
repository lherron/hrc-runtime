"""Compare Bun's restart-self workflow with native, requiring semantic evidence."""
import json
from pathlib import Path


def compare(args, checks):
    required = ('cancelPreservesGeneration', 'deferredUntilTerminal', 'timerFiredOnce',
                'boundTerminal', 'nextGeneration', 'freshRuntime', 'oneSemanticHandoff',
                'oneSuccessorTurn', 'freshCompile')
    sides = {}
    effects = {}
    for owner, directory in (('bun', args.baseline), ('native', args.candidate)):
        value = json.loads((Path(directory) / (owner + '.json')).read_text())
        rows = json.loads((Path(directory) / (owner + '-rows.json')).read_text())
        sides[owner] = value['checks']
        events = [e for e in rows['hrc_events'] if e['event_kind'].startswith('session.restart_')]
        executions = [e for e in events if e['event_kind'] == 'session.restart_executed']
        payload = json.loads(executions[0]['payload_json']) if len(executions) == 1 else {}
        delivery = payload.get('delivery', {})
        terminal = [e for e in rows['hrc_events'] if e['hrc_seq'] == payload.get('terminalHrcSeq')]
        raw_valid = (len(executions) == 1 and len(terminal) == 1
                     and terminal[0]['event_kind'] == 'turn.completed'
                     and json.loads(terminal[0]['payload_json'])['turnId'] == payload['turnId']
                     and json.loads(terminal[0]['payload_json'])['invocationId'] == payload['invocationId']
                     and payload['nextGeneration'] == payload['priorGeneration'] + 1
                     and 'error' not in delivery and bool(delivery.get('runId'))
                     and len([e for e in rows['hrc_events'] if e['run_id'] == delivery.get('runId')
                              and e['event_kind'] == 'turn.completed']) == 1)
        checks.append({'id': owner + ':raw-execution', 'pass': bool(raw_valid),
                       'reason': 'one execution binds its committed terminal and completed successor', 'failureCode': 1})
        requests = [m for m in rows['messages'] if m['phase'] == 'request'
                    and 'Fresh context after self-restart' in m['body']]
        fresh = [r for r in rows['runtimes'] if r['runtime_id'] == delivery.get('runtimeId')]
        compiles = value['compiles']
        checks.append({'id': owner + ':raw-successor',
                       'pass': (len(requests) == 1 and requests[0]['message_id'] == delivery.get('messageId')
                                and payload.get('handoffId', '<absent>') in requests[0]['body']
                                and len(fresh) == 1 and fresh[0]['generation'] == payload.get('nextGeneration')
                                and len(compiles) == 2 and 'continuation' not in compiles[-1]['compileRequest']),
                       'reason': 'one durable semantic request starts a fresh generation without continuation', 'failureCode': 1})
        identities = {}

        def normalize(value, key=''):
            if key == 'terminalHrcSeq':
                return '<bound-terminal>'
            if isinstance(value, dict):
                return {k: normalize(v, k) for k, v in value.items()}
            if isinstance(value, list):
                return [normalize(v) for v in value]
            if key in ('runtimeId', 'invocationId', 'turnId', 'priorHostSessionId',
                       'nextHostSessionId', 'runId', 'messageId') and isinstance(value, str):
                return identities.setdefault(value, '<identity-' + str(len(identities)) + '>')
            return value

        effects[owner] = {'events': [{'kind': e['event_kind'],
                                     'payload': normalize(json.loads(e['payload_json']))} for e in events],
                          'generations': [payload.get('priorGeneration'), payload.get('nextGeneration')]}
        for name in required:
            checks.append({'id': owner + ':' + name, 'pass': value['checks'].get(name) is True,
                           'reason': name + ' must be observed true', 'failureCode': 1})
        checks.append({'id': owner + ':not-control', 'pass': value['negativeControl'] is False,
                       'reason': 'a negative control cannot qualify parity', 'failureCode': 1})
    checks.append({'id': 'compare:workflow', 'pass': sides['bun'] == sides['native'],
                   'reason': json.dumps(sides), 'failureCode': 1})
    checks.append({'id': 'compare:effects', 'pass': effects['bun'] == effects['native'],
                   'reason': json.dumps(effects), 'failureCode': 1})
    return {'suite': 'n2-restart-self', 'cases': [{'id': c['id'], 'pass': c['pass']} for c in checks],
            'behaviorQualified': all(c['pass'] for c in checks)}
