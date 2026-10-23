#!/usr/bin/env python3
"""Behavior-first red controls for the independent assertions; no product qualification."""
import copy
from assertions import EvidenceError, archive_evidence, capture_evidence, drained, export_evidence, prune_report


def run():
    results = []
    def rejected(name, fn):
        try:
            fn()
        except (EvidenceError, KeyError, TypeError, ValueError):
            results.append(name)
        else:
            raise AssertionError('control accepted inadequate evidence: ' + name)
    rejected('export-empty', lambda: export_evidence({}, {}, [], 9))
    rejected('capture-empty', lambda: capture_evidence({}, {}, [], []))
    rejected('capture-inconclusive', lambda: capture_evidence({'status': 'inconclusive', 'ok': True}, {}, [{}], [{}]))
    rejected('archive-empty', lambda: archive_evidence([], []))
    row = {k: 'x' for k in ('ts', 'host_session_id', 'scope_ref', 'lane_ref', 'run_id', 'runtime_id', 'source', 'event_kind', 'event_json')}
    row.update(seq=1, generation=1, stream_seq=1)
    archive_evidence([row], [row])
    wrong = copy.deepcopy(row); wrong['event_json'] = '{"wrong":true}'
    rejected('archive-same-seq-wrong-payload', lambda: archive_evidence([row], [wrong]))
    rejected('maintenance-empty', lambda: drained({'stopReason': 'complete'}, 0))
    rejected('maintenance-busy-exit0', lambda: drained({'stopReason': 'busy'}, 3))
    rejected('maintenance-deadline-exit0', lambda: drained({'stopReason': 'deadline'}, 3))
    rejected('maintenance-missing-report', lambda: prune_report({'exit': 0, 'stdout': '{}'}))
    rejected('maintenance-truncated-report', lambda: prune_report({'exit': 0, 'stdout': '{"event":"prune.report"'}))
    return results


if __name__ == '__main__':
    import json
    print(json.dumps({'claim': 'checker-controls-only', 'rejected': run()}))
