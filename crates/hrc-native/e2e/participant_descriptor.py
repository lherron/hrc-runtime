"""Participant broker descriptors, built and hashed in Python.

The spec is the daemon's own: descriptor.rs `descriptor_hash` and
`agreement`, compile.rs `canonical`/`neutral_spec`/`neutral_start`
(hrcpty_substrate.canonical is the same projection). `scratch` and `live`
are ports of the former participant_descriptor.mjs and
participant_live_descriptor.mjs builders.
"""
import copy
import hashlib

from hrcpty_substrate import canonical


def digest(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def neutral_spec(spec):
    spec = copy.deepcopy(spec)
    spec.pop('invocationId', None)
    spec.pop('correlation', None)
    return spec


def neutral_start(start):
    value = copy.deepcopy(start)
    value['spec'] = neutral_spec(start['spec'])
    if 'initialInput' in start:
        value['initialInput'] = {k: start['initialInput'][k] for k in ('inputId', 'responseFormat') if k in start['initialInput']}
    return value


def spec_hash(spec):
    return digest(neutral_spec(spec))


def start_request_hash(start):
    return digest(neutral_start(start))


def descriptor_hash(d):
    v = copy.deepcopy(d)
    v.pop('descriptorHash', None)
    v.pop('compatibilityHash', None)
    v['harnessInvocation']['startRequest'] = neutral_start(d['harnessInvocation']['startRequest'])
    v['observability'] = {'correlation': {'generation': d['observability']['correlation']['generation']}}
    return digest(v)


def rehash(d):
    """Recompute descriptorHash after an edit, and the spec's selectedProfileHash with it."""
    d = copy.deepcopy(d)
    d['descriptorHash'] = descriptor_hash(d)
    d['harnessInvocation']['startRequest']['spec']['correlation']['selectedProfileHash'] = d['descriptorHash']
    return d


def _seal(d):
    inv = d['harnessInvocation']
    spec = inv['startRequest']['spec']
    inv['specHash'] = spec_hash(spec)
    inv['startRequestHash'] = start_request_hash(inv['startRequest'])
    spec['correlation']['startRequestHash'] = inv['startRequestHash']
    d['descriptorHash'] = descriptor_hash(d)
    spec['correlation']['selectedProfileHash'] = d['descriptorHash']
    return d


def seal(d):
    """Recompute specHash, startRequestHash and descriptorHash after editing the spec."""
    return _seal(copy.deepcopy(d))


def _correlation(joined):
    i = joined['identity']
    return {'requestId': i['requestId'], 'operationId': i['operationId'], 'hostSessionId': joined['hostSessionId'],
            'generation': joined['generation'], 'runtimeId': i['runtimeId'], 'invocationId': i['invocationId']}


def scratch(joined, cwd):
    """A descriptor for an external driver nobody launches: admission only."""
    i = joined['identity']
    spec = {
        'specVersion': 'harness-broker.invocation/v1', 'invocationId': i['invocationId'],
        'labels': {'participant': 'n1-scratch-descriptor-admission'},
        'harness': {'frontend': 'external', 'provider': 'external', 'driver': 'n1-external-driver'},
        'process': {'command': 'n1-external-driver', 'args': [], 'cwd': str(cwd), 'lockedEnv': {},
                    'harnessTransport': {'kind': 'pipes'}},
        'interaction': {'mode': 'headless', 'turnConcurrency': 'single', 'inputQueue': 'none'},
        'driver': {'kind': 'n1-external-driver'},
        'correlation': {'runtimeId': i['runtimeId'], 'hostSessionId': joined['hostSessionId'],
                        'generation': str(joined['generation']), 'invocationId': i['invocationId'],
                        'startRequestHash': '', 'selectedProfileHash': ''},
    }
    return _seal({
        'schemaVersion': 'participant-broker-descriptor/v1', 'descriptorId': 'n1-participant-descriptor',
        'descriptorHash': '', 'compatibilityHash': 'n1-participant-descriptor-compatibility',
        'interactionMode': 'headless', 'expectedCapabilities': {}, 'brokerProtocol': 'harness-broker/0.2',
        'brokerDriver': 'n1-external-driver', 'brokerOwnership': 'participant-owned-process',
        'harnessInvocation': {'startRequest': {'spec': spec}, 'specHash': '', 'startRequestHash': ''},
        'policy': {'permissionPolicy': {'mode': 'deny', 'audit': True},
                   'inputPolicy': {'readyInput': 'start-turn', 'busy': {'whenBusy': 'queue', 'maxDepth': 1},
                                   'supportedKinds': ['user'], 'attachmentPolicy': {'localImages': False, 'fileRefs': False}},
                   'exposurePolicy': {'mode': 'none'}},
        'observability': {'correlation': _correlation(joined)},
    })


def live(joined, compiled):
    """A real ASP compile result -> the participant-owned descriptor for its broker."""
    i = joined['identity']
    e = compiled['plan']['execution']
    start = copy.deepcopy(e['dispatchRequest']['startRequest'])
    spec = start['spec']
    if spec['invocationId'] != i['invocationId']:
        raise AssertionError('ASP identity drift', spec['invocationId'], i['invocationId'])
    carried = joined.get('continuation') or {}
    if carried.get('carried'):
        # The host states exactly the continuation HRC selected (participants/mod.rs attach).
        spec['continuation'] = carried['selected']
    spec['correlation'] = {**spec.get('correlation', {}), 'runtimeId': i['runtimeId'],
                           'hostSessionId': joined['hostSessionId'], 'generation': str(joined['generation']),
                           'invocationId': i['invocationId'], 'startRequestHash': '', 'selectedProfileHash': ''}
    return _seal({
        'schemaVersion': 'participant-broker-descriptor/v1', 'descriptorId': e['profile']['profileId'],
        'descriptorHash': '', 'compatibilityHash': e['profile']['compatibilityHash'], 'interactionMode': 'headless',
        'expectedCapabilities': {}, 'brokerProtocol': e['protocol'], 'brokerDriver': e['driver'],
        'brokerOwnership': 'participant-owned-process', 'brokerTerminal': {'host': 'tmux'},
        'harnessInvocation': {'startRequest': start, 'specHash': '', 'startRequestHash': ''},
        'policy': {}, 'observability': {'correlation': _correlation(joined)},
    })
