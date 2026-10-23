"""Read-only reconstruction of retained P1 repository evidence; no producer execution."""
import argparse
from contextlib import closing
import datetime as dt
import hashlib
import json
from pathlib import Path
import re
import sqlite3
import struct
from urllib.parse import quote

from catalog import CATALOG
from source_versions import select
from common import Gap, exact


def require(value, reason):
    if not value:
        raise AssertionError(reason)


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def clock(value):
    require(isinstance(value, str), 'clock must be a string')
    parsed = dt.datetime.fromisoformat(value.replace('Z', '+00:00'))
    require(parsed.utcoffset() == dt.timedelta(0), 'clock must include UTC offset')
    return '<clock>'


def normalize(value, clocks):
    if isinstance(value, list):
        return [normalize(v, clocks) for v in value]
    if not isinstance(value, dict):
        return value
    return {k: clock(v) if k in clocks and isinstance(v, str) else normalize(v, clocks) for k, v in value.items()}


DTO_CLOCKS = {'createdAt', 'updatedAt', 'presentedAt', 'ackedAt'}
SQL_CLOCKS = DTO_CLOCKS | {'created_at', 'updated_at', 'presented_at', 'acked_at'}


class Checker:
    def __init__(self, root, expected_identity=None):
        self.catalog = select(expected_identity)
        self.root = Path(root).resolve()
        self.assertions = []
        self.used = []

    def file(self, relative):
        path = self.root / relative
        if not path.is_file():
            raise Gap('missing raw receipt: ' + relative)
        require(not path.is_symlink() and path.resolve().is_relative_to(self.root), 'receipt escapes root: ' + relative)
        self.used.append(relative)
        return path

    def load(self, relative):
        return json.loads(self.file(relative).read_text())

    def receipt(self, family, name, exit=0):
        record = self.load(family + '/' + name)
        for key in ('exit', 'stdout', 'stderr'):
            if key not in record:
                raise Gap('missing raw command field: ' + family + '/' + name + ':' + key)
        require(type(record['exit']) is int and record['exit'] == exit, 'command exit differs: ' + family + '/' + name)
        require(not record.get('timeout', False), 'command timed out: ' + name)
        return json.loads(record['stdout'])

    def check(self, family, name, fn, covers=()):
        self.used = []
        row = {'id': family + '/' + name, 'family': family, 'status': 'PASS', 'reason': 'rederived from raw evidence', 'sourceAssertions': list(covers)}
        try:
            fn()
        except Gap as e:
            row.update(status='GAP', reason=str(e))
        except (KeyError, IndexError) as e:
            row.update(status='GAP', reason='missing required raw field/index: ' + str(e))
        except (AssertionError, ValueError, TypeError, sqlite3.Error, OSError) as e:
            row.update(status='FAIL', reason=type(e).__name__ + ': ' + str(e))
        if row['status'] == 'GAP':
            row['gapKind'] = 'CHECKER_UNSUPPORTED' if any(v in row['reason'] for v in ('binding', 'source expression', 'dynamic source iteration', 'source-invocation-to-receipt', 'not yet supported', 'unsupported', 'repeated exact source invocation', 'latest source assignment')) else 'RAW_MISSING'
        row['receipts'] = sorted(set(self.used))
        self.assertions.append(row)
        return row

    def db(self, family, name):
        path = self.file(family + '/' + name)
        for suffix in ('-wal', '-shm', '-journal'):
            require(not Path(str(path) + suffix).exists(), 'backup has live sidecar: ' + name)
        conn = sqlite3.connect('file:' + quote(str(path), safe='/') + '?mode=ro&immutable=1', uri=True)
        conn.execute('PRAGMA query_only=ON')
        require(conn.execute('PRAGMA quick_check').fetchall() == [('ok',)], 'invalid coherent SQLite backup: ' + name)
        return closing(conn)

    def rows(self, family, name, tables):
        with self.db(family, name) as db:
            db.row_factory = sqlite3.Row
            return {t: [dict(r) for r in db.execute('SELECT * FROM "' + t.replace('"', '""') + '" ORDER BY 1')] for t in tables}

    def logical(self, family, name):
        def enc(v):
            if isinstance(v, bytes):
                return {'sqliteBytes': v.hex()}
            if isinstance(v, (list, tuple)):
                return [enc(x) for x in v]
            return v
        with self.db(family, name) as db:
            db.text_factory = bytes
            schema = db.execute('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').fetchall()
            tables = [r[1].decode() for r in schema if r[0] == b'table']
            return {'schema': enc(schema), 'tables': {t: enc(db.execute('SELECT * FROM "' + t.replace('"', '""') + '"').fetchall()) for t in tables}}

    def identity(self, expected):
        observed = self.load('identity.json')
        for side, fields in (('native', ('path', 'sha256', 'sourceHead', 'sourceTreeSha256')), ('bun', ('release', 'sourceCommit'))):
            require(side in observed and isinstance(observed[side], dict), 'identity object absent: ' + side)
            for key in fields:
                require(isinstance(observed[side].get(key), str) and bool(observed[side][key]), 'identity field missing: ' + side + '.' + key)
            for key in ('sha256', 'sourceTreeSha256') if side == 'native' else ():
                require(re.fullmatch('[0-9a-f]{64}', observed[side][key]) is not None, 'invalid SHA256: ' + key)
            commit_key = 'sourceHead' if side == 'native' else 'sourceCommit'
            require(re.fullmatch('[0-9a-f]{40}', observed[side][commit_key]) is not None, 'invalid source commit')
        if expected is None:
            raise Gap('missing independent caller expected_identity pins; observed identity cannot pin itself')
        require(exact({k: observed[k] for k in ('native', 'bun')}, {k: expected[k] for k in ('native', 'bun')}), 'native/Bun/source identity differs from independent caller pins')
        binary = Path(expected['native']['path'])
        if not binary.is_file():
            raise Gap('missing retained frozen native executable: ' + str(binary))
        self.used.append('external-frozen-binary:' + str(binary))
        require(sha(binary) == expected['native']['sha256'], 'retained native executable bytes differ from independent pins')
        with binary.open('rb') as stream:
            magic = stream.read(4)
        require(magic in (b'\x7fELF', b'\xcf\xfa\xed\xfe', b'\xfe\xed\xfa\xcf', b'\xca\xfe\xba\xbe'), 'retained native executable is not a native image')
        bun = self.load('bun-release.json')
        require(bun['hrcBuild']['sourceCommit'] == expected['bun']['sourceCommit'] and bun['releaseId'] == Path(expected['bun']['release']).name, 'observed Bun producer manifest differs from independent pins')

    def build_provenance(self, expected):
        if expected is None:
            raise Gap('missing independent source/build identity pins')
        identity = self.load('identity.json')
        if 'buildProvenance' not in identity:
            raise Gap('no retained compiler/build/dependency/source input provenance; sourceTree digest alone is insufficient')
        for name, digest in identity['buildProvenance'].items():
            require(name.startswith('build/') and sha(self.file(name)) == digest, 'build provenance bytes differ: ' + name)
        source = self.load('build/native-source-manifest.json')
        require(exact(source, self.load('build/native-source-after.json')), 'native compiler inputs changed across build')
        require(hashlib.sha256(json.dumps(source, sort_keys=True, separators=(',', ':')).encode()).hexdigest() == expected['native']['sourceTreeSha256'], 'actual compiler input map differs from independent source tree pin')
        for name, digest in source.items():
            require(sha(self.file('build/source/' + name)) == digest, 'retained native compiler input differs: ' + name)
        for name in ('crates/hrc-store/src/main.rs', 'crates/hrc-store/src/reply_schema_meta.json', 'crates/hrc-store/e2e/fixtures/mail-body.jsonl', 'crates/Cargo.lock', 'crates/Cargo.toml'):
            require(name in source, 'required native build/include_str input absent: ' + name)
        dep_before = self.file('build/compiler-dependencies-before.d').read_text()
        dep_after = self.file('build/compiler-dependencies-after.d').read_text()
        require(dep_before == dep_after and bool(dep_before), 'native compiler dependency inputs changed/absent')
        for name in source:
            if name.endswith(('.rs', '.json', '.jsonl')):
                require(name in dep_before, 'manifest input not bound to actual compiler dependencies: ' + name)
        build = self.load('build/build.json')
        require(build['command'] == ['cargo', 'build', '--manifest-path', 'crates/Cargo.toml', '-p', 'hrc-store', '--locked'], 'wrong native build command')
        require(build['exit'] == 0 and type(build['exit']) is int and build['startedAt'] <= build['completedAt'], 'native build did not successfully finish')
        require(build['environment']['CARGO_TARGET_DIR'] == '/Users/lherron/praesidium/hrc-runtime/crates/target', 'unapproved isolated Cargo target')
        compiler = self.load('build/compiler.json')
        require(compiler['command'] == ['rustc', '-vV'] and compiler['exit'] == 0 and compiler['stdout'].startswith('rustc '), 'actual compiler identity receipt absent')
        require(exact(self.load('build/qualification-identity.json')['native'], expected['native']), 'embedded build native identity differs from caller pin')

    def family_identity(self, family, expected):
        observed = self.load('identity.json')
        if expected is None:
            raise Gap('missing independent caller expected_identity pins')
        require(exact(observed['native'], expected['native']) and exact(observed['bun'], expected['bun']), 'root identity differs from independent pins')
        if not isinstance(expected.get('sources'), dict) or family not in expected['sources']:
            raise Gap('missing independent caller source pin: ' + family)
        require(exact(observed.get('sources'), expected['sources']), 'retained source identity differs from independent caller source pins')
        if not isinstance(expected.get('controls'), dict):
            raise Gap('missing independent caller control/fixture source pins')
        require(exact(observed.get('controls'), expected['controls']), 'retained controls differ from independent caller source pins')
        record = self.catalog[family]
        retained_source = self.file(family + '/source/' + CATALOG[family]['source'])
        require(sha(retained_source) == expected['sources'][family], 'retained source bytes differ from independent caller source pin')
        if record is None:
            raise Gap('unreviewed caller-pinned source version: ' + family + ':' + expected['sources'][family])
        legs = [leg for leg in observed['legs'] if leg['family'] == family]
        require(bool(legs), 'no per-command identity legs: ' + family)
        captured = self.load(family + '/capture.json')
        require(captured['complete'] is True and captured['incompletePids'] == [], 'unfinished command capture')
        paths = sorted((self.root / family / 'commands').glob('*.json'))
        if not paths:
            raise Gap('missing actual subprocess command receipts: ' + family + '/commands/*.json')
        covered = set()
        receipts = []
        for path in paths:
            name = 'commands/' + path.name
            receipt = self.load(family + '/' + name)
            selected = [leg for leg in legs if leg['receipt'] == name]
            if len(selected) != 1:
                raise Gap('missing/duplicated per-command identity leg: ' + family + '/' + name)
            leg = selected[0]
            command = receipt['command']
            require(bool(command) and exact(command, receipt['argv']) and exact(command, leg['command']), 'identity command differs: ' + name)
            require(receipt['captureComplete'] is True and type(receipt['exit']) is int and isinstance(receipt['stdout'], str) and isinstance(receipt['stderr'], str), 'unfinished/malformed actual command receipt')
            for field in ('startedAt', 'completedAt'):
                require(type(leg[field]) in (int, float) and type(receipt[field]) in (int, float), 'expected numeric Unix command timestamp')
                require(leg[field] == receipt[field], 'command interval differs from raw capture')
            require(0 < leg['startedAt'] <= leg['completedAt'] < 1e12, 'invalid command observation interval')
            require(exact(leg['bun'], observed['bun']) and exact(receipt['bun'], observed['bun']), 'per-leg Bun identity differs')
            for phase in ('nativeBefore', 'nativeAfter'):
                pinned = {k: observed['native'][k] for k in ('path', 'sha256')}
                require(exact(leg[phase], pinned) and exact(receipt[phase], pinned), 'per-leg native identity differs: ' + name + ':' + phase)
            require(type(receipt['pid']) is int and receipt['pid'] > 0, 'missing actual process identity')
            executable = receipt['executable']
            require(isinstance(executable['path'], str) and re.fullmatch('[0-9a-f]{64}', executable['sha256']), 'missing actual launch executable hash')
            if command[0] == observed['native']['path']:
                require(exact(executable, {k: observed['native'][k] for k in ('path', 'sha256')}), 'actual native launch executable differs')
            covered.add(name)
            receipts.append(receipt)
        require(covered == {leg['receipt'] for leg in legs}, 'extra/unmatched identity leg')
        require(exact(captured['legs'], legs), 'family/root captured identity legs differ')
        # The convenience stdout files consumed by semantic adapters must come from
        # actual identified command receipts. Their filenames alone establish nothing.
        for path in sorted((self.root / family).glob('*.json')):
            if path.name in ('capture.json', 'comparison.json', 'summary.json'):
                continue
            raw = self.load(family + '/' + path.name)
            entries = raw if isinstance(raw, list) else [raw]
            for entry in entries:
                if not isinstance(entry, dict) or not {'exit', 'stdout', 'stderr'} <= set(entry):
                    continue
                command = entry.get('command', entry.get('argv'))
                matches = [r for r in receipts if all(exact(entry[k], r[k]) for k in ('exit', 'stdout', 'stderr')) and (command is None or exact(command, r['command']))]
                require(bool(matches), 'semantic raw receipt is not an actual identified command: ' + path.name)
        for side in ('bun', 'native'):
            path = self.root / family / (side + '.jsonl')
            if path.exists():
                output = self.file(family + '/' + side + '.jsonl').read_text()
                matches = [r for r in receipts if r['stdout'] == output and ((r['command'][0] == observed['native']['path']) == (side == 'native'))]
                require(len(matches) == 1 and matches[0]['exit'] == 0, 'JSONL output missing unique identified successful command: ' + side)
                stdin_record = matches[0].get('stdin', {})
                stdin = matches[0].get('stdinSha256', stdin_record.get('sha256'))
                if stdin is None:
                    raise Gap('missing actual stdinSha256: ' + family + '/' + side + '.jsonl')
                input_path = self.file(family + '/input.jsonl')
                require(stdin == sha(input_path), 'actual command stdin differs from fixed retained input')
                if stdin_record:
                    data = input_path.read_bytes()
                    require(stdin_record['present'] is True and stdin_record['bytes'] == len(data) and stdin_record['literalNewlineCount'] == data.count(b'\n'), 'actual stdin presence/bytes/literal newline mismatch')
        if 'sources' not in observed or family not in observed['sources']:
            raise Gap('missing captured fixed-source digest: identity.json:sources.' + family)
        require(observed['sources'][family] == record['sha256'], 'fixed E2E source identity differs')
        before = self.load(family + '/sources-before.json')
        after = self.load(family + '/sources-after.json')
        require(exact(before, after), 'E2E/control/fixture source changed during actual family')
        required_sources = {record['source']: observed['sources'][name] for name, record in CATALOG.items()}
        required_sources.update(observed['controls'])
        require(set(observed['sources']) == set(CATALOG), 'unknown/missing required source family identity')
        require(all(before.get(name) == digest for name, digest in required_sources.items()), 'fixed family/control source capture does not cover required exact inputs')
        for name, digest in before.items():
            require(sha(self.file(family + '/source/' + name)) == digest, 'captured E2E/control/fixture source bytes differ: ' + name)

    def integrity(self):
        names = ('manifest.json', 'SHA256SUMS')
        manifests = [name for name in names if (self.root / name).is_file()]
        if not manifests:
            raise Gap('no artifact integrity manifest or SHA256SUMS; semantic checks still run')
        actual = {str(p.relative_to(self.root)): sha(p) for p in sorted(self.root.rglob('*')) if p.is_file() and str(p.relative_to(self.root)) not in names}
        for name in manifests:
            if name == 'manifest.json':
                recorded = self.load(name)
            else:
                recorded = {}
                for line in self.file(name).read_text().splitlines():
                    digest, path = line.split('  ', 1)
                    path = path.removeprefix('./')
                    require(path not in recorded and re.fullmatch('[0-9a-f]{64}', digest), 'malformed/duplicate SHA256SUMS entry')
                    recorded[path] = digest
            require(exact(actual, recorded), 'artifact manifest does not cover exact bytes/files: ' + name)


def reconciliation(c):
    f = 'reconciliation_e2e'
    variants = {
        'aging': ['exact', 'pidWrong', 'childWrong', 'invocationMissing', 'invocationSkip', 'statusChanged', 'runChanged', 'opChanged', 'invChanged', 'activityChanged', 'stateChanged', 'hasAccepted', 'hasTerminal'],
        'orphan': ['free', 'noRuntime', 'ownsSame', 'ownsOtherOpen', 'ownsOtherTerminal', 'ownsOtherMissing', 'runTerminal', 'runCompleted'],
        'finalize': ['exact', 'wrongRuntime', 'ownerChanged', 'terminal', 'completed', 'unsupportedTransport'],
        'reap': ['exact', 'wrongRuntime', 'ownerChanged', 'terminal', 'completed', 'unsupportedTransport'],
        'zombie': ['exact', 'wrongTransport', 'terminal', 'completed'], 'release': ['exact', 'changed']}
    ids = [family + '-' + v for family, vs in variants.items() for v in vs]
    winners = {'aging-exact', 'aging-invocationSkip', 'aging-hasTerminal', 'orphan-free', 'orphan-noRuntime', 'orphan-ownsOtherTerminal', 'finalize-exact', 'finalize-unsupportedTransport', 'reap-exact', 'zombie-exact', 'release-exact'}
    def result():
        bodies = [c.receipt(f, side + '.json') for side in ('bun', 'native')]
        for body in bodies:
            require([v['id'] for v in body['results']] == ids, 'exact ordered CAS identities/cardinality')
            require(all(type(v['changed']) is bool for v in body['results']), 'CAS changed must be boolean')
            require({v['id'] for v in body['results'] if v['changed']} == winners, 'CAS exact winning predicates')
        require(exact(bodies[0]['results'], bodies[1]['results']), 'Bun/native CAS results differ')
    c.check(f, 'cas-results', result)
    tables = ['runs', 'runtimes', 'session_index', 'broker_invocations', 'hrc_events', 'event_stream_cursor', 'sqlite_sequence']
    def effects():
        states = {}
        for side in ('bun', 'native'):
            before = c.load(f + '/' + side + '-before.json')
            after = c.load(f + '/' + side + '-after.json')
            require(set(before) == set(after) == set(tables), 'exact coupled table coverage')
            require(all(before[t] for t in ('runs', 'runtimes', 'hrc_events')), 'nonempty CAS initial rows')
            require(not exact(before, after), 'zero-effect CAS batch')
            for table, idcol in (('runs', 'run_id'), ('runtimes', 'runtime_id')):
                b = {r[idcol]: r for r in before[table]}
                a = {r[idcol]: r for r in after[table]}
                require(set(a) == set(b) and len(a) == len(after[table]) and len(b) == len(before[table]), 'row identity/cardinality changed: ' + table)
                for case in ids:
                    key = case + ('-run' if table == 'runs' else '-runtime')
                    target = table == ('runtimes' if case.startswith(('aging-', 'release-')) else 'runs')
                    if key in b:
                        require((not exact(b[key], a[key])) == (target and case in winners), 'wrong CAS persisted effect: ' + key)
                        expected_row = dict(b[key])
                        if target and case in winners:
                            at = '2026-10-23T01:00:00.000Z'
                            family = case.split('-', 1)[0]
                            if family == 'aging':
                                expected_row.update(status='stale', status_changed_at=at, updated_at=at)
                            elif family == 'release':
                                expected_row.update(status='ready', active_run_id=None, updated_at=at, last_activity_at=at)
                            else:
                                expected_row.update(status={'orphan': 'failed', 'finalize': 'completed', 'reap': 'failed', 'zombie': 'zombie'}[family], completed_at=at, updated_at=at)
                                if family in ('orphan', 'reap', 'zombie'):
                                    expected_row.update(error_code='fixture-error', error_message='fixture message')
                        require(exact(expected_row, a[key]), 'CAS changed wrong fields/values: ' + key)
                for key in b:
                    if key not in {case + ('-run' if table == 'runs' else '-runtime') for case in ids} and key != ('atomic-run' if table == 'runs' else 'atomic-runtime'):
                        require(exact(b[key], a[key]), 'unrelated stored row changed: ' + key)
            require(exact(after, c.rows(f, side + '-state.sqlite', tables)), 'raw final rows differ from coherent backup: ' + side)
            states[side] = after
        require(exact(states['bun'], states['native']), 'full coupled Bun/native rows differ')
    c.check(f, 'cas-effects', effects)


def read_predicates(c):
    f = 'read_predicates_e2e'
    def values():
        bun = c.receipt(f, 'bun.json')['result']
        value = c.receipt(f, 'native.json')['result']
        require(exact(bun, value) and bool(value), 'nonempty exact query fields/order')
        require(value['accepted'] == [2, None], 'accepted input lower bound')
        require(value['terminals'] == ['turn.failed', 'turn.failed', 'turn.failed', 'turn.interrupted', None, None], 'terminal identity/bounds')
        for key, expected in [('inFlight', ['flight-tmux', 'flight-headless']), ('acceptedInFlight', ['flight-headless', 'flight-tmux', 'flight-accepted']), ('excluded', ['flight-accepted'])]:
            require([v['runId'] for v in value[key]] == expected, 'exact in-flight identities/order: ' + key)
        require(len(value['absorbedAll']) == 2 and len(value['absorbedOne']) == 1, 'absorbed cardinality')
        require(value['scoped'] == [[], ['selector-' + str(i) + '-' + str(g) for i in range(3) for g in [1, 2]], ['selector-0-1', 'selector-0-2'], ['selector-' + str(i) + '-' + str(g) for i in range(3) for g in [1, 2]]], 'scope selector escaping/generations/empty/deduplicated-union case')
        require(value['roleTree'] == value['scoped'][1] and value['roleExact'] == ['selector-1-1', 'selector-1-2'], 'role exact/tree identities/order')
        require(len(value['terminalRuntimes']) == 3, 'terminal runtime cardinality')
    c.check(f, 'query-values', values)
    def passive():
        before = c.load(f + '/before.json')
        require(bool(before), 'empty initial logical snapshot')
        for side in ('bun', 'native'):
            require(exact(before, c.load(f + '/' + side + '-after.json')), 'read changed logical rows: ' + side)
        with c.db(f, 'state-evidence.sqlite') as db:
            require(exact(before, list(db.iterdump())), 'final coherent backup differs from initial dump')
    c.check(f, 'reader-passivity', passive)


def body_bytes(units):
    result = bytearray()
    i = 0
    while i < len(units):
        n = units[i]
        require(type(n) is int and 0 <= n <= 65535, 'invalid UTF16 input unit')
        if 0xd800 <= n <= 0xdfff and i + 1 < len(units):
            i += 1
            n = 0x10000 + ((n & 1023) << 10) + (units[i] & 1023)
        result.extend(chr(n).encode('utf-8', 'surrogatepass'))
        i += 1
    return bytes(result)


def body_family(c, origin=False):
    f = 'federated_origin_body_e2e' if origin else 'mail_body_e2e'
    def prove():
        inputs = [json.loads(v) for v in c.file(f + '/input.jsonl').read_text().splitlines()]
        require(len(inputs) == 2004, 'fixed nonempty UTF16 fixture cardinality')
        fixture = Path(__file__).parents[1] / 'fixtures/mail-body.jsonl'
        require(sha(c.file(f + '/input.jsonl')) == sha(fixture), 'fixed UTF16 source fixture differs')
        values = {}
        physical = {}
        for side in ('bun', 'native'):
            result = c.receipt(f, side + '-writer.json')['results']
            read = c.receipt(f, side + '-opposite-passive.json')['envelopes']
            replay = c.receipt(f, side + ('-opposite-retry.json' if origin else '-opposite-retry-reappend.json'))['results']
            require(len(result) == len(inputs), 'UTF16 result cardinality')
            require(exact(normalize(replay, DTO_CLOCKS), normalize(result, DTO_CLOCKS)), 'cross-writer retries/reappend differ')
            before = c.load(f + '/' + side + '-before-passive.json')
            after = c.load(f + '/' + side + '-after-passive.json')
            require(bool(before['tables']) and exact(before, after), 'passive body read changed logical schema/rows')
            require(exact(after, c.logical(f, side + '-state.sqlite')), 'repeat/refusal leaked logical effects')
            with c.db(f, side + '-state.sqlite') as db:
                if origin:
                    rows = db.execute('SELECT ingress_id,envelope_json,request_fingerprint FROM hrcmail_federated_origins ORDER BY ingress_id').fetchall()
                    require(db.execute('SELECT COUNT(*) FROM hrcmail_envelopes').fetchone()[0] == 0, 'origin wrote local envelope')
                else:
                    rows = db.execute('SELECT envelope_id,hex(CAST(body AS BLOB)),typeof(body),request_fingerprint FROM hrcmail_envelopes JOIN hrcmail_ingress_receipts USING(envelope_id) ORDER BY envelope_seq').fetchall()
            require(exact([list(r) for r in rows], c.load(f + '/' + side + '-physical.json')), 'physical raw rows differ from backup')
            indexed = {r[0]: r for r in rows}
            read_index = {v['envelopeId']: v for v in read}
            require(len(indexed) == len(rows) and len(read_index) == len(read), 'duplicate persisted/read envelope identity')
            successes = conflicts = blank = 0
            for index, (source, observed) in enumerate(zip(inputs, result)):
                require(observed['index'] == index and observed['units'] == source['units'], 'UTF16 input identity/order')
                create = observed['create']
                if origin:
                    expected = b''.join(n.to_bytes(2, 'little') for n in source['units']).decode('utf-16-le', 'surrogatepass')
                    require(create['value']['envelope']['payload']['body'] == expected and read[index]['payload']['body'] == expected, 'origin lost original UTF16 body: ' + str(index))
                    require(exact(normalize(observed['retry'], DTO_CLOCKS), {**normalize(create, DTO_CLOCKS), 'name': 'retry'}), 'origin retry differs')
                    require(exact(normalize(observed['reappend'], DTO_CLOCKS), {**normalize(create, DTO_CLOCKS), 'name': 'reappend'}), 'origin reappend differs')
                    continue
                require(observed['name'] == source['name'], 'mail fixture name')
                require(exact(observed['retry'], {**create, 'name': 'retry'}), 'local retry differs')
                envelope_id = 'body-envelope-' + str(index)
                if 'error' in create:
                    require(create['error']['code'] == 'invalid_transition' and observed['reappend'] is None and envelope_id not in indexed, 'blank body refusal/effect')
                    continue
                successes += 1
                row = indexed[envelope_id]
                raw = body_bytes(source['units'])
                require(row[1] == raw.hex().upper() and row[2] == 'text', 'exact persisted UTF16-derived body bytes')
                try:
                    expected = raw.decode('utf-8')
                except UnicodeDecodeError:
                    expected = ''
                require(create['value']['envelope']['payload']['body'] == expected and read_index[envelope_id]['payload']['body'] == expected, 'local read body differs')
                encoded = expected.encode('utf-16-le')
                units = list(struct.unpack('<' + 'H' * (len(encoded) // 2), encoded))
                if units == source['units']:
                    require(exact(observed['reappend'], {**create, 'name': 'reappend'}), 'local reappend identity differs')
                elif expected == '':
                    require(observed['reappend']['error']['code'] == 'invalid_transition', 'blank decoded body reappend refusal')
                    blank += 1
                else:
                    require(observed['reappend']['error']['code'] == 'ingress_conflict', 'changed decoded body conflict')
                    conflicts += 1
            if origin:
                require(len(read) == len(rows) == len(inputs), 'origin read/persisted cardinality')
                physical[side] = [(key, normalize(json.loads(doc), DTO_CLOCKS), fingerprint) for key, doc, fingerprint in rows]
            else:
                require(len(rows) == len(read) == successes and successes > 1900 and conflicts > 100 and blank > 20, 'nonempty success/conflict/blank-refusal controls')
                physical[side] = rows
            values[side] = result
        require(exact(normalize(values['bun'], DTO_CLOCKS), normalize(values['native'], DTO_CLOCKS)), 'all writer fields/order differ')
        require(exact(physical['bun'], physical['native']), 'physical body/fingerprint parity differs')
    c.check(f, 'utf16-body', prove)


def json_lines(c, family):
    def prove():
        inputs = c.file(family + '/input.jsonl').read_text().splitlines()
        bun = c.file(family + '/bun.jsonl').read_text()
        native = c.file(family + '/native.jsonl').read_text()
        require(bun.endswith('\n') and native.endswith('\n'), 'truncated JSONL output')
        expected, actual = bun.split('\n')[:-1], native.split('\n')[:-1]
        minimum = {'json_values_e2e': 19900, 'mail_json_e2e': 1005, 'reply_schema_e2e': 250}[family]
        require(len(inputs) == len(expected) == len(actual) and len(inputs) >= minimum, 'nonempty fixed JSONL cardinality')
        if family == 'reply_schema_e2e':
            fixture = Path(__file__).parents[1] / 'fixtures/reply-schema.jsonl'
            require(sha(c.file(family + '/input.jsonl')) == sha(fixture), 'fixed reply-schema fixture differs')
            require(exact([json.loads(v) for v in expected], [json.loads(v) for v in actual]), 'reply validation per-input values/order differ')
        else:
            require(expected == actual, 'exact JSON serialization/canonical fingerprint output differs')
        if family == 'json_values_e2e':
            require(expected[-19:] == ['INVALID_JSON'] * 19, 'fixed invalid JSON refusal suffix')
        if family == 'mail_json_e2e':
            for text in actual:
                value = json.loads(text)
                require(set(value) == {'canonical', 'fingerprint'}, 'canonicalization output fields')
                require(isinstance(value['canonical'], str) and isinstance(value['fingerprint'], str) and value['fingerprint'], 'nonempty canonical/fingerprint values')
    c.check(family, 'all-input-values', prove)
    def receipt():
        proof = next(row for row in c.assertions if row['id'] == family + '/identity')
        c.used.extend(proof['receipts'])
        if proof['status'] == 'GAP':
            raise Gap(proof['reason'])
        require(proof['status'] == 'PASS', proof['reason'])
    c.check(family, 'raw-command-receipts', receipt)


def mail_mutations(c, origin=False):
    f = 'federated_origin_create_e2e' if origin else 'legacy_mail_mutations_e2e'
    def norm(v):
        if isinstance(v, list):
            return [norm(x) for x in v]
        if not isinstance(v, dict):
            return v
        result = {}
        clocks = {'createdAt', 'updatedAt', 'created_at', 'updated_at'} if origin else SQL_CLOCKS
        for k, x in v.items():
            if k in clocks and isinstance(x, str):
                result[k] = clock(x)
            elif k == 'receipt_json' or (origin and k == 'envelope_json'):
                # Preserve exact lexical JSON, replacing ONLY the source-declared clocks.
                result[k] = re.sub(r'"(createdAt|updatedAt)":"([^"]+)"', lambda m: '"' + m[1] + '":"' + clock(m[2]) + '"', x)
            else:
                result[k] = norm(x)
        return result
    def prove():
        states, values = {}, {}
        tables = ['hrcmail_envelopes', 'hrcmail_ingress_receipts', 'hrcmail_federated_origins' if origin else 'hrcmail_stop_refusals']
        for side in ('bun', 'native'):
            result = c.receipt(f, side + ('-run.json' if origin else '.json'))['results']
            if origin:
                result += c.receipt(f, side + '-missing.json')['results']
            require(len(result) == (10 if origin else 23), 'exact create/refusal/retry/ack result cardinality')
            states[side] = c.load(f + '/' + side + '-rows.json')
            require(set(states[side]) == set(tables), 'exact mail table coverage')
            require(exact(states[side], c.rows(f, side + '-state.sqlite', tables)), 'mail row snapshot differs from coherent backup')
            require(bool(states[side]['hrcmail_envelopes']), 'zero-effect mail writes')
            values[side] = result
        require(exact(norm(values['bun']), norm(values['native'])), 'all mail command fields/order/refusals differ')
        require(exact(norm(states['bun']), norm(states['native'])), 'all persisted mail fields differ')
        state = states['native']
        if origin:
            row = next(r for r in state['hrcmail_federated_origins'] if r['ingress_id'] == 'origin-ingress')
            body = json.loads(row['envelope_json'])
            require(body['payload']['body'] == 'X\ud800Y\udfff', 'origin JSON lost surrogates')
            require('__proto__' not in body['payload']['metadata'], 'stored origin metadata prototype filtering')
            require('__proto__' in values['bun'][0]['value']['envelope']['payload']['metadata'], 'initial Bun output prototype key')
            require('__proto__' not in values['native'][1]['value']['envelope']['payload']['metadata'], 'retried native output prototype filtering')
        else:
            require(len(state['hrcmail_envelopes']) == 2 and all(r['state'] == 'acked' for r in state['hrcmail_envelopes']), 'acked final envelope identities/cardinality')
            refusal = state['hrcmail_stop_refusals'][0]
            require(refusal['refusal_count'] == 0 and refusal['total_refusal_count'] == 8 and refusal['observed_envelope_seq'] == 2, 'stop-refusal counters')
            require(state['hrcmail_envelopes'][0]['materialization_intent_json'] == '{"first":true}', 'first materialization intent preserved')
    c.check(f, 'commands-and-persisted-rows', prove)


def guards(c):
    f = 'guards_e2e'
    def prove():
        commands = c.load(f + '/commands.json')
        expected = [('inspect', 'store_not_found'), ('inspect', 'store_schema_unknown'), ('inspect', 'store_schema_behind'), ('page', None), ('page', None), ('inspect', None), ('session-contract', 'store_busy'), ('page', None), ('crash-contract', 70), ('page', None), ('crash-contract', 71), ('page', None)]
        # There are twelve native calls in the fixed guard source.
        require(len(commands) == len(expected), 'exact guard command sequence')
        bodies = []
        for receipt, (command, error) in zip(commands, expected):
            require(receipt['argv'][1] == command, 'guard command/order differs')
            if isinstance(error, str):
                require(type(receipt['exit']) is int and receipt['exit'] != 0 and json.loads(receipt['stdout'])['error']['code'] == error, 'exact guard refusal: ' + error)
                bodies.append(None)
            elif type(error) is int:
                require(receipt['exit'] == error, 'crash boundary exit')
                bodies.append(None)
            else:
                require(receipt['exit'] == 0, 'successful guard command exit')
                bodies.append(json.loads(receipt['stdout']))
        require(len(bodies[3]['rows']) == 2, 'compatible extra-index page')
        old, new, rolled, committed = bodies[4], bodies[7], bodies[9], bodies[11]
        require(len(new['rows']) == len(old['rows']) + 1 and new['head'] > old['head'], 'mutation control did no work')
        require(exact(rolled, new), 'crash-before commit leaked state')
        require(len(committed['rows']) == len(new['rows']) + 1 and committed['head'] > new['head'], 'crash-after commit lost state')
        require(committed['rows'][:-1] == new['rows'], 'crash commit changed existing rows')
        before = c.load(f + '/passive-before.json')
        require(bool(before['tables']), 'empty guard logical snapshot')
        for receipt in ('passive-page-after.json', 'passive-after.json'):
            require(exact(before, c.load(f + '/' + receipt)), 'passive guard reader changed logical state: ' + receipt)
        require(not exact(before, c.load(f + '/activity-after.json')), 'logical guard mutation control did no work')
        require(c.receipt(f, 'activity-control.json')['lastActivityAt'] == '2026-10-23T00:00:01.000Z', 'real activity mutation control identity/value')
        c.receipt(f, 'bun-mutation.json')
    c.check(f, 'refusals-passivity-crash', prove)
    c.check(f, 'missing-and-busy-boundaries', lambda: (_ for _ in ()).throw(Gap('retain post-refusal missing-file inventory and lock start/end receipts; noncreation and <12s busy bound cannot be reconstructed from stdout')))


def append_boundary(c):
    f = 'append_boundaries_e2e'
    def prove():
        native, bun = c.receipt(f, 'native.json'), c.receipt(f, 'independent-bun.json')
        for r in (native, bun):
            require(bool(r['before']['rows']), 'empty append initial page')
            require(exact(r['before'], r['afterCaught']), 'caught append leaked row/cursor')
            require(r['withinCaught']['head'] == r['afterCommit']['head'] + 1, 'rollback did not perform append')
            require(exact(r['afterRollback'], r['afterCommit']), 'caller rollback leaked rows/cursor')
            require(r['afterCommit']['head'] == r['before']['head'] + 1 and len(r['afterCommit']['rows']) == len(r['before']['rows']) + 1, 'commit did no work/cardinality')
            for key in ('before', 'afterCaught', 'afterCommit', 'withinCaught', 'afterRollback'):
                require(isinstance(r[key]['ledgerIncarnationId'], str) and r[key]['ledgerIncarnationId'], 'missing declared ledger incarnation')
                r[key].pop('ledgerIncarnationId')  # Exactly the field permitted by this fixed source.
        require(exact(native, bun), 'append boundary Bun/native parity')
    c.check(f, 'raw-append-boundaries', prove)


def titles(c):
    f = 'title_reads_e2e'
    def prove():
        value = c.receipt(f, 'native.json')
        require(exact(value, c.receipt(f, 'bun.json')), 'all title facade fields differ')
        require(value['one']['source'] == 'manual' and 'model' not in value['one'] and len(value['all']) == 1, 'title provenance/omission/cardinality')
        surrogate = c.receipt(f, 'native-surrogate.json')
        require(exact(surrogate, c.receipt(f, 'bun-surrogate.json')), 'title surrogate read parity')
        require(surrogate['one']['title'] == '\ud800 title \udfff', 'title original surrogate code units')
        for prefix, oracle in [('', 'bun-after-native-reappend.json'), ('whitespace-', 'bun-whitespace-after-native.json')]:
            native = c.receipt(f, 'native-' + prefix + 'reappend.json')
            require(exact(native, c.receipt(f, oracle)['one']), 'title reappend full row parity')
            if prefix:
                require(native['title'] == '\u0085 title \u0085', 'non-ECMAScript whitespace stripped')
    c.check(f, 'facade-surrogates-reappend', prove)
    c.check(f, 'passivity', lambda: (_ for _ in ()).throw(Gap('retain before and after logical snapshots for title reads; source-local snapshot variables were not retained')))


def revalidate(root, expected_identity=None):
    c = Checker(root, expected_identity)
    c.check('identity', 'root', lambda: c.identity(expected_identity))
    c.check('identity', 'build-provenance', lambda: c.build_provenance(expected_identity))
    c.check('integrity', 'manifest', c.integrity)
    from source_checks import source_checks
    for family in c.catalog:
        c.check(family, 'identity', lambda f=family: c.family_identity(f, expected_identity))
    source_checks(c)
    reconciliation(c)
    from observations import run as observation_checks
    observation_checks(c)
    read_predicates(c)
    body_family(c)
    body_family(c, origin=True)
    mail_mutations(c)
    mail_mutations(c, origin=True)
    for family in ('json_values_e2e', 'mail_json_e2e', 'reply_schema_e2e'):
        json_lines(c, family)
    guards(c)
    append_boundary(c)
    titles(c)
    for family in c.catalog:
        if family not in ('reconciliation_e2e', 'read_predicates_e2e', 'mail_body_e2e', 'federated_origin_body_e2e', 'legacy_mail_mutations_e2e', 'federated_origin_create_e2e', 'json_values_e2e', 'mail_json_e2e', 'reply_schema_e2e', 'atomic_e2e', 'session_e2e', 'transcript_e2e', 'repository_e2e', 'guards_e2e', 'title_reads_e2e', 'append_boundaries_e2e'):
            c.check(family, 'persisted-operation-receipts', lambda f=family: (_ for _ in ()).throw(Gap('persisted operation reconstruction not yet supported for ' + f + '; fixed source output rows and historical coverageDiscovery method links remain distinct from exact effects/refusals/transaction proof')))
    from source_checks import close_flags
    from coverage_links import COVERAGE_DISCOVERY
    close_flags(c)
    for row in c.assertions:
        row['coverageDiscoveryRef'] = row['family'] if row['family'] in COVERAGE_DISCOVERY['families'] else None
    status = 'FAIL' if any(r['status'] == 'FAIL' for r in c.assertions) else 'GAP' if any(r['status'] == 'GAP' for r in c.assertions) else 'PASS'
    return {'schemaVersion': 1, 'status': status, 'exitCode': {'PASS': 0, 'FAIL': 1, 'GAP': 2}[status],
            'scope': 'repository-source-raw-evidence', 'installedNativeAcceptance': False,
            'fullP1Qualified': False, 'fullParityQualified': False,
            'requiredFamilies': sorted(c.catalog), 'reviewedSourceCatalog': {f: r['sha256'] if r else None for f, r in c.catalog.items()}, 'coverageDiscovery': COVERAGE_DISCOVERY, 'assertions': c.assertions,
            'gaps': [{'id': r['id'], 'reason': r['reason'], 'kind': r.get('gapKind', 'RAW_MISSING'), 'receipts': r['receipts']} for r in c.assertions if r['status'] == 'GAP']}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--root', type=Path, required=True)
    p.add_argument('--identity', type=Path, help='independently pinned expected native/Bun identity JSON')
    p.add_argument('--output', type=Path)
    a = p.parse_args()
    try:
        if a.output and a.output.resolve().is_relative_to(a.root.resolve()):
            raise ValueError('--output must be outside the read-only evidence root')
        result = revalidate(a.root, json.loads(a.identity.read_text()) if a.identity else None)
    except Exception as e:
        result = {'schemaVersion': 1, 'status': 'FAIL', 'exitCode': 1, 'assertions': [{'id': 'input/parse', 'family': 'input', 'status': 'FAIL', 'reason': type(e).__name__ + ': ' + str(e), 'receipts': []}], 'gaps': [], 'installedNativeAcceptance': False, 'fullP1Qualified': False, 'fullParityQualified': False}
    text = json.dumps(result, indent=2, ensure_ascii=True) + '\n'
    if a.output and not a.output.resolve().is_relative_to(a.root.resolve()):
        try:
            a.output.write_text(text)
        except OSError as e:
            result = {'schemaVersion': 1, 'status': 'FAIL', 'exitCode': 1, 'assertions': [{'id': 'output/write', 'family': 'output', 'status': 'FAIL', 'reason': str(e), 'receipts': []}], 'gaps': [], 'installedNativeAcceptance': False, 'fullP1Qualified': False, 'fullParityQualified': False}
            text = json.dumps(result, indent=2) + '\n'
    print(text, end='')
    return result['exitCode']


if __name__ == '__main__':
    raise SystemExit(main())
