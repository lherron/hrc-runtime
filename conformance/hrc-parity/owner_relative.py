"""Explicit owner-relative facts for fixtures that intentionally use separate stores."""
import json
from urllib.parse import parse_qs, urlsplit

READY_RULE = 'owner-relative:bounded-stream-ready'
READY_FIELDS = ['replayHeadHrcSeq', 'ledgerIncarnationId']


def bounded_ready(row):
    """Validate raw ready against this owner's sampled page before projecting.

    An invalid observation is returned with its raw body/path intact. Callers
    must gate on rule.pass too; the projection alone is never qualification.
    """
    projected = dict(row)
    raw = row.get('wireBody', row.get('body'))
    path = row.get('wirePath', row.get('path', ''))
    projected.update(body=raw, path=path)
    rule = dict(id=READY_RULE, fields=READY_FIELDS, raw={}, expected={}, **{'pass': False})
    try:
        ready = json.loads(raw)
        page = row['ownerPage']
        incarnation, head = page['ledgerIncarnationId'], page['head']
        rule['raw'] = {key: ready.get(key) for key in READY_FIELDS}
        rule['expected'] = dict(replayHeadHrcSeq=head, ledgerIncarnationId=incarnation)
        expected = dict(type='ready', ledgerIncarnationId=incarnation,
                        acceptedAfterHrcSeq=0, replayHeadHrcSeq=head)
        query = parse_qs(urlsplit(path).query)
        valid = (row['status'] == 200 and ready == expected
                 and isinstance(incarnation, str) and bool(incarnation)
                 and type(head) is int and head >= 0
                 and query.get('ledgerIncarnationId') == [incarnation]
                 and query.get('afterSeq') == ['0'] and query.get('follow') == ['true'])
        rule['pass'] = valid
        if valid:
            projected['path'] = path.replace('ledgerIncarnationId=' + incarnation,
                                             'ledgerIncarnationId=<owner-ledger>')
            projected['body'] = json.dumps({key: '<owner-ledger>' if key == 'ledgerIncarnationId' else
                                           '<owner-head>' if key == 'replayHeadHrcSeq' else value
                                           for key, value in ready.items()}, separators=(',', ':')) + '\n'
    except (KeyError, TypeError, ValueError):
        pass
    return projected, rule
