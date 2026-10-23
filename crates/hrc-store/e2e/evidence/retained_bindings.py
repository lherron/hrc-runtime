"""Reviewed aliases into actual retained source data; no producer/helper execution."""
import ast
import hashlib
import json
from common import Gap, exact
from expressions import Pure

MISSING = object()


def identified(c, family):
    if not any(r['id'] == family + '/identity' and r['status'] == 'PASS' for r in c.assertions):
        raise Gap('retained source binding requires complete independently pinned family identity')


def source(c, family):
    identified(c, family)
    path = c.file(family + '/source/' + c.catalog[family]['source'])
    raw = path.read_bytes()
    if hashlib.sha256(raw).hexdigest() != c.catalog[family]['sha256']:
        raise AssertionError('retained binding source differs from reviewed catalog')
    return ast.parse(raw)


def lines(c, family, name):
    return c.file(family + '/' + name).read_text().split('\n')[:-1]


def precheck(c, family, assertion, local):
    """Preserve reviewed missing boundaries and actual source branch guards."""
    line = assertion['line']
    if family == 'prune_e2e' and 'variant' in local:
        tree = source(c, family)
        node = next(n for n in ast.walk(tree) if isinstance(n, ast.Assert) and
                    (n.lineno, n.col_offset) == (line, assertion['column']))
        parents = {child: p for p in ast.walk(tree) for child in ast.iter_child_nodes(p)}
        variant = local['variant']
        env = {'variant': variant, 'mode': 'full' if variant == 'full-shared' else variant}
        while node in parents:
            parent = parents[node]
            if isinstance(parent, ast.If):
                reached_then = bool(Pure(env).expr(parent.test))
                in_then = node in parent.body
                if reached_then != in_then:
                    raise Gap('source branch not reached: variant=' + variant + ', ' + ast.unparse(parent.test))
            node = parent
        if line in (32, 33, 36, 44):
            raise Gap('missing actual per-variant prune before-state image; after-only remaining rows cannot establish this source predicate')
    missing = {
        ('guards_e2e', 11): 'post-refusal missing.sqlite filesystem inventory',
        ('guards_e2e', 55): 'outer lock-acquire/native-call/rollback monotonic interval',
        ('store_e2e', 35): 'post-refusal absent.sqlite filesystem inventory',
        ('native_discriminator_e2e', 56): 'absent.sock filesystem inventory before native command',
        ('native_discriminator_e2e', 61): 'absent.sock filesystem inventory after native command',
        ('legacy_mail_reads_e2e', 13): 'actual retained before/after logical snapshots for original legacy mail reader',
        ('title_reads_e2e', 13): 'actual retained before/after logical snapshots for original title reader',
        ('placement_e2e', 13): 'actual pre-factory schema image or observed placement_ledger count',
    }
    if (family, line) in missing:
        raise Gap('missing actual source boundary receipt: ' + missing[(family, line)])


def environments(c, family, assertion, local):
    if family == 'read_predicates_e2e' and assertion['line'] == 45:
        identified(c, family)
        before = c.load(family + '/before.json')
        return [{**local, 'before': before, 'after': c.load(family + '/' + side + '-after.json')}
                for side in ('bun', 'native')]
    return [local]


def resolve(c, family, key, local):
    if family in ('json_values_e2e', 'mail_json_e2e', 'reply_schema_e2e'):
        supported = {'raw', 'inputs', 'expected', 'actual', 'differences', 'invalid'}
        if key not in supported:
            return MISSING
        identified(c, family)
        raw = lines(c, family, 'input.jsonl')
        if key == 'raw':
            return raw
        if key == 'inputs':
            # Source uses splitlines for parsed fixture inputs, literal newline
            # splitting for producer outputs. Do not interchange these laws.
            return [json.loads(s) for s in c.file(family + '/input.jsonl').read_text().splitlines()]
        expected = lines(c, family, 'bun.jsonl')
        actual = lines(c, family, 'native.jsonl')
        if family == 'reply_schema_e2e':
            expected = [json.loads(s) for s in expected if s]
            actual = [json.loads(s) for s in actual if s]
        if key in ('expected', 'actual'):
            return expected if key == 'expected' else actual
        if key == 'invalid' and family == 'json_values_e2e':
            tree = source(c, family)
            assignments = [n for n in ast.walk(tree) if isinstance(n, ast.Assign) and
                           any(isinstance(t, ast.Name) and t.id == 'invalid' for t in n.targets)]
            if len(assignments) != 1:
                raise Gap('unsupported source invalid-input literal binding')
            return ast.literal_eval(assignments[0].value)
        if key == 'differences':
            return [i for i, (a, b) in enumerate(zip(expected, actual)) if not exact(a, b)]
        return MISSING
    if family == 'read_predicates_e2e' and key in ('before', 'values', 'value'):
        identified(c, family)
        if key == 'before':
            return c.load(family + '/before.json')
        values = {side: c.receipt(family, side + '.json')['result'] for side in ('bun', 'native')}
        return values if key == 'values' else values['native']
    if family == 'prune_e2e' and key in ('observed', 'control', 'n', 'b', 'discrepancies'):
        identified(c, family)
        if key == 'discrepancies':
            return [variant for variant in ('minimal', 'full', 'full-shared')
                    if not exact(c.receipt(family, 'native-' + variant + '.json')['removed'],
                                 c.receipt(family, 'bun-' + variant + '.json')['removed'])]
        variant = local.get('variant')
        if variant not in ('minimal', 'full', 'full-shared'):
            raise Gap('unsupported prune source variant binding')
        if key in ('observed', 'control'):
            side = 'native' if key == 'observed' else 'bun'
            return c.receipt(family, side + '-' + variant + '.json')
        return c.load(family + '/remaining-' + variant + '.json')['native' if key == 'n' else 'bun']
    return MISSING
