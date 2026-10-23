"""Small pure expression interpreter for fixed source assertions, never producer code.

No imports, file access, subprocess, arbitrary attribute lookup, or exec/eval.
Expressions requiring uncaptured process/SQLite/time state explicitly remain GAP.
"""
import ast
import json
import operator
from common import Gap, exact


class Receipt:
    def __init__(self, value):
        self.value = value


class Pure:
    def __init__(self, env):
        self.env = env

    def expr(self, node, local=None):
        env = {**self.env, **(local or {})}
        e = lambda n: self.expr(n, env)
        if isinstance(node, ast.Constant):
            return node.value
        if isinstance(node, ast.Name):
            if node.id not in env:
                raise Gap('uncaptured source binding: ' + node.id)
            return env[node.id]
        if isinstance(node, (ast.List, ast.Tuple, ast.Set)):
            values = [e(n) for n in node.elts]
            return set(values) if isinstance(node, ast.Set) else tuple(values) if isinstance(node, ast.Tuple) else values
        if isinstance(node, ast.Dict):
            return {e(k): e(v) for k, v in zip(node.keys, node.values)}
        if isinstance(node, ast.Subscript):
            return e(node.value)[e(node.slice)]
        if isinstance(node, ast.Slice):
            return slice(e(node.lower) if node.lower else None, e(node.upper) if node.upper else None, e(node.step) if node.step else None)
        if isinstance(node, ast.Attribute) and isinstance(e(node.value), Receipt):
            raw = e(node.value).value
            if node.attr not in ('returncode', 'stdout', 'stderr'):
                raise Gap('uncaptured process attribute: ' + node.attr)
            return raw['exit' if node.attr == 'returncode' else node.attr]
        if isinstance(node, ast.UnaryOp):
            fn = {ast.Not: operator.not_, ast.USub: operator.neg, ast.UAdd: operator.pos}.get(type(node.op))
            if fn:
                return fn(e(node.operand))
        if isinstance(node, ast.BinOp):
            fn = {ast.Add: operator.add, ast.Sub: operator.sub, ast.Mult: operator.mul, ast.Div: operator.truediv}.get(type(node.op))
            if fn:
                return fn(e(node.left), e(node.right))
        if isinstance(node, ast.BoolOp):
            # Evaluate every operand: short circuit must not hide a missing required field.
            values = [e(n) for n in node.values]
            return all(values) if isinstance(node.op, ast.And) else any(values)
        if isinstance(node, ast.Compare):
            left = e(node.left)
            answers = []
            for op, right_node in zip(node.ops, node.comparators):
                right = e(right_node)
                if isinstance(op, (ast.Eq, ast.NotEq)):
                    equal = left == right if isinstance(left, (set, bytes)) or isinstance(right, (set, bytes)) else exact(left, right)
                    answers.append(equal if isinstance(op, ast.Eq) else not equal)
                elif isinstance(op, ast.Is):
                    answers.append(left is right)
                elif isinstance(op, ast.IsNot):
                    answers.append(left is not right)
                else:
                    fn = {ast.Lt: operator.lt, ast.LtE: operator.le, ast.Gt: operator.gt, ast.GtE: operator.ge, ast.In: lambda a, b: a in b, ast.NotIn: lambda a, b: a not in b}.get(type(op))
                    if not fn:
                        raise Gap('unsupported comparison: ' + type(op).__name__)
                    answers.append(fn(left, right))
                left = right
            return all(answers)
        if isinstance(node, (ast.ListComp, ast.SetComp, ast.GeneratorExp, ast.DictComp)):
            def walk(generators, scope):
                if not generators:
                    yield scope
                    return
                gen, *rest = generators
                if not isinstance(gen.target, ast.Name):
                    raise Gap('uncaptured destructuring comprehension')
                for item in self.expr(gen.iter, scope):
                    child = {**scope, gen.target.id: item}
                    if all(self.expr(v, child) for v in gen.ifs):
                        yield from walk(rest, child)
            scopes = walk(node.generators, env)
            if isinstance(node, ast.DictComp):
                return {self.expr(node.key, s): self.expr(node.value, s) for s in scopes}
            values = [self.expr(node.elt, s) for s in scopes]
            return set(values) if isinstance(node, ast.SetComp) else values
        if isinstance(node, ast.Call):
            args = [e(n) for n in node.args]
            require_no_keywords = not node.keywords
            if not require_no_keywords:
                raise Gap('unsupported keyword call')
            if isinstance(node.func, ast.Name):
                functions = {'len': len, 'all': all, 'any': any, 'list': list, 'reversed': lambda x: list(reversed(x)), 'str': str, 'bytes': bytes, 'sorted': sorted, 'range': lambda *x: list(range(*x))}
                if node.func.id in functions:
                    return functions[node.func.id](*args)
            if isinstance(node.func, ast.Attribute):
                if isinstance(node.func.value, ast.Name) and node.func.value.id == 'json' and node.func.attr == 'loads':
                    return json.loads(*args)
                value = e(node.func.value)
                if node.func.attr == 'get' and isinstance(value, dict):
                    return value.get(*args)
                if node.func.attr == 'encode' and isinstance(value, str):
                    return value.encode(*args)
                if node.func.attr == 'strip' and isinstance(value, str):
                    return value.strip(*args)
                if node.func.attr == 'split' and isinstance(value, str):
                    return value.split(*args)
        raise Gap('source expression needs uncaptured observation or explicit semantic adapter: ' + ast.unparse(node))
