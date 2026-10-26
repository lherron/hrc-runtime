"""Direct registration/attachment comparison, including every canonical row.

UUIDs may vary only through a typed bijection anchored in the durable graph.
Clocks are checked at the request which first writes them; birth clocks and
immutable frozen bytes are also checked within each subject before comparison.
"""
import datetime
import hashlib
import json
import re
from pathlib import Path

CORE = (
    'join-mode',
    'join-array',
    'join-unknown-field',
    'join-invalid-scope',
    'join-missing-incarnation',
    'join-null-lane',
    'join-relative-endpoint',
    'join-invalid-predecessor',
    'join-invalid-continuation',
    'join-bad-json',
    'attach-bad-json',
    'join',
    'join-retry',
    'join-metadata',
    'join-metadata-invalid',
    'join-retry-other-lane-metadata',
    'join-own-predecessor',
    'join-incarnation-elsewhere',
    'reserved-target',
    'attach-array',
    'attach-extra',
    'attach-zero-epoch',
    'attach-null-descriptor',
    'attach-null-env',
    'attach-relative-socket',
    'attach-false-unsupported',
    'attach-mixed-unsupported',
    'attach-missing-reason',
    'attach-unknown',
    'attach-stale-epoch',
    'attach-invalid-descriptor',
    'attach-resume-unsupported',
    'attach-invalid-start-process.cwd',
    'attach-invalid-start-process.lockedEnv',
    'attach-invalid-start-harness.driver',
    'attach-invalid-start-process.harnessTransport',
    'attach-invalid-start-interaction',
    'attach-invalid-start-driver',
    'attach-invalid-start-sdk',
    'attach-invalid-start-launch',
    'attach-invalid-start-agent',
    'attach-invalid-start-correlation',
    'attach-wrong-hash',
    'attach-unselected-continuation',
    'attach-no-endpoint',
    'attach-prepared',
    'attach-retry',
    'attach-retry-env-endpoint',
    'attach-changed-descriptor',
    'join-after-attach',
    'join-classful',
)
UUID = re.compile(r'^(.*-)([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$')
CLOCK = re.compile(r'^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$')
IDENTITIES = {
    'participant_address_reservations': ('reservation_id',),
    'participant_host_bindings': ('binding_id',),
    'participant_registrations': ('registration_id', 'host_session_id'),
    'participant_registration_attempts': ('attempt_id', 'request_id', 'operation_id', 'invocation_id', 'runtime_id'),
}


def compare(args, checks):
    def check(name, passed, reason):
        checks.append({'id': name, 'pass': bool(passed), 'reason': reason, 'failureCode': 1})
    data = {}
    for kind, directory in [('bun', Path(args.baseline)), ('native', Path(args.candidate))]:
        rows = json.loads((directory / 'observations.json').read_text())
        check(kind + ':required', all(k in {r['case'] for r in rows} for k in CORE), 'required direct join and attach cases must exist')
        check(kind + ':unique', len({r['case'] for r in rows}) == len(rows), 'case names must be unique')
        mapping = {}
        final = rows[-1]['durable']
        for table, columns in IDENTITIES.items():
            for index, row in enumerate(final[table]):
                for column in columns:
                    value = row[column]
                    check(f'{kind}:uuid:{table}:{index}:{column}', isinstance(value, str) and bool(UUID.fullmatch(value)), 'identities must use a prefixed UUIDv4')
                    logical = f'<{table}:{index}:{column}>'
                    check(f'{kind}:unique-id:{table}:{index}:{column}', value not in mapping, 'new allocations must not alias')
                    mapping[value] = logical
        tokens_path=directory.parent/(kind+'-tokens.json')
        if tokens_path.exists():
            tokens=json.loads(tokens_path.read_text())
        else:
            tokens=[]
        # Derived credential paths vary only by the exact published allocation.
        for attempt in final['participant_registration_attempts']:
            if not attempt['hosting_intent_json']:
                continue
            descriptor = json.loads(attempt['prepared_profile_json'])
            intent = json.loads(attempt['hosting_intent_json'])
            token = intent['endpoint']['attachTokenRef']['path']
            leaf = hashlib.sha256((descriptor['brokerDriver'] + ':' + attempt['runtime_id']).encode()).hexdigest()[:12]
            check(kind + ':credential-derived', token.endswith('/bipc/' + leaf + '/attach.token'), 'token path must derive from the exact driver/runtime identity')
            owned=next((t for t in tokens if t['path']==token),None)
            check(kind+':credential-file',owned is not None and owned['mode']==0o600 and owned['parentMode']==0o700 and bool(re.fullmatch(r'[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}',owned['value'])), 'the exact allocation credential must be a nonempty UUIDv4 in an owner-only file and directory')
            mapping[token] = '<attach-token:' + mapping[attempt['runtime_id']] + '>'
        seen_clocks = set()
        for observed in rows:
            name = observed['case']
            before, after = observed['beforeDurable'], observed['durable']
            for table, records in after.items():
                for record in records:
                    for column, value in record.items():
                        if isinstance(value, str) and CLOCK.fullmatch(value) and value not in seen_clocks:
                            epoch = datetime.datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp()
                            check(f'{kind}:{name}:clock:{table}:{column}', observed['before'] - .01 <= epoch <= observed['after'] + .01, 'new canonical clocks must lie within their request/effect interval')
                            seen_clocks.add(value)
            # Refusals must have no durable side effects, including timestamp churn.
            if observed['status'] >= 400:
                check(kind + ':' + name + ':no-write', before == after, 'refused request must preserve every captured canonical row byte-for-byte')
            if name in ('join-retry', 'join-own-predecessor', 'attach-no-endpoint', 'attach-retry', 'attach-retry-env-endpoint'):
                check(kind + ':' + name + ':converges', before == after, 'retry or missing endpoint cannot rewrite a frozen allocation')
            if name == 'join':
                clocks = [r['created_at'] for t in ('sessions', 'participant_registrations', 'participant_registration_attempts') for r in after[t]]
                check(kind + ':birth-clock', len(set(clocks)) == 1 and after['events'][0]['ts'] == clocks[0], 'the session, registration, attempt and birth event must share the transaction clock; the reservation precedes that allocation')
            check(kind + ':' + name + ':no-runtime', all(not after[t] for t in ('runtimes', 'runtime_operations', 'broker_invocations')), 'identity admission or failed external endpoint must never fabricate a runtime')
        by_name = {r['case']: r for r in rows}
        prepared = by_name.get('attach-prepared', {}).get('durable', {}).get('participant_registration_attempts', [{}])[0]
        check(kind + ':retry-exhaustion', prepared.get('state') == 'DISPATCH_FROZEN' and prepared.get('establishment_work_state') == 'exhausted' and prepared.get('establishment_attempt_count') == 5 and prepared.get('establishment_next_attempt_at') is None and prepared.get('establishment_last_error') == 'Failed to connect to broker unix socket' and prepared.get('broker_identity_json') is None, 'five failed connections exhaust only work, preserving immutable dispatch and nonterminal identity')
        if 'attach-prepared' in by_name:
            frozen = by_name['attach-prepared']['durable']['participant_registration_attempts'][0]
            for name in ('attach-retry', 'attach-retry-env-endpoint', 'attach-changed-descriptor', 'join-after-attach'):
                if name not in by_name:
                    continue
                latest = by_name[name]['durable']['participant_registration_attempts'][0]
                check(kind + ':' + name + ':frozen', frozen == latest, 'descriptor, endpoint, adapter environment and exhausted work must remain byte-for-byte frozen')
        def normalize(value):
            if isinstance(value, dict):
                return {k: normalize(v) for k, v in value.items()}
            if isinstance(value, list):
                return [normalize(v) for v in value]
            if isinstance(value, str):
                if CLOCK.fullmatch(value):
                    return '<request-bounded-clock>'
                try:
                    parsed = json.loads(value)
                except (ValueError, TypeError):
                    parsed = None
                if isinstance(parsed, (dict, list)):
                    return normalize(parsed)
                for raw, logical in sorted(mapping.items(), key=lambda pair: -len(pair[0])):
                    value = value.replace(raw, logical)
            return value
        normalized = {}
        for row in rows:
            row = normalize(row)
            # Bun emits server.started on startup; N1 owns only this scope's
            # birth events. Cursor offsets are checked through that owned order.
            for side in ('beforeDurable', 'durable'):
                for i, event in enumerate(row[side]['events']):
                    check(kind + ':' + row['case'] + ':event-kind', event['event_kind'] in ('session.created','session.metadata.changed','session.metadata.rejected'), 'only session birth and metadata events are expected before establishment')
                    event['hrc_seq'] = i + 1
                    event['stream_seq'] = i + 1
            normalized[row['case']] = {k: row[k] for k in ('path', 'request', 'status', 'body', 'beforeDurable', 'durable')}
        data[kind] = normalized
    results = []
    check('same-case-set', set(data['bun']) == set(data['native']), 'both owners must execute the identical request mix')
    for name in data['bun']:
        passed = data['bun'][name] == data['native'].get(name)
        check('compare:' + name, passed, 'full HTTP request/status/body and every captured canonical row must agree after typed identity and bounded-clock normalization')
        results.append({'id': name, 'pass': passed})
    return {'suite': 'n1-participants', 'cases': results, 'behaviorQualified': all(c['pass'] for c in checks)}


def compare_live(args, checks):
    """Qualify establishment before N2 projection, against real ASP/brokers.

    Bun projects its held events after activation. Native must keep those
    events unACKed. Cursor/status/seat projection differences are deliberate
    N2 gaps; immutable identity, profile, dispatch and graph facts are checked
    against each subject's actual ASP compile and broker receipt instead.
    """
    def check(name, passed, reason):
        checks.append({'id': name, 'pass': bool(passed), 'reason': reason, 'failureCode': 1})
    compared = {}
    for kind, directory in [('bun', Path(args.baseline)), ('native', Path(args.candidate))]:
        value = json.loads((directory / (kind + '.json')).read_text())
        d = value['descriptor']
        start = d['harnessInvocation']['startRequest']
        joined = value['joined']
        identity = joined['identity']
        durable = value['durable']
        check(kind + ':join-not-runnable', joined['observation']['state'] == 'attachment_pending' and not value['joinRows']['runtimes'] and not value['joinRows']['runtime_operations'] and not value['joinRows']['broker_invocations'], 'registration must allocate only durable participant identity')
        check(kind + ':real-compile', value['compiled']['ok'] is True and value['compiled']['executionRelease']['worker']['executable'].startswith('/Users/lherron/praesidium/var/aspd/releases/') and value['compiled']['plan']['execution']['driver'] == 'claude-code-tmux' and value['compileRequest']['agent']['id'] == 'tabularasa', 'real aspd and the approved blank claude profile must supply the executable and invocation')
        check(kind + ':no-process-mutation', start == value['compiled']['plan']['execution']['dispatchRequest']['startRequest'] or start['spec']['process'] == value['compiled']['plan']['execution']['dispatchRequest']['startRequest']['spec']['process'], 'the adapter must retain the producer process, arguments, environment and working directory')
        check(kind + ':cardinalities', all(len(durable[t]) == 1 for t in ('sessions', 'continuities', 'participant_registrations', 'participant_host_bindings', 'participant_registration_attempts', 'runtimes', 'runtime_operations', 'broker_invocations')), 'one join and one immutable ensure must yield exactly one canonical graph')
        reg = durable['participant_registrations'][0]
        a = durable['participant_registration_attempts'][0]
        runtime = durable['runtimes'][0]
        operation = durable['runtime_operations'][0]
        invocation = durable['broker_invocations'][0]
        state = json.loads(runtime['runtime_state_json'])
        ack = json.loads(a['broker_identity_json'])
        intent = json.loads(a['hosting_intent_json'])
        realized = json.loads(a['realized_hosting_json'])
        dispatch = json.loads(a['dispatch_json'])
        check(kind + ':attempt-current', a['state'] == 'ACTIVE' and a['establishment_work_state'] == 'completed' and a['establishment_attempt_count'] == 0 and a['initial_activation_confirmed_at'] is not None and a['attempt_id'] == identity['attemptId'] and a['attach_epoch'] == identity['attachEpoch'], 'only the committed current epoch may activate and finish its work')
        check(kind + ':descriptor-frozen', json.loads(a['prepared_profile_json']) == d and dispatch['startRequest'] == start and dispatch['lifecyclePolicy'] == intent['lifecyclePolicy'], 'complete adapter and dispatch tuples must be frozen verbatim')
        check(kind + ':identity-installed', ack['installed'] is True and bool(ack['brokerInstanceId']) and bool(ack['installedAt']) and all(ack[k] == v for k, v in {'runtimeId': identity['runtimeId'], 'hostSessionId': joined['hostSessionId'], 'generation': joined['generation'], 'attachEpoch': identity['attachEpoch'], 'invocationId': identity['invocationId']}.items()), 'actual install acknowledgement must fence every allocation coordinate')
        check(kind + ':binding', durable['participant_host_bindings'][0]['state'] == 'BOUND' and durable['participant_host_bindings'][0]['bound_at'] is not None and reg['serving_socket_path'] == intent['endpoint']['socketPath'] == realized['endpoint']['socketPath'], 'binding time and external endpoint must agree with the frozen hosting intent')
        check(kind + ':external-presentation', realized['substrate'] == {'kind': 'external'} and realized['presentation']['kind'] == 'tmux-tui' and dispatch['runtime']['terminalSurface']['paneId'] == realized['presentation']['tuiWindow']['paneId'], 'participant keeps its process; HRC owns only its separate real tmux presentation')
        # Bun runtimeHarness recognizes 'claude-code-cli'; ASP emits
        # 'claude-code', which currently takes Bun's codex-cli fallback.
        expected = {'runtime_id': identity['runtimeId'], 'host_session_id': joined['hostSessionId'], 'scope_ref': joined['scopeRef'], 'lane_ref': identity['laneRef'], 'generation': joined['generation'], 'transport': 'tmux', 'harness': 'codex-cli', 'provider': 'anthropic', 'supports_inflight_input': 1, 'controller_kind': 'harness-broker', 'active_operation_id': identity['operationId'], 'active_invocation_id': identity['invocationId'], 'selected_profile_hash': d['descriptorHash']}
        check(kind + ':runtime-graph', all(runtime[k] == v for k, v in expected.items()) and state['lifecycleOwner'] == 'external' and state['control'] == {'mode': 'broker-ipc', 'brokerAttached': True}, 'runtime identity, compatibility projections, external lifecycle owner and retained controller must match Bun')
        expected = {'operation_id': identity['operationId'], 'runtime_id': identity['runtimeId'], 'host_session_id': joined['hostSessionId'], 'generation': joined['generation'], 'operation_kind': 'broker_invocation', 'controller': 'harness-broker', 'selected_profile_id': d['descriptorId'], 'selected_profile_hash': d['descriptorHash'], 'startup_method': 'broker.ensureInvocation', 'turn_delivery': 'invocation.input', 'status': 'starting', 'run_id': None, 'compile_id': None, 'plan_hash': None, 'preparation_json': None}
        check(kind + ':operation-graph', all(operation[k] == v for k, v in expected.items()) and json.loads(operation['route_decision_json']) == {'origin': 'participant-registration', 'join': 'participant-served'}, 'participant operation must use ensure and retain the selected immutable descriptor')
        expected = {'invocation_id': identity['invocationId'], 'operation_id': identity['operationId'], 'runtime_id': identity['runtimeId'], 'broker_protocol': d['brokerProtocol'], 'broker_driver': d['brokerDriver'], 'spec_hash': d['harnessInvocation']['specHash'], 'start_request_hash': d['harnessInvocation']['startRequestHash'], 'selected_profile_hash': d['descriptorHash'], 'lifecycle_policy_hash': intent['lifecyclePolicy']['policyHash'], 'execution_format': 'format1', 'run_id': None}
        check(kind + ':invocation-graph', all(invocation[k] == v for k, v in expected.items()) and json.loads(invocation['spec_projection_json']) == start['spec'] and json.loads(invocation['start_request_projection_json']) == start, 'canonical invocation must retain the complete actual profile projections and hashes')
        events = [e for e in durable['hrc_events'] if e['event_kind'] == 'runtime.ensured']
        check(kind + ':activation-event', len(events) == 1 and json.loads(events[0]['payload_json']) == {'source': 'participant-activation', 'attemptId': identity['attemptId'], 'attachEpoch': identity['attachEpoch'], 'classification': 'attached_unknown'} and state['participantActivation']['activatedAt'] == a['initial_activation_confirmed_at'], 'one activation transaction must classify continuity once and publish its truthful event')
        check(kind + ':retry', value['attach'][0] == value['retry'][0] == 200 and value['attach'][1]['prepared'] is True and value['retry'][1]['prepared'] is False, 'identical live attachment must converge without replacing its broker')
        check(kind + ':shutdown-survival', value['brokerAliveAfterShutdown'] is True, 'daemon shutdown must leave the independently owned real broker alive')
        if kind == 'native':
            check('native:holds-events', invocation['last_projected_seq'] in (None, 0) and state['brokerReplay']['lastProjectedSeq'] == state['brokerReplay']['ackedThroughSeq'] == 0 and value['snapshot']['currentSeq'] > 0, 'native must hold the real broker events without pretending they were projected or ACKed')
        compared[kind] = {'status': value['attach'][0], 'prepared': value['attach'][1]['prepared'], 'retryPrepared': value['retry'][1]['prepared'], 'active': a['state'], 'work': a['establishment_work_state'], 'count': a['establishment_attempt_count'], 'external': state['lifecycleOwner'], 'brokerAttached': state['control']['brokerAttached'], 'policy': intent['lifecyclePolicy'], 'format': invocation['execution_format'], 'route': json.loads(operation['route_decision_json']), 'survived': value['brokerAliveAfterShutdown']}
    check('compare:live-establishment', compared['bun'] == compared['native'], 'Bun and native must establish the same participant-owned lifecycle through durable activation')
    return {'suite': 'n1-participant-live', 'cases': [{'id': 'live-establishment', 'pass': all(c['pass'] for c in checks)}], 'behaviorQualified': all(c['pass'] for c in checks)}
