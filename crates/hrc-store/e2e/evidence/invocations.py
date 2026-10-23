"""Link fixed source subprocess expressions to identified raw argv, without execution.

Only unconditionally reached module/with statements and a deliberately small path
expression language are supported. Ambiguous, repeated, helper and loop launches
remain gaps. Receipt order and a convenient output filename never select a call.
"""
import ast
import hashlib
from pathlib import PurePosixPath as Path
import re
from types import SimpleNamespace
from catalog import CATALOG
from common import Gap
from expressions import Receipt


class Invocations:
    def __init__(self, checker, family):
        self.c, self.family = checker, family
        rows = {r['id']: r for r in checker.assertions}
        if rows.get(family + '/identity', {}).get('status') != 'PASS':
            raise Gap('source invocation requires independently pinned complete family identity')
        record = CATALOG[family]
        raw = checker.file(family + '/source/' + record['source']).read_bytes()
        if hashlib.sha256(raw).hexdigest() != record['sha256']:
            raise AssertionError('invocation source differs from fixed reviewed source')
        self.tree = ast.parse(raw)
        self.parents = {child: parent for parent in ast.walk(self.tree) for child in ast.iter_child_nodes(parent)}
        entry = checker.load(family + '/entry.json')
        argv = entry['command']
        if entry['scriptSha256'] != record['sha256'] or not argv[1].endswith('/' + record['source']):
            raise AssertionError('source entry identity mismatch')
        self.filename = argv[1]
        options = argv[2:]
        if len(options) % 2 or len(set(options[::2])) != len(options[::2]):
            raise Gap('unsupported source entry arguments')
        args = dict(zip(options[::2], options[1::2]))
        identity = checker.load('identity.json')
        if args.get('--binary') != identity['native']['path'] or ('--release' in args and args['--release'] != identity['bun']['release']):
            raise AssertionError('source entry producer arguments differ from pinned identity')
        self.args = SimpleNamespace(**{k.removeprefix('--'): v for k, v in args.items()})
        self.commands = [(family + '/commands/' + p.name, checker.load(family + '/commands/' + p.name)) for p in sorted((checker.root / family / 'commands').glob('*.json'))]

    def eligible(self, node):
        while node in self.parents:
            node = self.parents[node]
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.If, ast.For, ast.While, ast.Try, ast.IfExp, ast.ListComp, ast.DictComp, ast.Lambda)):
                return False
        return True

    def assignment(self, name, before):
        candidates = [n for n in ast.walk(self.tree) if isinstance(n, ast.Assign) and (n.lineno, n.col_offset) < before and any(isinstance(t, ast.Name) and t.id == name for t in n.targets)]
        if not candidates:
            raise Gap('unsupported source invocation binding: ' + name)
        selected = max(candidates, key=lambda n: (n.lineno, n.col_offset))
        if not self.eligible(selected):
            raise Gap('latest source assignment is conditional/helper/iteration scoped: ' + name)
        return selected

    def value(self, n, before, stack=()):
        e = lambda x: self.value(x, before, stack)
        if isinstance(n, ast.Constant):
            return n.value
        if isinstance(n, (ast.List, ast.Tuple)):
            return [e(x) for x in n.elts]
        if isinstance(n, ast.Name):
            if n.id == '__file__':
                return self.filename
            if n.id == 'a':
                return self.args
            # A temporary directory is observed from real argv and constrained by
            # the exact source prefix and tempfile's eight-character random suffix.
            for w in ast.walk(self.tree):
                if not isinstance(w, ast.With) or not self.eligible(w) or (w.lineno, w.col_offset) >= before:
                    continue
                for item in w.items:
                    call = item.context_expr
                    if isinstance(item.optional_vars, ast.Name) and item.optional_vars.id == n.id and isinstance(call, ast.Call) and ast.unparse(call.func) == 'tempfile.TemporaryDirectory':
                        kw = {k.arg: ast.literal_eval(k.value) for k in call.keywords}
                        if set(kw) != {'prefix', 'dir'}:
                            raise Gap('unsupported temporary directory arguments')
                        pattern = re.compile(re.escape(str(Path(kw['dir']) / kw['prefix'])) + r'[a-z0-9_]{8}(?=/|$)')
                        roots = {m.group() for _, r in self.commands for arg in r['argv'] if isinstance(arg, str) for m in pattern.finditer(arg)}
                        if len(roots) != 1:
                            raise Gap('missing or ambiguous observed temporary directory: ' + n.id)
                        return next(iter(roots))
            if n.id in stack:
                raise Gap('recursive source invocation binding')
            a = self.assignment(n.id, before)
            return self.value(a.value, (a.lineno, a.col_offset), stack + (n.id,))
        if isinstance(n, ast.Attribute):
            v = e(n.value)
            if isinstance(v, SimpleNamespace) and n.attr in vars(v):
                return vars(v)[n.attr]
            if isinstance(v, Path) and n.attr == 'parent':
                return v.parent
        if isinstance(n, ast.BinOp) and isinstance(n.op, ast.Div):
            return Path(e(n.left)) / e(n.right)
        if isinstance(n, ast.BinOp) and isinstance(n.op, ast.Add):
            return e(n.left) + e(n.right)
        if isinstance(n, ast.Call) and not n.keywords:
            name = ast.unparse(n.func)
            if name == 'str' and len(n.args) == 1:
                return str(e(n.args[0]))
            if name in ('pathlib.Path', 'Path') and len(n.args) == 1:
                return Path(e(n.args[0]))
            if isinstance(n.func, ast.Attribute) and n.func.attr == 'with_name' and len(n.args) == 1:
                v = e(n.func.value)
                if isinstance(v, Path):
                    return v.with_name(e(n.args[0]))
        raise Gap('unsupported pure invocation expression: ' + ast.unparse(n))

    def receipt(self, name, line, column):
        assertions = [n for n in ast.walk(self.tree) if isinstance(n, ast.Assert) and (n.lineno, n.col_offset) == (line, column)]
        if len(assertions) != 1 or not self.eligible(assertions[0]):
            raise Gap('process assertion is within unsupported conditional/helper/iteration scope')
        assignment = self.assignment(name, (line, column))
        call = assignment.value
        if not isinstance(call, ast.Call) or ast.unparse(call.func) != 'subprocess.run' or not call.args:
            raise Gap('binding is not a supported direct subprocess invocation: ' + name)
        argv = self.value(call.args[0], (assignment.lineno, assignment.col_offset))
        if not isinstance(argv, list) or not all(isinstance(x, str) for x in argv):
            raise Gap('invocation argv is not a complete string vector')
        sites = []
        for site in ast.walk(self.tree):
            if not isinstance(site, ast.Assign) or not self.eligible(site) or not isinstance(site.value, ast.Call) or ast.unparse(site.value.func) != 'subprocess.run' or not site.value.args:
                continue
            try:
                if self.value(site.value.args[0], (site.lineno, site.col_offset)) == argv:
                    sites.append(site)
            except Gap:
                continue
        if len(sites) != 1:
            raise Gap('repeated exact source invocation requires additional temporal linkage')
        self.c.file(self.family + '/source/' + CATALOG[self.family]['source'])
        self.c.file(self.family + '/entry.json')
        self.c.file(self.family + '/capture.json')
        self.c.file('identity.json')
        matched = [(p, r) for p, r in self.commands if r['argv'] == argv]
        if len(matched) != 1:
            raise Gap('source invocation has missing or ambiguous exact argv receipt: ' + name)
        path, raw = matched[0]
        self.c.file(path)
        return Receipt(raw)
