#!/usr/bin/env python3
"""Message filters and row shape over native store inserts, through HTTP.

Failure modes: applying filters after limit, wrong address/lane normalization,
missing execution/metadata fields, invalid-type error order, or pretending local
history is complete. Collective authority/replication belongs to N4.
"""
import argparse,json,sqlite3
from pathlib import Path
from n3_scratch import Scratch

def exercise(s):
    seat='agent:tabularasa:project:n3-t11839:task:messages/lane:main'
    cases=[('empty-body',None),('primitive',3),('array',[]),('all',{}),('id',{'messageId':'msg-2'}),('from',{'from':{'kind':'entity','entity':'human'}}),('to',{'to':{'kind':'session','sessionRef':seat}}),('participant',{'participant':{'kind':'session','sessionRef':seat}}),('thread',{'thread':{'rootMessageId':'msg-0'}}),('after',{'afterSeq':2}),('kinds',{'kinds':['dm','system']}),('phases',{'phases':['response']}),('generation',{'generation':1}),('reverse-limit',{'order':'desc','limit':2}),('host',{'hostSessionId':'hs-message'}),('run',{'runId':'run-message'}),('reply',{'replyToMessageId':'msg-0'}),('invalid-thread',{'thread':3}),('invalid-after',{'afterSeq':-1}),('invalid-limit',{'limit':0}),('invalid-order',{'order':'random'}),('invalid-kinds',{'kinds':['bad']}),('invalid-phases',{'phases':'response'}),('invalid-reply',{'replyToMessageId':42}),('invalid-generation',{'generation':-1}),('invalid-participant',{'participant':None}),('invalid-entity',{'from':{'kind':'entity','entity':'agent'}}),('invalid-kind',{'to':{'kind':'other'}}),('invalid-ref',{'to':{'kind':'session','sessionRef':'bad'}}),('default-lane',{'to':{'kind':'session','sessionRef':seat.replace('lane:main','lane:default')}}),('empty-lists',{'kinds':[],'phases':[]}),('thread-root-type',{'thread':{'rootMessageId':3}})]
    return {key:s.http('POST','/v1/messages/query',body) for key,body in cases}

SEAT = 'agent:tabularasa:project:n3-t11839:task:messages/lane:main'
EXEC = ('state', 'mode', 'sessionRef', 'hostSessionId', 'generation', 'runtimeId', 'runId', 'transport', 'errorCode', 'errorMessage')
EXEC_COLUMNS = ('execution_state', 'execution_mode', 'session_ref', 'host_session_id', 'generation', 'runtime_id', 'run_id', 'transport', 'error_code', 'error_message')


def seed_messages(db_path):
    """Seven dm/literal/system rows by hrc_store::messages insert and update_execution, verbatim.

    No HTTP door writes literal or system rows, so the store's own statements seed them.
    """
    seat = {'kind': 'session', 'sessionRef': SEAT}
    human, system = {'kind': 'entity', 'entity': 'human'}, {'kind': 'entity', 'entity': 'system'}
    ref = lambda a: a['entity'] if a['kind'] == 'entity' else a['sessionRef']
    rows = []
    with sqlite3.connect(db_path, timeout=30) as db:
        for i in range(7):
            m = {'messageId': f'msg-{i}', 'kind': ('dm', 'literal', 'system')[i % 3], 'phase': ('request', 'response', 'oneway')[i % 3],
                 'from': seat if i % 2 else human, 'to': system if i % 2 else seat, 'body': '' if i == 2 else f'body {i} \u6f22\u5b57\nnext',
                 'replyToMessageId': 'msg-0' if i == 1 else None, 'rootMessageId': 'msg-0' if i == 1 else None,
                 'execution': {'state': 'completed' if i % 2 else 'not_applicable', 'mode': 'headless', 'sessionRef': SEAT,
                               'hostSessionId': 'hs-message', 'generation': i % 2, 'runtimeId': 'rt-message', 'runId': 'run-message', 'transport': 'pipe'},
                 'metadataJson': {'fixture': 'native store insert', 'i': i}}
            columns = ['message_id', 'created_at', 'kind', 'phase', 'from_kind', 'from_ref', 'to_kind', 'to_ref',
                       'reply_to_message_id', 'root_message_id', 'body', 'body_format', *EXEC_COLUMNS, 'metadata_json']
            values = [m['messageId'], '2026-11-10T00:00:0%d.000Z' % i, m['kind'], m['phase'], m['from']['kind'], ref(m['from']),
                      m['to']['kind'], ref(m['to']), m['replyToMessageId'], m['rootMessageId'] or m['messageId'], m['body'], 'text/plain',
                      *[m['execution'].get(k) for k in EXEC], json.dumps(m['metadataJson'], separators=(',', ':'))]
            db.execute(f'INSERT INTO messages ({",".join(columns)}) VALUES ({",".join("?" * len(values))})', values)
            rows.append(m)
        db.execute('UPDATE messages SET coalesced_into_run_id=?,coalesced_position=?,error_code=?,error_message=? WHERE message_id=?',
                   ('run-other', 2, 'fixture', 'observed', 'msg-1'))
    return rows


def main():
    p=argparse.ArgumentParser()
    for k in ('binary','aspd-socket','scratch-root','artifacts'):p.add_argument('--'+k,type=Path,required=True)
    p.add_argument('--installed-release',type=Path,help='accepted and ignored')
    a=p.parse_args();s=Scratch(a.scratch_root,a.installed_release,a.aspd_socket,a.binary,a.artifacts,project_id='n3-t11839')
    try:
        s.init_substrate()
        owner=s.up('native','message-schema');empty=s.http('POST','/v1/messages/query',{});s.down(owner)
        seeded=seed_messages(s.db_path)
        s.up('native','message-subject');got=exercise(s)
        (a.artifacts/'messages.json').write_text(json.dumps({'empty':empty,'seeded':seeded,'reads':got},indent=2,ensure_ascii=False)+'\n')
        failures=check(empty,got,seeded)
        assert not failures,failures
        print(json.dumps({'pass':True,'cases':len(got),'artifacts':str(a.artifacts)}))
    finally:s.cleanup('agent:tabularasa:project:n3-t11839:task:')


ALL = list(range(7))
# case -> the seeded i's it must select, in order (message_seq = i + 1).
SELECT = {'array': ALL, 'all': ALL, 'empty-lists': ALL, 'host': ALL, 'run': ALL,
          'participant': ALL,  # the seat is the sender or the recipient of every row
          'id': [2], 'from': [0, 2, 4, 6], 'to': [0, 2, 4, 6], 'default-lane': [0, 2, 4, 6],
          'thread': [0, 1], 'after': [2, 3, 4, 5, 6], 'kinds': [0, 2, 3, 5, 6], 'phases': [1, 4],
          'generation': [1, 3, 5], 'reverse-limit': [6, 5], 'reply': [1]}
# case -> (error code, detail.field) for the refusals.
REFUSE = {'empty-body': ('malformed_request', None), 'primitive': ('malformed_request', None),
          'invalid-thread': ('malformed_request', 'thread.rootMessageId'), 'thread-root-type': ('malformed_request', 'thread.rootMessageId'),
          'invalid-after': ('malformed_request', 'afterSeq'), 'invalid-limit': ('malformed_request', 'limit'),
          'invalid-order': ('malformed_request', 'order'), 'invalid-kinds': ('malformed_request', 'kinds[0]'),
          'invalid-phases': ('malformed_request', 'phases'), 'invalid-reply': ('malformed_request', 'replyToMessageId'),
          'invalid-generation': ('malformed_request', 'generation'), 'invalid-participant': ('malformed_request', 'participant'),
          'invalid-entity': ('malformed_request', 'from.entity'), 'invalid-kind': ('malformed_request', 'to.kind'),
          'invalid-ref': ('invalid_selector', None)}


def expected_row(m, i):
    row = {'messageSeq': i + 1, 'messageId': m['messageId'], 'kind': m['kind'], 'phase': m['phase'], 'from': m['from'], 'to': m['to'],
           'rootMessageId': m['rootMessageId'] or m['messageId'], 'body': m['body'], 'bodyFormat': 'text/plain',
           'execution': dict(m['execution']), 'metadataJson': m['metadataJson']}
    if m['replyToMessageId']:
        row['replyToMessageId'] = m['replyToMessageId']
    if i == 1:
        row['execution'].update(coalescedIntoRunId='run-other', coalescedPosition=2, errorCode='fixture', errorMessage='observed')
    return row


def check(empty, got, seeded):
    failures = []
    assert set(SELECT) | set(REFUSE) == set(got), sorted(set(got) ^ (set(SELECT) | set(REFUSE)))
    status, body = empty
    if status != 200 or body['messages'] or body['history'].get('pendingReplicationCount') != 0:
        failures.append(('empty store', status, body))
    for name, want in SELECT.items():
        status, body = got[name]
        if status != 200:
            failures.append((name, status, body)); continue
        ids = [m['messageId'] for m in body['messages']]
        if ids != [f'msg-{i}' for i in want]:
            failures.append((name, 'selected', ids))
        for m in body['messages']:
            i = int(m['messageId'].split('-')[1])
            row = {k: v for k, v in m.items() if k != 'createdAt'}
            if row != expected_row(seeded[i], i):
                failures.append((name, 'row shape', m['messageId'], row))
        history = body['history']
        # Local history never claims to be the collective record.
        if (history['source'], history['complete'], history['pendingReplicationCount']) != ('local', False, 7):
            failures.append((name, 'history', history))
    for name, (code, field) in REFUSE.items():
        status, body = got[name]
        error = body.get('error', {}) if isinstance(body, dict) else {}
        if status != 400 or error.get('code') != code or (field and error.get('detail', {}).get('field') != field):
            failures.append((name, 'refusal', status, body))
    return failures
if __name__=='__main__':main()
