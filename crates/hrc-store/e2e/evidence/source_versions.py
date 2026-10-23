"""Explicit reviewed source variants; caller pins select, retained bytes prove.

The historical catalog is immutable. A reviewed new assertion record is source
metadata only, never proof that the new producer scenario actually executed.
"""
from catalog import CATALOG

NEW_SERIALIZATION = {'source': 'crates/hrc-store/e2e/serialization_e2e.py',
 'sha256': 'ef7a586fd70bc66c251ff105a8e748f6798fa9eef2a7db738f7a49eba0834797',
 'assertions': [{'id': 'serialization_e2e:L7C71',
                 'line': 7,
                 'column': 71,
                 'expression': 'seed.returncode==0',
                 'loops': []},
                {'id': 'serialization_e2e:L9C115',
                 'line': 9,
                 'column': 115,
                 'expression': 'n.returncode==0',
                 'loops': []},
                {'id': 'serialization_e2e:L11C128',
                 'line': 11,
                 'column': 128,
                 'expression': 'bun.returncode==0',
                 'loops': []},
                {'id': 'serialization_e2e:L13C4',
                 'line': 13,
                 'column': 4,
                 'expression': "b['numericIdempotent'] is True",
                 'loops': []},
                {'id': 'serialization_e2e:L14C4',
                 'line': 14,
                 'column': 4,
                 'expression': "b['storedNumeric']==b['expectedNumeric']",
                 'loops': []},
                {'id': 'serialization_e2e:L15C4',
                 'line': 15,
                 'column': 4,
                 'expression': "b['storedSpill']==b['expectedSpill']",
                 'loops': []},
                {'id': 'serialization_e2e:L20C8',
                 'line': 20,
                 'column': 8,
                 'expression': 'result.returncode==0',
                 'loops': []},
                {'id': 'serialization_e2e:L23C4',
                 'line': 23,
                 'column': 4,
                 'expression': "written['repeat'] and written['conflictRefused'] and written['spillRepeat']",
                 'loops': []},
                {'id': 'serialization_e2e:L24C4',
                 'line': 24,
                 'column': 4,
                 'expression': "written['expectedDiagnostic']==written['storedDiagnostic']",
                 'loops': []},
                {'id': 'serialization_e2e:L27C4',
                 'line': 27,
                 'column': 4,
                 'expression': 'native==control',
                 'loops': []},
                {'id': 'serialization_e2e:L30C4',
                 'line': 30,
                 'column': 4,
                 'expression': "len(head.encode('utf-16-le','surrogatepass'))//2==4095",
                 'loops': []},
                {'id': 'serialization_e2e:L31C4',
                 'line': 31,
                 'column': 4,
                 'expression': 'not '
                               "0xd800<=int.from_bytes(head.encode('utf-16-le','surrogatepass')[-2:],'little')<=0xdbff",
                 'loops': []},
                {'id': 'serialization_e2e:L32C4',
                 'line': 32,
                 'column': 4,
                 'expression': "native['hydrated']['payload']['result']=='X'+'🫠'*20000",
                 'loops': []}]}

REVIEWED = {family: {record['sha256']: record} for family, record in CATALOG.items()}
REVIEWED['serialization_e2e'][NEW_SERIALIZATION['sha256']] = NEW_SERIALIZATION


def select(expected_identity):
    pins = expected_identity.get('sources', {}) if isinstance(expected_identity, dict) else {}
    if not isinstance(pins, dict):
        pins = {}
    return {family: variants.get(pins[family]) if isinstance(pins.get(family), str) else None
            for family, variants in REVIEWED.items()}
