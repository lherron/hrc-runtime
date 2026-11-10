#!/usr/bin/env python3
"""Granted restart/stop variants and authorization refusals on a private owner."""
import json
from lifecycle_fixture import LifecycleFixture, prove_delta
from native_seat import arguments, report
from metrics_isolation import isolated_suite


@isolated_suite
def main():
    a = arguments().parse_args()
    results = []
    with LifecycleFixture(a) as f:
        primary = f.actor('mable')
        ordinary = f.actor('mable', 'not-primary')
        matrix = [('restart', {}), ('stop', {}), ('restart', {'wait': True}),
                  ('restart', {'force': True}), ('restart', {'drain': True}), ('stop', {'force': True})]
        for index, (action, flags) in enumerate(matrix):
            if not f.s.socket.exists():
                f.boot('action-' + str(index))
            old, before = f.ready()
            initial = f.facts()
            body = dict(action=action, reason='Private lifecycle qualification', **flags)
            refusals = [('non-primary', body, ordinary, 403, 'not_authorized')]
            if index < 2:
                refusals += [('reason-required', {'action': action}, primary, 403, 'reason_required'),
                             ('unknown-node', {**body, 'targetNode': 'unknown-fixture-node'}, primary, 403, 'unknown_node')]
            for name, request, actor, expected_status, refusal in refusals:
                code, value = f.lifecycle(request, actor)
                assert code == expected_status and value['error']['detail']['refusal'] == refusal, (name, code, value)
                assert f.facts() == initial and f.ready()[0] == old
                results.append(dict(case=name + '-' + str(index), status=code, response=value, **{'pass': True}))
            code, response = f.lifecycle(body, primary)
            assert code == 200 and response['ok'] is True and response['accepted'] is True, (code, response)
            grant = response['grant']
            assert grant['action'] == action and grant['reason'] == body['reason'], grant
            assert grant['flags'] == {name: flags.get(name, False) for name in ('wait', 'drain', 'force')}, grant
            assert grant['callerKind'] == 'mable-primary' and grant['requestedBy'] == primary['sessionRef'].split('/')[0], grant
            if flags.get('drain'):
                runs = f.s.rows('SELECT run_id FROM runs ORDER BY run_id')
                refused, value = f.s.http('POST', '/v1/turns', dict(hostSessionId=ordinary['hostSessionId'], prompt='must refuse'))
                assert refused == 503 and value['error']['code'] == 'server_draining', (refused, value)
                detail = value['error']['detail']
                assert detail['retryable'] is True and detail['operationId'].startswith('restart-drain-')
                assert detail['requestedBy'] == grant['requestedBy'] and detail['closedAt']
                assert f.s.rows('SELECT run_id FROM runs ORDER BY run_id') == runs
                results.append(dict(case='drain-closes-admission', **{'pass': True}))
            if action == 'restart':
                new, after = f.ready(old)
                assert after['startedAt'] != before['startedAt']
                assert after['lastRestart']['requestedBy'] == grant['requestedBy']
                assert after['lastRestart']['reason'] == body['reason']
            else:
                f.stopped()
                new = None
            delta = prove_delta(f, initial, action, grant, old, new)
            results.append(dict(case='granted-' + action, flags=flags, response=response,
                                beforePid=old, afterPid=new, rows=delta, **{'pass': True}))
    return report(a, results)


if __name__ == '__main__':
    raise SystemExit(main())
