#!/usr/bin/env python3
"""Real ASP profile compilation and hosted launch metadata, on private state.

Checks first birth, identical/changed recompiles, launch replacement, rejected
leaves without birth failure, and API precedence. No store seeding or fake ASP.
This is manual task acceptance, deliberately outside the standing verify gate.
"""
import argparse
import json
from pathlib import Path
from urllib.parse import urlencode

from n3_scratch import Scratch


def main():
    p = argparse.ArgumentParser(description=__doc__)
    for key in ('binary', 'aspd-socket', 'scratch-root', 'artifacts'):
        p.add_argument('--' + key, type=Path, required=True)
    a = p.parse_args()
    assert a.artifacts.resolve().is_relative_to(Path('/tmp').resolve()), '--artifacts must be under /tmp'
    s = Scratch(a.scratch_root, None, a.aspd_socket, a.binary, a.artifacts, project_id='t13180')
    s.env.update(HRC_METRICS='0', HRC_PEER_CONFIG_FILE=str(s.root / 'absent-federation.json'))
    scope = 'agent:tabularasa:project:t13180:task:metadata'
    agent = s.root / 'agents/tabularasa'
    agent.mkdir(parents=True)
    results = {'pass': False, 'cases': {}}

    def profile(color, bg='#112233'):
        text = ('version = 4\n[identity]\ndisplay = "Metadata probe"\n'
                '[provisioning]\nharness = "claude"\n[spaces]\nbase = []\n')
        if color is not None:
            text += f'[session.metadata.appearance]\ncolor = "{color}"\nterminalBg = "{bg}"\n'
        (agent / 'agent-profile.toml').write_text(text)

    def call(method, path, body=None):
        code, value = s.http(method, path, body)
        assert code == 200, (code, value)
        return value

    def snapshot():
        return {
            'rows': s.rows('SELECT * FROM session_metadata ORDER BY key,source'),
            'events': s.rows("SELECT hrc_seq,event_kind,payload_json FROM hrc_events "
                             "WHERE event_kind IN ('session.metadata.changed','session.metadata.rejected') ORDER BY hrc_seq"),
            'session': call('GET', '/v1/sessions/get?' + urlencode({'scopeRef': scope})),
        }

    def launch(name, color, bg='#112233'):
        profile(color, bg)
        before = snapshot()
        born = call('POST', '/v1/runtimes/start', {'hostSessionId': host, 'intent': intent, 'restartStyle': 'fresh_pty'})
        after = snapshot()
        preparations = s.rows('SELECT preparation_json FROM runtime_operations WHERE runtime_id=?', (born['runtimeId'],))
        assert len(preparations) == 1, preparations
        compiled = json.loads(preparations[0]['preparation_json'])['response']
        case = {'profileColor': color, 'profileBg': bg, 'birth': born, **after,
                'compiledMetadata': compiled['sessionMetadata'],
                'aspRelease': compiled['executionRelease']['releaseId'],
                'newEvents': after['events'][len(before['events']):]}
        results['cases'][name] = case
        assert born['status'] == 'ready' and born['hostSessionId'] == host, born
        assert born['runtimeId'] not in runtimes, ('recompile reused runtime', born)
        runtimes.add(born['runtimeId'])
        return case

    def launch_values(case):
        return {r['key']: json.loads(r['value_json']) for r in case['rows'] if r['source'] == 'launch'}

    def changed(case):
        return [json.loads(e['payload_json']) for e in case['newEvents'] if e['event_kind'] == 'session.metadata.changed']

    try:
        s.init_substrate()
        s.up('native', 'metadata')
        profile('#123456')
        declaration = call('POST', '/v1/declarations/resolve', {
            'agentId': 'tabularasa', 'agentRoot': str(agent), 'projectId': 't13180',
            'projectRoot': str(s.project), 'cwd': str(s.project),
            'preferredMode': 'headless', 'interactive': False,
        })
        intent = declaration['intent']
        intent['presentation'] = {'operator': 'none'}
        results['intent'] = intent
        session = call('POST', '/v1/sessions/resolve', {'sessionRef': scope + '/lane:main',
                       'create': True, 'summonIntent': 'explicit_local', 'runtimeIntent': intent})
        host = session['hostSessionId']
        runtimes = set()
        first = launch('first', '#123456')
        assert launch_values(first) == {'appearance.color': '#123456', 'appearance.terminalBg': '#112233'}, first
        assert first['session']['metadata']['appearance'] == {'color': '#123456', 'terminalBg': '#112233'}, first
        assert len(changed(first)) == 2, first
        same = launch('unchanged', '#123456')
        assert same['rows'] == first['rows'] and same['newEvents'] == [], same
        new = launch('changed', '#654321')
        assert launch_values(new)['appearance.color'] == '#654321', new
        assert [e['key'] for e in changed(new)] == ['appearance.color'], new
        assert new['session']['metadata']['appearance']['color'] == '#654321', new
        # Two bad leaves: each must have its own rejection while the birth succeeds.
        invalid = launch('invalid', 'invalid-color', 'invalid-bg')
        rejects = [json.loads(e['payload_json']) for e in invalid['newEvents'] if e['event_kind'] == 'session.metadata.rejected']
        assert sorted(e['key'] for e in rejects) == ['appearance.color', 'appearance.terminalBg'], invalid
        assert launch_values(invalid) == {}, invalid
        mixed = launch('mixed', 'invalid-color')
        assert launch_values(mixed) == {'appearance.terminalBg': '#112233'}, mixed
        rejects = [e for e in mixed['newEvents'] if e['event_kind'] == 'session.metadata.rejected']
        assert len(rejects) == 1, mixed
        call('PATCH', '/v1/sessions/metadata', {'scopeRef': scope, 'set': {'appearance.color': '#ABCDEF'}})
        api = launch('api-over-launch', '#987654')
        assert launch_values(api)['appearance.color'] == '#987654', api
        assert api['session']['metadata']['appearance']['color'] == '#ABCDEF', api
        assert api['session']['metadataSources']['appearance.color']['source'] == 'api', api
        empty = launch('removed-profile-metadata', None)
        assert launch_values(empty) == {}, empty
        assert empty['session']['metadata']['appearance']['color'] == '#ABCDEF', empty
        results['pass'] = True
        print(json.dumps({'pass': True, 'cases': list(results['cases']), 'artifacts': str(a.artifacts)}))
    finally:
        (a.artifacts / 'result.json').write_text(json.dumps(results, indent=2) + '\n')
        (a.artifacts / 'steps.json').write_text(json.dumps(s.steps, indent=2) + '\n')
        s.cleanup('agent:tabularasa:project:t13180:')


if __name__ == '__main__':
    main()
