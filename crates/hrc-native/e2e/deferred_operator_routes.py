#!/usr/bin/env python3
"""Paired real-owner federation retirement refusals."""
from routes import main


def cases(scope, host):
    return [(name, 'POST', '/v1/federation/retire', body) for name, body in [
        ('retire-missing', {}), ('retire-array', []), ('retire-primitive', 3),
        ('retire-unconfigured', {'scopeRef': scope, 'reason': 'test'}),
    ]]


if __name__ == '__main__':
    main(case_factory=cases, suite='deferred-operator-routes')
