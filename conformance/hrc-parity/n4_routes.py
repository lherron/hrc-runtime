"""N4 per-case comparison of federation reads on real scratch nodes, key order included."""
import json
from pathlib import Path

# Peer-probe clocks move with every request; their key positions still compare.
DYNAMIC = {'checkedAt', 'answeredAt', 'latencyMs'}
CONFIGS = ('none', 'peerless', 'peered', 'peer-refused', 'peer-down')
PER_CONFIG = 62


def canonical(value, local_tail=False):
    if isinstance(value, dict):
        return [(k, '<dynamic>' if k in DYNAMIC or (local_tail and k == 'headHrcSeq') else canonical(x, local_tail))
                for k, x in value.items()]
    if isinstance(value, list):
        return [canonical(x, local_tail) for x in value]
    return value


def compare(args, checks):
    a = json.loads((Path(args.baseline) / 'federation.json').read_text())
    b = json.loads((Path(args.candidate) / 'federation.json').read_text())
    configs = {name.split(':', 1)[0] for name in a}
    checks.append({'id': 'case-matrix', 'pass': len(a) == PER_CONFIG * len(CONFIGS) and set(a) == set(b)
                   and configs == set(CONFIGS), 'reason': 'every case under every federation config on both owners',
                   'failureCode': 1})
    cases = []
    for name in a:
        # A local tail reports this store's head; Bun's own startup appends
        # server lifecycle rows there and native's does not (N5 owns them).
        local_tail = ':events-tail:' in name and a[name].get('homeNode') is None
        passed = name in b and canonical(a[name], local_tail) == canonical(b[name], local_tail)
        checks.append({'id': 'compare:' + name, 'pass': passed,
                       'reason': 'status, x-hrc-home-node, fields, values and key order must match Bun',
                       'failureCode': 1})
        cases.append({'id': name, 'pass': passed})
    return {'suite': args.suite, 'cases': cases, 'behaviorQualified': all(c['pass'] for c in checks)}


# Placement: each owner runs on its own scratch root (births mutate state), so
# paths arrive root-normalized. bundleIdentity hashes those absolute paths and
# host session ids/clocks are minted per owner; positions still compare.
PLACEMENT_DYNAMIC = {'bundleIdentity', 'hostSessionId', 'activeHostSessionId', 'createdAt', 'updatedAt',
                     'lastActivityAt'}
PLACEMENT_CASES = 37


def placement_canonical(value):
    if isinstance(value, dict):
        return [(k, '<dynamic>' if k in PLACEMENT_DYNAMIC else placement_canonical(x)) for k, x in value.items()]
    if isinstance(value, list):
        return [placement_canonical(x) for x in value]
    return value


def compare_placement(args, checks):
    a = json.loads((Path(args.baseline) / 'placement.json').read_text())
    b = json.loads((Path(args.candidate) / 'placement.json').read_text())
    checks.append({'id': 'case-matrix', 'pass': len(a) == PLACEMENT_CASES and set(a) == set(b),
                   'reason': 'every placement door and cold birth on both owners', 'failureCode': 1})
    cases = []
    for name in a:
        passed = name in b and placement_canonical(a[name]) == placement_canonical(b[name])
        checks.append({'id': 'compare:' + name, 'pass': passed,
                       'reason': 'status, fields, values, key order and the born pane cwd must match Bun',
                       'failureCode': 1})
        cases.append({'id': name, 'pass': passed})
    return {'suite': args.suite, 'cases': cases, 'behaviorQualified': all(c['pass'] for c in checks)}
