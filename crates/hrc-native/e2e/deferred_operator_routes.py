#!/usr/bin/env python3
"""Native federation retirement validation and old-home refusal."""
from routes import main


def cases(scope, host):
    return [(name, 'POST', '/v1/federation/retire', body) for name, body in [
        ('retire-missing', {}), ('retire-array', []), ('retire-primitive', 3),
        ('retire-unconfigured', {'scopeRef': scope, 'reason': 'test'}),
    ]]


def compare(results):
    rows=results['native']
    assert len(rows)==4
    for row in rows[:3]:
        assert row['response']['status']==400,row
        assert row['response']['body']['error']['code']=='malformed_request',row
    result=rows[-1]['response']
    assert result['status']==200 and result['body']['ok'] is False,result
    assert result['body']['outcome']=='refused' and result['body']['state']=='unchanged',result
    assert result['body']['retryable'] is False,result
    assert result['body']['detail']=='retirement must be performed by the scope old home',result


if __name__ == '__main__':
    main(case_factory=cases, suite='deferred-operator-routes',compare=compare)
