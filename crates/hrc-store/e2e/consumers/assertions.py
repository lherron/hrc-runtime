"""Independent evidence predicates. No fixture PASS flags are accepted."""
import json


class EvidenceError(AssertionError):
    pass


def require(value, reason):
    if not value:
        raise EvidenceError(reason)


def export_evidence(body, run, rows, global_head):
    require(bool(run) and bool(rows), 'nonempty selected run/events required')
    seqs = [r['hrc_seq'] for r in rows]
    require(min(seqs) > 0 and global_head > max(seqs), 'unrelated global-head control required')
    require(body['kind'] == 'hrc.invocation_exposure.v1', 'export kind')
    require(body['externalRunRef'] == 'hrc:' + run['run_id'], 'external run identity')
    fields = [('runId', 'run_id'), ('runtimeId', 'runtime_id'), ('hostSessionId', 'host_session_id'),
              ('scopeRef', 'scope_ref'), ('laneRef', 'lane_ref'), ('generation', 'generation'),
              ('transport', 'transport'), ('status', 'status'), ('acceptedAt', 'accepted_at'),
              ('startedAt', 'started_at'), ('completedAt', 'completed_at'), ('updatedAt', 'updated_at'),
              ('errorCode', 'error_code'), ('errorMessage', 'error_message'),
              ('operationId', 'operation_id'), ('invocationId', 'invocation_id')]
    expected = {wire: run[column] for wire, column in fields if run[column] is not None}
    require(body['run'] == expected, 'complete run fields, values and optional presence')
    require(body['session']['sessionRef'] == run['scope_ref'] + '/lane:' + run['lane_ref'], 'session reference')
    require(body['cursors'] == {'eventHighWaterSeq': max(seqs), 'eventsFromSeq': min(seqs)}, 'per-run cursors')


def capture_evidence(body, invocation, events, lifecycle, artifact=True):
    require(bool(events) and bool(lifecycle), 'nonempty capture history required')
    require(body['status'] == 'pass' and body['ok'] is True, 'capture must be pass, not inconclusive')
    for key, column in [('invocationId', 'invocation_id'), ('runtimeId', 'runtime_id'), ('runId', 'run_id')]:
        require(body[key] == invocation[column], 'capture identity: ' + key)
    n = len(events)
    require(body['ledger']['eventCount'] == n > 0, 'nonempty ledger count')
    require(body['ledger']['firstSeq'] == min(e['seq'] for e in events), 'first sequence')
    require(body['ledger']['lastSeq'] == max(e['seq'] for e in events), 'last sequence')
    require(body['rawMirror']['checked'] == body['rawMirror']['matched'] == n, 'all mirrors checked and matched')
    require(bool(body['lifecycle']) and all(x['status'] == 'present' for x in body['lifecycle']), 'all mapped lifecycle present')
    if artifact:
        require(body['transcriptArtifact']['hashStatus'] == 'matched', 'artifact hash fidelity')
        require(bool(body['providerMatches']), 'nonempty provider comparisons')


def archive_evidence(expected, actual):
    require(bool(expected), 'nonempty archive source required')
    columns = ('seq', 'ts', 'host_session_id', 'scope_ref', 'lane_ref', 'generation',
               'run_id', 'runtime_id', 'source', 'event_kind', 'event_json', 'stream_seq')
    def project(rows):
        return sorted([tuple(r[c] for c in columns) for r in rows], key=lambda r: r[0])
    require(project(expected) == project(actual), 'archive exact full-row fidelity')


def prune_report(command):
    require(command['exit'] == 0, 'maintenance process error')
    records = []
    for line in command['stdout'].splitlines():
        try:
            records.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    require(not any(r.get('event') == 'prune.failed' for r in records), 'prune.failed')
    reports = [r['data'] for r in records if r.get('event') == 'prune.report']
    require(len(reports) == 1, 'exactly one structured prune.report required')
    return reports[0]


def drained(report, effect):
    require(report['stopReason'] == 'complete', 'partial/busy/deadline is not complete')
    require(effect > 0, 'nonzero maintenance effect required')
