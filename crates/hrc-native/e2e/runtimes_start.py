#!/usr/bin/env python3
"""POST /v1/runtimes/start on Bun and native, compared case by case (T-11911).

Each owner runs on its own fresh scratch root: a `cp -R` of the installed Bun
release, a private wrkqd, and a peerless federation.json with the gate in
enforce mode (the exact and implicit-suffix branches refuse without one). The
cases are the request shapes live callers send:

  exact   hrc-kernel seat.summon, iOS new-session, force-primary create
          ({sessionRef, conflictPolicy:"reject", summonIntent:"implicit"})
  suffix  hrc-kernel --fresh and iOS roster (implicit), `hrc start
          --on-conflict suffix` (explicit_local)
  ensure  workflow interact runs, force-primary launch successor, `hrc start`
          without a prompt, `hrc resume --no-attach` ({hostSessionId, intent})

Failure modes this guards: the route not served (404 route.not_served, the
negative control: point --native-binary at a build without the route and the
driver must fail); a claim that reports another slot, scope or replay flag; an
occupied exact scope that is reused or mutated instead of refused 409
session_scope_occupied; a reused key with another body that is not refused
idempotency_key_conflict; a durable roster_claims hash that differs from Bun's
own hash function for the same request (a claim made by one owner must replay
on the other across the flip); a second ensure start that births a second
runtime instead of reusing the live one; and refusals with another status, code
or detail. Each side's normalized observations are written next to a diff.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys
import time

from n3_scratch import Scratch
from n4_federation import TAILNET, free_port

PROJECT = 'rs-t11911'
AGENT = 'tabularasa'
NODE = 'max3'
ARTIFACTS = Path.home() / 'praesidium/var/wrkq-artifacts/T-11911'
ID = re.compile(r'\b(hsid|rt|run|inv|op|req|trace|input|lease|compile|plan-op|attached)-[0-9a-f-]{8,}\b')
VOLATILE = {'createdAt', 'updatedAt', 'created_at', 'updated_at', 'ts', 'startedAt', 'lastActivityAt',
            'observedAt', 'elapsedMs', 'ms', 'pid', 'durationMs'}


def scope(task):
    return f'agent:{AGENT}:project:{PROJECT}:task:{task}'


def normalize(value, ids, root):
    """Replace ids by first-appearance placeholders, drop volatile keys, root → <root>."""
    if isinstance(value, dict):
        return {k: normalize(v, ids, root) for k, v in value.items() if k not in VOLATILE}
    if isinstance(value, list):
        return [normalize(v, ids, root) for v in value]
    if isinstance(value, str):
        value = value.replace(str(root.resolve()), '<root>').replace(str(root), '<root>')
        return ID.sub(lambda m: ids.setdefault(m.group(0), f'<{m.group(1)}#{len(ids)}>'), value)
    return value


def bun_hash(release, body):
    """Bun's own claim hash for this request: the cross-owner replay oracle."""
    src = release / 'packages/hrc-server/src'
    script = ('const [p,e,s]=await Promise.all([import(process.argv[1]),import(process.argv[2]),import(process.argv[3])]);'
              'const r=p.parseStartRuntimeRequest(JSON.parse(process.argv[4]));'
              'console.log(r.conflictPolicy==="reject"?e.exactStartRequestHash(r):s.suffixStartRequestHash(r))')
    out = subprocess.run(['bun', '-e', script, str(src / 'parsers/runtime.ts'), str(src / 'exact-claim.ts'),
                          str(src / 'roster-claim.ts'), json.dumps(body)],
                         cwd=release, capture_output=True, text=True, check=True)
    return out.stdout.strip()


def run_owner(owner, binary, args, out_dir):
    root = args.scratch_root / owner
    s = Scratch(root, args.installed_release, args.aspd_socket, binary, out_dir, project_id=PROJECT)
    # Enforced gate on a peerless node that hosts its own binding registry (on
    # a private tailnet port), so this node is home for every scope it births.
    config = s.root / 'federation.json'
    # The node is named max3 because the agent profile's provisioning directive
    # names max3; the config is private and has no peers, so nothing real is reached.
    config.write_text(json.dumps({'nodeId': NODE, 'peers': {},
                                  'registry': {'bind': f'http://{TAILNET}:{free_port()}'},
                                  'gate': {'mode': 'enforce', 'registryHost': NODE}}))
    config.chmod(0o600)
    ids, cases, hashes = {}, {}, {}
    try:
        s.init_substrate()
        s.up(owner, 'runtimes-start')

        def snapshot(scopes):
            marks = ','.join('?' * len(scopes))
            rows = {
                'sessions': s.rows(f'SELECT scope_ref,lane_ref,generation,status,host_session_id,prior_host_session_id '
                                   f'FROM sessions WHERE scope_ref IN ({marks}) ORDER BY created_at,host_session_id', scopes),
                'continuities': s.rows(f'SELECT scope_ref,lane_ref,active_host_session_id FROM continuities '
                                       f'WHERE scope_ref IN ({marks}) ORDER BY scope_ref', scopes),
                'runtimes': s.rows(f'SELECT scope_ref,host_session_id,runtime_id,transport,harness,provider,status,'
                                   f'controller_kind FROM runtimes WHERE scope_ref IN ({marks}) '
                                   f'ORDER BY created_at,runtime_id', scopes),
                'rosterClaims': s.rows(f'SELECT idempotency_key,base_scope,claimed_scope,successor_host_session_id '
                                       f'FROM roster_claims WHERE claimed_scope IN ({marks}) OR base_scope IN ({marks}) '
                                       f'ORDER BY created_at,idempotency_key', scopes + scopes),
            }
            return rows

        def events_since(seq, scopes):
            marks = ','.join('?' * len(scopes))
            out = []
            for e in s.rows(f'SELECT event_kind,scope_ref,payload_json FROM hrc_events WHERE hrc_seq>? '
                            f'AND scope_ref IN ({marks}) ORDER BY hrc_seq', (seq, *scopes)):
                payload = json.loads(e['payload_json'] or '{}')
                keep = {k: payload[k] for k in ('reason', 'created', 'trigger', 'exactScope', 'baseScope',
                                                'dropContinuation', 'relaunch') if k in payload}
                out.append({'kind': e['event_kind'], 'scope': e['scope_ref'], **keep})
            # Broker/turn lifecycle kinds are covered by the birth suites; count claim-path kinds exactly.
            return [e for e in out if e['kind'].startswith(('session.', 'runtime.created', 'runtime.started'))]

        def seq():
            return s.rows('SELECT COALESCE(MAX(hrc_seq),0) AS m FROM hrc_events')[0]['m']

        def case(name, body, scopes, path='/v1/runtimes/start'):
            before, mark = snapshot(scopes), seq()
            status, value = s.http('POST', path, body, timeout=240)
            after = snapshot(scopes)
            cases[name] = {'request': body, 'status': status, 'body': value, 'rows': after,
                           'mutated': before != after, 'events': events_since(mark, scopes)}
            return status, value

        def intent_for(task, kernel=True):
            status, value = s.http('POST', '/v1/declarations/resolve', {
                'scopeRef': scope(task), 'runMode': 'task', 'interactive': True, 'preferredMode': 'headless'})
            assert status == 200, ('declarations/resolve', status, value)
            intent = value['intent']
            if kernel:
                # seat.summon's correlation; the ensure-shape callers send the declared intent as-is.
                intent['placement'].setdefault('correlation', {})['sessionRef'] = scope(task) + '/lane:main'
            return intent

        # A: exact claim (kernel summon / iOS reject / force-primary create).
        ex = scope('ex1')
        exact = {'sessionRef': ex + '/lane:main', 'runtimeIntent': intent_for('ex1'), 'conflictPolicy': 'reject',
                 'summonIntent': 'implicit', 'idempotencyKey': f'rs-{owner}-exact-1', 'restartStyle': 'reuse_pty'}
        hashes['exact'] = bun_hash(s.release, exact)
        case('exact.claim', exact, [ex])
        case('exact.replay', exact, [ex])
        case('exact.occupied', {**exact, 'idempotencyKey': f'rs-{owner}-exact-2'}, [ex])
        case('exact.key-conflict', {**exact, 'restartStyle': 'fresh_pty'}, [ex])
        case('exact.explicit-local-refused', {**exact, 'summonIntent': 'explicit_local',
                                              'idempotencyKey': f'rs-{owner}-exact-3'}, [ex])

        # B: suffix roster, implicit (kernel --fresh / iOS roster) then explicit_local (hrc start --on-conflict suffix).
        sx = [scope('sx1'), scope('sx1-nova'), scope('sx1-comet')]
        suffix = {'baseSessionRef': sx[0] + '/lane:main', 'runtimeIntent': intent_for('sx1'), 'conflictPolicy': 'suffix',
                  'summonIntent': 'implicit', 'idempotencyKey': f'rs-{owner}-suffix-1', 'restartStyle': 'reuse_pty'}
        hashes['suffix'] = bun_hash(s.release, suffix)
        case('suffix.base', suffix, sx)
        case('suffix.next', {**suffix, 'idempotencyKey': f'rs-{owner}-suffix-2'}, sx)
        case('suffix.replay', suffix, sx)
        sy = [scope('sy1'), scope('sy1-nova')]
        local = {'baseSessionRef': sy[0] + '/lane:main', 'runtimeIntent': intent_for('sy1'), 'conflictPolicy': 'suffix',
                 'summonIntent': 'explicit_local', 'idempotencyKey': f'rs-{owner}-local-1', 'restartStyle': 'reuse_pty'}
        hashes['suffixLocal'] = bun_hash(s.release, local)
        case('suffix.explicit-local', local, sy)

        # C: ensure shape on an existing session (workflow interact, launch successor, hrc start/resume no prompt).
        en = scope('en1')
        en_intent = intent_for('en1', kernel=False)
        status, resolved = s.http('POST', '/v1/sessions/resolve', {
            'sessionRef': en + '/lane:main', 'runtimeIntent': en_intent, 'create': True})
        assert status == 200 and resolved.get('hostSessionId'), resolved
        host = resolved['hostSessionId']
        case('ensure.start', {'hostSessionId': host, 'intent': en_intent, 'restartStyle': 'reuse_pty'}, [en])
        case('ensure.reuse', {'hostSessionId': host, 'intent': en_intent, 'restartStyle': 'reuse_pty'}, [en])
        case('ensure.allow-stale', {'hostSessionId': host, 'intent': en_intent, 'restartStyle': 'reuse_pty',
                                    'allowStaleGeneration': True}, [en])
        case('ensure.default-style', {'hostSessionId': host, 'intent': en_intent}, [en])
        claimed = cases['exact.claim']['body'].get('hostSessionId') if isinstance(cases['exact.claim']['body'], dict) else None
        if claimed:
            # Force-primary launch successor: ensure on the exact-claimed seat reuses its runtime.
            case('ensure.claimed-seat', {'hostSessionId': claimed, 'intent': exact['runtimeIntent'],
                                         'restartStyle': 'reuse_pty', 'allowStaleGeneration': True}, [ex])
        case('ensure.unknown-host', {'hostSessionId': 'hsid-00000000-0000-0000-0000-000000000000',
                                     'intent': en_intent}, [en])
        case('ensure.no-intent', {'hostSessionId': host}, [en])

        # Malformed shapes: parser refusals before any routing.
        case('bad.policy', {**exact, 'conflictPolicy': 'bogus'}, [ex])
        case('bad.suffix-host', {**suffix, 'hostSessionId': host}, sx)
        case('bad.suffix-no-key', {k: v for k, v in suffix.items() if k != 'idempotencyKey'}, sx)
        case('bad.exact-no-intent', {k: v for k, v in exact.items() if k != 'runtimeIntent'}, [ex])

        stored = {r['idempotency_key']: r['request_hash'] for r in s.rows('SELECT * FROM roster_claims')}
        hash_check = {
            'exact': stored.get(exact['idempotencyKey']) == hashes['exact'],
            'suffix': stored.get(suffix['idempotencyKey']) == hashes['suffix'],
            'suffixLocal': stored.get(local['idempotencyKey']) == hashes['suffixLocal'],
        }
        normalized = normalize({'cases': cases, 'hashMatchesBun': hash_check}, ids, s.root)
        # Keys carry the owner name so each side can mint its own; compare them owner-free.
        normalized = json.loads(json.dumps(normalized).replace(f'rs-{owner}-', 'rs-<owner>-'))
        (out_dir / f'{owner}.json').write_text(json.dumps(normalized, indent=1) + '\n')
        return normalized
    finally:
        (out_dir / f'{owner}-steps.json').write_text(json.dumps(s.steps, indent=1, default=str) + '\n')
        s.cleanup(f'agent:{AGENT}')


def expectations(side):
    """Bun's contract, asserted per side so a Bun-only run is itself a check."""
    c, failures = side['cases'], []

    def want(name, status, code=None):
        got = c.get(name)
        if got is None:
            return failures.append(f'{name}: case not run')
        body = got['body'] if isinstance(got['body'], dict) else {}
        err = body.get('error', {}) if isinstance(body.get('error'), dict) else {}
        if got['status'] == 404 or err.get('code') == 'route.not_served' or 'not_served' in json.dumps(body):
            failures.append(f'{name}: route not served ({got["status"]} {body})')
        elif got['status'] != status or (code and err.get('code') != code):
            failures.append(f'{name}: want {status} {code or ""}, got {got["status"]} {err.get("code")}')

    want('exact.claim', 200)
    want('exact.replay', 200)
    want('exact.occupied', 409, 'session_scope_occupied')
    want('exact.key-conflict', 409, 'idempotency_key_conflict')
    want('suffix.base', 200)
    want('suffix.next', 200)
    want('suffix.replay', 200)
    want('suffix.explicit-local', 200)
    want('ensure.start', 200)
    want('ensure.reuse', 200)
    if failures:
        return failures
    claim = lambda n: c[n]['body'].get('claim', {})
    if claim('exact.claim').get('replayed') is not False or claim('exact.replay').get('replayed') is not True:
        failures.append('exact replay flag')
    if c['exact.claim']['body']['hostSessionId'] != c['exact.replay']['body']['hostSessionId']:
        failures.append('exact replay changed hostSessionId')
    if c['exact.occupied']['mutated']:
        failures.append('occupied exact refusal mutated rows')
    if [claim(n).get('slot') for n in ('suffix.base', 'suffix.next', 'suffix.replay')] != ['sx1', 'sx1-nova', 'sx1']:
        failures.append('suffix slots: ' + str([claim(n).get('slot') for n in ('suffix.base', 'suffix.next', 'suffix.replay')]))
    if c['ensure.start']['body'].get('runtimeId') != c['ensure.reuse']['body'].get('runtimeId'):
        failures.append('ensure reuse birthed a second runtime')
    for k, ok in side['hashMatchesBun'].items():
        if not ok:
            failures.append(f'roster_claims.request_hash for {k} differs from Bun\'s hash function')
    return failures


def diff(a, b, path=''):
    if type(a) is not type(b):
        return [f'{path}: bun={json.dumps(a)[:300]} native={json.dumps(b)[:300]}']
    if isinstance(a, dict):
        out = []
        for k in list(a) + [k for k in b if k not in a]:
            if k not in b:
                out.append(f'{path}.{k}: only bun ({json.dumps(a[k])[:200]})')
            elif k not in a:
                out.append(f'{path}.{k}: only native ({json.dumps(b[k])[:200]})')
            else:
                out += diff(a[k], b[k], f'{path}.{k}')
        return out
    if isinstance(a, list):
        if len(a) != len(b):
            return [f'{path}: length bun={len(a)} native={len(b)}: bun={json.dumps(a)[:400]} native={json.dumps(b)[:400]}']
        return [d for i, (x, y) in enumerate(zip(a, b)) for d in diff(x, y, f'{path}[{i}]')]
    return [] if a == b else [f'{path}: bun={json.dumps(a)[:300]} native={json.dumps(b)[:300]}']


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('--native-binary', type=Path, help='rusthrc to test; a build without the route must FAIL')
    p.add_argument('--installed-release', type=Path, default=Path.home() / '.bun/install/hrc-runtime-current')
    p.add_argument('--aspd-socket', type=Path, default=Path.home() / 'praesidium/var/aspd/run/aspd.sock')
    p.add_argument('--scratch-root', type=Path, required=True, help='fresh directory; one sub-root per owner')
    p.add_argument('--artifacts', type=Path, default=None)
    p.add_argument('--bun-only', action='store_true')
    p.add_argument('--native-only', action='store_true', help='reuse an existing bun.json in --artifacts')
    args = p.parse_args()
    args.installed_release = args.installed_release.resolve()
    out_dir = args.artifacts or ARTIFACTS / ('runtimes-start-' + time.strftime('%Y%m%dT%H%M%SZ', time.gmtime()))
    out_dir.mkdir(parents=True, exist_ok=True)
    result = {'artifacts': str(out_dir), 'installedRelease': str(args.installed_release)}
    sides = {}
    if not args.native_only:
        # The Bun owner never execs --binary; Scratch only resolves it.
        sides['bun'] = run_owner('bun', args.installed_release / 'bin/rusthrc', args, out_dir)
    else:
        sides['bun'] = json.loads((out_dir / 'bun.json').read_text())
    result['bunFailures'] = expectations(sides['bun'])
    if not args.bun_only:
        assert args.native_binary, '--native-binary is required unless --bun-only'
        result['nativeBinary'] = str(args.native_binary.resolve())
        sides['native'] = run_owner('native', args.native_binary, args, out_dir)
        result['nativeFailures'] = expectations(sides['native'])
        result['diff'] = diff(sides['bun'], sides['native'])
    result['ok'] = not result['bunFailures'] and not result.get('nativeFailures') and not result.get('diff')
    (out_dir / 'result.json').write_text(json.dumps(result, indent=1) + '\n')
    print(json.dumps(result, indent=1))
    sys.exit(0 if result['ok'] else 1)


if __name__ == '__main__':
    main()
