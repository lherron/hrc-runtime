#!/usr/bin/env python3
"""Mark-gated runtime prune (T-12855): prune contract gates 1 and 2, no-window,
deadline and the scheduled task, on copies of a real ledger (a `.backup` of a
node's state.sqlite; never the live file).

Every case starts from the same source bytes (APFS clone), relocates the
copy's absolute paths under its own scratch root (they name max3's live run
and state dirs, and the daemon has tmux kill-server paths), writes the case's
prune-mark.json, boots a private rusthrc, runs the prune and compares the copy
before and after.

Usage: ledger_prune.py --binary <rusthrc> --source <state.sqlite> --out <dir>
"""
import argparse
import datetime as dt
import json
import os
import shutil
import socket
import sqlite3
import subprocess
import sys
import time
from http.client import HTTPConnection
from pathlib import Path

CASCADE = ['transcript_turns', 'transcript_index_invocations', 'broker_invocation_events', 'hrc_events',
           'runtime_artifacts', 'broker_projection_dispositions', 'broker_invocations', 'runtime_first_turn_watch',
           'tool_result_blob_parts', 'tool_result_blobs', 'runtime_operations', 'runtime_buffers',
           'surface_bindings', 'runs', 'runtimes']
TERMINAL = ('terminated', 'dead', 'stale', 'crashed', 'detached')
LEDGER_TABLES = ('hrc_events', 'broker_invocation_events')
GUARD_REASONS = ('external_lifecycle_owner', 'offline_evidence_held', 'active_run', 'unsettled_absorbed_auxiliary',
                 'live_broker_lease', 'live_tmux', 'live_broker_pid')
LIVE_VAR = '/Users/lherron/praesidium/var/'
DAY = 86_400_000


class UnixHTTP(HTTPConnection):
    def __init__(self, path):
        super().__init__('localhost', timeout=600)
        self.sock_path = str(path)

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX)
        self.sock.settimeout(self.timeout)
        self.sock.connect(self.sock_path)


def iso(ms):
    return dt.datetime.fromtimestamp(ms / 1000, dt.timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.') + f'{int(ms) % 1000:03d}Z'


def parse(ts):
    return dt.datetime.fromisoformat(ts.replace('Z', '+00:00')).timestamp() * 1000


def ro(path):
    db = sqlite3.connect(f'file:{path}?mode=ro', uri=True)
    db.row_factory = sqlite3.Row
    return db


def tables(db):
    return {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}


def snapshot(path):
    """Row counts of every cascade table, per runtime and in total, plus the
    session-level rows the prune must never touch."""
    db = ro(path)
    have = tables(db)
    out = {'totals': {}, 'runtimes': {}}
    for t in CASCADE:
        # hrc_events rows with no runtime are counted apart: the owner itself
        # appends them (boot, shutdown) and the prune never touches them.
        where = ' WHERE runtime_id IS NOT NULL' if t == 'hrc_events' else ''
        out['totals'][t] = db.execute(f'SELECT COUNT(*) FROM {t}{where}').fetchone()[0] if t in have else None
    for r in db.execute('SELECT runtime_id,status,updated_at FROM runtimes'):
        out['runtimes'][r['runtime_id']] = dict(r)
    for t in ('hrc_events', 'broker_invocation_events', 'runs', 'broker_invocations'):
        for r in db.execute(f'SELECT runtime_id,COUNT(*) n FROM {t} WHERE runtime_id IS NOT NULL GROUP BY 1'):
            if r['runtime_id'] in out['runtimes']:
                out['runtimes'][r['runtime_id']][t] = r['n']
    out['session_level'] = {
        'hrc_events_no_runtime': db.execute('SELECT COUNT(*) FROM hrc_events WHERE runtime_id IS NULL').fetchone()[0],
        'sessions': db.execute('SELECT COUNT(*) FROM sessions').fetchone()[0],
        'events': db.execute('SELECT COUNT(*) FROM events').fetchone()[0] if 'events' in have else None,
        'seat_handoffs': db.execute('SELECT COUNT(*) FROM seat_handoffs').fetchone()[0] if 'seat_handoffs' in have else None,
    }
    out['incarnation'] = db.execute('SELECT ledger_incarnation_id FROM hrc_event_ledger_metadata').fetchone()[0]
    out['max'] = {'hrc_events': db.execute('SELECT MAX(hrc_seq) FROM hrc_events').fetchone()[0],
                  'broker_invocation_events': db.execute('SELECT MAX(id) FROM broker_invocation_events').fetchone()[0]}
    db.close()
    return out


def heads(path):
    db = ro(path)
    h = {}
    for r in db.execute('SELECT runtime_id,MAX(hrc_seq) m FROM hrc_events WHERE runtime_id IS NOT NULL GROUP BY 1'):
        h.setdefault(r['runtime_id'], [None, None])[0] = r['m']
    for r in db.execute('SELECT runtime_id,MAX(id) m FROM broker_invocation_events GROUP BY 1'):
        h.setdefault(r['runtime_id'], [None, None])[1] = r['m']
    db.close()
    return h


def relocate(path, root):
    """Point every non-ledger path at this scratch root instead of max3's live var/."""
    db = sqlite3.connect(path)
    skip = set(LEDGER_TABLES) | {'sqlite_sequence'}
    changed = 0
    for (t,) in db.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall():
        if t in skip or t.startswith(('transcript_', 'tool_result_')):
            continue
        cols = [r[1] for r in db.execute(f'PRAGMA table_info("{t}")') if (r[2] or '').upper() in ('TEXT', '')]
        for c in cols:
            changed += db.execute(f'UPDATE "{t}" SET "{c}"=replace("{c}",?,?) WHERE instr("{c}",?)>0',
                                  (LIVE_VAR, str(root) + '/relocated-var/', LIVE_VAR)).rowcount
    db.commit()
    db.close()
    return changed


class Owner:
    def __init__(self, case, source, binary, out, mark, window, tz=None):
        self.root = Path(f'/tmp/t12855-{case}-{os.getpid()}')
        shutil.rmtree(self.root, ignore_errors=True)
        (self.root / 'state').mkdir(parents=True)
        (self.root / 'run').mkdir()
        self.db = self.root / 'state/state.sqlite'
        subprocess.run(['cp', '-c', str(source), str(self.db)], check=True)
        self.relocated = relocate(self.db, self.root)
        if mark is not None:
            (self.root / 'state/prune-mark.json').write_text(mark if isinstance(mark, str) else json.dumps(mark, indent=2))
        env = {k: v for k, v in os.environ.items() if not k.startswith(
            ('HRC_', 'HARNESS', 'ASP_', 'WRKQ', 'CODEX', 'CLAUDE', 'AGENT', 'TMUX', 'PRAE'))}
        env.update(HRC_RUNTIME_DIR=str(self.root / 'run'), HRC_STATE_DIR=str(self.root / 'state'),
                   HRC_ACP_WEBHOOK_URL='', HRC_WRKQ_DB=str(self.root / 'private-wrkq.sqlite'),
                   HRC_TMUX_AGING_ENABLED='0', HRC_SESSION_RETENTION_SWEEP_ENABLED='0')
        if window is not None:
            env['HRC_RUNTIME_PRUNE_WINDOW'] = window
        if tz:
            env['TZ'] = tz
        self.env = env
        self.binary = binary
        self.out = out / case
        self.out.mkdir(parents=True, exist_ok=True)
        self.log_path = self.out / 'owner.log'
        self.before = None
        self.proc = None

    def up(self):
        log = self.log_path.open('w')
        bins = [str(Path.home() / '.local/bin')]
        env = {**self.env, 'PATH': os.pathsep.join([*bins, self.env.get('PATH', os.defpath)])}
        self.proc = subprocess.Popen([str(self.binary), 'server'], cwd=self.root, env=env, stdout=log, stderr=log)
        for _ in range(1200):
            assert self.proc.poll() is None, f'owner exited; see {self.log_path}'
            try:
                if self.http('GET', '/v1/health')[0] == 200:
                    time.sleep(2)  # let boot reconcile settle
                    self.before = snapshot(self.db)
                    return
            except (OSError, ValueError):
                pass
            time.sleep(.1)
        raise AssertionError('owner did not become healthy')

    def http(self, method, path, body=None):
        c = UnixHTTP(self.root / 'run/hrc.sock')
        c.request(method, path, json.dumps(body) if body is not None else None, {'Content-Type': 'application/json'})
        r = c.getresponse()
        data = json.loads(r.read() or b'null')
        c.close()
        return r.status, data

    def cli(self, *argv):
        r = subprocess.run([str(self.binary), 'runtime', 'prune-window', *argv], env=self.env,
                           capture_output=True, text=True, timeout=900)
        (self.out / f"cli{'-'.join(a.strip('-') for a in argv)}.txt").write_text(
            f'argv: {argv}\nexit: {r.returncode}\n--- stdout\n{r.stdout}\n--- stderr\n{r.stderr}')
        assert r.returncode == 0, r.stderr
        return json.loads(r.stdout) if '--json' in argv else r.stdout

    def reports(self):
        lines = []
        for path in [self.log_path, *sorted((self.root / 'run').glob('logs/*'))]:
            if path.is_file():
                for line in path.read_text(errors='replace').splitlines():
                    if '"prune.report"' in line:
                        lines.append(json.loads(line))
        return lines

    def down(self):
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()
            self.proc.wait(timeout=60)
        self.after = snapshot(self.db)
        return self.after

    def cleanup(self):
        shutil.rmtree(self.root, ignore_errors=True)


def real_mark(source):
    """A mark from the copy's own incarnation and two real ledger rows, chosen
    for gate 2: reconciled_at 20 days ago, anchors at the newest rows of a
    middle runtime among the old ones, so the ledgers continue above them."""
    db = ro(source)
    now = time.time() * 1000
    reconciled = now - 20 * DAY
    h = heads(source)
    old = [r['runtime_id'] for r in db.execute(
        f"SELECT runtime_id,updated_at FROM runtimes WHERE status IN {TERMINAL} ORDER BY runtime_id")
        if parse(r['updated_at']) < reconciled]
    both = sorted((h[r][0], r) for r in old if r in h and h[r][0] is not None and h[r][1] is not None)
    owner = both[len(both) // 2][1]
    hk, bk = h[owner]
    mark = {
        'version': 1, 'node': 'hrcdev',
        'hrc_ledger_incarnation_id': db.execute('SELECT ledger_incarnation_id FROM hrc_event_ledger_metadata').fetchone()[0],
        'reconciled_at': iso(reconciled),
        'anchors': {
            'hrc_events': {'key': hk, 'created': db.execute('SELECT ts FROM hrc_events WHERE hrc_seq=?', (hk,)).fetchone()[0]},
            'broker_invocation_events': {'key': bk, 'created': db.execute('SELECT time FROM broker_invocation_events WHERE id=?', (bk,)).fetchone()[0]},
        },
    }
    db.close()
    return mark, owner


def expected(source, mark, window_ms):
    """Independent 4(b)-(e): the runtimes the daemon may delete, and why each
    other old terminal runtime may not."""
    db = ro(source)
    h = heads(source)
    now = time.time() * 1000
    rec = parse(mark['reconciled_at'])
    ak, bk = mark['anchors']['hrc_events']['key'], mark['anchors']['broker_invocation_events']['key']
    allowed, refused = set(), {}
    for r in db.execute('SELECT runtime_id,status,updated_at FROM runtimes'):
        rid, u = r['runtime_id'], parse(r['updated_at'])
        if r['status'] not in TERMINAL or u >= now - window_ms:
            continue
        mh, mb = h.get(rid, [None, None])
        if u >= rec:
            refused[rid] = 'changed_after_mark'
        elif (mh is not None and mh >= ak) or (mb is not None and mb >= bk):
            refused[rid] = 'at_or_above_anchor'
        else:
            allowed.add(rid)
    db.close()
    return allowed, refused


def session_level_kept(o):
    b, a = o.before['session_level'], o.after['session_level']
    return all(a[k] == b[k] for k in ('sessions', 'events', 'seat_handoffs')) and a['hrc_events_no_runtime'] >= b['hrc_events_no_runtime']


def unchanged(o):
    return o.before['totals'] == o.after['totals'] and o.before['runtimes'] == o.after['runtimes'] and session_level_kept(o)


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--binary', type=Path, required=True)
    p.add_argument('--source', type=Path, required=True)
    p.add_argument('--out', type=Path, required=True)
    p.add_argument('--keep', action='store_true')
    a = p.parse_args()
    a.out.mkdir(parents=True, exist_ok=True)
    mark, anchor_owner = real_mark(a.source)
    (a.out / 'mark.json').write_text(json.dumps(mark, indent=2) + '\n')
    results = {'source': str(a.source), 'binary': str(a.binary), 'mark': mark, 'anchorOwner': anchor_owner, 'cases': {}}
    failures = []

    def record(name, ok, **facts):
        results['cases'][name] = {'pass': ok, **facts}
        print(f"{'PASS' if ok else 'FAIL'} {name}", flush=True)
        if not ok:
            failures.append(name)

    def refusal(name, case_mark, stop):
        o = Owner(name, a.source, a.binary, a.out, case_mark, '14d')
        try:
            o.up()
            rep = o.cli('--yes', '--json')
            o.down()
            ok = rep['stopReason'] == stop and rep['deleted'] == 0 and unchanged(o)
            record(name, ok, stopReason=rep['stopReason'], deleted=rep['deleted'], detail=rep.get('detail'),
                   totalsBefore=o.before['totals'], totalsAfter=o.after['totals'], logged=o.reports())
        finally:
            o.down() if o.proc and o.proc.poll() is None else None
            a.keep or o.cleanup()

    # Gate 1: nothing without a true mark.
    refusal('g1-no-file', None, 'no_mark')
    refusal('g1-unreadable', '{"version": 1, "anchors": ', 'mark_unreadable')
    refusal('g1-version-unknown', dict(mark, version=2), 'mark_version_unknown')
    refusal('g1-incarnation', dict(mark, hrc_ledger_incarnation_id='0' * 32), 'incarnation_mismatch')
    gone = json.loads(json.dumps(mark))
    gone['anchors']['hrc_events']['key'] = snapshot(a.source)['max']['hrc_events'] + 1000
    refusal('g1-anchor-key-absent', gone, 'anchor_mismatch')
    moved = json.loads(json.dumps(mark))
    c = moved['anchors']['broker_invocation_events']['created']
    moved['anchors']['broker_invocation_events']['created'] = iso(parse(c) + 1)
    refusal('g1-anchor-created-differs', moved, 'anchor_mismatch')

    # No window: the scheduled task (local clock put at 03:59:30 through TZ)
    # reports no_window and deletes nothing, with a true mark on disk.
    def tz_for(target_local='03:58:30'):
        now = dt.datetime.now(dt.timezone.utc)
        hh, mm, ss = map(int, target_local.split(':'))
        want = now.replace(hour=hh, minute=mm, second=ss, microsecond=0)
        d = (want - now).total_seconds() % 86400
        if d > 43200:
            d -= 86400
        o = -int(round(d))  # POSIX: local = UTC - offset
        sign = '-' if o < 0 else '+'
        o = abs(o)
        return f'PRU{sign}{o // 3600:02d}:{o % 3600 // 60:02d}:{o % 60:02d}'

    def scheduled(name, window, want_stop):
        o = Owner(name, a.source, a.binary, a.out, mark, window, tz=tz_for())
        try:
            o.up()
            deadline = time.time() + 240
            while time.time() < deadline and not o.reports():
                time.sleep(2)
            o.down()
            reps = o.reports()
            rep = reps[0]['data'] if reps else {}
            return o, rep, reps
        finally:
            o.down() if o.proc and o.proc.poll() is None else None
            a.keep or o.cleanup()

    o, rep, reps = scheduled('no-window-scheduled', None, 'no_window')
    record('no-window-scheduled', len(reps) == 1 and rep.get('trigger') == 'schedule' and rep.get('stopReason') == 'no_window'
           and rep.get('deleted') == 0 and unchanged(o), report=reps, totalsBefore=o.before['totals'], totalsAfter=o.after['totals'])

    # Gate 2: only behind the mark, by hand; then the same through the schedule.
    allowed, refused = expected(a.source, mark, 14 * DAY)
    results['expected'] = {'allowed': len(allowed), 'refused': refused}
    o = Owner('g2-operator', a.source, a.binary, a.out, mark, None)
    try:
        o.up()
        dry = o.cli('--window', '14d', '--dry-run', '--json')
        human = o.cli('--window', '14d', '--dry-run')
        rep = o.cli('--window', '14d', '--yes', '--json')
        o.down()
        deleted = set(rep['deletedRuntimeIds'])
        skipped = {s['runtimeId']: s['reason'] for s in rep['skippedRuntimes']}
        gone_after = set(o.before['runtimes']) - set(o.after['runtimes'])
        protected = {
            'anchor_owner': anchor_owner,
            'above_anchor': next((r for r, why in sorted(refused.items()) if why == 'at_or_above_anchor' and r != anchor_owner), None),
            'changed_after_mark': next((r for r, why in sorted(refused.items()) if why == 'changed_after_mark'), None),
        }
        survivors = {k: (v is not None and v in o.after['runtimes']) for k, v in protected.items()}
        guard_only = all(skipped.get(r, '').split(':')[0] in GUARD_REASONS for r in allowed - deleted)
        cascade_gone = True
        db = ro(o.db)
        for t in ('hrc_events', 'broker_invocation_events', 'runs', 'broker_invocations', 'runtimes', 'surface_bindings', 'runtime_buffers'):
            n = db.execute(f"SELECT COUNT(*) FROM {t} WHERE runtime_id IN (SELECT value FROM json_each(?))", (json.dumps(sorted(deleted)),)).fetchone()[0]
            cascade_gone &= n == 0
        db.close()
        totals_add_up = all(
            o.before['totals'][t] is None or o.before['totals'][t] - rep['rowsDeleted'].get(t, 0) == o.after['totals'][t]
            for t in CASCADE)
        kept_rows_intact = all(o.before['runtimes'][r] == o.after['runtimes'][r] for r in o.after['runtimes']
                               if r in o.before['runtimes'] and o.before['runtimes'][r]['status'] in TERMINAL)
        ok = (rep['stopReason'] == 'complete' and len(deleted) > 0 and deleted <= allowed and deleted == gone_after
              and all(survivors.values()) and guard_only and cascade_gone and totals_add_up and kept_rows_intact
              and dry['eligible'] == rep['eligible'] and dry['deleted'] == 0
              and dry['wouldDelete'] == rep['rowsDeleted']
              and session_level_kept(o))
        record('g2-operator', ok, protected=protected, survivors=survivors, deleted=len(deleted), allowedByMark=len(allowed),
               allowedButGuarded={r: skipped.get(r) for r in sorted(allowed - deleted)}, skippedByReason=rep['skipped'],
               guardOnly=guard_only, cascadeGone=cascade_gone, totalsAddUp=totals_add_up, keptRowsIntact=kept_rows_intact,
               dryRunReport={k: v for k, v in dry.items() if k not in ('deletedRuntimeIds', 'skippedRuntimes')},
               dryRunHuman=human,
               report={k: v for k, v in rep.items() if k not in ('deletedRuntimeIds', 'skippedRuntimes')},
               totalsBefore=o.before['totals'], totalsAfter=o.after['totals'],
               sessionLevelBefore=o.before['session_level'], sessionLevelAfter=o.after['session_level'],
               logged=[l['data']['stopReason'] for l in o.reports()])
        results['g2DeletedRuntimeIds'] = sorted(deleted)
    finally:
        o.down() if o.proc and o.proc.poll() is None else None
        a.keep or o.cleanup()

    o, rep, reps = scheduled('g2-scheduled', '14d', 'complete')
    # The guards probe the copy's recorded pids on this host, so which of the
    # mark-allowed runtimes a guard holds can differ run to run; every allowed
    # runtime is either deleted or guard-skipped.
    guarded = sum(n for why, n in rep.get('skipped', {}).items() if why.split(':')[0] in GUARD_REASONS)
    record('g2-scheduled', len(reps) == 1 and rep.get('trigger') == 'schedule' and rep.get('stopReason') == 'complete'
           and rep.get('deleted', 0) > 0 and rep.get('deleted', 0) + guarded == len(allowed), report=reps)

    # Deadline: a run whose budget is already spent deletes nothing more and says so.
    o = Owner('deadline', a.source, a.binary, a.out, mark, '14d')
    try:
        o.up()
        rep = o.cli('--max-minutes', '0.0001', '--yes', '--json')
        o.down()
        record('deadline', rep['stopReason'] == 'deadline' and rep['remaining'] > 0 and rep['deleted'] == 0 and unchanged(o),
               report={k: v for k, v in rep.items() if k not in ('deletedRuntimeIds', 'skippedRuntimes')})
    finally:
        o.down() if o.proc and o.proc.poll() is None else None
        a.keep or o.cleanup()

    results['pass'] = not failures
    (a.out / 'result.json').write_text(json.dumps(results, indent=2, default=str) + '\n')
    print(json.dumps({'pass': not failures, 'failures': failures}))
    sys.exit(1 if failures else 0)


if __name__ == '__main__':
    main()
