#!/usr/bin/env python3
"""Session index pages, facets and placement bindings on one native owner.

Sessions come from the daemon's own door (POST /v1/sessions/resolve, PATCH
/v1/sessions/metadata); placement-ledger rows from the native writer's install
and retirement statements (n4_federation.LEDGER_ACTIVE / LEDGER_RETIRE). The
seed is read back through the owner before any case runs.

Failure modes: filters applied after the limit or ignored; facets that do not
exclude their own dimension; a cursor that skips, repeats, never ends, or
survives a filter change; LIKE wildcards unescaped; wrong refusal precedence or
detail; bindings that leak retired or foreign rows or trim the query; a page
high-water that is not the ledger head; reads that write. Expectations are read
off server/front/index.rs, hrc-store index.rs and placement/aspc.rs.
"""
import argparse
import base64
import datetime
from http.client import HTTPException
import json
import os
from pathlib import Path
import shutil
import signal
import sqlite3
import subprocess
import time
from urllib.parse import urlencode
from foundation import daemon_env, UnixHTTP
from n4_federation import LEDGER_ACTIVE, LEDGER_RETIRE

TITLE = 'N1 index title'
STATUSES = ['active', 'detached', 'inactive', 'stale']
MODES = ['headless', 'interactive', 'nonInteractive']


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--binary', type=Path, required=True)
    p.add_argument('--scratch-root', type=Path, required=True)
    p.add_argument('--artifacts', type=Path, required=True)
    args = p.parse_args()
    assert not any(os.environ.get(k) for k in ('CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CODEX_SANDBOX'))
    root = args.scratch_root.absolute()
    assert not root.exists(), 'fresh scratch root required'
    root.mkdir(parents=True)
    args.artifacts.mkdir(parents=True, exist_ok=True)
    env = dict(os.environ, HRC_RUNTIME_DIR=str(root/'run'), HRC_STATE_DIR=str(root/'state'),
               HRC_PEER_CONFIG_FILE=str(root/'absent-federation.json'),
               HRC_WRKQ_DB=str(root/'wrkq.db'), WRKQ_DB=str(root/'wrkq.db'), HRC_METRICS='0',
               HRC_ACP_WEBHOOK_URL='', HRC_EVENT_INGEST_SOCKET=str(root/'run/ingest.sock'))
    for key in ('HRC_SESSION_REF', 'HRC_RUNTIME_ID', 'HRC_RUN_ID', 'HRC_HOST_SESSION_ID',
                'HRC_EVENT_FORWARD_URL', 'HRC_EVENT_INGEST_TCP_PORT', 'HRC_EVENT_FORWARD_SOURCE_REF',
                'WRKQ_DB_PATH', 'WRKQ_DB_PATH_FILE'):
        env.pop(key, None)
    dbpath = root/'state/state.sqlite'
    proc, log = None, None

    def ro(sql):
        with sqlite3.connect(f'file:{dbpath}?mode=ro', uri=True) as db:
            return db.execute(sql).fetchone()[0]

    def call(method, path, body=None):
        http = UnixHTTP(root/'run/hrc.sock')
        http.request(method, path, json.dumps(body) if body is not None else None,
                     {'Content-Type': 'application/json', 'x-hrc-principal-ref': 'agent:clod'})
        response = http.getresponse()
        raw = response.read().decode()
        http.close()
        try: value = json.loads(raw)
        except json.JSONDecodeError: value = raw
        return {'status': response.status, 'body': value}

    def up(label):
        nonlocal proc, log
        log = (args.artifacts/f'{label}.log').open('w')
        # Preserve the caller PATH without adding a runtime directory.
        proc = subprocess.Popen([str(args.binary.resolve()), 'server'], env=daemon_env(env), cwd=root, stdout=log, stderr=log)
        for _ in range(300):
            assert proc.poll() is None, (label, 'owner exited')
            try:
                if call('GET', '/v1/health')['status'] == 200: return
            except (OSError, HTTPException): pass
            time.sleep(.05)
        raise AssertionError(label+' not ready')

    def down():
        nonlocal proc, log
        if proc is not None and proc.poll() is None:
            proc.send_signal(signal.SIGTERM)
            proc.wait(timeout=20)
        if log: log.close()
        proc, log = None, None

    scope = 'agent:tabularasa:project:n1-t11818:task:route-'+str(time.time_ns())
    query = lambda path, **kw: path+'?'+urlencode(kw)
    try:
        subprocess.run([str(args.binary.resolve()), 'store', 'migrate', str(dbpath)], env=env, check=True, capture_output=True)
        subprocess.run(['wrkqadm', 'migrate'], env=env, check=True, capture_output=True)
        subprocess.run([str(Path.home()/'.local/bin/wrkq'), 'mkdir', '/n1-t11818', '--kind', 'project', '--as', 'agent:clod'], env=env, check=True, capture_output=True)
        up('prime')
        hosts = {}
        for lane in ('main', 'alternate'):
            created = call('POST', '/v1/sessions/resolve', {'sessionRef': scope+'/lane:'+lane, 'create': True, 'summonIntent': 'explicit_local'})
            assert created['status'] == 200 and created['body']['created'] is True, created
            hosts[lane] = created['body']['hostSessionId']
        written = call('PATCH', '/v1/sessions/metadata', {'scopeRef': scope, 'set': {'title': TITLE}})
        assert written['status'] == 200, written
        local = call('GET', '/v1/status')['body']['node']['nodeId']
        down()
        at = '2026-10-25T12:00:00.000Z'
        with sqlite3.connect(dbpath) as db:
            for suffix, node in (('local-a', local), ('local-b', local), ('remote', 'n1-remote'), ('retired', local)):
                db.execute(LEDGER_ACTIVE, (scope+'-'+suffix, node, at, at))
            db.execute(LEDGER_RETIRE, (at, 'n1 scratch fixture', at, scope+'-retired', local))
        up('native')
        # Owner readback of the seed: both sessions with the title, and the ledger rows the route can see.
        seeded = call('GET', '/v1/sessions/page?limit=200')
        assert sorted(i['hostSessionId'] for i in seeded['body']['items']) == sorted(hosts.values()), seeded
        assert [i.get('title') for i in seeded['body']['items'] if i['hostSessionId'] == hosts['main']] == [TITLE], seeded
        ledger = call('GET', '/v1/placement/bindings?home=self&state=active')
        assert ledger['status'] == 200, ledger
        highwater = ro('SELECT COALESCE(MAX(hrc_seq),0) FROM hrc_events')
        cases = [
            ('placement-bindings', '/v1/placement/bindings?home=self&state=active'),
            ('placement-bindings-missing', '/v1/placement/bindings'),
            ('placement-bindings-wrong-state', '/v1/placement/bindings?home=self&state=retired'),
            ('placement-bindings-untrimmed', '/v1/placement/bindings?home=%20self&state=active'),
            ('index-page', '/v1/sessions/page?limit=1'),
            ('index-page-all', '/v1/sessions/page'),
            ('index-page-filter', query('/v1/sessions/page', agentId='tabularasa', projectId='n1-t11818', effectiveStatus='inactive', executionMode='nonInteractive', q='n1-t11818')),
            ('index-page-lossy', '/v1/sessions/page?q=%ff'),
            ('index-page-empty', query('/v1/sessions/page', q='%_')),
            ('index-page-lane', '/v1/sessions/page?laneRef=alternate'),
            ('index-page-limit', '/v1/sessions/page?limit=0'),
            ('index-page-limit-fraction', '/v1/sessions/page?limit=1.5'),
            ('index-page-limit-overflow', '/v1/sessions/page?limit=201'),
            ('index-page-status', '/v1/sessions/page?effectiveStatus=invalid'),
            ('index-page-mode', '/v1/sessions/page?executionMode=invalid'),
            ('index-page-nodes', '/v1/sessions/page?nodes=missing'),
            ('index-page-nodes-order', '/v1/sessions/page?nodes=z,a'),
            ('index-page-duplicate-limit', '/v1/sessions/page?limit=1&limit=0'),
            ('index-page-cursor', '/v1/sessions/page?cursor=bad'),
            ('index-facets', '/v1/sessions/facets'),
            ('index-facets-filter', query('/v1/sessions/facets', agentId='absent', effectiveStatus='active', executionMode='headless')),
            ('index-facets-agent', '/v1/sessions/facets?agentId=absent'),
            ('index-facets-effective', '/v1/sessions/facets?effectiveStatus=active'),
            ('index-facets-execution', '/v1/sessions/facets?executionMode=headless'),
            ('index-facets-project', '/v1/sessions/facets?projectId=absent'),
            ('index-facets-status', '/v1/sessions/facets?effectiveStatus=invalid'),
            ('index-facets-mode', '/v1/sessions/facets?executionMode=invalid'),
            ('index-facets-limit', '/v1/sessions/facets?limit=1'),
            ('index-facets-cursor', '/v1/sessions/facets?cursor=bad'),
        ]
        observed = []

        def run(name, path):
            before, events = time.time(), ro('SELECT count(*) FROM hrc_events')
            value = call('GET', path)
            observed.append({'case': name, 'path': path, 'response': value, 'before': before, 'after': time.time(),
                             'newEvents': ro('SELECT count(*) FROM hrc_events') - events})
            return value

        for name, path in cases:
            run(name, path)
        first = observed[4]['response']['body']
        cursor = first.get('nextCursor', 'missing') if isinstance(first, dict) else 'missing'
        try:
            numeric = json.loads(base64.urlsafe_b64decode(cursor+'='*(-len(cursor) % 4)))
            numeric['v'] = 5.0
            numeric = base64.urlsafe_b64encode(json.dumps(numeric, separators=(',', ':')).encode()).decode().rstrip('=')
        except ValueError:
            numeric = 'missing'
        run('index-cursor-number', query('/v1/sessions/page', limit=1, cursor=numeric))
        run('index-next', query('/v1/sessions/page', limit=1, cursor=cursor))
        run('index-cursor-mismatch', query('/v1/sessions/page', limit=1, cursor=cursor, agentId='absent'))
        down()
        (args.artifacts/'observations.json').write_text(json.dumps({'hosts': hosts, 'local': local, 'highwater': highwater, 'observations': observed}, indent=2)+'\n')
        failures = check(observed, hosts, local, scope, highwater)
        (args.artifacts/'failures.json').write_text(json.dumps(failures, indent=2)+'\n')
        assert not failures, failures
        print(json.dumps({'pass': True, 'cases': len(observed), 'artifacts': str(args.artifacts)}))
    finally:
        down()
        shutil.rmtree(root)


def check(observed, hosts, local, scope, highwater):
    failures = []
    by = {r['case']: r for r in observed}
    status = lambda n: by[n]['response']['status']
    body = lambda n: by[n]['response']['body'] if isinstance(by[n]['response']['body'], dict) else {}

    def fail(name, what, value=None):
        failures.append((name, what, value if value is not None else by[name]['response']))

    def refusal(name, message, detail):
        error = body(name).get('error', {})
        if status(name) != 400 or error.get('message') != message or error.get('detail') != detail:
            fail(name, 'refusal')

    def page(name, want, more):
        b = body(name)
        if status(name) != 200 or [i['hostSessionId'] for i in b.get('items', [])] != want:
            return fail(name, 'items')
        if ('nextCursor' in b) != more:
            fail(name, 'nextCursor')
        # Only the local node: the high-water is the ledger head, the page complete, the peer checked now.
        peer = b.get('peerStatus', {}).get(local, {})
        checked = peer.get('checkedAt')
        checked = checked and datetime.datetime.fromisoformat(checked.replace('Z', '+00:00')).timestamp()
        if (b.get('eventHighWater') != {local: highwater} or b.get('complete') is not True or set(b.get('peerStatus', {})) != {local}
                or peer.get('state') != 'healthy' or not (checked and by[name]['before']-.01 <= checked <= by[name]['after']+.01)):
            fail(name, 'page envelope', {k: v for k, v in b.items() if k != 'items'})
        for item in b.get('items', []):
            lane = 'main' if item['hostSessionId'] == hosts['main'] else 'alternate'
            if (item.get('nodeId'), item.get('scopeRef'), item.get('laneRef'), item.get('agentId'), item.get('projectId'),
                    item.get('effectiveStatus'), item.get('executionMode'), item.get('title')) != (
                    local, scope, 'main' if lane == 'main' else 'lane:alternate', 'tabularasa', 'n1-t11818',
                    'inactive', 'nonInteractive', TITLE if lane == 'main' else None):
                fail(name, 'item', item)
            if list(item)[0] != 'nodeId':
                fail(name, 'item key order', list(item))

    def facets(name, total, by_status, by_mode, by_agent):
        b = body(name)
        want = {'total': total, 'byEffectiveStatus': by_status, 'byExecutionMode': by_mode, 'byAgentId': by_agent,
                'byNodeId': {local: total}, 'complete': True}
        if status(name) != 200 or {k: v for k, v in b.items() if k != 'peerStatus'} != want:
            return fail(name, 'facets')
        if list(b) != ['total', 'byEffectiveStatus', 'byExecutionMode', 'byAgentId', 'byNodeId', 'complete', 'peerStatus']:
            fail(name, 'facets key order', list(b))

    names = [r['case'] for r in observed]
    if len(names) != len(set(names)) or len(names) != 32:
        failures.append(('matrix', names))
    for r in observed:
        if r['newEvents']:
            fail(r['case'], 'read appended events', r['newEvents'])
    # Bindings: only active rows homed here, ordered by scope; no retired, no foreign, no trimming of the query.
    b = body('placement-bindings')
    if status('placement-bindings') != 200 or b != {'localNodeId': local, 'bindings': [
            {'scopeRef': scope+'-local-a', 'homeNodeId': local, 'state': 'active'},
            {'scopeRef': scope+'-local-b', 'homeNodeId': local, 'state': 'active'}]}:
        fail('placement-bindings', 'bindings')
    for name in ('placement-bindings-missing', 'placement-bindings-wrong-state', 'placement-bindings-untrimmed'):
        refusal(name, 'only home=self&state=active is served by this route', {'field': 'home'})
    # Newest activity first (last_activity_at DESC, host DESC); a one-row page then its cursor walk both rows exactly once.
    order = [i['hostSessionId'] for i in body('index-page-all').get('items', [])]
    if sorted(order) != sorted(hosts.values()):
        fail('index-page-all', 'both sessions')
        order = [hosts['main'], hosts['alternate']]
    page('index-page-all', order, False)
    page('index-page', order[:1], True)
    page('index-page-duplicate-limit', order[:1], True)  # the first value wins (server.rs query map or_insert)
    page('index-next', order[1:], False)
    page('index-cursor-number', order[1:], False)  # v=5.0 is the number 5
    page('index-page-filter', order, False)
    page('index-page-lossy', [], False)
    page('index-page-empty', [], False)  # % and _ are escaped: a literal "%_" matches no scope
    page('index-page-lane', [hosts['alternate']], False)
    for name in ('index-page-limit', 'index-page-limit-fraction', 'index-page-limit-overflow'):
        refusal(name, 'limit must be an integer between 1 and 200', {'field': 'limit'})
    for name in ('index-page-status', 'index-facets-status'):
        refusal(name, 'effectiveStatus is invalid', {'field': 'effectiveStatus', 'value': 'invalid', 'allowed': STATUSES})
    for name in ('index-page-mode', 'index-facets-mode'):
        refusal(name, 'executionMode is invalid', {'field': 'executionMode', 'value': 'invalid', 'allowed': MODES})
    refusal('index-page-nodes', 'nodes contains an unknown nodeId', {'field': 'nodes', 'unknown': ['missing'], 'known': [local]})
    refusal('index-page-nodes-order', 'nodes contains an unknown nodeId', {'field': 'nodes', 'unknown': ['z', 'a'], 'known': [local]})
    refusal('index-page-cursor', 'cursor is malformed', {'field': 'cursor'})
    refusal('index-cursor-mismatch', 'cursor does not match the active filters', {'field': 'cursor'})
    refusal('index-facets-limit', 'limit is not accepted by the facets endpoint', {'field': 'limit'})
    refusal('index-facets-cursor', 'cursor is not accepted by the facets endpoint', {'field': 'cursor'})
    # Each facet counts under every filter but its own.
    facets('index-facets', 2, {'inactive': 2}, {'nonInteractive': 2}, {'tabularasa': 2})
    facets('index-facets-filter', 0, {}, {}, {})
    facets('index-facets-agent', 0, {}, {}, {'tabularasa': 2})
    facets('index-facets-effective', 0, {'inactive': 2}, {}, {})
    facets('index-facets-execution', 0, {}, {'nonInteractive': 2}, {})
    facets('index-facets-project', 0, {}, {}, {})
    return failures


if __name__ == '__main__':
    main()
