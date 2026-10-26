"""N4 per-case comparison of federation reads on real scratch nodes, key order included."""
import json
from pathlib import Path

# Peer-probe clocks move with every request; their key positions still compare.
DYNAMIC = {'checkedAt', 'answeredAt', 'latencyMs', 'generatedAt'}
CONFIGS = ('none', 'peerless', 'peered', 'peer-refused', 'peer-down')
PER_CONFIG = 65


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


# Registry listener: the same ordered request list against node B's registry,
# B run as Bun (baseline) or native (candidate). Registry clocks are minted per run.
REGISTRY_DYNAMIC = {'createdAt', 'updatedAt', 'designatedAt', 'supersededAt'}
REGISTRY_CASES = 34


def registry_canonical(value):
    if isinstance(value, dict):
        return [(k, '<dynamic>' if k in REGISTRY_DYNAMIC else registry_canonical(x)) for k, x in value.items()]
    if isinstance(value, list):
        return [registry_canonical(x) for x in value]
    return value


def compare_registry(args, checks):
    a = json.loads((Path(args.baseline) / 'registry-bun.json').read_text())
    b = json.loads((Path(args.candidate) / 'registry-native.json').read_text())
    checks.append({'id': 'case-matrix', 'pass': len(a) == REGISTRY_CASES and set(a) == set(b),
                   'reason': 'every registry route and refusal on both registry hosts', 'failureCode': 1})
    cases = []
    for name in a:
        passed = name in b and registry_canonical(a[name]) == registry_canonical(b[name])
        checks.append({'id': 'compare:' + name, 'pass': passed,
                       'reason': 'status, fields, values and key order must match the Bun registry host',
                       'failureCode': 1})
        cases.append({'id': name, 'pass': passed})
    return {'suite': args.suite, 'cases': cases, 'behaviorQualified': all(c['pass'] for c in checks)}


# Home direction: a Bun origin's federation reads with node B (the home and
# registry host) run as Bun (baseline) and as native (candidate). Each run has
# its own scratch root, ports, ledger and clocks; Bun's startup lifecycle row
# shifts B's ledger sequence by one (N5 owns those rows natively).
HOME_DYNAMIC = DYNAMIC | {'hostSessionId', 'activeHostSessionId', 'createdAt', 'updatedAt', 'ts',
                          'ledgerIncarnationId', 'lastActivityAt', 'endpoint', 'registryEndpoint', 'headHrcSeq',
                          'statusChangedAt', 'expectedLedgerIncarnationId', 'currentLedgerIncarnationId',
                          'designatedAt', 'supersededAt', 'hrcSeq', 'streamSeq', 'replayHeadHrcSeq'}


def home_canonical(value):
    import re
    if isinstance(value, dict):
        return [(k, '<dynamic>' if k in HOME_DYNAMIC else home_canonical(x)) for k, x in value.items()]
    if isinstance(value, list):
        return [home_canonical(x) for x in value]
    if isinstance(value, str):
        return re.sub(r'hsid-[0-9a-f-]+', '<hsid>', re.sub(r'(/private)?/tmp/n4[^/"]*', '<root>', value))
    return value


def compare_home(args, checks):
    a = json.loads((Path(args.baseline) / 'federation.json').read_text())
    b = json.loads((Path(args.candidate) / 'federation.json').read_text())
    checks.append({'id': 'case-matrix', 'pass': len(a) == PER_CONFIG * len(CONFIGS) and set(a) == set(b),
                   'reason': 'every origin case against both homes', 'failureCode': 1})
    cases = []
    for name in a:
        passed = name in b and home_canonical(a[name]) == home_canonical(b[name])
        checks.append({'id': 'compare:' + name, 'pass': passed,
                       'reason': 'a Bun origin must see the same answers from a native home', 'failureCode': 1})
        cases.append({'id': name, 'pass': passed})
    return {'suite': args.suite, 'cases': cases, 'behaviorQualified': all(c['pass'] for c in checks)}


# Summon gate: the same ordered ensure-target cases on each owner's own node,
# enforce then advisory, plus the registry/designation/ledger/session rows each
# phase leaves. Session identities and clocks are minted per owner.
GATE_DYNAMIC = {'hostSessionId', 'activeHostSessionId', 'createdAt', 'updatedAt'}
GATE_CASES = 40


def gate_canonical(value):
    import re
    if isinstance(value, dict):
        return [(k, '<dynamic>' if k in GATE_DYNAMIC else gate_canonical(x)) for k, x in value.items()]
    if isinstance(value, list):
        return [gate_canonical(x) for x in value]
    if isinstance(value, str):
        return re.sub(r'hsid-[0-9a-f-]+', '<hsid>', value)
    return value


def compare_gate(args, checks):
    a = json.loads((Path(args.baseline) / 'gate.json').read_text())
    b = json.loads((Path(args.candidate) / 'gate.json').read_text())
    checks.append({'id': 'case-matrix', 'pass': len(a) == GATE_CASES and set(a) == set(b),
                   'reason': 'every gate branch in enforce and advisory on both owners', 'failureCode': 1})
    cases = []
    for name in a:
        passed = name in b and gate_canonical(a[name]) == gate_canonical(b[name])
        checks.append({'id': 'compare:' + name, 'pass': passed,
                       'reason': 'decision, status, code, detail and the rows it writes must match Bun',
                       'failureCode': 1})
        cases.append({'id': name, 'pass': passed})
    return {'suite': args.suite, 'cases': cases, 'behaviorQualified': all(c['pass'] for c in checks)}


# Operations reads: Bun and native answer the same cases on one frozen store,
# so nothing is minted per owner and every field compares exactly. Run
# previews mint dry ids and hashes per compile; the e2e masks those by role.
OPS_CASES = 32


def compare_ops(args, checks):
    a = json.loads((Path(args.baseline) / 'ops.json').read_text())
    b = json.loads((Path(args.candidate) / 'ops.json').read_text())
    checks.append({'id': 'case-matrix', 'pass': len(a) == OPS_CASES and set(a) == set(b),
                   'reason': 'bindings, runtime-diagnostics, broker-forensics, federation runtimes and run-preview '
                             'cases on both owners', 'failureCode': 1})
    cases = []
    for name in a:
        passed = name in b and canonical(a[name]) == canonical(b[name])
        checks.append({'id': 'compare:' + name, 'pass': passed,
                       'reason': 'status, fields, values and key order must match Bun on the same store',
                       'failureCode': 1})
        cases.append({'id': name, 'pass': passed})
    return {'suite': args.suite, 'cases': cases, 'behaviorQualified': all(c['pass'] for c in checks)}


# First-turn watchdog: each owner trips the same armed rows on its own copy of
# one frozen store. The e2e masks timestamps, the scratch root and event seqs
# (by ordinal among the watchdog events); everything else compares in order.
WATCHDOG_SECTIONS = ('events', 'watches', 'runs', 'artifacts', 'bundles', 'webhook', 'emissions')


def compare_watchdog(args, checks):
    a = json.loads((Path(args.baseline) / 'watchdog.json').read_text())
    b = json.loads((Path(args.candidate) / 'watchdog.json').read_text())
    checks.append({'id': 'case-matrix', 'pass': len(a['events']) == 8 and len(a['bundles']) == 4
                   and len(a['webhook']) == 8 and set(a) == set(WATCHDOG_SECTIONS) == set(b),
                   'reason': 'four trips with diagnostics and bridged (each retried once), three rows left '
                             'armed, on both owners', 'failureCode': 1})
    cases = []
    for name in WATCHDOG_SECTIONS:
        passed = canonical(a[name]) == canonical(b[name])
        checks.append({'id': 'compare:' + name, 'pass': passed,
                       'reason': 'fields, values and key order must match Bun on the same fixture store',
                       'failureCode': 1})
        cases.append({'id': name, 'pass': passed})
    return {'suite': args.suite, 'cases': cases, 'behaviorQualified': all(c['pass'] for c in checks)}


# Collective history: A's owners (bun, native) read through one S, or one A
# read through an S of each owner. observedAt is the authority's clock.
HISTORY_CASES = {'a': 15, 'authority': 20}


def compare_history(args, checks):
    a = json.loads((Path(args.baseline) / 'history.json').read_text())
    b = json.loads((Path(args.candidate) / 'history.json').read_text())
    side = 'authority' if Path(args.baseline).name == 'authority' else 'a'
    checks.append({'id': 'case-matrix', 'pass': len(a) == HISTORY_CASES[side] and set(a) == set(b),
                   'reason': 'collective queries, the unreachable fallback and peer history verbs on both owners',
                   'failureCode': 1})
    cases = []
    for name in a:
        passed = name in b and canon_history(a[name]) == canon_history(b[name])
        checks.append({'id': 'compare:' + name, 'pass': passed,
                       'reason': 'status, fields, values and key order must match Bun', 'failureCode': 1})
        cases.append({'id': name, 'pass': passed})
    return {'suite': args.suite, 'cases': cases, 'behaviorQualified': all(c['pass'] for c in checks)}


def canon_history(value):
    if isinstance(value, dict):
        return [(k, '<dynamic>' if k in DYNAMIC or k == 'observedAt' else canon_history(x)) for k, x in value.items()]
    if isinstance(value, list):
        return [canon_history(x) for x in value]
    return value


# svc on its own data (T-11931): one scratch svc per owner on a copy of the
# real registry and collective-history rows. Read cases compare every value,
# seeded clocks included; only rows a case writes carry clocks minted per run.
SVC_AUTHORITY_CASES = 69
# Inbound verbs native does not serve yet (peer_listener.rs answers
# peer_upgrade_required); Bun advertises them, native leaves them absent so a
# capability-gated origin refuses typed instead of calling. svc saw 0 of each in
# the 14 days before T-11931.
SVC_UNSERVED_CAPABILITIES = ('establish', 'rosterStart', 'exactStart', 'semanticTurnHandoff')


def svc_canonical(value, mutates):
    if isinstance(value, dict):
        return [(k, '<dynamic>' if k in DYNAMIC or k in ('observedAt', 'startedAt')
                 or (mutates and k in REGISTRY_DYNAMIC)
                 else svc_canonical(x, mutates)) for k, x in value.items()]
    if isinstance(value, list):
        return [svc_canonical(x, mutates) for x in value]
    return value


def compare_svc_authority(args, checks):
    a = json.loads((Path(args.baseline) / 'svc-authority.json').read_text())
    b = json.loads((Path(args.candidate) / 'svc-authority.json').read_text())
    checks.append({'id': 'case-matrix', 'pass': len(a) == SVC_AUTHORITY_CASES and list(a) == list(b),
                   'reason': 'every registry, peer-history and local case on both svc owners', 'failureCode': 1})
    cases = []
    for name, x in a.items():
        y = b.get(name, {})
        if name == 'peer:health':
            caps = x.get('body', {}).get('capabilities', {})
            x = {**x, 'body': {**x['body'], 'capabilities': {
                k: v for k, v in caps.items() if k not in SVC_UNSERVED_CAPABILITIES}}}
        passed = all(svc_canonical(x.get(k), x['mutates']) == svc_canonical(y.get(k), x['mutates'])
                     for k in ('status', 'body'))
        checks.append({'id': 'compare:' + name, 'pass': passed,
                       'reason': 'status, fields, values and key order must match Bun on svc data', 'failureCode': 1})
        cases.append({'id': name, 'pass': passed, 'bunMs': x['ms'], 'nativeMs': y.get('ms')})
    return {'suite': args.suite, 'cases': cases, 'behaviorQualified': all(c['pass'] for c in checks)}
