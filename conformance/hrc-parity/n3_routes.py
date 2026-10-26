"""N3 per-case comparison of real socket observations, including key order."""
import json
from pathlib import Path

# Dynamic producer identities and clocks may change; no behavioral fields may
# disappear from comparison. Their key positions still participate below.
DYNAMIC={'subscriberId','receiptToken','openedAt','lastStreamAcceptedAt','lastConsumerAcknowledgedAt','consumerReceiptBehindSince','keepaliveOnlySince','pendingSince'}

def canonical(value, dynamic=False):
    masked=dynamic if isinstance(dynamic,set) else DYNAMIC if dynamic else set()
    if isinstance(value,dict):
        return [(k,'<dynamic>' if k in masked and x is not None else canonical(x,dynamic)) for k,x in value.items()]
    if isinstance(value,list):return [canonical(x,dynamic) for x in value]
    # Raw NDJSON and serialized broker JSON remain byte-for-byte strings.
    return value

def compare(args,checks):
    filename={'n3-events':'events.json','n3-subscribers':'subscribers.json','n3-mail':'mail.json','n3-presentation':'presentation.json','n3-replay':'replay.json','n3-publication':'publication.json','n3-edges':'edges.json','n3-submissions':'submissions.json','n3-messages':'messages.json','n3-handoff':'handoff.json'}[args.suite]
    a=json.loads((Path(args.baseline)/filename).read_text());b=json.loads((Path(args.candidate)/filename).read_text())
    expected={'n3-events':23,'n3-subscribers':35,'n3-mail':10,'n3-presentation':12,'n3-replay':13,'n3-publication':9,'n3-edges':10,'n3-submissions':56,'n3-messages':32,'n3-handoff':37}[args.suite]
    checks.append({'id':'case-matrix','pass':len(a)==expected and set(a)==set(b),'reason':'exact required case set on both actual socket subjects','failureCode':1})
    cases=[]
    mask=DYNAMIC|{'runId','submissionId','turnId'} if args.suite=='n3-submissions' else args.suite in ('n3-subscribers','n3-replay','n3-edges')
    for name in a:
        passed=name in b and canonical(a[name],mask)==canonical(b[name],mask)
        checks.append({'id':'compare:'+name,'pass':passed,'reason':'status, fields, values, key order and NDJSON framing must match Bun','failureCode':1});cases.append({'id':name,'pass':passed})
    return {'suite':args.suite,'cases':cases,'behaviorQualified':all(c['pass'] for c in checks)}
