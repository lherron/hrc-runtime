#!/usr/bin/env python3
"""Verified primary grant forwarded to a private native peer; origin never acts."""
import copy
import json
from lifecycle_fixture import LifecycleFixture, prove_delta
from native_seat import arguments, report
from metrics_isolation import isolated_suite
from n4_federation import local_tailnet_address, free_port
import secrets


@isolated_suite
def main():
    a = arguments().parse_args()
    a.artifacts.mkdir(parents=True, exist_ok=True)
    origin_args, target_args = copy.copy(a), copy.copy(a)
    origin_args.artifacts, target_args.artifacts = a.artifacts / 'origin', a.artifacts / 'target'
    results = []
    with LifecycleFixture(origin_args) as origin, LifecycleFixture(target_args) as target:
        primary = origin.actor('mable')
        ordinary = origin.actor('mable', 'not-primary')
        host, port = local_tailnet_address(), free_port()
        token = secrets.token_hex(24)
        target.configure(dict(nodeId='fixture-target', peers={'fixture-origin': dict(endpoint=f'http://{host}:{free_port()}', token=token)},
                              peerListener=dict(bind=f'http://{host}:{port}'), gate=dict(mode='off')))
        origin.configure(dict(nodeId='fixture-origin', peers={'fixture-target': dict(endpoint=f'http://{host}:{port}', token=token)}, gate=dict(mode='off')))
        for action in ('restart', 'stop'):
            old, before = target.ready()
            origin_pid, _ = origin.ready()
            initial, origin_rows = target.facts(), origin.facts()
            body = dict(action=action, targetNode='fixture-target', reason='Private peer qualification', proofTimeoutMs=5000)
            code, refused = origin.lifecycle(body, ordinary)
            assert code == 403 and refused['error']['detail']['refusal'] == 'not_authorized', (code, refused)
            assert target.facts() == initial and origin.facts() == origin_rows
            code, response = origin.lifecycle(body, primary)
            assert code == 200 and response['accepted'] is True and response['targetNode'] == 'fixture-target', (code, response)
            if action == 'restart':
                target.awaiting_restart = old
                new, after = target.ready(old)
                assert response['remote']['proven'] is True
                assert response['remote']['beforeStartedAt'] == before['startedAt']
                assert response['remote']['afterStartedAt'] == after['startedAt'] != before['startedAt']
            else:
                target.stopped()
                new = None
            grant = response['grant']
            assert grant['originNode'] == 'fixture-origin' and grant['callerKind'] == 'mable-primary'
            assert grant['requestedBy'] == primary['sessionRef'].split('/')[0]
            delta = prove_delta(target, initial, action, grant, old, new)
            assert origin.facts() == origin_rows and origin.ready()[0] == origin_pid, 'origin acted on itself'
            results.append(dict(case='peer-granted-' + action, response=response, beforePid=old, afterPid=new,
                                rows=delta, nonPrimaryRefused=True, originUnchanged=True, **{'pass': True}))
    return report(a, results)


if __name__ == '__main__':
    raise SystemExit(main())
