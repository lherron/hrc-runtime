#!/usr/bin/env python3
"""External HRC conformance driver. No daemon imports or implicit endpoints."""
import argparse
from collections import Counter
from contextlib import closing
import hashlib
import http.client
import json
import os
from pathlib import Path
import socket
import pty
import re
import select
import signal
import sqlite3
import subprocess
import sys
import time
import threading
import traceback
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[2]
MANDATORY = ('identity-isolation', 'cold-second-turn', 'attach-restart-resume-terminate',
             'finite-store', 'streams-errors', 'direct-cli-sdk', 'wrkq',
             'fallback-performance', 'jobs-files-listeners')
STATUS_FIELDS = {'api.dbPath': str, 'binaryPath': str, 'packagePath': str,
                 'release.runningEqualsInstalled': bool,
                 'release.hrcBuild.sourceCommit': str}


def release_files(root):
    root = Path(root).resolve()
    entries = {}
    for path in sorted(root.rglob('*')):
        name = str(path.relative_to(root))
        if path.is_symlink():
            if not path.resolve().is_relative_to(root):
                raise ValueError('release symlink escapes release: ' + str(path))
            entries[name] = {'link': os.readlink(path)}
        elif path.is_file():
            entries[name] = {'sha256': digest(path)}
    return entries


def observe_installed_copy(profile):
    original = Path(profile['installedReleaseRoot']).resolve()
    copied = Path(profile['copiedReleaseRoot']).resolve()
    root = Path(profile['scratchRoot']).resolve()
    if not copied.is_relative_to(root) or copied.parent.name == 'hrc-runtime-releases':
        raise ValueError('installed copy must be unmanaged inside scratch')
    if original.parent.name != 'hrc-runtime-releases':
        raise ValueError('original is not an installed atomic release')
    manifest = json.loads((original / 'praesidium-release.json').read_text())
    return {'originalRoot': str(original), 'copiedRoot': str(copied),
            'manifest': manifest, 'manifestRaw': (original / 'praesidium-release.json').read_text(),
            'originalFiles': release_files(original),
            'copiedFiles': release_files(copied)}


def verify_installed_copy(observation, status, checks):
    original, copied = observation.get('originalFiles'), observation.get('copiedFiles')
    manifest = observation.get('manifest', {})
    root = Path(observation.get('copiedRoot', '/ABSENT'))
    raw = observation.get('manifestRaw', '')
    valid_manifest = (bool(manifest.get('releaseId')) and
        bool(manifest.get('hrcBuild', {}).get('sourceCommit')) and
        json.loads(raw or '{}') == manifest and
        (original or {}).get('praesidium-release.json', {}).get('sha256') ==
        hashlib.sha256(raw.encode()).hexdigest())
    check(checks, 'status:installed-copy-bytes', bool(original) and original == copied and valid_manifest,
          'copied installed release must retain every file and its original manifest')
    check(checks, 'status:installed-copy-owner', status.get('release', {}).get('mode') == 'unmanaged'
          and status.get('release', {}).get('runningEqualsInstalled') is False
          and Path(status.get('binaryPath', '/ABSENT')).resolve() == root / 'packages/hrc-cli/src/cli.ts'
          and Path(status.get('packagePath', '/ABSENT')).resolve() == root / 'packages/hrc-server',
          'unmanaged scratch owner must execute the byte-identical installed copy')


def get(value, path):
    for key in path.split('.'):
        if isinstance(value, list):
            value = value[int(key)]
        else:
            value = value[key]
    return value


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def write(path, data):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_text(json.dumps(data, indent=2, sort_keys=True) + '\n')


def check(checks, id, passed, reason, code=1):
    checks.append({'id': id, 'pass': bool(passed), 'reason': reason, 'failureCode': code})


def status_checks(status, checks, installed_copy=None):
    if installed_copy:
        verify_installed_copy(installed_copy, status, checks)
        fields = {k: v for k, v in STATUS_FIELDS.items() if k != 'release.hrcBuild.sourceCommit'}
    else:
        fields = STATUS_FIELDS
    for path, kind in fields.items():
        try:
            value = get(status, path)
            ok = type(value) is kind and (kind is bool or bool(value))
        except (KeyError, TypeError, ValueError):
            ok = False
        check(checks, 'status:' + path, ok, 'required observed status field/type: ' + path)
    if not installed_copy and isinstance(status.get('release'), dict):
        check(checks, 'status:running-installed', status['release'].get('runningEqualsInstalled') is True,
              'running release must equal the admitted installed subject')


def validate_evidence(data, directory, checks):
    control = data.get('claim') == 'checker-control'
    required_cases = ('cold-second-turn',) if control else MANDATORY
    check(checks, 'artifact:claim', data.get('claim') in
          ('checker-control', 'bun-compatibility', 'full-parity'), 'unknown evidence claim', 2)
    check(checks, 'artifact:complete', data.get('complete') is True,
          'run interrupted or completion marker absent', 3)
    cases = data.get('cases', [])
    check(checks, 'suite:nonempty', isinstance(cases, list) and len(cases) > 0,
          'empty suite is a coverage gap', 2)
    ids = [c.get('id') for c in cases]
    check(checks, 'suite:unique', len(set(ids)) == len(ids), 'duplicate case identities', 2)
    check(checks, 'suite:mandatory', set(required_cases) <= set(ids) and
          set(data.get('coverage', {}).get('required', [])) == set(required_cases),
          'mandatory coverage is runner-owned; serialized coverage.required cannot reduce it', 2)
    for case in cases:
        id = str(case.get('id'))
        state = case.get('status')
        check(checks, id + ':executed', state in ('PASS', 'FAIL', 'BASELINE_FAILURE', 'INFRA_ERROR'),
              'case not executed: ' + str(state), 2)
        if state in ('FAIL', 'BASELINE_FAILURE', 'INFRA_ERROR'):
            check(checks, id + ':result', False, 'nonpassing case: ' + str(state),
                  3 if state == 'INFRA_ERROR' else 1)
        assertions = case.get('assertions', [])
        check(checks, id + ':assertions', bool(assertions), 'no discriminating assertions', 2)
        for item in assertions:
            if item.get('pass') is not True:
                check(checks, id + ':' + str(item.get('id')), False,
                      item.get('reason', 'recorded baseline failure'))
            if id == 'cold-second-turn':
                check(checks, id + ':semantic-validator', item.get('validator') == 'turn-evidence'
                      and 'predicate' not in item,
                      'semantic turn assertion cannot be replaced by a profile status predicate')
        evidence = case.get('evidence', [])
        valid_paths = bool(evidence) and all(
            (directory / e).is_file() and (directory / e).resolve().is_relative_to(directory.resolve())
            for e in evidence)
        check(checks, id + ':evidence', valid_paths, 'case evidence absent or outside artifact root', 2)
        if not control and valid_paths:
            observations = [json.loads((directory / e).read_text()) for e in evidence]
            validate_case_observations(id, observations, checks, data.get('status'), data.get('installedCopy'))
    status_checks(data.get('status', {}), checks, data.get('installedCopy'))
    if not control:
        report_path = directory / 'coverage-report.json'
        check(checks, 'artifact:coverage-report', report_path.is_file() and
              digest(report_path) == data.get('coverageReportHash'),
              'source identity must bind the actual generated coverage report', 2)
        if data.get('installedCopy'):
            copy_path = directory / 'installed-copy.json'
            check(checks, 'artifact:installed-copy', copy_path.is_file() and
                  json.loads(copy_path.read_text()) == data['installedCopy'],
                  'copy identity must bind the observed installed files')
        check(checks, 'artifact:installed-surface', data.get('validationSurface') == 'installed',
              'source evidence cannot qualify an installed compatibility baseline', 2)
        identity_observations = []
        for case in cases:
            if case.get('id') == 'identity-isolation':
                for path in case.get('evidence', []):
                    if (directory / path).is_file():
                        observation = json.loads((directory / path).read_text())
                        if isinstance(observation, dict):
                            identity_observations.append(observation)
        cli_statuses = [o for o in identity_observations if o.get('exit') == 0
            and all(word in o.get('argv', []) for word in ('server', 'status', '--json'))]
        check(checks, 'status:raw-CLI-binding', len(cli_statuses) == 1
            and cli_statuses[0].get('body') == data.get('status'),
            'serialized status must equal the actual CLI status observation')
        api_statuses = [o for o in identity_observations if o.get('method') == 'GET'
            and o.get('path') == '/v1/status' and o.get('status') == 200]
        check(checks, 'status:raw-API-binding', len(api_statuses) == 1 and all(
            api_statuses[0].get('body', {}).get(key) == data.get('status', {}).get('api', {}).get(key)
            for key in ('dbPath', 'runtimeRoot', 'stateRoot', 'socketPath', 'binaryPath', 'packagePath')),
            'CLI/API owner destinations must agree in raw observations')
        joins = []
        for case in cases:
            if case.get('id') == 'cold-second-turn':
                for e in case.get('evidence', []):
                    path = directory / e
                    if path.is_file():
                        o = json.loads(path.read_text())
                        if isinstance(o, dict) and o.get('kind') == 'turn-ledger':
                            joins.append(o)
        check(checks, 'turn:real-ledger-source', len(joins) == 1,
              'exactly one final real broker/lifecycle ledger join is required')
        if len(joins) == 1:
            observed_events, observed_effects = derive_turns(joins[0])
            check(checks, 'turn:serialized-events', data.get('events') == observed_events,
                  'serialized turn events disagree with raw committed ledger observations')
            check(checks, 'turn:serialized-effects', data.get('effects') == observed_effects,
                  'serialized effects disagree with raw committed ledger observations')
    effects = data.get('effects', [])
    check(checks, 'effects:nonempty', bool(effects), 'nonempty durable effects required')
    keys = [effect.get('key') for effect in effects]
    check(checks, 'effects:unique', len(set(keys)) == len(keys) and all(keys),
          'duplicate or missing effect identity')
    for effect in effects:
        check(checks, 'effect:' + str(effect.get('key')), effect.get('count') == 1,
              'durable effect cardinality must be exactly one')
    events = data.get('events', [])
    check(checks, 'events:nonempty', bool(events), 'nonempty final and terminal observations required')
    messages = [e for e in events if e.get('eventKind') == 'turn.message' and e.get('final') is True]
    terminals = [e for e in events if e.get('eventKind') == 'turn.completed']
    fields = ('identity', 'invocationId', 'runtimeId', 'scopeRef', 'laneRef', 'generation')
    for event in messages + terminals:
        valid = all(isinstance(event.get(k), str) and bool(event[k]) for k in fields[:-1]) and \
                type(event.get('generation')) is int and event['generation'] >= 0
        check(checks, 'turn:correlation', valid, 'nonempty actual turn/invocation correlation fence required')
    identities = {(e.get('identity'), e.get('invocationId')) for e in messages}
    check(checks, 'turn:two-identities', len(identities) >= 2,
          'two distinct real turn/invocation identities required')
    check(checks, 'turn:two-terminals', len(terminals) >= 2,
          'two distinct completed turn observations required')
    for message in messages:
        matches = [e for e in terminals if all(e.get(k) == message.get(k) for k in fields)]
        check(checks, 'terminal:' + str(message.get('identity')), len(matches) == 1,
              'final message needs exactly one correlated turn.completed, runId is conditional')
        check(checks, 'message:' + str(message.get('identity')), message.get('text', '').strip() == 'OK',
              'blank-seat final message must be exactly OK')
    if data.get('claim') == 'full-parity':
        check(checks, 'coverage:full', not data.get('coverage', {}).get('gaps'),
              'full parity has unresolved behavior gaps', 2)
        report_path = directory / 'coverage-report.json'
        report = json.loads(report_path.read_text()) if report_path.is_file() else {}
        passed = {c['id'] for c in cases if c.get('status') == 'PASS'}
        check(checks, 'coverage:full-source-obligations', bool(report.get('items')) and
              all(i.get('target') in passed for i in report['items']),
              'generated source coverage must map every item to a passing case', 2)


def derive_turns(observation):
    """Prove serialized scratch turns using raw broker identity and lifecycle fences.

    Legacy final message projections omit turnId, and hrc_event_seq can be null.
    Match the one final message inside consecutive terminal boundaries, and prove
    its exact text against the raw final for that terminal's actual broker turn.
    Run IDs are corroboration when present, never the identity source.
    """
    events = []
    previous = {}
    lifecycle = observation.get('lifecycleRows', [])
    broker = observation.get('brokerRows', [])
    for terminal in lifecycle:
        if terminal['event_kind'] != 'turn.completed':
            continue
        payload = json.loads(terminal['payload_json'])
        invocation, turn = payload.get('invocationId'), payload.get('turnId')
        fence = tuple(terminal.get(k) for k in ('runtime_id', 'scope_ref', 'lane_ref', 'generation'))
        messages = [r for r in lifecycle if r['event_kind'] == 'turn.message'
                    and tuple(r.get(k) for k in ('runtime_id', 'scope_ref', 'lane_ref', 'generation')) == fence
                    and previous.get(fence, 0) < r['hrc_seq'] < terminal['hrc_seq']
                    and json.loads(r['payload_json']).get('final') is True]
        envelopes = [{**json.loads(r['broker_envelope_json']), 'payload': json.loads(r['broker_event_json'])} for r in broker
                     if r.get('runtime_id') == terminal.get('runtime_id')]
        raw_finals = [e for e in envelopes if e.get('invocationId') == invocation
                      and e.get('turnId') == turn and e.get('type') == 'assistant.message.completed'
                      and e.get('payload', {}).get('final') is True]
        raw_terminals = [e for e in envelopes if e.get('invocationId') == invocation
                         and e.get('turnId') == turn and e.get('type') == 'turn.completed']
        previous[fence] = terminal['hrc_seq']
        if len(messages) != 1 or len(raw_finals) != 1 or len(raw_terminals) != 1:
            continue
        message = messages[0]
        text = json.loads(message['payload_json']).get('message', {}).get('content')
        raw_text = ''.join(p.get('text', '') for p in raw_finals[0]['payload'].get('content', []) if p.get('type') == 'text')
        if text != raw_text or not invocation or not turn:
            continue
        for row in (message, terminal):
            events.append({'identity': turn, 'invocationId': invocation,
                'runtimeId': row['runtime_id'], 'scopeRef': row['scope_ref'],
                'laneRef': row['lane_ref'], 'generation': row['generation'],
                'eventKind': row['event_kind'], 'final': row is message,
                'text': text if row is message else '', 'hrcSeq': row['hrc_seq']})
    # Count raw terminal effects as well, including duplicates hidden by a
    # projected lifecycle seam. Both durable sources must have cardinality one.
    counts = Counter((json.loads(r['payload_json']).get('invocationId'),
                      json.loads(r['payload_json']).get('turnId'))
                     for r in lifecycle if r['event_kind'] == 'turn.completed')
    effects = [{'key': str(k[0]) + ':' + str(k[1]), 'invocationId': k[0], 'identity': k[1],
                'source': 'lifecycle', 'count': count} for k, count in counts.items()]
    for row in broker:
        envelope = json.loads(row['broker_envelope_json'])
        if envelope.get('type') == 'turn.completed':
            key = 'raw:' + str(envelope.get('invocationId')) + ':' + str(envelope.get('turnId'))
            match = next((e for e in effects if e['key'] == key), None)
            if match:
                match['count'] += 1
            else:
                effects.append({'key': key, 'invocationId': envelope.get('invocationId'),
                    'identity': envelope.get('turnId'), 'source': 'broker', 'count': 1})
    return events, effects


def validate_case_observations(id, observations, checks, status=None, installed_copy=None):
    """Re-evaluate raw external responses/SQL/PTY, never serialized pass flags."""
    if not all(isinstance(o, dict) for o in observations):
        check(checks, id + ':semantic:raw-schema', False, 'case observations must be raw observation objects', 2)
        return
    def http(method, path):
        return [o for o in observations if isinstance(o, dict) and o.get('method') == method
                and o.get('path', '').split('?')[0] == path]
    def success(method, path):
        return [o for o in http(method, path) if 200 <= o.get('status', 0) < 300]
    def cli(words):
        return [o for o in observations if isinstance(o, dict) and o.get('exit') == 0
                and all(w in o.get('argv', []) for w in words)]
    def require(label, passed):
        check(checks, id + ':semantic:' + label, passed, id + ': required real ' + label + ' evidence absent')
    def preparations_valid(minimum):
        captures = [o for o in observations if o.get('kind') == 'preparation']
        try:
            identities = set()
            for capture in captures:
                roots = capture['admittedRoots']
                root = Path(roots['scratchRoot']).resolve()
                if not all(Path(roots[k]).resolve().is_relative_to(root) for k in ('agentRoot', 'projectRoot')):
                    return False
                if not capture['rows']:
                    return False
                for row in capture['rows']:
                    prepared = json.loads(row['preparation_json'])
                    if row['runtime_id'] != capture['runtimeId'] or prepared['runtimeId'] != row['runtime_id'] or prepared['generation'] != row['generation']:
                        return False
                    identities.add((row['runtime_id'], row['generation']))
                    for placement in (prepared['intent']['placement'], prepared['response']['plan']['placement']):
                        if any(Path(placement[k]).resolve() != Path(roots[target]).resolve()
                               for k, target in (('agentRoot','agentRoot'),('projectRoot','projectRoot'),('cwd','projectRoot'))):
                            return False
                    frozen = prepared['admission']['execution']['dispatchRequest']['startRequest']['spec']['process']
                    if Path(frozen['cwd']).resolve() != Path(roots['projectRoot']).resolve():
                        return False
                    if Path(prepared['response']['plan']['resolvedBundle']['cwd']).resolve() != Path(roots['projectRoot']).resolve():
                        return False
            expected = {o.get('body', {}).get('runtimeId') for o in success('POST', '/v1/runtimes/start')}
            expected |= {o.get('body', {}).get('launch', {}).get('runtimeId') for o in success('POST', '/v1/sessions/restart')}
            expected.discard(None)
            return len(identities) >= minimum and {runtime for runtime, generation in identities} == expected
        except (KeyError, TypeError, ValueError):
            return False
    if id == 'identity-isolation':
        require('owner-status', bool(success('GET', '/v1/status')))
        require('health', bool(success('GET', '/v1/health')))
        require('Bun-alone', any(o.get('kind') == 'owner-observation' and o.get('ownerPid') in o.get('scratchPids', [])
            and o.get('rustOwners') == [] and o.get('dbPids') == [o.get('ownerPid')]
            for o in observations if isinstance(o, dict)))
    elif id == 'cold-second-turn':
        require('start', bool(success('POST', '/v1/runtimes/start')))
        require('submission', bool(success('POST', '/v1/submissions/invoke')))
        require('real-ledger-join', any(o.get('kind') == 'turn-ledger' and len(derive_turns(o)[0]) >= 4 for o in observations if isinstance(o, dict)))
        require('effective-preparation-roots', preparations_valid(1))
    elif id == 'attach-restart-resume-terminate':
        require('effective-preparation-roots', preparations_valid(2))
        restarts = success('POST', '/v1/sessions/restart')
        require('fenced-generation-advance', any(type(o.get('request', {}).get('expectedGeneration')) is int
            and type(o.get('body', {}).get('generation')) is int
            and o['body']['generation'] > o['request']['expectedGeneration'] for o in restarts))
        require('resume', bool(success('POST', '/v1/sessions/resume-continuation')))
        require('resume-final', any(o.get('body', {}).get('events') and any(
            e.get('eventKind') == 'turn.completed' and e.get('payload', {}).get('success') is True
            for e in o['body']['events']) for o in success('GET', '/v1/events/tail')))
        require('terminate', bool(success('POST', '/v1/terminate')))
        require('PTY-attach-detach', any(o.get('transport') == 'pty' and isinstance(o.get('attachedClient'), dict)
            and o['attachedClient'].get('pid') == o.get('childPid')
            and o['attachedClient'].get('session') == o.get('expectedSession')
            and (not o.get('expectedWindow') or o['attachedClient'].get('window') == o['expectedWindow'])
            and o.get('detachExit') == 0 and o.get('exit') == 0
            and o.get('runtimeAliveBefore') is True and o.get('runtimeAliveAfter') is True
            and all(c.get('pid') != o.get('childPid') for c in o.get('clientsAfter', []))
            for o in observations if isinstance(o, dict)))
        require('terminated-substrate', any(o.get('kind') == 'substrate' and o.get('processes') == [] for o in observations if isinstance(o, dict)))
    elif id == 'finite-store':
        pages = success('GET', '/v1/events/page')
        require('nonempty-page', any(o.get('body', {}).get('rows') for o in pages))
        require('cursor-mismatch-refusal', any(o.get('body', {}).get('error', {}).get('code') == 'cursor_invalid'
            for o in http('GET', '/v1/events/page')))
        from urllib.parse import parse_qs
        def full_page(o):
            body = o.get('body', {})
            limit = int(parse_qs(urlparse(o['path']).query).get('limit', ['0'])[0])
            return limit > 0 and len(body.get('rows', [])) == limit and body.get('scannedThrough', -1) < body.get('head', -1)
        def short_page(o):
            body = o.get('body', {})
            limit = int(parse_qs(urlparse(o['path']).query).get('limit', ['0'])[0])
            seqs = [r.get('hrcSeq') for r in body.get('rows', [])]
            return (limit > len(seqs) > 0 and body.get('scannedThrough') == body.get('head')
                    and all(type(x) is int for x in seqs) and seqs == sorted(set(seqs)))
        require('full-and-short-pages', any(full_page(o) for o in pages) and any(short_page(o) for o in pages))
        require('highwater-holes-spill', any(o.get('kind') == 'store-observation' and type(o.get('head')) is int and o.get('holes') and o.get('spillCount', 0) > 0 for o in observations if isinstance(o, dict)))
        seeds = [o.get('body', {}) for o in observations if o.get('sdk') is True and o.get('exit') == 0 and 'seed' in o.get('argv', [])]
        stores = [o for o in observations if o.get('kind') == 'store-observation']
        require('deleted-highest-preserved', any(seed.get('fixtureOnly') is True
            and len(seed.get('deleted', [])) == 2 and all(seq not in store.get('seqs', []) for seq in seed['deleted'])
            and store.get('head', -1) >= max(seed['deleted']) for seed in seeds for store in stores))
        require('spill-stub', any(any(r.get('payload', {}).get('result', {}).get('details', {}).get('spill', {}).get('bytes', 0) > 512 * 1024
            and r['payload']['result']['details']['spill'].get('kind') == 'lifecycle_canonical'
            and len(json.dumps(r['payload']['result'])) < 512 * 1024
            for r in o.get('body', {}).get('rows', []) if r.get('eventKind') == 'turn.tool_result') for o in pages))
    elif id == 'streams-errors':
        streams = [o for o in observations if isinstance(o, dict) and 'frames' in o]
        def valid_stream(o):
            try:
                frames = [json.loads(f['raw']) for f in o['frames'] if f['raw'].strip()]
                ready = frames[0]
                events = [f for f in frames if f.get('type') == 'event']
                head = ready['replayHeadHrcSeq']
                seqs = [f['event']['hrcSeq'] for f in events]
                incarnation = ready['ledgerIncarnationId']
                return (o.get('closed') is True and not o.get('errors') and ready['type'] == 'ready'
                    and type(head) is int and bool(incarnation) and all(f['ledgerIncarnationId'] == incarnation for f in events)
                    and seqs == sorted(set(seqs)) and any(x <= head for x in seqs) and any(x > head for x in seqs)
                    and any(f['event'].get('eventKind') == 'turn.completed' and f['event']['hrcSeq'] > head for f in events))
            except (ValueError, KeyError, TypeError, IndexError):
                return False
        require('live-frames', any(valid_stream(o) for o in streams))
        require('ordered-unique', any(valid_stream(o) for o in streams))
        require('abort-timeout', any(o.get('closed') is True and o.get('closeDurationMs', 999999) < 3000 for o in streams))
        require('unknown-route', any(o.get('status') == 404 and o.get('path') == '/v1/p0-unknown'
            for o in observations if isinstance(o, dict)))
        require('malformed-body', any(o.get('status') in (400, 422) and o.get('rawRequest') == '{'
            for o in observations if isinstance(o, dict)))
        require('missing-field', any(o.get('status') == 400 and o.get('request') == {} for o in http('POST', '/v1/sessions/resolve')))
        require('wrong-method', any(o.get('status') == 404 for o in http('DELETE', '/v1/health')))
    elif id == 'direct-cli-sdk':
        for words in (['--help'], ['monitor', 'show'], ['monitor', 'watch'], ['run', 'export'], ['run', 'annotate']):
            require('CLI-' + '-'.join(words), bool(cli(words)))
        require('monitor-show-watch-wait', all(cli(['monitor', verb]) for verb in ('show', 'watch', 'wait'))
            and any(o.get('body', {}).get('event') == 'monitor.completed'
                and o['body'].get('result') == 'matched' and o['body'].get('matchedCondition') == 'turn-finished'
                and o['body'].get('members') for o in cli(['monitor', 'wait'])))
        require('cli-alias', bool(cli(['ls', 'runtimes'])) and bool(cli(['list', 'runtimes'])))
        def ndjson(o):
            try:
                rows = [json.loads(line) for line in o.get('stdout', '').splitlines()]
                return bool(rows) and all(isinstance(row, dict) for row in rows)
            except ValueError:
                return False
        require('json-ndjson-exits', any(ndjson(o) for o in cli(['monitor', 'watch', 'ndjson'])))
        annotations = cli(['run', 'annotate'])
        exports = cli(['run', 'export'])
        require('run-bearing-export-annotation', bool(annotations) and any(
            o.get('body', {}).get('correlation', {}).get('attemptRef') == 'p0:compatibility'
            and any(set(a['argv']) & set(o['argv']) & {v for v in o['argv'] if v.startswith('run-')} for a in annotations)
            for o in exports))
        require('SDK-read', any(o.get('sdk') is True and 'health' in o.get('argv', []) and o.get('exit') == 0 and o.get('body', {}).get('ok') is True
            for o in observations if isinstance(o, dict)))
    elif id == 'wrkq':
        publications = [o for o in observations if isinstance(o, dict) and o.get('kind') == 'publication']
        def published(o):
            facts = o.get('facts', [])
            try:
                return (o.get('nodeId', '').startswith('p0-') and len(facts) > 0
                    and any(f.get('type', '').startswith('server.') for f in facts)
                    and any(f.get('type', '').startswith(('session.', 'turn.')) for f in facts)
                    and all(json.loads(f['attributes']).get('node') == o['nodeId'] for f in facts)
                    and all(f.get('idempotency_key') for f in facts)
                    and len({f['idempotency_key'] for f in facts}) == len(facts))
            except (ValueError, KeyError, TypeError):
                return False
        require('isolated-authority-publication', any(published(o) for o in publications))
        def cursors(o):
            before = {r['stream']: r['high_water'] for r in o.get('cursorsBefore', [])}
            after = {r['stream']: r['high_water'] for r in o.get('cursorsAfter', [])}
            owners = ('server-project-events', 'session-project-events')
            return (all(k in before and k in after and type(before[k]) is int and type(after[k]) is int for k in owners)
                and after[owners[1]] > before[owners[1]] and after[owners[0]] == before[owners[0]] > 0)
        require('two-cursor-owners', any(cursors(o) for o in publications))
        require('real-unavailable-authority', any(o.get('kind') == 'authority-unavailable' and o.get('exit') != 0 and 'refused' in o.get('stderr', '').lower() for o in observations if isinstance(o, dict)))
        expected_commit = (status or {}).get('release', {}).get('hrcBuild', {}).get('sourceCommit')
        if expected_commit:
            require('HRC-unavailable-source-tuple', any(
                json.loads(r.get('payload_json', '{}')).get('sourceCommit') == expected_commit
                and json.loads(r.get('payload_json', '{}')).get('release') == status['release'].get('releaseId')
                and isinstance(status['release'].get('releaseId'), str)
                for o in observations if o.get('kind') == 'hrc-authority-unavailable' for r in o.get('events', [])
                if r.get('eventKind') == 'server.started'))
        if installed_copy:
            expected_cli = Path(installed_copy['copiedRoot']) / 'packages/hrc-cli/src/cli.ts'
            require('HRC-unavailable-installed-copy', any(
                any(word.startswith('/') and Path(word).resolve() == expected_cli
                    for word in o.get('processBeforeStop', {}).get('stdout', '').split())
                and any(word.startswith('/') and Path(word).resolve() == expected_cli
                    for word in o.get('launch', '').split())
                for o in observations if o.get('kind') == 'hrc-authority-unavailable'))
        require('HRC-unavailable-authority', any(o.get('kind') == 'hrc-authority-unavailable'
            and o.get('processBeforeStop', {}).get('exit') == 0 and 'server serve' in o['processBeforeStop'].get('stdout', '')
            and o.get('environment', {}).get('HRC_WRKQ_DB') == o.get('environment', {}).get('WRKQ_DB') == 'rpc://127.0.0.1:1'
            and any(r.get('event') == 'server_project_event.post_failed'
                    and r.get('data', {}).get('type') == 'server.started' and r['data'].get('error')
                    for r in o.get('failures', []))
            and any(r.get('stream') == 'server-project-events' and r.get('high_water') == 0 for r in o.get('cursors', []))
            and any(r.get('eventKind') == 'server.started' and r.get('hrc_seq', 0) > 0 for r in o.get('events', []))
            and o.get('processProbe', {}).get('exit') != 0
            for o in observations if isinstance(o, dict)))
    elif id == 'fallback-performance':
        statuses = success('GET', '/v1/status')
        fields = ('release', 'dbPath', 'runtimeRoot', 'stateRoot', 'socketPath', 'binaryPath', 'packagePath')
        require('same-fallback-repeat', len(statuses) >= 2 and all(
            statuses[0].get('body', {}).get(key) == statuses[-1].get('body', {}).get(key) for key in fields))
        samples = [o['durationMs'] for o in observations if isinstance(o, dict) and 'durationMs' in o]
        require('measured-finite-samples', len(samples) >= 30)
        require('resource-observation', any(o.get('kind') == 'resource' and o.get('rssKb', 0) > 0 for o in observations if isinstance(o, dict)))
    elif id == 'jobs-files-listeners':
        require('source-inventory', any(o.get('inventoryComplete') is True for o in observations if isinstance(o, dict)))
        require('startup-stop-effects', any(o.get('kind') == 'server-log'
            and 'server.start.ready' in o.get('events', []) and 'broker.warmup.complete' in o.get('events', [])
            and any(r.get('event_kind') == 'server.started' for r in o.get('lifecycleRows', []))
            and any(r.get('event_kind') == 'server.stopped' and json.loads(r.get('payload_json', '{}')).get('pid')
                    for r in o.get('lifecycleRows', [])) for o in observations if isinstance(o, dict)))
    else:
        require('known-case', False)


def compare(args, checks):
    if getattr(args, 'suite', None) == 'n2-continuation':
        from n2_continuation import compare as compare_n2_continuation
        return compare_n2_continuation(args, checks)
    if getattr(args, 'suite', None) == 'n2-routes':
        from n2_routes import compare as compare_n2_routes
        return compare_n2_routes(args, checks)
    if getattr(args, 'suite', None) == 'n2-attached':
        from n2_attached import compare as compare_n2_attached
        return compare_n2_attached(args, checks)
    if getattr(args, 'suite', None) in ('n3-events','n3-subscribers','n3-mail','n3-presentation','n3-replay'):
        from n3_routes import compare as compare_n3
        return compare_n3(args, checks)
    if getattr(args, 'suite', None) == 'n4-federation':
        from n4_routes import compare as compare_n4
        return compare_n4(args, checks)
    if getattr(args, 'suite', None) == 'n2-turns':
        from n2_turns import compare as compare_n2_turns
        return compare_n2_turns(args, checks)
    if getattr(args, 'suite', None) == 'n1-maintenance':
        from n1_maintenance import compare as compare_maintenance
        return compare_maintenance(args, checks)
    if getattr(args, 'suite', None) == 'n1-participant-live':
        from n1_participants import compare_live
        return compare_live(args, checks)
    if getattr(args, 'suite', None) in ('n1-participants','n1-foundry-participants'):
        from n1_participants import compare as compare_participants
        return compare_participants(args, checks)
    if getattr(args, 'suite', None) == 'n1-session-projection':
        from n1_session_projection import compare as compare_projection
        return compare_projection(args, checks)
    if getattr(args, 'suite', None) == 'n1-front-accounting':
        from n1_front_accounting import compare as compare_front_accounting
        return compare_front_accounting(args, checks)
    if getattr(args, 'suite', None) == 'n1-target-placement':
        from n1_target_placement import compare as compare_target_placement
        return compare_target_placement(args, checks)
    if getattr(args, 'suite', None) == 'n1-surfaces':
        from n1_surfaces import compare as compare_surfaces
        return compare_surfaces(args, checks)
    if getattr(args, 'suite', None) == 'n1-runtime-reads':
        from n1_runtime_reads import compare as compare_runtime
        return compare_runtime(args, checks)
    if getattr(args, 'suite', None) == 'n1-index':
        from n1_index import compare as compare_index
        return compare_index(args, checks)
    if getattr(args, 'suite', None) == 'n1-accounting':
        from n1_routes import compare_accounting
        return compare_accounting(args, checks)
    if getattr(args, 'suite', None) == 'n1-routes':
        from n1_routes import compare as compare_n1_routes
        return compare_n1_routes(args, checks)
    if getattr(args, 'suite', None) == 'n1-passthrough':
        from n1_routes import compare_passthrough
        return compare_passthrough(args, checks)
    a, b = Path(args.baseline), Path(args.candidate)
    baseline = json.loads((a / 'summary.json').read_text())
    candidate = json.loads((b / 'summary.json').read_text())
    validate_evidence(baseline, a, checks)
    validate_evidence(candidate, b, checks)
    check(checks, 'inventory:identity', bool(baseline.get('coverageReportHash')) and baseline.get('coverageReportHash') == candidate.get('coverageReportHash'),
          'inventory source drift requires explicit baseline recapture', 2)
    # Only explicitly named identity fields can vary. Never erase missing keys,
    # result classifications, ordering, generations, error codes or effect counts.
    rules = candidate.get('normalization', {})
    mapping = rules.get('identities', {})
    check(checks, 'normalization:bijection', len(set(mapping.values())) == len(mapping),
          'identity normalization must be bijective', 2)
    identity_fields = set(rules.get('fields', []))
    check(checks, 'normalization:allowlist', identity_fields <= {
        'identity', 'invocationId', 'runtimeId', 'hostSessionId', 'runId', 'scopeRef'},
        'undeclared semantic normalization is forbidden', 2)
    def normalized(value):
        if isinstance(value, list):
            return [normalized(v) for v in value]
        if isinstance(value, dict):
            result = {k: mapping.get(v, v) if k in identity_fields and isinstance(v, str)
                    else normalized(v) for k, v in value.items()}
            if result.get('source') in ('lifecycle', 'broker') and 'key' in result:
                result['key'] = ('raw:' if result['source'] == 'broker' else '') + str(result.get('invocationId')) + ':' + str(result.get('identity'))
            return result
        return value
    for key in ('events', 'effects'):
        check(checks, 'compare:' + key, baseline.get(key) == normalized(candidate.get(key)),
              'behavior/order/effect difference: ' + key)
    return {'baseline': str(a), 'candidate': str(b),
            'controlOnly': candidate.get('claim') == 'checker-control',
            'behaviorQualified': candidate.get('claim') != 'checker-control' and all(c['pass'] for c in checks)}


class UnixHTTP(http.client.HTTPConnection):
    def __init__(self, path, timeout):
        super().__init__('localhost', timeout=timeout)
        self.path = path

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(self.path)


def request(profile, method, path, body=None, timeout=None, raw_body=None):
    client = UnixHTTP(profile['publicSocket'], timeout or profile.get('requestTimeoutSec', 10))
    raw = raw_body.encode() if raw_body is not None else (None if body is None else json.dumps(body).encode())
    started = time.monotonic()
    client.request(method, path, body=raw,
                   headers={'content-type': 'application/json', 'x-hrc-request-id': profile['runId']})
    response = client.getresponse()
    content = response.read(profile.get('maxResponseBytes', 16 * 1024 * 1024) + 1)
    if len(content) > profile.get('maxResponseBytes', 16 * 1024 * 1024):
        raise RuntimeError('response exceeds explicit capture bound; cannot call truncated evidence complete')
    result = {'method': method, 'path': path, 'request': body, 'rawRequest': raw_body, 'status': response.status,
              'headers': dict(response.getheaders()), 'raw': content.decode('utf-8', 'replace'),
              'durationMs': (time.monotonic() - started) * 1000}
    result['observedAt'] = time.time()
    try:
        result['body'] = json.loads(result['raw'])
    except ValueError:
        pass
    client.close()
    return result


def isolation(profile, output, checks):
    forbidden = Path('/Users/lherron/praesidium/var')
    root = Path(profile.get('scratchRoot', '/INVALID')).resolve()
    names = ('scratchRoot', 'publicSocket', 'dbPath', 'runtimeRoot', 'stateRoot', 'agentsRoot', 'agentRoot',
             'projectRoot', 'peerConfig', 'wrkqDbPath')
    for name in names:
        val = profile.get(name)
        valid = isinstance(val, str) and val.startswith('/')
        if valid:
            p = Path(val).resolve()
            valid = p.is_relative_to(root) and not p.is_relative_to(forbidden) and root != Path('/')
        check(checks, 'isolation:' + name, valid,
              'isolation requires an explicit scratch path: ' + name, 3)
    check(checks, 'isolation:output', not output.resolve().is_relative_to(root),
          'isolation: artifacts must survive scratch removal', 3)
    check(checks, 'isolation:scope', str(profile.get('scopePrefix', '')).startswith('agent:tabularasa:')
          and ':task:p0-' in profile.get('scopePrefix', ''), 'isolation requires a unique blank scratch scope', 3)
    check(checks, 'isolation:claim', profile.get('claim') == 'bun-compatibility',
          'P0 run certifies Bun compatibility only; native qualification needs downstream driver', 3)
    env = profile.get('env', {})
    check(checks, 'isolation:wrkq', env.get('HRC_WRKQ_DB') == env.get('WRKQ_DB') == profile.get('wrkqLocator')
          and bool(profile.get('wrkqLocator')), 'isolation requires both explicit wrkq destinations', 3)
    for key in ('WRKQ_DB_PATH', 'WRKQ_DB_PATH_FILE', 'WRKQD_TOKEN', 'WRKQD_NODE_TOKENS', 'WRKQD_NODE_TOKENS_FILE', 'WRKQD_UNIX'):
        check(checks, 'isolation:' + key, not env.get(key), 'isolation forbids inherited fleet credential/alias: ' + key, 3)
    locator = urlparse(profile.get('wrkqLocator', ''))
    if locator.scheme == 'rpc':
        check(checks, 'isolation:authority-locator', locator.hostname == '127.0.0.1'
              and locator.port == profile.get('wrkqPort') and locator.port >= 30000,
              'isolated wrkqd must use the allocated loopback authority port', 3)
        token_file = env.get('HRC_WRKQD_TOKEN_FILE', '')
        check(checks, 'isolation:authority-credential', bool(token_file)
              and token_file == env.get('WRKQD_TOKEN_FILE')
              and Path(token_file).resolve().is_relative_to(root)
              and Path(token_file).is_file(), 'explicit scratch credential file required', 3)
    else:
        check(checks, 'isolation:local-authority', profile.get('wrkqLocator') == profile.get('wrkqDbPath'),
              'local authority locator must name the verified scratch ledger', 3)
    expected = {'HRC_RUNTIME_DIR': 'runtimeRoot', 'HRC_STATE_DIR': 'stateRoot',
                'ASP_AGENTS_ROOT': 'agentsRoot', 'HRC_PROJECT_SEARCH_ROOTS': 'projectRoot',
                'HRC_PEER_CONFIG_FILE': 'peerConfig'}
    for key, field in expected.items():
        check(checks, 'isolation:env:' + key, env.get(key) == profile.get(field),
              'isolation environment mismatch: ' + key, 3)
    check(checks, 'isolation:webhook', env.get('HRC_ACP_WEBHOOK_URL', '') == '',
          'baseline must disable production ACP publication', 3)
    asp_path = Path(profile.get('aspAdmissionEvidence', '/ABSENT'))
    asp = json.loads(asp_path.read_text()).get('body', {}) if asp_path.is_file() else {}
    sources = asp.get('declaration', {}).get('agentSources', {})
    placement = asp.get('intent', {}).get('placement', {})
    check(checks, 'isolation:ASP', asp.get('declaration', {}).get('release', {}).get('releaseId')
          and Path(sources.get('agentsRoot', '/ABSENT')).resolve() == Path(profile.get('agentsRoot', '/MISSING')).resolve()
          and Path(placement.get('projectRoot', '/ABSENT')).resolve() == Path(profile.get('projectRoot', '/MISSING')).resolve(),
          'isolation requires observed ASP release and exact scratch agent/project destinations', 3)
    if Path(profile.get('peerConfig', '/ABSENT')).is_file():
        config = json.loads(Path(profile['peerConfig']).read_text())
        check(checks, 'isolation:peers', config.get('peers', {}) == {} and
              str(config.get('nodeId', '')).startswith('p0-'),
              'isolation baseline must have explicit scratch node and no production peers', 3)
    else:
        check(checks, 'isolation:peer-config', False, 'isolation peer configuration is absent', 3)
    for key in ('cliArgv', 'sdkArgv'):
        argv = profile.get(key, [])
        check(checks, 'isolation:' + key, bool(argv) and Path(argv[0]).is_absolute()
              and Path(argv[0]).is_file(), 'explicit executable required: ' + key, 3)
    check(checks, 'isolation:owner', isinstance(profile.get('ownerPid'), int) and
          profile.get('implementation') == 'bun' and profile.get('rustOwnerPids') == [],
          'Bun-alone needs exactly one declared real Bun owner and no scratch Rust owners', 3)


def assertion(actual, spec):
    op = spec['op']
    try:
        value = get(actual, spec['path']) if spec.get('path') else actual
    except (KeyError, IndexError, TypeError, ValueError):
        return op == 'absent'
    if op == 'exists':
        return True
    if op == 'absent':
        return False
    if op == 'equals':
        return type(value) is type(spec['value']) and value == spec['value']
    if op == 'type':
        return type(value).__name__ == spec['value']
    if op == 'nonempty':
        return bool(value)
    if op == 'count':
        return len(value) == spec['value']
    if op == 'unique':
        return len(value) == len({json.dumps(v, sort_keys=True) for v in value})
    if op == 'contains':
        return spec['value'] in value
    raise ValueError('unknown assertion operator: ' + op)


def admit_mutation(profile, method, path, body, hosts, runtimes):
    if method in ('GET', 'HEAD'):
        return
    if path == '/v1/health' and method == 'DELETE':
        return  # Exact wrong-method control.
    if path.startswith('/v1/internal/') and body == {}:
        return  # Retired callbacks have no live owner.
    if path == '/v1/sessions/resolve' and body in (None, {}):
        return  # Exact malformed/missing-body controls.
    if not isinstance(body, dict):
        raise ValueError('mutation requires an admitted request object')
    def scope(value):
        return value in (profile['scopePrefix'], profile['scopePrefix'] + '/lane:main')
    if path == '/v1/declarations/resolve':
        if all(Path(body.get(key, '/ABSENT')).resolve() == Path(profile[target]).resolve()
               for key, target in (('agentRoot', 'agentRoot'), ('projectRoot', 'projectRoot'), ('cwd', 'projectRoot'))):
            return
    elif path == '/v1/sessions/resolve' and scope(body.get('sessionRef')):
        return
    elif path == '/v1/submissions/invoke' and scope(body.get('target')) and scope(body.get('origin', {}).get('scopeRef')):
        return
    elif path in ('/v1/runtimes/start', '/v1/sessions/restart') and body.get('hostSessionId') in hosts:
        return
    elif path == '/v1/sessions/resume-continuation' and scope(body.get('sessionRef')) and body.get('priorHostSessionId') in hosts:
        return
    elif path == '/v1/terminate' and body.get('runtimeId') in runtimes:
        return
    raise ValueError('mutation selector is outside admitted scratch ownership: ' + path)


def run_suite(args, checks):
    if not args.profile:
        check(checks, 'profile:required', False, 'explicit --profile required', 2)
        return {}
    profile = json.loads(Path(args.profile).read_text())
    output = Path(args.out)
    profile.setdefault('runId', 'p0-' + str(time.time_ns()))
    isolation(profile, output, checks)
    if any(not c['pass'] for c in checks):
        return {'mutationRequests': 0}
    if profile.get('status') == 'design-example-not-admitted':
        check(checks, 'profile:admitted', False, 'example profile is not executable acceptance', 3)
        return {'mutationRequests': 0}
    if profile['wrkqLocator'].startswith('rpc://'):
        pid = profile.get('authorityPid', 0)
        authority = subprocess.run(['ps', '-p', str(pid), '-o', 'command='], capture_output=True, text=True, timeout=5)
        listener = subprocess.run(['/usr/sbin/lsof', '-nP', '-a', '-p', str(pid), '-iTCP:' + str(profile['wrkqPort']),
                                   '-sTCP:LISTEN', '-Fn'], capture_output=True, text=True, timeout=5)
        write(output / 'authority-process.json', {'pid': pid, 'argv': authority.stdout,
              'listener': listener.stdout, 'listenerStderr': listener.stderr, 'dbPath': profile['wrkqDbPath']})
        check(checks, 'isolation:authority-process', authority.returncode == 0
              and 'wrkqd' in authority.stdout and profile['wrkqDbPath'] in authority.stdout
              and '127.0.0.1:' + str(profile['wrkqPort']) in authority.stdout
              and listener.returncode == 0 and '127.0.0.1:' + str(profile['wrkqPort']) in listener.stdout,
              'scratch authority PID must own the explicit DB and loopback listener', 3)
        if any(not c['pass'] for c in checks):
            return {'mutationRequests': 0}
    owner = subprocess.run(['ps', '-p', str(profile['ownerPid']), '-o', 'command='],
                           capture_output=True, text=True, timeout=5)
    write(output / 'owner-process.json', {'pid': profile['ownerPid'], 'argv': owner.stdout, 'exit': owner.returncode})
    check(checks, 'owner:process', owner.returncode == 0 and 'server serve' in owner.stdout
          and profile['cliArgv'][0] in owner.stdout, 'owner pid must be admitted foreground Bun server serve', 3)
    if any(not c['pass'] for c in checks):
        return {'mutationRequests': 0}
    status_result = request(profile, 'GET', '/v1/status')
    write(output / 'identity-status.json', status_result)
    status = status_result.get('body', {})
    # The API status differs from the CLI envelope. Require real API keys first.
    for field in ('dbPath', 'runtimeRoot', 'stateRoot', 'socketPath', 'binaryPath', 'packagePath', 'release'):
        check(checks, 'owner:' + field, field in status, 'real owner field absent: ' + field, 3)
    for field, expected in (('dbPath', 'dbPath'), ('runtimeRoot', 'runtimeRoot'),
                            ('stateRoot', 'stateRoot'), ('socketPath', 'publicSocket')):
        check(checks, 'owner:path:' + field, status.get(field) == profile[expected],
              'wrong owner: observed ' + field + ' must match admitted scratch', 3)
    if any(not c['pass'] for c in checks):
        return {'mutationRequests': 0, 'status': status}
    with closing(sqlite3.connect('file:' + profile['dbPath'] + '?mode=ro', uri=True)) as db:
        existing = db.execute('SELECT count(*) FROM sessions WHERE scope_ref = ?', [profile['scopePrefix']]).fetchone()[0]
    check(checks, 'isolation:fresh-scope', existing == 0, 'scope already exists; never adopt an existing subject', 3)
    if existing:
        return {'mutationRequests': 0, 'status': status}
    definitions = json.loads((ROOT / 'contract/hrc-parity/cases.json').read_text())
    declared = profile.get('cases', [])
    by_id = {c['id']: c for c in declared}
    check(checks, 'profile:mandatory', set(MANDATORY) <= set(by_id),
          'mandatory P0 workflow definition absent; cannot downgrade to downstream gap', 2)
    if any(not c['pass'] for c in checks):
        return {'mutationRequests': 0, 'status': status}
    generated = inventory(argparse.Namespace(source_ref='HEAD', out=str(output)), checks)
    data = {'schema': 1, 'claim': profile['claim'], 'complete': False, 'status': {},
            'cases': [], 'events': [], 'effects': [], 'coverage': {'required': list(MANDATORY),
                'gaps': generated.get('coverage', {}).get('gaps', [])},
            'coverageReportHash': generated.get('coverageReportHash')}
    if profile.get('copiedReleaseRoot'):
        data['installedCopy'] = observe_installed_copy(profile)
        write(output / 'installed-copy.json', data['installedCopy'])
    write(output / 'manifest.json', {'profile': profile, 'source': source_identity(),
          'startedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'profileHash': digest(args.profile),
          'driverHash': digest(__file__),
          'producerTuple': status.get('release'),
          'executables': [{'path': str(Path(arg).resolve()), 'sha256': digest(arg)}
              for key in ('cliArgv', 'sdkArgv', 'wrkqArgv') for arg in profile[key]
              if Path(arg).is_absolute() and Path(arg).is_file()]})
    start = time.monotonic()
    variables = {k: v for k, v in profile.items() if isinstance(v, (str, int, bool))}
    followers = {}
    captures = []
    hosts, runtimes = set(), set()
    def expand(value):
        if isinstance(value, str) and value.startswith('$'):
            return variables[value[1:]]
        if isinstance(value, str):
            for key, replacement in variables.items():
                if not isinstance(replacement, (dict, list)):
                    value = value.replace('${' + key + '}', str(replacement))
            return value
        if isinstance(value, dict):
            return {k: expand(v) for k, v in value.items()}
        if isinstance(value, list):
            return [expand(v) for v in value]
        return value
    # Destructive lifecycle rotation follows all independent observations of this subject.
    execution_order = [id for id in MANDATORY if id != 'attach-restart-resume-terminate'] + ['attach-restart-resume-terminate']
    for id in execution_order:
        case_started = time.monotonic()
        spec = by_id[id]
        record = {'id': id, 'status': 'PASS', 'assertions': [], 'evidence': []}
        required = definitions['cases'][id]['assertionIds']
        actions = spec.get('actions', [])
        check(checks, id + ':actions', bool(actions), 'no executable actions for mandatory case', 2)
        seen = set()
        try:
            for n, action in enumerate(actions):
                action_started = time.monotonic()
                if time.monotonic() - start > profile.get('suiteTimeoutSec', 1800):
                    raise TimeoutError('suite deadline exceeded; evidence incomplete')
                kind = action['kind']
                if kind == 'http':
                    target = expand(action['path'])
                    if not target.startswith('/v1/'):
                        raise ValueError('HTTP action must use admitted public endpoint')
                    body = expand(action.get('body'))
                    admit_mutation(profile, action.get('method', 'GET'), target, body, hosts, runtimes)
                    actual = request(profile, action.get('method', 'GET'), target, body,
                                     raw_body=action.get('rawBody'))
                    if 200 <= actual.get('status', 0) < 300:
                        result = actual.get('body', {})
                        if isinstance(result, dict):
                            if result.get('hostSessionId'):
                                hosts.add(result['hostSessionId'])
                            if result.get('runtimeId'):
                                runtimes.add(result['runtimeId'])
                            if result.get('launch', {}).get('runtimeId'):
                                runtimes.add(result['launch']['runtimeId'])
                elif kind == 'poll':
                    deadline = time.monotonic() + action.get('timeoutSec', 120)
                    while True:
                        actual = request(profile, 'GET', expand(action['path']))
                        if all(assertion(actual, expand(a)) for a in action['until']):
                            break
                        if time.monotonic() >= deadline:
                            raise TimeoutError('required real workflow did not reach its terminal evidence')
                        time.sleep(0.25)
                elif kind == 'stream-open':
                    client = UnixHTTP(profile['publicSocket'], action.get('timeoutSec', 30))
                    client.request('GET', expand(action['path']))
                    response = client.getresponse()
                    frames = []
                    errors = []
                    def follow(stream=response, target_frames=frames, target_errors=errors):
                        try:
                            while True:
                                line = stream.readline()
                                if not line:
                                    break
                                target_frames.append({'at': time.time(), 'raw': line.decode('utf-8', 'replace')})
                        except (OSError, http.client.HTTPException) as error:
                            target_errors.append(str(error))
                    thread = threading.Thread(target=follow, daemon=True)
                    thread.start()
                    followers[action['name']] = (client, response, thread, frames, errors)
                    actual = {'status': response.status, 'headers': dict(response.getheaders()), 'openedAt': time.time()}
                elif kind == 'stream-close':
                    close_start = time.monotonic()
                    client, response, thread, frames, errors = followers.pop(action['name'])
                    wait = time.monotonic() + action.get('waitSec', 1)
                    while len(frames) < action.get('minFrames', 1) and time.monotonic() < wait:
                        time.sleep(0.05)
                    if client.sock:
                        client.sock.shutdown(socket.SHUT_RDWR)
                    thread.join(timeout=2)
                    client.close()
                    actual = {'frames': list(frames), 'errors': list(errors), 'closed': not thread.is_alive(),
                              'closeDurationMs': (time.monotonic() - close_start) * 1000}
                    captures.extend(frames)
                elif kind in ('cli', 'sdk'):
                    argv = profile[kind + 'Argv'] + expand(action.get('args', []))
                    if kind == 'cli' and any(x in action.get('args', []) for x in ('start', 'turn')):
                        raise ValueError('hrc start/turn orchestration commands prohibited; use HTTP')
                    if kind == 'cli' and action.get('args', [])[:2] in (["server", "start"], ["server", "stop"], ["server", "restart"]):
                        raise ValueError('shared service lifecycle is not a conformance action')
                    env = {k: v for k, v in os.environ.items() if not k.startswith(('HRC_', 'ASP_', 'WRKQ'))}
                    env.update(profile['env'])
                    child = subprocess.run(argv, text=True, capture_output=True, env=env,
                                           cwd=profile['projectRoot'], timeout=action.get('timeoutSec', 30))
                    actual = {'argv': argv, 'stdout': child.stdout, 'stderr': child.stderr, 'exit': child.returncode, 'sdk': kind == 'sdk',
                              'durationMs': (time.monotonic() - action_started) * 1000}
                    try:
                        actual['body'] = json.loads(child.stdout)
                    except ValueError:
                        pass
                elif kind == 'sql':
                    # SQL observations are readonly. Existing Bun tools own deliberate writes.
                    with closing(sqlite3.connect('file:' + profile['dbPath'] + '?mode=ro', uri=True)) as db:
                        db.execute('PRAGMA query_only=ON')
                        cursor = db.execute(expand(action['query']), expand(action.get('params', [])))
                        actual = {'columns': [d[0] for d in cursor.description], 'rows': cursor.fetchall()}
                elif kind == 'inventory':
                    child = subprocess.run([sys.executable, str(Path(__file__).resolve()), 'inventory',
                        '--source-ref', source_identity()['commit'], '--out', str(output / 'inventory-check')],
                        text=True, capture_output=True, timeout=120)
                    actual = json.loads(child.stdout)
                elif kind == 'resource':
                    result = subprocess.check_output(['ps', '-p', str(profile['ownerPid']), '-o', 'rss=,pcpu='], text=True)
                    rss, cpu = result.split()
                    actual = {'kind': 'resource', 'rssKb': int(rss), 'cpuPercent': float(cpu), 'at': time.time()}
                elif kind == 'owner-observation':
                    processes = subprocess.check_output(['ps', '-axo', 'pid=,command='], text=True)
                    db_owners = subprocess.run(['/usr/sbin/lsof', '-t', profile['dbPath']],
                        text=True, capture_output=True, timeout=5)
                    scratch = [line.strip() for line in processes.splitlines()
                               if profile['scratchRoot'] in line and 'ps -axo' not in line]
                    actual = {'kind': kind, 'ownerPid': profile['ownerPid'],
                              'dbPids': sorted({int(pid) for pid in db_owners.stdout.split()}),
                              'dbOwnerStderr': db_owners.stderr, 'dbOwnerExit': db_owners.returncode,
                              'scratchPids': sorted({profile['ownerPid']} | {int(line.split()[0]) for line in scratch}),
                              'processes': scratch, 'rustOwners': [line for line in scratch
                                  if any(name in line for name in ('rusthrc', 'hrc-kernel'))]}
                elif kind == 'server-log':
                    path = Path(profile['serveLog']).resolve()
                    if not path.is_relative_to(Path(profile['scratchRoot']).resolve()):
                        raise ValueError('server log outside admitted scratch')
                    records = [json.loads(line) for line in path.read_text().splitlines() if line.startswith('{')]
                    with closing(sqlite3.connect('file:' + profile['dbPath'] + '?mode=ro', uri=True)) as db:
                        db.row_factory = sqlite3.Row
                        lifecycle = [dict(r) for r in db.execute("SELECT * FROM hrc_events WHERE event_kind IN ('server.started','server.stopped') ORDER BY hrc_seq")]
                    actual = {'kind': 'server-log', 'events': [r.get('event') for r in records],
                              'records': records, 'lifecycleRows': lifecycle}
                elif kind == 'cursor-observation':
                    with closing(sqlite3.connect('file:' + profile['dbPath'] + '?mode=ro', uri=True)) as db:
                        db.row_factory = sqlite3.Row
                        cursors = [dict(r) for r in db.execute('SELECT * FROM wrkq_ledger_cursors ORDER BY stream')]
                    actual = {'kind': 'cursor-observation', 'cursors': cursors}
                elif kind == 'publication':
                    with closing(sqlite3.connect('file:' + profile['wrkqDbPath'] + '?mode=ro', uri=True)) as db:
                        db.row_factory = sqlite3.Row
                        facts = [dict(r) for r in db.execute('SELECT type,idempotency_key,attributes FROM project_events')]
                    with closing(sqlite3.connect('file:' + profile['dbPath'] + '?mode=ro', uri=True)) as db:
                        db.row_factory = sqlite3.Row
                        cursors = [dict(r) for r in db.execute('SELECT * FROM wrkq_ledger_cursors ORDER BY stream')]
                    actual = {'kind': 'publication', 'nodeId': profile['nodeId'], 'facts': facts,
                              'cursorsBefore': expand(action['before']), 'cursorsAfter': cursors}
                elif kind == 'authority-unavailable':
                    env = {k: v for k, v in os.environ.items() if not k.startswith(('HRC_', 'ASP_', 'WRKQ'))}
                    env.update({'WRKQ_DB': 'rpc://127.0.0.1:1', 'WRKQD_TOKEN': '', 'WRKQD_TOKEN_FILE': ''})
                    result = subprocess.run(profile['wrkqArgv'] + ['projects', '--json'], env=env,
                                            capture_output=True, text=True, timeout=10, cwd=profile['projectRoot'])
                    actual = {'kind': 'authority-unavailable', 'exit': result.returncode, 'stdout': result.stdout, 'stderr': result.stderr}
                elif kind == 'hrc-unavailable':
                    negative_root = Path(profile['unavailableRoot']).resolve()
                    if not negative_root.is_relative_to(Path(profile['scratchRoot']).resolve()):
                        raise ValueError('unavailable HRC probe outside scratch root')
                    pid = int((negative_root / 'owner.pid').read_text())
                    process = subprocess.run(['ps', '-p', str(pid), '-o', 'command='], text=True, capture_output=True, timeout=5)
                    db_path = negative_root / 'state/state.sqlite'
                    publication = json.loads((negative_root / 'publication-before-stop.json').read_text())
                    log = (negative_root / 'publication-before-stop.log').read_text()
                    failures = [json.loads(line) for line in log.splitlines() if line.startswith('{')]
                    failures = [r for r in failures if r.get('event') == 'server_project_event.post_failed']
                    actual = {'kind': 'hrc-authority-unavailable', 'root': str(negative_root), 'pid': pid,
                        'exit': int((negative_root / 'exit').read_text()),
                        'environment': json.loads((negative_root / 'environment.json').read_text()),
                        'log': log, 'cursors': publication['cursors'], 'events': publication['events'], 'failures': failures,
                        'processBeforeStop': json.loads((negative_root / 'process-before-stop.json').read_text()),
                        'launch': (negative_root / 'launch.sh').read_text(),
                        'processProbe': {'exit': process.returncode, 'stdout': process.stdout, 'stderr': process.stderr}}
                elif kind == 'store-observation':
                    with closing(sqlite3.connect('file:' + profile['dbPath'] + '?mode=ro', uri=True)) as db:
                        seqs = [r[0] for r in db.execute('SELECT hrc_seq FROM hrc_events ORDER BY hrc_seq')]
                        head = db.execute("SELECT seq FROM sqlite_sequence WHERE name='hrc_events'").fetchone()[0]
                        spill = db.execute('SELECT count(*) FROM tool_result_blobs').fetchone()[0]
                    holes = [b-a-1 for a,b in zip([0]+seqs, seqs+[head+1]) if b-a>1]
                    actual = {'kind': 'store-observation', 'head': head, 'seqs': seqs, 'holes': holes, 'spillCount': spill}
                elif kind == 'turn-ledger':
                    with closing(sqlite3.connect('file:' + profile['dbPath'] + '?mode=ro', uri=True)) as db:
                        db.row_factory = sqlite3.Row
                        scope = expand(action['scopeRef'])
                        if not scope.startswith(profile['scopePrefix']):
                            raise ValueError('turn ledger selector outside admitted scratch scope')
                        query = "SELECT * FROM hrc_events WHERE scope_ref = ? ORDER BY hrc_seq"
                        rows = [dict(r) for r in db.execute(query, [scope])]
                        raw_query = """SELECT * FROM broker_invocation_events WHERE runtime_id IN
                            (SELECT runtime_id FROM hrc_events WHERE scope_ref = ?) ORDER BY id"""
                        raw = [dict(r) for r in db.execute(raw_query, [scope])]
                    actual = {'kind': 'turn-ledger', 'query': query, 'rawQuery': raw_query,
                              'scopeRef': scope, 'lifecycleRows': rows, 'brokerRows': raw}
                    data['events'], data['effects'] = derive_turns(actual)
                elif kind == 'preparation':
                    runtime = expand(action['runtimeId'])
                    with closing(sqlite3.connect('file:' + profile['dbPath'] + '?mode=ro', uri=True)) as db:
                        db.row_factory = sqlite3.Row
                        rows = [dict(r) for r in db.execute('''SELECT op.* FROM runtime_operations op
                            JOIN runtimes r ON r.runtime_id=op.runtime_id
                            WHERE r.runtime_id=? AND r.scope_ref=? ORDER BY op.created_at''', [runtime, profile['scopePrefix']])]
                    actual = {'kind': 'preparation', 'runtimeId': runtime, 'rows': rows,
                        'admittedRoots': {k: profile[k] for k in ('scratchRoot', 'agentRoot', 'projectRoot')}}
                elif kind == 'pty':
                    actual = drive_pty(profile, {**action, 'path': expand(action['path'])})
                elif kind == 'substrate':
                    processes = subprocess.check_output(['ps', '-axo', 'pid=,command='], text=True)
                    matches = [line for line in processes.splitlines() if any(rid in line for rid in variables.values() if isinstance(rid, str) and rid.startswith('rt-'))]
                    actual = {'kind': 'substrate', 'processes': matches, 'observedAt': time.time()}
                elif kind == 'evidence':
                    # PTY/cleanup/authority probes must be actual captured observations,
                    # never an assertion supplied by a profile author.
                    path = Path(expand(action['path'])).resolve()
                    if not path.is_relative_to(Path(profile['scratchRoot']).resolve()):
                        raise ValueError('external evidence must belong to this scratch subject')
                    actual = json.loads(path.read_text())
                else:
                    raise ValueError('unknown external action: ' + kind)
                evidence = f'cases/{id}/{n:03d}.json'
                write(output / evidence, actual)
                with (output / 'drive.txt').open('a') as drive:
                    drive.write(json.dumps({'at': time.time(), 'case': id, 'action': action, 'artifact': evidence}) + '\n')
                record['evidence'].append(evidence)
                for name, path in action.get('capture', {}).items():
                    variables[name] = get(actual, path)
                for spec_assert in action.get('assertions', []):
                    passed = assertion(actual, expand(spec_assert))
                    seen.add(spec_assert['id'])
                    entry = {'id': spec_assert['id'], 'pass': passed, 'reason': spec_assert.get('reason', spec_assert['id'])}
                    entry.update({'op': spec_assert['op'], 'path': spec_assert.get('path'),
                                  'expected': expand(spec_assert).get('value')})
                    try:
                        entry['observed'] = get(actual, spec_assert['path']) if spec_assert.get('path') else actual
                    except (KeyError, IndexError, TypeError, ValueError):
                        entry['observedAbsent'] = True
                    if id == 'cold-second-turn':
                        entry['validator'] = 'turn-evidence'
                    record['assertions'].append(entry)
                    check(checks, id + ':' + spec_assert['id'], passed, entry['reason'])
                for field in ('events', 'effects'):
                    if action.get('collect', {}).get(field):
                        data[field].extend(get(actual, action['collect'][field]))
                if action.get('collect', {}).get('status'):
                    data['status'] = get(actual, action['collect']['status'])
        except Exception as error:
            record['status'] = 'INFRA_ERROR'
            failure_path = f'cases/{id}/failure.json'
            write(output / failure_path, {'kind': 'failed-action', 'action': action,
                'errorType': type(error).__name__, 'error': str(error), 'at': time.time(),
                'durationMs': (time.monotonic() - action_started) * 1000})
            record['evidence'].append(failure_path)
            check(checks, id + ':infrastructure', False, type(error).__name__ + ': ' + str(error), 3)
        check(checks, id + ':required-assertions', set(required) <= seen,
              'mandatory semantic assertions missing: ' + ','.join(sorted(set(required) - seen)), 2)
        if record['status'] != 'INFRA_ERROR' and any(not a['pass'] for a in record['assertions']):
            record['status'] = 'FAIL'
        semantic = []
        raw = [json.loads((output / path).read_text()) for path in record['evidence']]
        validate_case_observations(id, raw, semantic, data.get('status'), data.get('installedCopy'))
        checks.extend(semantic)
        if record['status'] == 'PASS' and any(not c['pass'] for c in semantic):
            record['status'] = 'FAIL'
        record['durationMs'] = (time.monotonic() - case_started) * 1000
        data['cases'].append(record)
    for client, response, thread, frames, errors in followers.values():
        if client.sock:
            client.sock.shutdown(socket.SHUT_RDWR)
        thread.join(timeout=2)
        client.close()
    write(output / 'stream-frames.json', captures)
    samples, resources = [], []
    for case in data['cases']:
        for path in case['evidence']:
            observation = json.loads((output / path).read_text())
            if case['id'] == 'fallback-performance' and 'durationMs' in observation:
                samples.append(observation['durationMs'])
            if observation.get('kind') == 'resource':
                resources.append(observation)
    ordered = sorted(samples)
    write(output / 'performance.json', {'samplesMs': samples, 'resources': resources,
          'count': len(samples), 'p50Ms': ordered[len(ordered)//2] if ordered else None,
          'p95Ms': ordered[min(len(ordered)-1, int(len(ordered)*0.95))] if ordered else None,
          'thresholdsEnforced': False})
    # Discover only this newly admitted exact scope, including a successor whose
    # HTTP request timed out before its identity could be captured.
    with closing(sqlite3.connect('file:' + profile['dbPath'] + '?mode=ro', uri=True)) as db:
        db.row_factory = sqlite3.Row
        owned = [dict(r) for r in db.execute('SELECT * FROM runtimes WHERE scope_ref = ?', [profile['scopePrefix']])]
    cleanup = {'scopeRef': profile['scopePrefix'], 'runtimesBefore': owned, 'terminations': []}
    for row in owned:
        if row['status'] not in ('terminated', 'failed', 'stopped'):
            try:
                result = request(profile, 'POST', '/v1/terminate', {'runtimeId': row['runtime_id']})
            except Exception as error:
                result = {'errorType': type(error).__name__, 'error': str(error)}
            cleanup['terminations'].append(result)
    deadline = time.monotonic() + 10
    while True:
        ps = subprocess.check_output(['ps', '-axo', 'pid=,command='], text=True)
        residue = [line.strip() for line in ps.splitlines() if any(row['runtime_id'] in line for row in owned)]
        sockets = []
        for row in owned:
            tmux = json.loads(row['tmux_json'] or '{}')
            path = tmux.get('socketPath')
            if path and Path(path).exists():
                sockets.append(path)
        if not residue and not sockets or time.monotonic() >= deadline:
            break
        time.sleep(0.2)
    cleanup.update({'residue': residue, 'sockets': sockets, 'settledAt': time.time()})
    write(output / 'cleanup.json', cleanup)
    check(checks, 'cleanup:owned-substrate', not residue and not sockets,
          'owned runtime processes/sockets remain after bounded cleanup', 3)
    data['complete'] = True
    data['validationSurface'] = profile.get('validationSurface')
    data['behaviorQualified'] = False
    if profile.get('validationSurface') != 'installed':
        check(checks, 'surface:installed', False, 'source checks do not certify canonical installed baseline', 2)
    validate_evidence(data, output, checks)
    return data


def drive_pty(profile, action):
    attach = request(profile, 'GET', action['path'])
    descriptor = attach.get('body', {})
    argv = descriptor.get('argv', [])
    if not argv or '-S' not in argv or '-t' not in argv:
        raise ValueError('PTY descriptor must identify the scratch tmux socket and target')
    sock = argv[argv.index('-S') + 1]
    if not Path(sock).resolve().is_relative_to(Path(profile['runtimeRoot']).resolve()):
        raise ValueError('PTY descriptor points outside admitted scratch runtime')
    target = argv[argv.index('-t') + 1]
    expected_session, _, expected_window = target.partition(':')
    prefix = [argv[0], '-S', sock]
    def clients():
        result = subprocess.run(prefix + ['list-clients', '-F',
            '#{client_pid}\t#{client_tty}\t#{session_name}\t#{window_name}'],
            text=True, capture_output=True, timeout=5)
        return [{'pid': int(fields[0]), 'tty': fields[1], 'session': fields[2], 'window': fields[3]}
                for line in result.stdout.splitlines() if len(fields := line.split('\t')) == 4]
    def runtime_alive():
        return subprocess.run(prefix + ['has-session', '-t', expected_session],
            capture_output=True, timeout=5).returncode == 0
    before = clients()
    alive_before = runtime_alive()
    child_pid, master = pty.fork()
    if child_pid == 0:
        env = {k: v for k, v in os.environ.items() if not k.startswith(('HRC_', 'ASP_', 'WRKQ'))}
        env.update(profile.get('env', {}))
        env['TERM'] = 'xterm-256color'
        os.chdir(profile['projectRoot'])
        os.execvpe(argv[0], argv, env)
    chunks, attached = [], None
    exit_status, detach_exit = None, None
    deadline = time.monotonic() + action.get('timeoutSec', 10)
    try:
        while time.monotonic() < deadline:
            ready, _, _ = select.select([master], [], [], 0.1)
            if ready:
                try:
                    chunk = os.read(master, 65536)
                except OSError:
                    chunk = b''
                if chunk:
                    chunks.append(chunk)
            attached = next((c for c in clients() if c['pid'] == child_pid
                             and c['session'] == expected_session
                             and (not expected_window or c['window'] == expected_window)), None)
            if attached:
                break
            ended, code = os.waitpid(child_pid, os.WNOHANG)
            if ended:
                exit_status = os.waitstatus_to_exitcode(code)
                break
        if attached:
            detach = subprocess.run(prefix + ['detach-client', '-t', attached['tty']],
                capture_output=True, text=True, timeout=5)
            detach_exit = detach.returncode
        wait_until = time.monotonic() + 5
        while exit_status is None and time.monotonic() < wait_until:
            ready, _, _ = select.select([master], [], [], 0.05)
            if ready:
                try:
                    chunk = os.read(master, 65536)
                    if chunk:
                        chunks.append(chunk)
                except OSError:
                    pass
            ended, code = os.waitpid(child_pid, os.WNOHANG)
            if ended:
                exit_status = os.waitstatus_to_exitcode(code)
                break
            time.sleep(0.05)
        if exit_status is None:
            os.kill(child_pid, signal.SIGTERM)
            grace = time.monotonic() + 1
            while time.monotonic() < grace:
                ended, code = os.waitpid(child_pid, os.WNOHANG)
                if ended:
                    exit_status = os.waitstatus_to_exitcode(code)
                    break
                time.sleep(0.05)
            if exit_status is None:
                os.kill(child_pid, signal.SIGKILL)
                _, code = os.waitpid(child_pid, 0)
                exit_status = os.waitstatus_to_exitcode(code)
    finally:
        os.close(master)
    after = clients()
    return {'transport': 'pty', 'argv': argv, 'descriptor': descriptor, 'childPid': child_pid,
            'expectedSession': expected_session, 'expectedWindow': expected_window,
            'clientsBefore': before, 'attachedClient': attached, 'clientsAfter': after,
            'runtimeAliveBefore': alive_before, 'runtimeAliveAfter': runtime_alive(),
            'detachExit': detach_exit, 'exit': exit_status,
            'stdout': b''.join(chunks).decode('utf-8', 'replace')}


def source_identity():
    def git(*args):
        return subprocess.check_output(['git', '-C', str(ROOT), *args], text=True).strip()
    return {'commit': git('rev-parse', 'HEAD'), 'branch': git('branch', '--show-current'),
            'dirty': git('status', '--porcelain')}


def inventory(args, checks):
    command = ['bun', str(ROOT / 'conformance/hrc-parity/inventory.ts'), '--source-ref', args.source_ref]
    child = subprocess.run(command, cwd=ROOT, text=True, capture_output=True, timeout=120)
    Path(args.out, 'extractor.stderr').write_text(child.stderr)
    if child.returncode:
        check(checks, 'inventory:extractor', False, child.stderr or child.stdout, 2)
        return {}
    observed = json.loads(child.stdout)
    definitions = json.loads((ROOT / 'contract/hrc-parity/cases.json').read_text())
    report = coverage_report(observed, definitions)
    write(Path(args.out) / 'coverage-report.json', report)
    check(checks, 'inventory:nonempty', bool(report['items']), 'no extracted inventory entries', 2)
    check(checks, 'inventory:unresolved', not observed.get('unresolved'),
          'unresolved source expressions cannot pass coverage discovery', 2)
    ids = [i['id'] for i in report['items']]
    check(checks, 'inventory:unique', len(set(ids)) == len(ids), 'duplicate inventory identity', 2)
    for item in report['items']:
        check(checks, 'inventory:mapped:' + item['id'], item['target'] is not None,
              'unmapped inventory item: ' + item['id'], 2)
    return {'coverageReportHash': digest(Path(args.out) / 'coverage-report.json'),
            'sourceCommit': observed['sourceCommit'],
            'inventoryComplete': all(c['pass'] for c in checks),
            'behaviorQualified': False, 'counts': report['counts'],
            'coverage': {'gaps': [i['id'] for i in report['items'] if (i['target'] or '').startswith('GAP:')]}}


def coverage_report(observed, definitions):
    """First matching rule wins; exact overrides take precedence. Never assert PASS."""
    cases = definitions['cases']
    def target_for(item):
        if item['id'] in definitions['coverageOverrides']:
            return definitions['coverageOverrides'][item['id']], None
        for rule in definitions['coverageRules']:
            if (('kind' not in rule or rule['kind'] == item['kind'])
                and item['id'].startswith(rule.get('idPrefix', ''))
                and item.get('path', '').startswith(rule.get('pathPrefix', ''))
                and ('pathPattern' not in rule or re.search(rule['pathPattern'], item.get('path', '')))):
                return rule['target'], rule.get('reason')
        return None, None
    items = []
    for item in observed['items']:
        target, rule_reason = target_for(item)
        # Current main contains no supported UNSUPPORTED mapping. Adding one
        # requires an explicit plan reason allowlist here, not arbitrary prose.
        if target not in cases and target not in {'GAP:N' + str(i) for i in range(1, 7)}:
            target = None
        reason = definitions.get('coverageReasons', {}).get(item['id'], rule_reason)
        items.append({**item, 'target': target, **({'reason': reason} if reason is not None else {})})
    counts = Counter({'GAP:N' + str(i): 0 for i in range(1, 7)})
    counts['UNSUPPORTED'] = 0
    counts.update(i['target'] or 'UNMAPPED' for i in items)
    return {'schema': 1, 'sourceCommit': observed['sourceCommit'], 'items': items,
            'unresolved': observed.get('unresolved', []),
            'counts': dict(sorted(counts.items()))}


def controls(args, checks):
    child = subprocess.run([sys.executable, '-m', 'unittest', 'discover', '-s',
                           str(ROOT / 'conformance/hrc-parity/tests'), '-v'],
                           text=True, capture_output=True, timeout=120)
    Path(args.out, 'controls.stdout').write_text(child.stdout)
    Path(args.out, 'controls.stderr').write_text(child.stderr)
    check(checks, 'controls:checker', child.returncode == 0, 'black-box checker controls must pass')
    return {'controlOnly': True, 'behaviorQualified': False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['inventory', 'run', 'compare', 'controls'])
    parser.add_argument('--out', required=True)
    parser.add_argument('--profile')
    parser.add_argument('--suite', default='p0-bun')
    parser.add_argument('--source-ref', default='HEAD')
    parser.add_argument('--baseline')
    parser.add_argument('--candidate')
    args = parser.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    checks, data = [], {}
    # A partial run is never a successful artifact, even when the checker dies.
    write(out / 'summary.json', {'schema': 1, 'complete': False,
          'classification': 'INFRA_ERROR', 'reason': 'checker interrupted before completion',
          'exitCode': 3, 'checks': [{'id': 'completion', 'pass': False}]})
    try:
        if args.command == 'run':
            data = run_suite(args, checks)
        elif args.command == 'compare':
            data = compare(args, checks)
        elif args.command == 'inventory':
            data = inventory(args, checks)
        elif args.command == 'controls':
            data = controls(args, checks)
    except Exception as error:
        check(checks, 'infrastructure', False, type(error).__name__ + ': ' + str(error), 3)
        (out / 'error.txt').write_text(traceback.format_exc())
    failures = [c for c in checks if not c['pass']]
    if not checks:
        check(checks, 'suite:empty', False, 'no checks executed', 2)
        failures = checks
    code = max((c['failureCode'] for c in failures), default=0)
    data.update({'schema': 1, 'exitCode': code, 'checks': checks,
                 'classification': {0: 'PASS', 1: 'FAIL', 2: 'GAP', 3: 'INFRA_ERROR'}[code],
                 'reason': '; '.join(c['reason'] for c in failures) or 'all requested checks passed'})
    if args.command == 'run':
        data['qualificationScope'] = 'p0-bun-compatibility'
        data['inventoryComplete'] = any(c['id'] == 'jobs-files-listeners:semantic:source-inventory' and c['pass'] for c in checks)
        data['behaviorQualified'] = code == 0 and data.get('validationSurface') == 'installed'
    data['fullParityQualified'] = code == 0 and data.get('claim') == 'full-parity'
    write(out / 'summary.json', data)
    write(out / 'coverage.json', data.get('coverage', {'gaps': [], 'claim': 'checker-only'}))
    with (out / 'cases.ndjson').open('w') as cases_file:
        for case in data.get('cases', []):
            cases_file.write(json.dumps(case) + '\n')
    (out / 'SHA256SUMS').write_text(''.join(digest(p) + '  ' + str(p.relative_to(out)) + '\n'
        for p in sorted(out.rglob('*')) if p.is_file() and p.name != 'SHA256SUMS'))
    print(json.dumps(data, sort_keys=True))
    return code


if __name__ == '__main__':
    sys.exit(main())
