"""Source-linked output assertion checks, with explicit uncaptured-state gaps."""
import ast
from itertools import product
import json
from common import Gap
from expressions import Pure, Receipt
from catalog import CATALOG


NATIVE = {'atomic_e2e': 'native-atomic.json', 'store_e2e': 'native-page.json'}
BUN = {'session_e2e': 'bun-readback.json', 'transcript_e2e': 'bun-read.json',
       'serialization_e2e': 'unchanged-bun.json', 'legacy_mail_reads_e2e': 'bun.json',
       'legacy_mail_transitions_e2e': 'bun.json', 'legacy_mail_origins_e2e': 'bun.json',
       'legacy_mail_rollback_e2e': 'bun.json', 'title_reads_e2e': 'bun.json'}


class Bindings(dict):
    """Resolve only values actually needed by this source assertion."""
    def __init__(self, c, family, expr, local):
        self.c, self.family = c, family
        self.expr = expr
        self.local = local

    def raw(self, name):
        return self.c.load(self.family + '/' + name)

    def body(self, name):
        return self.c.receipt(self.family, name)

    def get_binding(self, key):
        if key in self.local:
            return self.local[key]
        f = self.family
        native = NATIVE.get(f, 'native.json')
        bun = BUN.get(f, 'unchanged-bun.json')
        if key in ('seed', 's'):
            for name in ('seed.json', 'bun-seed.json'):
                if (self.c.root / f / name).is_file():
                    return Receipt(self.raw(name)) if any(isinstance(n, ast.Attribute) and isinstance(n.value, ast.Name) and n.value.id == key for n in ast.walk(self.expr)) else self.body(name)
            raise Gap('seed stdout/argv not retained: ' + f)
        # Statement-local subprocess variables and decoded bodies share names.
        attrs = [n for n in ast.walk(self.expr) if isinstance(n, ast.Attribute) and isinstance(n.value, ast.Name) and n.value.id == key]
        if any(n.attr in ('returncode', 'stdout', 'stderr') for n in attrs):
            selected = native
            if key in ('bun', 'b', 'control', 'controls', 'writer'):
                selected = {'writer': 'bun-writer.json', 'control': 'bun-read.json' if f == 'serialization_e2e' else bun,
                            'controls': 'bun-count-controls.json'}.get(key, bun)
            if key == 'b' and f in ('collective_e2e', 'append_boundaries_e2e'):
                selected = 'independent-bun.json'
            return Receipt(self.raw(selected))
        if key in ('r', 'n', 'v', 'd', 'data', 'checks', 'result'):
            return self.body(native)
        if key in ('b', 'bun', 'readback'):
            return self.body(bun)
        if key == 'observed':
            if f == 'broker_e2e':
                return self.body(native)['observations']
            if f == 'placement_e2e':
                return self.body(native)
            return self.body(bun)
        guard_files = {'logical_before': 'passive-before.json', 'logical_after': 'passive-after.json', 'logical_activity': 'activity-after.json', 'page_image': 'passive-page-after.json'}
        if f == 'guards_e2e' and key in guard_files:
            return self.raw(guard_files[key])
        if f == 'atomic_e2e' and key in ('observations', 'boundaries', 'bun_parts'):
            if key == 'bun_parts':
                return self.body('bun-parts.json')
            observed = self.body('native-atomic.json')['observations']
            return observed if key == 'observations' else {r['stage']: r['state'] for r in observed['partBoundaries']}
        if f == 'repository_e2e' and key in ('rollback', 'actual'):
            return self.body('bun-roster.json') if key == 'actual' else self.body(native)['observations']['rosterRollback']
        if key == 'raw':
            return self.raw('sqlite-raw.json' if f == 'broker_e2e' else 'raw.json')
        if key == 'imported':
            return [r for r in self.raw('sqlite-raw.json')['broker_invocation_events'] if r['source_ref'] == 'p1-peer']
        if key == 'latest':
            return self.body(native)['latest']['presentation']
        if key == 'absent':
            return self.body('absent.json')
        if key == 'expected' and f == 'append_boundaries_e2e':
            return self.body('independent-bun.json')
        if key == 'written':
            return self.body('bun-write.json')
        if key == 'native':
            return self.body('native-read.json' if f == 'serialization_e2e' else native)
        if key == 'control' and f == 'serialization_e2e':
            return self.body('bun-read.json')
        if f == 'store_e2e':
            if key == 'page':
                return self.body('native-page.json')
            if key == 'full':
                return self.body('native-full.json')
        raise Gap('missing raw binding for fixed source expression: ' + f + ':' + key)


def source_checks(c):
    for family, record in CATALOG.items():
        for assertion in record['assertions']:
            expression = ast.parse(assertion['expression'], mode='eval').body
            loops = assertion['loops']
            fixed = [loop for loop in loops if isinstance(loop['values'], (list, tuple))]
            combos = list(product(*(loop['values'] for loop in fixed))) or [()]
            for combo in combos:
                local = {loop['binding']: value for loop, value in zip(fixed, combo)}
                suffix = ''.join(':' + k + '=' + str(v) for k, v in local.items())
                name = assertion['id'].split(':', 1)[1] + suffix
                def prove(f=family, expr=expression, local=local, loops=loops):
                    if any(isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute) and n.func.attr == 'get' and isinstance(n.func.value, ast.Name) and n.func.value.id in ('result', 'checks', 'data', 'd') and n.args and isinstance(n.args[0], ast.Name) and n.args[0].id in local for n in ast.walk(expr)):
                        raise Gap('native self-attestation ignored; raw operation/boundary reconstruction required')
                    if f == 'append_boundaries_e2e' and ast.unparse(expr) == 'r == expected':
                        raise Gap('declared incarnation normalization reconstructed by raw-append-boundaries adapter')
                    if any(isinstance(n, ast.Attribute) and n.attr in ('returncode', 'stdout', 'stderr') for n in ast.walk(expr)):
                        raise Gap('retain exact source-invocation-to-receipt linkage; reusable local process variable is not an identity receipt')
                    names = {n.id for n in ast.walk(expr) if isinstance(n, ast.Name)}
                    # Comprehension targets are local to their expression.
                    names -= {n.target.id for n in ast.walk(expr) if isinstance(n, ast.comprehension) and isinstance(n.target, ast.Name)}
                    names -= {'json', 'len', 'all', 'any', 'str', 'list', 'bytes', 'reversed', 'sorted', 'range'}
                    bindings = Bindings(c, f, expr, local)
                    env = {name: bindings.get_binding(name) for name in names}
                    answer = Pure(env).expr(expr)
                    if not answer:
                        raise AssertionError('raw source assertion false: ' + ast.unparse(expr))
                    # A successful output flag remains a behavioral gap. Do not turn native
                    # self-attestation into transaction, conflict, observer or FTS proof.
                    if any(loop['values'] is None for loop in loops):
                        raise Gap('dynamic source iteration not independently reconstructed: ' + ', '.join(loop['source'] for loop in loops if loop['values'] is None))
                row = c.check(family, name, prove)
                row.update(source=record['source'], sourceSha256=record['sha256'], line=assertion['line'], column=assertion['column'], expression=assertion['expression'], scope='raw-output-only')


FLAG_CLOSURES = {
    'atomic_e2e': ('transaction-spill-observers', {'outerRollback', 'savepointRollback', 'commitHintsOnly', 'observerFailureIsolated', 'spillHydration', 'readOnlyRefusal'}),
    'session_e2e': ('lineage-metadata-cursor', {'lineage', 'continuationReuseReset', 'metadataPrecedence', 'titleContinuityFacade', 'metadataRollback', 'cursorMonotonic'}),
    'transcript_e2e': ('fts-transaction-readbacks', {'ftsInsertUpdateDelete', 'ftsRollback', 'unicodeTokenizer', 'perRuntimeCap', 'invalidWeights', 'cursorAndMark'}),
    'repository_e2e': ('family-operations', {'acceptanceIdempotency', 'acceptanceConflict', 'permissionIdentity', 'artifactIdempotency', 'retainedAppendOnly', 'emissionClaimDedup', 'bufferOrdering', 'surfaceReplacement', 'bridgeClose'}),
}


def close_flags(c):
    rows = {r['id']: r for r in c.assertions}
    for row in c.assertions:
        family = row['family']
        if row.get('scope') != 'raw-output-only' or family not in FLAG_CLOSURES or row['status'] == 'FAIL':
            continue
        group, supported = FLAG_CLOSURES[family]
        flag = row['id'].rsplit('=', 1)[-1]
        overrides = {('atomic_e2e', 'blobPartsValidated'): 'invalid-part-effects', ('repository_e2e', 'rosterAtomic'): 'roster-atomicity'}
        if (family, flag) in overrides:
            group = overrides[(family, flag)]
        if flag in supported or (family, flag) in overrides:
            proof = rows[family + '/' + group]
            row.update(status=proof['status'], reason='independent raw reconstruction: ' + proof['id'] + ': ' + proof['reason'], receipts=proof['receipts'], scope='semantic-source-assertion', reconstructedBy=proof['id'])
