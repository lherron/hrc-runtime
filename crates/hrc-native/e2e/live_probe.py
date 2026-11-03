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
    expected = {'seat.summon', 'seat.restart', 'seat.send', 'seat.annotation.put',
                'seat.annotation.act', 'seat.annotation.delete'}
    assert {o['name'] for o in discovery['operations'] if o['provider'] == 'hrc'} == expected
    assert not [t for t in discovery['node_types'] if t['provider'] == 'hrc']
    resync = wire.call('resync')
    subscriber = Wire(options.socket)
    live = subscriber.call('events.subscribe', dict(after=resync['cursor'], incarnation=resync['host_incarnation']))
    assert live['host_incarnation'] == resync['host_incarnation'], live
    subscriber.close()
    assert resync['documents'] == {}, resync
    report = dict(at=datetime.datetime.now(datetime.timezone.utc).isoformat(), socket=options.socket,
                  discovery=discovery, resync=resync, events_subscribe=live)
    (target/'probe.json').write_text(json.dumps(report, indent=2)+'\n')
    print(json.dumps(dict(pass_=True, operations=sorted(expected), documents=0,
                         artifact=str(target/'probe.json'))))
    wire.close()


if __name__ == '__main__':
    main()
