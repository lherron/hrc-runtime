#!/usr/bin/env python3
"""`hrc session meta set|clear`, `session retitle`, `federation retire`: native
against a frozen, Bun-verified golden, on ONE isolated scratch rusthrc.

The Bun implementation was deleted in T-13049. `--oracle <hrc.js>` re-runs the
differential against a Bun CLI that still has it (the canonical checkout before
the deletion, or a copied release) and, with `--record`, refuses to write the
golden unless every case is identical. Without `--oracle`, `bun` is absent from
PATH and native output and stored state are compared with
fixtures/meta-retire-golden.json.

Twins: Bun and native each act on their own continuity or scope, set up the
same way, so each side's write starts from the same state. Those names, host
session ids and timestamps are the only normalization.

Failure modes, each a case:
  grammar    a flag, alias or positional form Bun accepted is refused, or a
             Bun refusal is accepted (missing arguments, --output json, an
             unknown option, retitle with neither or both of --title and
             --regenerate, retire without --reason or with a blank one)
  output     a key, key order, trailing newline, the deprecation line, stderr
             versus stdout, an exit code
  stored     the metadata the daemon holds after each write (read back from
             GET /v1/sessions/metadata): `set` stores JSON.parse(value) as
             JSON.stringify writes it (doubles, index keys first) or the plain
             string; `clear` removes exactly the named keys
  retire     the body names the qualified scope (handle forms qualify with the
             project), and the placement ledger row, continuity and session
             fence after each call are the same as Bun's: unplaced (refused),
             live runtime (refused with its id), placed (retired), again
             (idempotent)

Never the live daemon: the daemon, its store, aspd and the broker are scratch
(kernel_fold's substrate: fake aspd, stub broker, private wrkqd).
"""
import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
sys.path.insert(0, str(REPO / 'crates/hrc-native/e2e'))
from hrcpty_substrate import AGENT, PROJECT  # noqa: E402
from kernel_fold import placement_hint, substrate  # noqa: E402

GOLDEN = HERE / 'fixtures/meta-retire-golden.json'
LIVE_STATE = Path.home() / 'praesidium/var'
ISO = re.compile(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z')
SIDES = {'bun': 'twbun', 'native': 'twnat'}


def scope(task):
    return f'agent:{AGENT}:project:{PROJECT}:task:{task}'


# Target forms Bun's continuity resolver accepts, per twin.
def targets(task, host):
    return {
        'scope': scope(task), 'session': scope(task) + '/lane:main', 'handle': f'{AGENT}@{PROJECT}:{task}',
        'prefixed': 'session:' + scope(task) + '/lane:main', 'hsid': host, 'host': 'host:' + host,
        'scope-prefixed': 'scope:' + scope(task),
    }


META = [  # (target form, argv after the target form is substituted for {t})
    ('scope', ['session', 'meta', 'set', '{t}', 'title', 'plain words']),
    ('session', ['session', 'meta', 'set', '{t}', 'n', '42']),
    ('handle', ['session', 'meta', 'set', '{t}', 'f', '1.0']),
    ('prefixed', ['session', 'meta', 'set', '{t}', 'big', '12345678901234567890']),
    ('hsid', ['session', 'meta', 'set', '{t}', 'obj', '{"b":1,"k":[true,null,-0,1e2,1.50,1e21,0.1],"a":{"x":"y"}}']),
    ('hsid', ['session', 'meta', 'set', '{t}', 'idx', '{"b":1,"2":0}']),
    ('host', ['session', 'meta', 'set', '{t}', 'quoted', '"x"']),
    ('scope-prefixed', ['session', 'meta', 'set', '{t}', 'nul', 'null']),
    ('scope', ['session', 'meta', 'set', '{t}', 'broken', '{"a":']),
    ('scope', ['session', 'meta', 'set', '{t}', 'empty', '']),
    ('scope', ['session', 'meta', 'set', '{t}', 'spaced', ' [1, 2] ']),
    ('scope', ['session', 'meta', 'set', '{t}', 'dash', '--', '-1']),
    ('scope', ['session', 'meta', 'set', '{t}', 'k']),
    ('scope', ['session', 'meta', 'set', '{t}']),
    ('scope', ['session', 'meta', 'set', '{t}', 'a', 'b', 'extra']),
    ('scope', ['session', 'meta', 'set', '{t}', 'a', 'b', '--json']),
    ('scope', ['--output', 'json', 'session', 'meta', 'set', '{t}', 'a', 'b']),
    ('scope', ['session', 'meta', 'clear', '{t}', 'n']),
    ('session', ['session', 'meta', 'clear', '{t}', 'f', 'big', 'never-set']),
    ('hsid', ['session', 'meta', 'clear', '{t}', 'nul']),
    ('scope', ['session', 'meta', 'clear', '{t}']),
    ('scope', ['session', 'meta', 'clear', '{t}', 'x', '--json']),
    ('scope', ['session', 'retitle', '{t}', '--title', 'Retitled']),
    ('session', ['session', 'retitle', '{t}', '--title', 'Forced', '--force']),
    ('hsid', ['session', 'retitle', '{t}', '--title=']),
    ('handle', ['session', 'retitle', '{t}', '--regenerate']),
    ('scope', ['session', 'retitle', '{t}', '--regenerate', '--force']),
    ('scope', ['session', 'retitle', '{t}', '--title', '1']),
    ('scope', ['session', 'retitle', '{t}', '--title', 'x' * 200]),
    ('scope', ['session', 'retitle', '{t}', '--title', 'x' * 201]),
    ('scope', ['session', 'retitle', '{t}', '--title', 'break\u001b[2Jrow']),
    ('scope', ['session', 'retitle', '{t}', '--title', '  Padded title  ']),
    ('scope', ['session', 'retitle', '{t}', '--title', '\u00e9\U0001F600 wide']),
    ('scope', ['session', 'retitle', '{t}']),
    ('scope', ['session', 'retitle', '{t}', '--force']),
    ('scope', ['session', 'retitle', '{t}', '--title', 'x', '--regenerate']),
    ('scope', ['session', 'retitle', '{t}', '--title']),
    ('scope', ['session', 'retitle']),
    ('scope', ['--output', 'json', 'session', 'retitle', '{t}', '--title', 'x']),
    ('scope', ['session', 'meta', 'set', '--help']),
    ('scope', ['session', 'meta', 'clear', '--help']),
    ('scope', ['session', 'retitle', '--help']),
]
# Targets that name no session the daemon knows, and malformed selectors.
UNKNOWN = [
    ['session', 'meta', 'set', 'hsid-{s}-missing', 'k', 'v'],
    ['session', 'meta', 'clear', 'host:hsid_{s}_missing', 'k'],
    ['session', 'retitle', 'hsid-{s}-missing', '--title', 'x'],
    ['session', 'retitle', 'hsid-{s}-missing', '--regenerate'],
    ['session', 'meta', 'set', 'agent:ghost{s}:project:' + PROJECT + ':task:none', 'k', 'v'],
    ['session', 'meta', 'set', 'runtime:rt-{s}-missing', 'k', 'v'],
    ['session', 'meta', 'set', 'not a selector {s}', 'k', 'v'],
    ['session', 'meta', 'set', 'scope:', 'k', 'v'],
    ['session', 'retitle', 'nobody{s}@', '--title', 'x'],
    ['session', 'meta', 'set', 'agent:' + AGENT + ':project:' + PROJECT + ':task:{s}/lane:other', 'k', 'v'],
]
# (setup, argv): setup is 'unplaced', 'placed' or 'live'; {t} is that twin's
# scope in the named form; `again` repeats the previous scope.
RETIRE = [
    ('placed', 'scope', ['federation', 'retire', '{t}']),
    ('placed', 'scope', ['federation', 'retire', '{t}', '--reason', '   ']),
    ('placed', 'scope', ['federation', 'retire', '{t}', '--reason']),
    ('placed', 'scope', ['federation', 'retire', '--reason', 'r']),
    ('placed', 'scope', ['--output', 'json', 'federation', 'retire', '{t}']),
    ('unplaced', 'scope', ['federation', 'retire', '{t}', '--reason', 'never here']),
    ('unplaced', 'scope', ['federation', 'retire', '{t}', '--reason', 'never here', '--json']),
    ('live', 'scope', ['federation', 'retire', '{t}', '--reason', 'still running']),
    ('again', 'scope', ['federation', 'retire', '{t}', '--reason', 'still running', '--json']),
    ('placed', 'scope', ['federation', 'retire', '{t}', '--reason', '  operator retirement  ']),
    ('again', 'scope', ['federation', 'retire', '{t}', '--reason', 'again']),
    ('placed', 'handle', ['federation', 'retire', '{t}', '--reason=handle form', '--json']),
    ('again', 'handle', ['--output', 'json', 'federation', 'retire', '{t}', '--reason', 'idem']),
    ('placed', 'bare-task', ['federation', 'retire', '{t}', '--reason', 'qualified from cwd']),
    ('placed', 'session', ['federation', 'retire', '{t}', '--reason', 'session handle']),
    ('placed', 'scope', ['federation', 'retire', '{t}', '--reason', 'x', '--wat']),
    ('unplaced', 'scope', ['federation', 'retire', 'not a scope!', '--reason', 'bad']),
    ('unplaced', 'scope', ['federation', 'retire', 'agent:', '--reason', 'bad']),
    ('unplaced', 'scope', ['federation', 'retire', 'clod:T-1', '--reason', 'task without project']),
    ('placed', 'scope', ['federation', 'retire', '--help']),
    ('placed', 'scope', ['federation', '--help']),
]


def retire_forms(task):
    return {'scope': scope(task), 'handle': f'{AGENT}@{PROJECT}:{task}', 'bare-task': f'{AGENT}:{task}',
            'session': f'{AGENT}@{PROJECT}:{task}~main'}


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('--binary', type=Path, default=REPO / 'crates/target/aarch64-apple-darwin/debug/rusthrc')
    p.add_argument('--oracle', type=Path, help='a Bun hrc.js that still has these commands')
    p.add_argument('--record', action='store_true', help='with --oracle: rewrite the golden when every case matches')
    p.add_argument('--root', type=Path, default=Path(f'/tmp/hmeta-{os.getpid()}'))
    p.add_argument('--artifacts', type=Path, required=True)
    a = p.parse_args()
    assert not a.record or a.oracle, '--record needs --oracle'
    binary = a.binary.resolve()
    root = a.root.absolute()
    root.mkdir(parents=True)  # refuse a reused root
    assert not str(root).startswith(str(LIVE_STATE))
    a.artifacts.mkdir(parents=True, exist_ok=True)
    sides = ['bun', 'native'] if a.oracle else ['native']
    # kernel_fold's node: a declaring fake aspd, the stub broker release, a
    # private wrkqd, and an enforced gate on a peerless node that hosts its own
    # binding registry, so an explicit create establishes the scope here and
    # retirement fences the local ledger before releasing the registry binding.
    r, aspd, _ = substrate(root, a.artifacts, binary)
    # The declaration contract always carries searchedAgentRoots (string[]);
    # kernel_fold's fake omits it, and Bun's placement reader dereferences it.
    declare = aspd.handle

    def handle(method, params):
        out = declare(method, params)
        if method == 'aspc.resolveRuntimeDeclaration':
            out.setdefault('searchedAgentRoots', [])
        return out
    aspd.handle = handle
    (root / 'no-bun').mkdir()
    r.env.update(HRC_METRICS='0', NO_COLOR='1', FORCE_COLOR='0')
    env = r.env
    cli_env = {'bun': dict(env), 'native': dict(env, PATH=f"{root / 'no-bun'}:/usr/bin:/bin")}
    assert shutil.which('bun', path=cli_env['native']['PATH']) is None

    def cli(side, argv):
        command = [shutil.which('bun'), str(a.oracle.resolve())] if side == 'bun' else [str(binary)]
        c = subprocess.run(command + argv, env=cli_env[side], cwd=root / PROJECT, text=True, capture_output=True, timeout=60)
        return {'exit': c.returncode, 'stdout': c.stdout, 'stderr': c.stderr}

    def place(task):
        status, session = r.http('POST', '/v1/sessions/resolve', {'sessionRef': scope(task) + '/lane:main', 'create': True,
                                                                  'summonIntent': 'explicit_local',
                                                                  'runtimeIntent': placement_hint(root)})
        assert status == 200, (status, session)
        return session['hostSessionId']

    def birth(task, host):
        intent = dict(placement_hint(root), harness={'provider': 'anthropic', 'interactive': True})
        status, born = r.http('POST', '/v1/turns', {'hostSessionId': host, 'prompt': 'retire e2e turn', 'runtimeIntent': intent})
        assert status in (200, 202), ('birth', status, born)
        r.wait(lambda: r.rows("SELECT 1 FROM hrc_events WHERE run_id=? AND event_kind='turn.awaiting_input'", (born['runId'],)),
               60, 'live runtime')
        return born['runtimeId']

    def metadata(task):
        status, body = r.http('GET', f"/v1/sessions/metadata?scopeRef={scope(task)}&laneRef=main")
        return {'status': status, 'body': body}

    def retirement(task):
        s = scope(task)
        return {'ledger': r.rows('SELECT state, home_node_id IS NOT NULL AS homed, retired_at IS NOT NULL AS retired, '
                                 'retirement_reason FROM placement_ledger WHERE scope_ref=?', (s,)),
                'continuities': r.rows('SELECT count(*) AS n FROM continuities WHERE scope_ref=?', (s,))[0]['n'],
                'reuseDisabled': [x['d'] for x in r.rows('SELECT continuation_reuse_disabled AS d FROM sessions '
                                                         'WHERE scope_ref=? ORDER BY generation', (s,))]}

    def norm(value, swaps):
        text = json.dumps(value, ensure_ascii=False)
        for real, placeholder in swaps:
            text = text.replace(real, placeholder)
        return json.loads(ISO.sub('<ts>', text))

    results = []
    golden = {} if a.oracle else json.loads(GOLDEN.read_text())['cases']

    def judge(name, observed):
        if a.oracle:
            ok = observed.get('bun') == observed['native']
            results.append({'case': name, 'pass': ok, 'oracle': observed.get('bun'), 'subject': observed['native']})
            golden[name] = observed['native']
        else:
            ok = golden.get(name) == observed['native']
            results.append({'case': name, 'pass': ok, 'expected': golden.get(name), 'subject': observed['native']})
        print(('PASS ' if ok else 'FAIL ') + name, flush=True)

    try:
        r.up('1')
        # == session meta set|clear, session retitle: one continuity per twin ==
        hosts = {side: place(SIDES[side]) for side in sides}
        for i, (form, template) in enumerate(META):
            observed = {}
            for side in sides:
                task, host = SIDES[side], hosts[side]
                argv = [targets(task, host)[form] if x == '{t}' else x for x in template]
                swaps = [(host, '<host>'), (task, '<twin>')]
                observed[side] = norm({'cli': cli(side, argv), 'stored': metadata(task)}, swaps)
            judge(f'meta {i:02d} [{form}] ' + ' '.join(template), observed)
        for i, template in enumerate(UNKNOWN):
            observed = {}
            for side in sides:
                argv = [x.replace('{s}', SIDES[side]) for x in template]
                observed[side] = norm({'cli': cli(side, argv)}, [(SIDES[side], '<twin>')])
            judge(f'unknown {i:02d} ' + ' '.join(template), observed)

        # == federation retire: one scope per twin and case ====================
        tasks = {}
        for i, (setup, form, template) in enumerate(RETIRE):
            observed = {}
            for side in sides:
                if setup != 'again':
                    tasks[side] = f'rt{i:02d}{SIDES[side]}'
                    swaps = [(tasks[side], '<twin>')]
                    if setup in ('placed', 'live'):
                        host = place(tasks[side])
                        swaps.append((host, '<host>'))
                        if setup == 'live':
                            runtime = birth(tasks[side], host)
                            swaps.append((runtime, '<runtime>'))
                    tasks[side, 'swaps'] = swaps
                task, swaps = tasks[side], tasks[side, 'swaps']
                argv = [retire_forms(task)[form] if x == '{t}' else x for x in template]
                observed[side] = norm({'cli': cli(side, argv), 'stored': retirement(task)}, swaps)
            judge(f'retire {i:02d} [{setup}/{form}] ' + ' '.join(template), observed)
    finally:
        for proc in r.owners:
            if proc.poll() is None:
                r.down(proc)
        for log in r.logs:
            log.close()
        (a.artifacts / 'results.json').write_text(json.dumps({'mode': 'bun differential' if a.oracle else 'golden',
                                                              'cases': len(results), 'results': results},
                                                             indent=2, ensure_ascii=False) + '\n')

    failed = [x['case'] for x in results if not x['pass']]
    if a.record and not failed:
        GOLDEN.parent.mkdir(exist_ok=True)
        oracle_commit = subprocess.run(['git', '-C', str(a.oracle.resolve().parent), 'rev-parse', '--short', 'HEAD'],
                                       capture_output=True, text=True).stdout.strip() or 'unknown'
        GOLDEN.write_text(json.dumps({'recordedFrom': f'native, verified identical to the Bun CLI at {oracle_commit}', 'cases': golden},
                                     indent=1, ensure_ascii=False) + '\n')
    (a.artifacts / 'results.json').write_text(json.dumps({'mode': 'bun differential' if a.oracle else 'golden',
                                                          'cases': len(results), 'failed': failed, 'results': results},
                                                         indent=2, ensure_ascii=False) + '\n')
    print(json.dumps({'cases': len(results), 'failed': len(failed)}))
    if not failed:
        shutil.rmtree(root, ignore_errors=True)
    return 1 if failed else 0


if __name__ == '__main__':
    raise SystemExit(main())
