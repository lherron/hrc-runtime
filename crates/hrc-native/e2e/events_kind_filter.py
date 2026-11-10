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
F7 a list of only commas silently widens to the whole ledger;
(F8, hrc-sdk's client-side watch() matcher, is TypeScript and left this driver
with its TypeScript probe; it belongs in the hrc-sdk suite.)
Ground truth is the seed: every row is appended with the native store's own
append (n3_events.append_events) and its category/kind/scope are known here,
so each unfiltered and single-value read is checked against the seed, and
every surface (history, follow, tail, bounded stream) against history.
"""
import argparse
import json
import socket
import threading
import time
from pathlib import Path
from urllib.parse import urlencode

from n2_scratch import UnixHTTP
from n3_events import append_events
from n4_federation import Node

KINDS = [('runtime', 'runtime.ensured'), ('turn', 'turn.started'), ('turn', 'turn.tool_call'),
         ('turn', 'turn.tool_result'), ('turn', 'turn.tool_call'), ('turn', 'turn.message'),
         ('turn', 'turn.completed'), ('session', 'session.resolved'), ('turn', 'turn.attention'),
         ('runtime', 'runtime.status')]
CATS = 'runtime,session'
EVENT_KINDS = 'turn.started,turn.completed,turn.attention'


def seed(node, start, count, live=True):
    """Append rows start..start+count natively; returns {hrcSeq: row} for the seeded rows."""
    rows = []
    for i in range(start, start + count):
        c, e = KINDS[i % len(KINDS)]
        rows.append({'ts': '2023-11-14T22:13:%02d.%03dZ' % (20 + i // 1000, i % 1000), 'hostSessionId': f'hsid-{i % 3}',
                     'scopeRef': f'agent:t:project:p:task:T-{i % 3}', 'laneRef': 'main', 'generation': 1,
                     'category': c, 'eventKind': e, 'payload': {'i': i, 'pad': 'x' * 200}})
    seqs = append_events(node.db, rows)
    assert len(seqs) == count, seqs
    if live:
        # A follow wakes only on an owner commit (streams.rs): one real owner write
        # after the append, whose own session rows the history-derived truth includes.
        status, body, _ = node.http('POST', '/v1/sessions/resolve',
                                    {'sessionRef': f'agent:t:project:p:task:wake-{start}/lane:main', 'create': True})
        assert status == 200, (status, body)
    return dict(zip(seqs, rows))


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
    for k in ('binary', 'aspd-socket', 'scratch-root', 'artifacts'):
        p.add_argument('--' + k, type=Path, required=True)
    p.add_argument('--installed-release', type=Path, help='accepted and ignored')
    a = p.parse_args()
    a.artifacts.mkdir(parents=True, exist_ok=True)
    node = Node(a.scratch_root, a.installed_release, a.aspd_socket, a.artifacts, 'kind', a.binary)
    report = {'failureModes': [l for l in __doc__.split('\n') if l[:1] == 'F' or l.startswith('   ')]}
    try:
        seeded = seed(node, 0, 120, live=False)
        owner = node.up('native', a.binary.resolve(), 'subject')
        page = node.http('GET', '/v1/events/page?afterSeq=0&limit=1000')[1]
        incarnation = page['ledgerIncarnationId']
        head = max(seeded)
        subj = capture(node, head, incarnation)
        # F1/F2: every unfiltered and single-value read selects exactly the seeded rows it must.
        seqs = lambda lines: [json.loads(l)['hrcSeq'] for l in lines]
        pick = lambda f: [q for q, r in sorted(seeded.items()) if f(r)]
        expect = {'history:cat_turn': pick(lambda r: r['category'] == 'turn'),
                  'history:kind_started': pick(lambda r: r['eventKind'] == 'turn.started'),
                  'history:cat_turn_from': [q for q in pick(lambda r: r['category'] == 'turn') if q >= 40],
                  'history:runtime_scope': pick(lambda r: r['scopeRef'] == 'agent:t:project:p:task:T-1')}
        for name, want in expect.items():
            assert seqs(subj[name]) == want and want, ('F2 single value', name, seqs(subj[name])[:10], want[:10])
        every = {json.loads(l)['hrcSeq']: json.loads(l) for l in subj['history:all']}
        for q, r in seeded.items():
            got = every.get(q)
            assert got and (got['category'], got['eventKind'], got['scopeRef'], got['payload']) == \
                (r['category'], r['eventKind'], r['scopeRef'], r['payload']), ('F1 seeded row', q, got)
        assert seqs(subj['history:all']) == sorted(every), 'F1 history out of order'
        # F1: the follow and bounded stream carry history's bytes; tail its rows.
        def first_diff(x, y):
            i = next((i for i, (p, q) in enumerate(zip(x, y)) if p != q), min(len(x), len(y)))
            return len(x), len(y), x[i:i + 1], y[i:i + 1]
        line = lambda name: [l.rstrip('\n') for l in subj[name]]  # follow keeps the NDJSON newline, history splits it off
        assert line('follow:all') == line('history:all'), ('F1 follow differs from history', first_diff(line('follow:all'), line('history:all')))
        assert line('follow:cat_turn') == line('history:cat_turn'), ('F1 filtered follow differs', first_diff(line('follow:cat_turn'), line('history:cat_turn')))
        assert [json.dumps(json.loads(l)['event'], sort_keys=True) for l in subj['bounded:all']] == \
            [json.dumps(json.loads(l), sort_keys=True) for l in subj['history:all']], 'F1 bounded stream differs'
        tail_rows = sorted(json.loads(l)['hrcSeq'] for l in subj['tail'])
        assert tail_rows == seqs(subj['history:all'])[-50:], ('F1 tail', tail_rows)
        assert all(json.loads(l) == every[json.loads(l)['hrcSeq']] for l in subj['tail']), 'F1 tail row differs'
        report['unchanged'] = {'seededHead': head, 'cases': {k: {'lines': len(v), 'bytes': sum(map(len, v))}
                                                             for k, v in subj.items()}}
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
        seed(node, 1000, 36)
        # i=1042..1045 are skipped kinds written after the wake (the wake's session rows
        # are wanted): the cut has skipped rows after it, which the resume must step over.
        seed(node, 1042, 4, live=False)
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
        seed(node, 2000, 23)
        f2 = Follow(node, f'/v1/events?follow=true&fromSeq={last + 1}&{filt}')
        seed(node, 3000, 15)
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
        seed(node, 4000, 19)
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
