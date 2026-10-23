"""Regenerate only this checker's fixed-source assertion inventory after review."""
import argparse
import ast
import hashlib
from pathlib import Path
import pprint


def inventory(root):
    catalog = {}
    for p in sorted(root.glob('*e2e.py')):
        source = p.read_text()
        tree = ast.parse(source)
        parents = {child: node for node in ast.walk(tree) for child in ast.iter_child_nodes(node)}
        rows = []
        for node in sorted((n for n in ast.walk(tree) if isinstance(n, ast.Assert)), key=lambda n: (n.lineno, n.col_offset)):
            loops = []
            parent = parents.get(node)
            while parent:
                if isinstance(parent, ast.For) and isinstance(parent.target, ast.Name):
                    try:
                        values = ast.literal_eval(parent.iter)
                    except (ValueError, TypeError):
                        values = None
                    loops.append({'binding': parent.target.id, 'values': values, 'source': ast.unparse(parent.iter)})
                parent = parents.get(parent)
            rows.append({'id': p.stem + ':L' + str(node.lineno) + 'C' + str(node.col_offset), 'line': node.lineno,
                         'column': node.col_offset, 'expression': ast.get_source_segment(source, node.test), 'loops': loops})
        catalog[p.stem] = {'source': 'crates/hrc-store/e2e/' + p.name, 'sha256': hashlib.sha256(p.read_bytes()).hexdigest(), 'assertions': rows}
    return catalog


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--write', action='store_true')
    a = p.parse_args()
    current = inventory(Path(__file__).resolve().parents[1])
    if a.write:
        Path(__file__).with_name('catalog.py').write_text('"""Fixed source assertion inventory; source flags are never behavior proof."""\nCATALOG = ' + pprint.pformat(current, width=120, sort_dicts=False) + '\n')
    else:
        from catalog import CATALOG
        if current != CATALOG:
            raise SystemExit('fixed source inventory drift: review source and semantic adapters, then inventory.py --write')
        print('fixed source assertions and source digests match')
