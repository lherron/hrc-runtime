import { lifecycleKindForBrokerEvent } from 'hrc-core'
import {
  type BrokerCaptureEvent,
  type BrokerInvocationCapture,
  CAPTURE_VERIFIER_SCHEMA,
  type CaptureVerificationAnalytics,
  type CaptureVerificationFinding,
  type CaptureVerificationReport,
  type InvocationCaptureSnapshot,
  type LifecycleCheck,
} from './types.js'
import { lifecycleKey } from './verifier-normalize.js'

export type LedgerCheckResult = {
  ledger: CaptureVerificationReport['ledger']
  analytics: CaptureVerificationAnalytics['brokerLedger']
}

export function checkLedger(
  invocation: BrokerInvocationCapture,
  events: BrokerCaptureEvent[],
  findings: CaptureVerificationFinding[]
): LedgerCheckResult {
  const statuses: Record<string, number> = {}
  const eventsByType: Record<string, number> = {}
  let previousSeq: number | undefined
  const seen = new Set<number>()
  let seqHoleCount = 0
  let duplicateSeqCount = 0
  let runtimeIdentityMismatchCount = 0
  let runDivergenceWarningCount = 0
  let staleGenerationCount = 0
  let staleAttemptCount = 0

  for (const row of events) {
    statuses[row.projectionStatus] = (statuses[row.projectionStatus] ?? 0) + 1
    eventsByType[row.type] = (eventsByType[row.type] ?? 0) + 1
    if (row.runtimeId !== invocation.runtimeId) {
      runtimeIdentityMismatchCount += 1
      findings.push({
        schema: CAPTURE_VERIFIER_SCHEMA,
        severity: 'error',
        layer: 'broker-ledger',
        code: 'runtime_identity_mismatch',
        message: `broker seq ${row.seq} runtime_id ${row.runtimeId} does not match invocation runtime ${invocation.runtimeId}`,
        brokerSeq: row.seq,
        type: row.type,
      })
    }
    if (
      invocation.runId !== undefined &&
      row.runId !== undefined &&
      row.runId !== invocation.runId
    ) {
      runDivergenceWarningCount += 1
      findings.push({
        schema: CAPTURE_VERIFIER_SCHEMA,
        severity: 'warning',
        layer: 'broker-ledger',
        code: 'run_identity_differs_from_current_invocation',
        message: `broker seq ${row.seq} run_id ${row.runId} differs from current invocation run ${invocation.runId}; this is valid for prior turns in a multi-turn invocation`,
        brokerSeq: row.seq,
        type: row.type,
      })
    }
    if (row.projectionStatus !== 'applied') {
      findings.push({
        schema: CAPTURE_VERIFIER_SCHEMA,
        severity: 'error',
        layer: 'broker-ledger',
        code: 'projection_not_applied',
        message: `broker seq ${row.seq} projection_status is ${row.projectionStatus}`,
        brokerSeq: row.seq,
        type: row.type,
      })
    }
    if (seen.has(row.seq)) {
      duplicateSeqCount += 1
      findings.push({
        schema: CAPTURE_VERIFIER_SCHEMA,
        severity: 'error',
        layer: 'broker-ledger',
        code: 'duplicate_seq',
        message: `broker seq ${row.seq} appears more than once in query result`,
        brokerSeq: row.seq,
        type: row.type,
      })
    }
    seen.add(row.seq)
    if (previousSeq !== undefined && row.seq > previousSeq + 1) {
      seqHoleCount += 1
      findings.push({
        schema: CAPTURE_VERIFIER_SCHEMA,
        severity: 'error',
        layer: 'broker-ledger',
        code: 'seq_hole',
        message: `broker seq jumps from ${previousSeq} to ${row.seq}`,
        brokerSeq: row.seq,
        type: row.type,
      })
    }
    if (
      invocation.currentHarnessGeneration !== undefined &&
      row.harnessGeneration !== undefined &&
      row.harnessGeneration !== invocation.currentHarnessGeneration
    ) {
      staleGenerationCount += 1
    }
    if (
      invocation.currentTurnAttempt !== undefined &&
      row.turnAttempt !== undefined &&
      row.turnAttempt !== invocation.currentTurnAttempt
    ) {
      staleAttemptCount += 1
    }
    previousSeq = row.seq
  }

  const last = events.at(-1)
  const ledger = {
    eventCount: events.length,
    ...(events[0] !== undefined ? { firstSeq: events[0].seq } : {}),
    ...(last !== undefined ? { lastSeq: last.seq } : {}),
    statuses,
  }
  return {
    ledger,
    analytics: {
      invocationId: invocation.invocationId,
      eventCount: events.length,
      ...(events[0] !== undefined ? { firstSeq: events[0].seq } : {}),
      ...(last !== undefined ? { lastSeq: last.seq } : {}),
      seqHoleCount,
      duplicateSeqCount,
      statuses,
      eventsByType,
      runtimeIdentityMismatchCount,
      runDivergenceWarningCount,
      staleGenerationCount,
      staleAttemptCount,
    },
  }
}

export function checkLifecycle(
  snapshot: InvocationCaptureSnapshot,
  findings: CaptureVerificationFinding[]
): LifecycleCheck[] {
  const out: LifecycleCheck[] = []
  for (const row of snapshot.brokerEvents) {
    const lifecycleKind = lifecycleKindForBrokerEvent(row.type)
    if (lifecycleKind === undefined) {
      out.push({ brokerSeq: row.seq, brokerType: row.type, status: 'not_applicable' })
      continue
    }
    if (isSuppressedLifecycleProjection(snapshot.invocation, row)) {
      out.push({
        brokerSeq: row.seq,
        brokerType: row.type,
        lifecycleKind,
        status: 'suppressed',
      })
      continue
    }
    const lifecycle = snapshot.lifecycleProjections[lifecycleKey(row, lifecycleKind)]?.[0]
    if (lifecycle === undefined) {
      out.push({
        brokerSeq: row.seq,
        brokerType: row.type,
        lifecycleKind,
        status: 'missing',
      })
      findings.push({
        schema: CAPTURE_VERIFIER_SCHEMA,
        severity: 'warning',
        layer: 'lifecycle',
        code: 'lifecycle_projection_missing',
        message: `broker seq ${row.seq} ${row.type} has no matching ${lifecycleKind} lifecycle projection`,
        brokerSeq: row.seq,
        type: row.type,
      })
      continue
    }
    out.push({
      brokerSeq: row.seq,
      brokerType: row.type,
      lifecycleKind,
      status: 'present',
      hrcSeq: lifecycle.hrcSeq,
    })
  }
  return out
}

export function isSuppressedLifecycleProjection(
  invocation: BrokerInvocationCapture,
  row: BrokerCaptureEvent
): boolean {
  return (
    (invocation.currentHarnessGeneration !== undefined &&
      row.harnessGeneration !== undefined &&
      row.harnessGeneration !== invocation.currentHarnessGeneration) ||
    (invocation.currentTurnAttempt !== undefined &&
      row.turnAttempt !== undefined &&
      row.turnAttempt !== invocation.currentTurnAttempt)
  )
}
