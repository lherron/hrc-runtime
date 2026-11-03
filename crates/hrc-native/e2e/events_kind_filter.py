#!/usr/bin/env python3
"""T-12422: category/eventKind list filters on /v1/events, over real HTTP.

Failure modes, written before the driver:
F1 no filter changes a byte (history, follow, tail, bounded stream);
F2 a single value changes meaning (one category, one kind);
F3 a list or the category-OR-kind union leaks or drops a row;
F4 a live follower receives a non-matching row;
F5 a reconnect from the last delivered seq duplicates a row, or misses one
   written while it was away, when skipped rows sit on both sides of the cut;
F6 the bounded stream resume does the same;
F7 a list of only commas silently widens to the whole ledger.
The baseline is the installed rusthrc on the same seeded ledger; the subject
is the build under test. Ground truth is the unfiltered history, filtered here.
"""
import argparse
import json
import socket
import threading
import time
from pathlib import Path
from urllib.parse import urlencode

from n2_scratch import UnixHTTP
from n4_federation import Node

KINDS = [('runtime', 'runtime.ensured'), ('turn', 'turn.started'), ('turn', 'turn.tool_call'),
         ('turn', 'turn.tool_result'), ('turn', 'turn.tool_call'), ('turn', 'turn.message'),
         ('turn', 'turn.completed'), ('session', 'session.resolved'), ('turn', 'turn.attention'),
         ('runtime', 'runtime.status')]
CATS = 'runtime,session'
EVENT_KINDS = 'turn.started,turn.completed,turn.attention'


def seed_js(start, count):
    return f'''const db=openHrcDatabase(a[0]);const k={json.dumps(KINDS)};
for(let i={start};i<{start + count};i++){{const [c,e]=k[i%k.length];
db.hrcEvents.append({{ts:new Date(1700000000000+i).toISOString(),hostSessionId:'hsid-'+(i%3),scopeRef:'agent:t:project:p:task:T-'+(i%3),laneRef:'main',generation:1,category:c,eventKind:e,payload:{{i,pad:'x'.repeat(200)}}}});}}
db.close();'''


def wanted(row, cats=None, kinds=None):
    if cats is None and kinds is None:
        return True
    return (cats is not None and row['category'] in cats) or (kinds is not None and row['eventKind'] in kinds)


class Follow:
    """Reads raw NDJSON lines; keeps every byte so bytes can be compared."""

    def __init__(self, node, path):
        self.c = UnixHTTP(node.socket, 30)
        self.c.request('GET', path)
        self.res = self.c.getresponse()
        assert self.res.status == 200, (path, self.res.status, self.res.read())
        self.lines, self.bytes, self.lock = [], 0, threading.Lock()
        self.thread = threading.Thread(target=self._read, daemon=True)
        self.thread.start()

    def _read(self):
        try:
            while True:
                line = self.res.readline()
                if not line:
                    return
                with self.lock:
                    self.bytes += len(line)
                    if line.strip():
                        self.lines.append(line.decode())
        except (OSError, ValueError):
            return

    def records(self):
        with self.lock:
            return [json.loads(l) for l in self.lines]

    def wait(self, predicate, timeout=20):
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            if predicate(self.records()):
                return self.records()
            time.sleep(.05)
        raise AssertionError(('follow wait timed out', self.records()[-5:]))

    def close(self):
        try:
            self.c.sock.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        self.thread.join(timeout=2)
        self.c.close()


def history(node, query=''):
    status, body, _ = node.http('GET', '/v1/events' + ('?' + query if query else ''))
    assert status == 200, (query, status, body)
    return [l for l in body.splitlines() if l.strip()] if isinstance(body, str) else [json.dumps(body)]


def capture(node, head, incarnation):
    """Every no-filter and single-value read, bounded to the seeded rows."""
    def upto(lines):
        return [l for l in lines if json.loads(l)['hrcSeq'] <= head]
    out = {}
    for name, q in [('all', ''), ('cat_turn', 'category=turn'), ('kind_started', 'eventKind=turn.started'),
                    ('cat_turn_from', 'category=turn&fromSeq=40'), ('runtime_scope', 'scopeRef=agent:t:project:p:task:T-1')]:
        out['history:' + name] = upto(history(node, q))
    f = Follow(node, '/v1/events?follow=true&fromSeq=1')
    f.wait(lambda r: any(x['hrcSeq'] >= head for x in r))
    f.close()
    out['follow:all'] = upto(f.lines)
    f = Follow(node, '/v1/events?follow=true&fromSeq=1&category=turn')
    f.wait(lambda r: any(x['hrcSeq'] >= head - 10 for x in r))
    f.close()
    out['follow:cat_turn'] = upto(f.lines)
    status, tail, _ = node.http('GET', '/v1/events/tail?' + urlencode(
        {'limit': 50, 'beforeHrcSeq': head + 1, 'ledgerIncarnationId': incarnation}))
    assert status == 200, tail
    out['tail'] = [json.dumps(e, sort_keys=True) for e in tail['events']]
    f = Follow(node, '/v1/events/bounded-stream?' + urlencode(
        {'follow': 'true', 'afterSeq': 0, 'ledgerIncarnationId': incarnation}))
    f.wait(lambda r: any(x.get('type') == 'event' and x['event']['hrcSeq'] >= head for x in r))
    f.close()
    out['bounded:all'] = [l for l in f.lines if json.loads(l).get('type') == 'event'
                          and json.loads(l)['event']['hrcSeq'] <= head]
    return out


def main():
    p = argparse.ArgumentParser()
    for k in ('binary', 'baseline-binary', 'installed-release', 'aspd-socket', 'scratch-root', 'artifacts'):
        p.add_argument('--' + k, type=Path, required=True)
    a = p.parse_args()
    a.artifacts.mkdir(parents=True, exist_ok=True)
    node = Node(a.scratch_root, a.installed_release, a.aspd_socket, a.artifacts, 'kind')
    report = {'failureModes': __doc__.split('\n')[2:11]}
    try:
        node.bun_store('seed', seed_js(0, 120), node.db)

        # F1/F2: baseline (installed) then subject on the same ledger.
        owner = node.up('native', a.baseline_binary.resolve(), 'baseline')
        page = node.http('GET', '/v1/events/page?afterSeq=0&limit=1000')[1]
        incarnation = page['ledgerIncarnationId']
        head = max(r['hrcSeq'] for r in page['rows'] if r['category'] != 'server')
        base = capture(node, head, incarnation)
        # Discriminator: the baseline treats a list as one literal value.
        baseline_list = len(history(node, f'category={CATS}'))
        assert baseline_list == 0, ('baseline already filters lists; F3 proves nothing', baseline_list)
        report['baselineListRows'] = {f'category={CATS}': baseline_list}
        node.down(owner)
        owner = node.up('native', a.binary.resolve(), 'subject')
        subj = capture(node, head, incarnation)
        diffs = {k: (len(base[k]), len(subj[k])) for k in base if base[k] != subj[k]}
        assert not diffs, ('F1/F2 unfiltered or single-value output changed', diffs)
        assert all(base[k] for k in base), {k: len(v) for k, v in base.items()}
        report['unchanged'] = {'seededHead': head, 'cases': {k: {'lines': len(v), 'bytes': sum(map(len, v)),
                                                                 'byteIdentical': True} for k, v in base.items()}}

        # F3: lists and the union against ground truth.
        truth = [json.loads(l) for l in history(node)]
        cases = {'category=runtime,session': (set(CATS.split(',')), None),
                 'eventKind=' + EVENT_KINDS: (None, set(EVENT_KINDS.split(','))),
                 f'category={CATS}&eventKind={EVENT_KINDS}': (set(CATS.split(',')), set(EVENT_KINDS.split(','))),
                 'category=turn&eventKind=runtime.status': ({'turn'}, {'runtime.status'}),
                 'category= runtime , ,session,runtime': ({'runtime', 'session'}, None)}
        report['lists'] = {}
        for q, (cats, kinds) in cases.items():
            got = [json.loads(l)['hrcSeq'] for l in history(node, q.replace(' ', '%20'))]
            exp = [r['hrcSeq'] for r in truth if wanted(r, cats, kinds)]
            assert got == exp and got, ('F3', q, got[:10], exp[:10])
            report['lists'][q] = {'rows': len(got), 'matchesGroundTruth': True}

        # F7: comma-only lists refuse instead of widening.
        report['refusals'] = {}
        for q in ('category=,', 'eventKind=,%20,', 'category=,&eventKind=turn.started'):
            for route in ('/v1/events?', '/v1/events?follow=true&', '/v1/events/tail?limit=5&'):
                status, body, _ = node.http('GET', route + q)
                assert status == 400 and body['error']['code'] == 'malformed_request', (route, q, status, body)
                report['refusals'][route + q] = body['error']['message']

        # F4/F5: live filtered follow, cut, write while away, resume from last seen.
        filt = f'category={CATS}&eventKind={EVENT_KINDS}'
        cats, kinds = set(CATS.split(',')), set(EVENT_KINDS.split(','))
        live_from = history(node)
        start = json.loads(live_from[-1])['hrcSeq'] + 1
        unfilt = Follow(node, f'/v1/events?follow=true&fromSeq={start}')
        f1 = Follow(node, f'/v1/events?follow=true&fromSeq={start}&{filt}')
        node.bun_store('live-1', seed_js(1000, 36), node.db)  # i=1032..1035 are skipped kinds: the cut has skipped rows after it
        after1 = [json.loads(l) for l in history(node, f'fromSeq={start}')]
        exp1 = [r['hrcSeq'] for r in after1 if wanted(r, cats, kinds)]
        f1.wait(lambda r: [x['hrcSeq'] for x in r][-1:] == exp1[-1:])
        time.sleep(2.5)  # past one poll backstop: nothing later may arrive
        got1 = [r['hrcSeq'] for r in f1.records()]
        f1.close()
        assert got1 == exp1, ('F4 live filtered follow', got1, exp1)
        assert all(wanted(r, cats, kinds) for r in f1.records()), 'F4 leaked a row'
        last = got1[-1]
        skipped_tail = [r['hrcSeq'] for r in after1 if r['hrcSeq'] > last]
        assert skipped_tail, 'cut must leave skipped rows after the last delivered seq'
        node.bun_store('away', seed_js(2000, 23), node.db)
        f2 = Follow(node, f'/v1/events?follow=true&fromSeq={last + 1}&{filt}')
        node.bun_store('live-2', seed_js(3000, 15), node.db)
        everything = [json.loads(l) for l in history(node, f'fromSeq={start}')]
        exp_all = [r['hrcSeq'] for r in everything if wanted(r, cats, kinds)]
        f2.wait(lambda r: [x['hrcSeq'] for x in r][-1:] == exp_all[-1:])
        time.sleep(2.5)
        got2 = [r['hrcSeq'] for r in f2.records()]
        f2.close()
        joined = got1 + got2
        assert joined == exp_all, ('F5 resume', got1, got2, exp_all)
        assert len(set(joined)) == len(joined), 'F5 duplicate'
        unfilt.wait(lambda r: [x['hrcSeq'] for x in r][-1:] == [everything[-1]['hrcSeq']])
        unfilt.close()
        filtered_bytes = f1.bytes + f2.bytes
        report['resume'] = {
            'filter': filt, 'fromSeq': start, 'firstConnection': got1, 'lastSeenSeq': last,
            'skippedAfterLastSeen': skipped_tail,
            'secondConnectionFromSeq': last + 1, 'secondConnection': got2, 'expected': exp_all,
            'gap': sorted(set(exp_all) - set(joined)), 'duplicates': len(joined) - len(set(joined)),
            'ledgerRowsInWindow': len(everything)}
        report['bytes'] = {'window': [start, everything[-1]['hrcSeq']], 'unfilteredFollowerBytes': unfilt.bytes,
                           'filteredFollowerBytes': filtered_bytes,
                           'ratio': round(filtered_bytes / unfilt.bytes, 3)}

        # F6: bounded stream with the filter, cut and resumed by afterSeq.
        b1 = Follow(node, '/v1/events/bounded-stream?' + urlencode(
            {'follow': 'true', 'afterSeq': start - 1, 'ledgerIncarnationId': incarnation,
             'category': CATS, 'eventKind': EVENT_KINDS}))
        b1.wait(lambda r: [x['event']['hrcSeq'] for x in r if x.get('type') == 'event'][-1:] == exp_all[-1:])
        bseq1 = [x['event']['hrcSeq'] for x in b1.records() if x.get('type') == 'event']
        assert not [x for x in b1.records() if x.get('type') == 'gap'], b1.records()
        b1.close()
        assert bseq1 == exp_all, ('F6 bounded replay', bseq1, exp_all)
        cut = bseq1[len(bseq1) // 2]
        node.bun_store('bounded-away', seed_js(4000, 19), node.db)
        b2 = Follow(node, '/v1/events/bounded-stream?' + urlencode(
            {'follow': 'true', 'afterSeq': cut, 'ledgerIncarnationId': incarnation,
             'category': CATS, 'eventKind': EVENT_KINDS}))
        final = [json.loads(l) for l in history(node, f'fromSeq={start}')]
        exp_b = [r['hrcSeq'] for r in final if wanted(r, cats, kinds)]
        b2.wait(lambda r: [x['event']['hrcSeq'] for x in r if x.get('type') == 'event'][-1:] == exp_b[-1:])
        bseq2 = [x['event']['hrcSeq'] for x in b2.records() if x.get('type') == 'event']
        b2.close()
        joined_b = [s for s in bseq1 if s <= cut] + bseq2
        assert joined_b == exp_b and len(set(joined_b)) == len(joined_b), ('F6 bounded resume', joined_b, exp_b)
        report['boundedResume'] = {'cutAfterSeq': cut, 'second': bseq2, 'expected': exp_b,
                                   'gap': sorted(set(exp_b) - set(joined_b)),
                                   'duplicates': len(joined_b) - len(set(joined_b))}
        report['pass'] = True
        print(json.dumps({'pass': True, 'bytes': report['bytes'],
                          'resume': {k: report['resume'][k] for k in ('lastSeenSeq', 'gap', 'duplicates')}}))
    finally:
        (a.artifacts / 'events-kind-filter.json').write_text(json.dumps(report, indent=2) + '\n')
        node.cleanup()


if __name__ == '__main__':
    main()
