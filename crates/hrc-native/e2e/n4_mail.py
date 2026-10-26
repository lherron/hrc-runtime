#!/usr/bin/env python3
"""N4 gate 1: mail and a reply in both directions between mixed scratch nodes.

Node A and node B each run one owner (bun or native) with federation peers,
one gate-enforcing binding registry on A, and the unchanged hrc-mail-injector
pointed at its own node's hrc.sock. Both nodes share one private wrkqd, since
the mail ledger is wrkq. A seat is born on each node. Then a@A mails b@B, and
b runs the reply to a; b@B mails a@A, and a runs the reply to b.

Failure modes this guards: a node's injector driving a seat homed on the other
node (a cold birth or a delivery on the wrong node); a request or reply never
presented, or presented twice; a mail turn running on the wrong node; a
registry or locate answer that hides the remote home; and any scratch process
reaching the real federation.json, registry, wrkq ledger or peers.
"""
import argparse
import json
import secrets
import shlex
import sqlite3
import subprocess
import time
from pathlib import Path

from n3_scratch import Scratch
from n4_federation import TAILNET, free_port

PROJECT = 'n4-t11872'
# Unpinned (no provisioning.node), so each node births its own seat locally;
# tabularasa pins node=max3.
AGENT = 'klod'


def scope(task):
    return f'agent:{AGENT}:project:{PROJECT}:task:{task}'


def seat(task):
    return f'{AGENT}@{PROJECT}:{task}'


class Node(Scratch):
    def __init__(self, root, args, node_id, owner):
        super().__init__(root, args.installed_release, args.aspd_socket, args.binary,
                         args.artifacts / node_id, project_id=PROJECT)
        self.node_id, self.owner, self.proc, self.injector = node_id, owner, None, None
        self.config = self.root / 'federation.json'

    def write_config(self, value):
        self.config.write_text(json.dumps(value))
        self.config.chmod(0o600)

    def start(self, tag):
        self.proc = self.up(self.owner, tag)
        _, status = self.http('GET', '/v1/status')
        assert status['node']['nodeId'] == self.node_id, status['node']
        return status

    def start_injector(self, version):
        env = {**self.env, 'HRC_SOCKET_PATH': str(self.socket), 'HRC_NODE_ID': self.node_id,
               'HRC_MAIL_INJECTOR_STATE_PATH': str(self.root / 'state/injector.sqlite')}
        argv = ['bunx', '--bun', '--silent', 'hrc-mail-injector@' + version]
        # A fresh store refuses to start without its one-time import marker.
        first = subprocess.run(argv, env=env, cwd=self.project, capture_output=True, text=True, timeout=120)
        assert first.returncode != 0 and 'import marker' in first.stderr, first.stderr
        with sqlite3.connect(self.root / 'state/injector.sqlite') as db:
            db.execute('INSERT INTO injector_store_imports(source_path,imported_at) VALUES(?,?)',
                       ('scratch:none', time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())))
        log = (self.artifacts / 'injector.log').open('w')
        self.logs.append(log)
        self.injector = subprocess.Popen(argv, env=env, cwd=self.project, stdout=log, stderr=log)
        self.owners.append(self.injector)

    def birth(self, task):
        start = self.command('birth-' + task, ['hrc', 'start', scope(task), '--project-id', PROJECT,
                                               '--project-root', self.project, '--cwd', self.project, '--json',
                                               '-p', 'Reply with exactly the word READY and nothing else. No tools.'])
        runtime = start['runtime']
        self.wait_completed(runtime['runId'])
        return runtime


def envelope(node, envelope_id):
    shown = node.command('show-' + envelope_id, ['wrkc', 'show', envelope_id, '--json'])
    return shown.get('envelope', shown)


def room_items(node):
    return node.command('room', ['wrkc', 'log', '/' + PROJECT, '--limit', '200', '--json'])['items']


def main():
    p = argparse.ArgumentParser()
    for k in ('binary', 'installed-release', 'aspd-socket', 'scratch-root', 'artifacts'):
        p.add_argument('--' + k, type=Path, required=True)
    p.add_argument('--a-owner', choices=['bun', 'native'], default='bun')
    p.add_argument('--b-owner', choices=['bun', 'native'], default='native')
    p.add_argument('--injector', default='0.1.0-dev.20261023155744')
    args = p.parse_args()
    args.artifacts.mkdir(parents=True, exist_ok=True)
    real = Path.home() / 'praesidium/var/state/hrc/federation.json'
    a = Node(args.scratch_root / 'a', args, 'n4a', args.a_owner)
    b = Node(args.scratch_root / 'b', args, 'n4b', args.b_owner)
    ports = {k: free_port() for k in ('a_registry', 'a_peer', 'b_peer')}
    token = secrets.token_hex(24)
    a_peer, b_peer = f'http://{TAILNET}:{ports["a_peer"]}', f'http://{TAILNET}:{ports["b_peer"]}'
    registry = f'http://{TAILNET}:{ports["a_registry"]}'
    gate = {'mode': 'enforce', 'registryHost': 'n4a'}
    a.write_config({'nodeId': 'n4a', 'peers': {'n4b': {'endpoint': b_peer, 'token': token}},
                    'registry': {'bind': registry}, 'peerListener': {'bind': a_peer}, 'gate': gate})
    b.write_config({'nodeId': 'n4b', 'peers': {'n4a': {'endpoint': a_peer, 'registryEndpoint': registry,
                                                        'token': token}},
                    'peerListener': {'bind': b_peer}, 'gate': gate})
    result = {'aOwner': args.a_owner, 'bOwner': args.b_owner, 'injector': args.injector, 'checks': {}}
    try:
        # One private wrkqd (on A's root) is the mail ledger for both nodes.
        a.init_substrate()
        for key in ('HRC_WRKQ_DB', 'WRKQ_DB', 'HRC_WRKQD_TOKEN_FILE', 'WRKQD_TOKEN_FILE', 'WRKQD_TOKEN'):
            b.env[key] = a.env[key]
        b.command('project-init', ['git', 'init', '-q'])
        b.command('schema-create', ['bun', '-e', 'import {openHrcDatabase} from ' + json.dumps(
            str(b.release / 'packages/hrc-store-sqlite/src/database.ts')) + ';openHrcDatabase(process.argv[1]).close()',
            b.db_path])
        a.start('mail')
        b.start('mail')
        rt = {'a': a.birth('mail-a'), 'b': b.birth('mail-b')}
        result['runtimes'] = {k: {'runtimeId': v['runtimeId'], 'hostSessionId': v['hostSessionId']} for k, v in rt.items()}
        for node, other, task, other_task in ((a, b, 'mail-a', 'mail-b'), (b, a, 'mail-b', 'mail-a')):
            _, located = node.http('GET', '/v1/federation/locate?scopeRef=' + scope(other_task))
            result.setdefault('locate', {})[f'{node.node_id}:{other_task}'] = located
        a.start_injector(args.injector)
        b.start_injector(args.injector)

        def exchange(name, sender, recipient, sender_task, recipient_task, marker):
            reply = (f'wrkc say /{PROJECT} --scope-ref {shlex.quote(seat(recipient_task))} --as agent:{AGENT} '
                     f'--to {shlex.quote(seat(sender_task))} --fyi -m {marker} --json')
            body = (f'N4 cross-node mail gate ({name}). Use your Bash tool to run exactly this command once; it replies '
                    'to this mail. Do not run another wrkc reply. After it finishes, respond only DONE.\n\n' + reply)
            said = sender.command(name + '-say', ['wrkc', 'say', '/' + PROJECT, '--scope-ref', seat(sender_task),
                                                  '--as', 'agent:' + AGENT, '--to', seat(recipient_task),
                                                  '-m', body, '--json'])
            request = said['envelopes'][0]['id']
            replies = sender.wait(lambda: [i for i in room_items(sender) if i.get('body') == marker], 300,
                                  name + ' reply in the room')
            assert len(replies) == 1, replies
            reply_id = replies[0]['id']
            # The reply reaches the sender seat: presented there, by the sender's own node.
            sender.wait(lambda: envelope(sender, reply_id).get('presentedTo'), 300, name + ' reply presented')
            return {'request': {'id': request}, 'reply': {'id': reply_id},
                    'marker': f'N4 cross-node mail gate ({name})'}

        legs = {'a-to-b': exchange('a-to-b', a, b, 'mail-a', 'mail-b', 'N4_MAIL_B_REPLIED'),
                'b-to-a': exchange('b-to-a', b, a, 'mail-b', 'mail-a', 'N4_MAIL_A_REPLIED')}
        time.sleep(5)  # let any duplicate presentation or stray birth surface
        home = {seat('mail-a'): 'n4a', seat('mail-b'): 'n4b'}
        # The mail each seat must see: the other side's request, then its reply.
        received = {'n4a': [legs['b-to-a']['marker'], 'N4_MAIL_B_REPLIED'],
                    'n4b': [legs['a-to-b']['marker'], 'N4_MAIL_A_REPLIED']}
        for name, leg in legs.items():
            for kind in ('request', 'reply'):
                e = leg[kind] = envelope(a, leg[kind]['id'])
                presented = e.get('presentedTo') or []
                to = e['to']['scopeRef']
                result['checks'][f'{name}:{kind}:presented-once'] = len(presented) == 1
                result['checks'][f'{name}:{kind}:presented-on-home'] = all(
                    x['memberRef'] == to and x['node'] == home[to] for x in presented)
        for node, task in ((a, 'mail-a'), (b, 'mail-b')):
            scopes = {r['scope_ref'] for r in node.rows('SELECT scope_ref FROM runtimes')}
            result['checks'][f'{node.node_id}:only-own-seat'] = scopes == {scope(task)}
            # Each mail to this node's seat reached its runtime exactly once, as a
            # user prompt (a fresh turn or an in-flight merge into a running one).
            prompts = [json.loads(r['payload_json'] or '{}').get('message', {}).get('content', '')
                       for r in node.rows("SELECT payload_json FROM hrc_events WHERE event_kind='turn.user_prompt'")]
            for marker in received[node.node_id]:
                result['checks'][f'{node.node_id}:prompted-once:{marker}'] = sum(
                    isinstance(c, str) and marker in c for c in prompts) == 1
            node.assert_no_duplicate_turn_messages()
        result['legs'] = legs
        result['pass'] = all(result['checks'].values())
        print(json.dumps({'pass': result['pass'], 'checks': result['checks']}))
    finally:
        (args.artifacts / 'result.json').write_text(json.dumps(result, indent=1, default=str) + '\n')
        for node in (a, b):
            node.dump('final')
            (node.artifacts / 'steps.json').write_text(json.dumps(node.steps, indent=1) + '\n')
        a.cleanup('agent:' + AGENT)
        b.cleanup('agent:' + AGENT)
        assert str(real) not in json.dumps(a.env) + json.dumps(b.env)
    if not result.get('pass'):
        raise SystemExit('FAIL')


if __name__ == '__main__':
    main()
