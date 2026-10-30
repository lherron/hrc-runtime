#!/usr/bin/env python3
"""Read-only installed/live wire smoke. Does not start or stop any service."""
import argparse
import datetime
import json
import pathlib
import time
from kernel_fold import Wire as FoldWire


class Wire(FoldWire):
    def call(self, op, args=None):
        reply = self.raw(op, args)
        assert reply.get("ok"), reply
        return reply["result"]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--socket', required=True)
    parser.add_argument('--artifacts', required=True)
    options = parser.parse_args()
    target = pathlib.Path(options.artifacts)
    target.mkdir(parents=True, exist_ok=True)
    wire = Wire(options.socket)
    discovery = wire.call('registry.discover')
    types = {t['name']: t for t in discovery['node_types']}
    assert {'hrc.seat', 'hrc.runtime', 'hrc.project'} <= types.keys()
    assert types['hrc.seat']['attachable']['transport'] == 'tmux-attach'
    deadline = time.monotonic() + 120
    while True:
        query = wire.call('document.query', dict(document_id='hrc', type='hrc.seat', limit=1000))
        if query['rows'] and not query['bootstrapping']:
            break
        assert time.monotonic() < deadline, wire.call('ingest.status', dict(document_id='hrc'))
        time.sleep(.25)
    assert query['next'] is None, 'probe limit must cover the complete live set'
    sessions = [r['payload']['sessionRef'] for r in query['rows']]
    assert len(sessions) == len(set(sessions)), 'duplicate seats'
    runtime_rows = wire.call('document.query', dict(document_id='hrc', type='hrc.runtime', limit=1000))
    status = wire.call('ingest.status', dict(document_id='hrc'))
    binding = status['bindings'][0]
    assert binding['caught_up'] and binding['resync']['every_ms'] == 600000, binding
    assert binding['cursor']['incarnation'] and isinstance(binding['cursor']['seq'], int)
    attached = []
    unavailable = []
    ended = []
    for row in query['rows']:
        if row['payload'].get('tmux') or row['payload'].get('hrcpty'):
            wire.file.write((json.dumps(dict(id='attach', op='resource.attach', args=dict(document_id='hrc', id=row['id'])))+'\n').encode())
            reply = json.loads(wire.file.readline())
            if not reply['ok']:
                assert reply['error']['code'] == 'resource_unavailable' and reply['error']['details']['reason'] == 'ended', reply
                ended.append(dict(id=row['id'], error=reply['error']))
                continue
            answer = reply['result']
            assert answer['transport'] == 'tmux-attach'
            assert answer['descriptor']['mode'] == 'read-only'
            flag = '--read-only' if row['payload'].get('hrcpty') else '-r'
            assert flag in answer['descriptor']['argv']
            attached.append(dict(id=row['id'], sessionRef=row['payload']['sessionRef'], attach=answer))
        else:
            wire.file.write((json.dumps(dict(id='absent', op='resource.attach', args=dict(document_id='hrc', id=row['id'])))+'\n').encode())
            answer = json.loads(wire.file.readline())
            assert not answer['ok'] and answer['error']['code'] == 'resource_unavailable', answer
            unavailable.append(row['id'])
    resync = wire.call('resync')
    subscriber = Wire(options.socket)
    live = subscriber.call('events.subscribe', dict(after=resync['cursor'], incarnation=resync['host_incarnation']))
    assert live['host_incarnation'] == resync['host_incarnation'], live
    subscriber.close()
    subscribed = Wire(options.socket)
    query_sub = subscribed.call('query.subscribe', dict(document_id='hrc', type='hrc.seat'))
    subscribed.close()
    report = dict(at=datetime.datetime.now(datetime.timezone.utc).isoformat(), socket=options.socket,
                  discovery=discovery, seats=query, runtimes=runtime_rows, ingest=status,
                  attach=attached, unavailable=unavailable, ended=ended, resync=resync,
                  events_subscribe=live, query_subscribe=query_sub)
    (target/'probe.json').write_text(json.dumps(report, indent=2)+'\n')
    print(json.dumps(dict(pass_=True, seats=len(sessions), runtimes=len(runtime_rows['rows']),
                          attachable=len(attached), unavailable=len(unavailable), ended=len(ended), cursor=binding['cursor'],
                          host_incarnation=resync['host_incarnation'], artifact=str(target/'probe.json'))))
    wire.close()


if __name__ == '__main__':
    main()
