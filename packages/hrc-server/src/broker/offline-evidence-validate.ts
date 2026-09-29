/** T-08566 stage 2 — whole-page validation of the reader's output (SPEC §3.4.4). */

import { type InvocationEventEnvelope, validateEventEnvelope } from 'spaces-harness-broker-protocol'

import { OFFLINE_EVIDENCE_SCHEMA } from './offline-evidence-outcomes'

// ── page validation ───────────────────────────────────────────────────────────
//
// Whole-response validation of the owning release's `evidence-read` output for
// `eventsSince` (harness-broker.offline-evidence/v1, as emitted by
// harness-broker `offline-evidence.ts` writeResponse/writeFailure). Both arms are
// validated completely before any mapper call; anything outside the producer's
// wire shape is `reader_contract_violation`, never an outcome it names.

export type ReleaseIdentity = { releaseId: string; sourceCommit: string; builtAt: string }

/** Typed error codes the producer emits on the `eventsSince` path. */
const EVENTS_SINCE_ERROR_CODES: ReadonlySet<string> = new Set([
  'invalid_request',
  'offline_schema_unsupported',
  'ledger_unavailable',
  'ledger_index_unavailable',
  'ledger_corrupt',
  'ledger_conflicting_duplicate',
  'ledger_snapshot_unstable',
  'offline_record_too_large',
  'replay_below_floor',
])

function sameRelease(value: unknown, expected: ReleaseIdentity): boolean {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return (
    record['releaseId'] === expected.releaseId &&
    record['sourceCommit'] === expected.sourceCommit &&
    record['builtAt'] === expected.builtAt
  )
}

function isSafeSeq(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Closed member check: every key is known and every required key is present. */
function closedMembers(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = []
): string | undefined {
  for (const key of required) {
    if (!Object.hasOwn(value, key)) return `missing:${key}`
  }
  for (const key of Object.keys(value)) {
    if (!required.includes(key) && !optional.includes(key)) return `unknown:${key}`
  }
  return undefined
}

function fileIdentityViolation(value: unknown): string | undefined {
  if (!isPlainRecord(value)) return 'not_object'
  const members = closedMembers(value, ['ino', 'size', 'mtimeMs'])
  if (members !== undefined) return members
  for (const key of ['ino', 'size', 'mtimeMs']) {
    if (typeof value[key] !== 'number' || !Number.isFinite(value[key])) return `${key}_not_number`
  }
  return undefined
}

function snapshotViolation(value: unknown): string | undefined {
  if (!isPlainRecord(value)) return 'snapshot:not_object'
  const members = closedMembers(value, ['ledger', 'index'])
  if (members !== undefined) return `snapshot:${members}`
  const ledger = fileIdentityViolation(value['ledger'])
  if (ledger !== undefined) return `snapshot.ledger:${ledger}`
  const index = value['index']
  if (!isPlainRecord(index)) return 'snapshot.index:not_object'
  const indexMembers = closedMembers(index, ['db'], ['wal'])
  if (indexMembers !== undefined) return `snapshot.index:${indexMembers}`
  const db = fileIdentityViolation(index['db'])
  if (db !== undefined) return `snapshot.index.db:${db}`
  if (index['wal'] !== undefined) {
    const wal = fileIdentityViolation(index['wal'])
    if (wal !== undefined) return `snapshot.index.wal:${wal}`
  }
  return undefined
}

function integrityViolation(value: unknown): string | undefined {
  if (!isPlainRecord(value)) return 'integrity:not_object'
  if (value['status'] === 'intact') {
    const members = closedMembers(value, ['status', 'byteLength'])
    if (members !== undefined) return `integrity:${members}`
    if (!isSafeSeq(value['byteLength'])) return 'integrity.byteLength'
    return undefined
  }
  if (value['status'] === 'torn_tail') {
    const members = closedMembers(
      value,
      ['status', 'byteLength', 'lastIntactByteOffset', 'trailingBytes'],
      ['lastIntact']
    )
    if (members !== undefined) return `integrity:${members}`
    for (const key of ['byteLength', 'lastIntactByteOffset', 'trailingBytes']) {
      if (!isSafeSeq(value[key])) return `integrity.${key}`
    }
    const lastIntact = value['lastIntact']
    if (lastIntact !== undefined) {
      if (!isPlainRecord(lastIntact)) return 'integrity.lastIntact:not_object'
      const intactMembers = closedMembers(lastIntact, ['invocationId', 'seq'])
      if (intactMembers !== undefined) return `integrity.lastIntact:${intactMembers}`
      if (typeof lastIntact['invocationId'] !== 'string' || lastIntact['invocationId'] === '') {
        return 'integrity.lastIntact.invocationId'
      }
      if (!isSafeSeq(lastIntact['seq']) || lastIntact['seq'] === 0)
        return 'integrity.lastIntact.seq'
    }
    return undefined
  }
  return 'integrity.status'
}

export type ValidPage = {
  events: InvocationEventEnvelope[]
  currentSeq: number
  retentionFloorSeq: number
  hasMore: boolean
  nextAfterSeq: number
  snapshot: Record<string, unknown>
  integrity: Record<string, unknown>
}

export type PageVerdict =
  | { ok: true; page: ValidPage }
  | { ok: false; outcome: string; detail: Record<string, unknown> }

function contractViolation(
  why: string,
  extra: Record<string, unknown> = {}
): PageVerdict & {
  ok: false
} {
  return { ok: false, outcome: 'reader_contract_violation', detail: { violation: why, ...extra } }
}

/** Success arm (reader exit 0). */
export function validateOfflineEvidencePage(
  response: Record<string, unknown>,
  expected: ReleaseIdentity,
  invocationId: string,
  afterSeq: number
): PageVerdict {
  const violation = contractViolation
  if (response['schema'] !== OFFLINE_EVIDENCE_SCHEMA) return violation('schema')
  if (!sameRelease(response['release'], expected)) {
    return {
      ok: false,
      outcome: 'reader_release_mismatch',
      detail: { expected, embedded: response['release'] ?? null },
    }
  }
  if (response['ok'] !== true)
    return violation('ok_not_true_on_success_exit', { ok: response['ok'] ?? null })
  if (response['operation'] !== 'eventsSince') {
    return violation('operation', { operation: response['operation'] ?? null })
  }
  const topMembers = closedMembers(response, [
    'schema',
    'ok',
    'operation',
    'release',
    'result',
    'hasMore',
    'nextAfterSeq',
    'snapshot',
    'integrity',
  ])
  if (topMembers !== undefined) return violation('response_members', { members: topMembers })
  const releaseMembers = closedMembers(response['release'] as Record<string, unknown>, [
    'releaseId',
    'sourceCommit',
    'builtAt',
  ])
  if (releaseMembers !== undefined) return violation('release_members', { members: releaseMembers })
  const result = response['result']
  if (!isPlainRecord(result)) return violation('result')
  const resultMembers = closedMembers(
    result,
    ['events', 'currentSeq', 'retentionFloorSeq'],
    ['liveStreamAttached']
  )
  if (resultMembers !== undefined) return violation('result_members', { members: resultMembers })
  if (
    result['liveStreamAttached'] !== undefined &&
    typeof result['liveStreamAttached'] !== 'boolean'
  ) {
    return violation('result.liveStreamAttached')
  }
  const currentSeq = result['currentSeq']
  const retentionFloorSeq = result['retentionFloorSeq']
  const nextAfterSeq = response['nextAfterSeq']
  const hasMore = response['hasMore']
  const events = result['events']
  if (
    !isSafeSeq(currentSeq) ||
    !isSafeSeq(retentionFloorSeq) ||
    !isSafeSeq(nextAfterSeq) ||
    typeof hasMore !== 'boolean'
  ) {
    return violation('page_fields')
  }
  if (!Array.isArray(events)) return violation('events')
  const snapshotProblem = snapshotViolation(response['snapshot'])
  if (snapshotProblem !== undefined) return violation('snapshot', { problem: snapshotProblem })
  const integrityProblem = integrityViolation(response['integrity'])
  if (integrityProblem !== undefined) return violation('integrity', { problem: integrityProblem })
  // Producer: currentSeq = max(last row seq, retentionFloorSeq).
  if (currentSeq < retentionFloorSeq) {
    return violation('current_seq_below_floor', { currentSeq, retentionFloorSeq })
  }
  // Astra EN-13678: HRC's committed prefix is not in the answered ledger. An HRC
  // admission classification, not a producer contract claim.
  if (afterSeq > currentSeq) {
    return {
      ok: false,
      outcome: 'reader_contract_violation',
      detail: {
        violation: 'cursor_above_current_seq',
        requestedAfterSeq: afterSeq,
        currentSeq,
        nextAfterSeq,
      },
    }
  }
  // Producer: a cursor below the floor answers replay_below_floor, never a page.
  if (afterSeq < retentionFloorSeq) {
    return violation('page_below_floor', { afterSeq, retentionFloorSeq })
  }
  const validated: InvocationEventEnvelope[] = []
  let expectedSeq = afterSeq + 1
  for (const raw of events) {
    let envelope: InvocationEventEnvelope
    try {
      envelope = validateEventEnvelope(raw)
    } catch (error) {
      return violation('invalid_envelope', {
        seq: expectedSeq,
        error: error instanceof Error ? error.message : String(error),
      })
    }
    if (String(envelope.invocationId) !== invocationId) {
      return violation('foreign_invocation', { seq: envelope.seq })
    }
    if (envelope.seq !== expectedSeq) {
      return violation('non_contiguous_seq', { expectedSeq, seq: envelope.seq })
    }
    if (envelope.seq > currentSeq) {
      return violation('event_beyond_current_seq', { seq: envelope.seq, currentSeq })
    }
    validated.push(envelope)
    expectedSeq += 1
  }
  // Producer: hasMore is true only after at least one event was selected and a
  // later candidate remains, so the page advances and stops short of currentSeq.
  if (
    hasMore &&
    (validated.length === 0 || nextAfterSeq <= afterSeq || nextAfterSeq >= currentSeq)
  ) {
    return violation('non_progressing_page', {
      afterSeq,
      nextAfterSeq,
      currentSeq,
      events: validated.length,
    })
  }
  const lastSeq = validated.at(-1)?.seq ?? afterSeq
  if (nextAfterSeq !== lastSeq) {
    return violation('next_after_seq_mismatch', { afterSeq, nextAfterSeq, lastSeq })
  }
  // Producer: with no later candidate the page ends at the last row, and
  // currentSeq = max(last row, floor) with floor <= afterSeq, so the final page
  // cursor equals currentSeq (cursor-above is classified above).
  if (!hasMore && nextAfterSeq !== currentSeq) {
    return violation('final_page_cursor_mismatch', { afterSeq, nextAfterSeq, currentSeq })
  }
  return {
    ok: true,
    page: {
      events: validated,
      currentSeq,
      retentionFloorSeq,
      hasMore,
      nextAfterSeq,
      snapshot: response['snapshot'] as Record<string, unknown>,
      integrity: response['integrity'] as Record<string, unknown>,
    },
  }
}

export type TypedErrorVerdict =
  | { ok: true; code: string; error: Record<string, unknown> }
  | { ok: false; outcome: string; detail: Record<string, unknown> }

/** Typed-error arm (reader exit 2). */
export function validateOfflineEvidenceTypedError(
  response: Record<string, unknown>,
  expected: ReleaseIdentity
): TypedErrorVerdict {
  const violation = contractViolation
  if (response['schema'] !== OFFLINE_EVIDENCE_SCHEMA) return violation('schema')
  if (response['release'] !== undefined && !sameRelease(response['release'], expected)) {
    return {
      ok: false,
      outcome: 'reader_release_mismatch',
      detail: { expected, embedded: response['release'] },
    }
  }
  if (response['ok'] !== false) {
    return violation('ok_not_false_on_typed_exit', { ok: response['ok'] ?? null })
  }
  const members = closedMembers(response, ['schema', 'ok', 'error'], ['operation', 'release'])
  if (members !== undefined) return violation('response_members', { members })
  // HRC only ever requests eventsSince; the producer echoes the request operation.
  if (response['operation'] !== undefined && response['operation'] !== 'eventsSince') {
    return violation('operation', { operation: response['operation'] })
  }
  if (response['release'] !== undefined) {
    const releaseMembers = closedMembers(response['release'] as Record<string, unknown>, [
      'releaseId',
      'sourceCommit',
      'builtAt',
    ])
    if (releaseMembers !== undefined) {
      return violation('release_members', { members: releaseMembers })
    }
  }
  const error = response['error']
  if (!isPlainRecord(error)) return violation('typed_error_without_code')
  const errorMembers = closedMembers(error, ['code', 'message'], ['data'])
  if (errorMembers !== undefined) return violation('error_members', { members: errorMembers })
  if (typeof error['code'] !== 'string') return violation('typed_error_without_code')
  if (!EVENTS_SINCE_ERROR_CODES.has(error['code'])) {
    return violation('typed_error_code_unsupported', { errorCode: error['code'] })
  }
  if (typeof error['message'] !== 'string') return violation('error.message')
  if (error['data'] !== undefined && !isPlainRecord(error['data'])) return violation('error.data')
  return { ok: true, code: error['code'], error }
}
