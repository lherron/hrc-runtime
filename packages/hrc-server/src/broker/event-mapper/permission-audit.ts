/**
 * Permission audit projection for the BrokerEventMapper.
 *
 * Extracted verbatim from event-mapper.ts as a pure mechanical move. Records the
 * authoritative `permission_decisions` row on resolution/cancellation, recovering
 * the originating `permission.requested` context from prior broker event rows.
 */
import type { HrcDatabase } from 'hrc-store-sqlite'
import type {
  InvocationEventEnvelope,
  PermissionCancelledPayload,
  PermissionRequestedPayload,
  PermissionResolvedPayload,
} from 'spaces-harness-broker-protocol'

import { type ProjectionContext, permissionIdentityKey } from './helpers'

export function auditPermissionResolved(
  db: HrcDatabase,
  envelope: InvocationEventEnvelope,
  ctx: ProjectionContext,
  now: string,
  stale: boolean
): void {
  const payload = envelope.payload as PermissionResolvedPayload
  const identityKey = permissionIdentityKey({
    invocationId: envelope.invocationId,
    harnessGeneration: envelope.harnessGeneration,
    turnAttempt: envelope.turnAttempt,
    permissionRequestId: payload.permissionRequestId,
  })
  if (db.permissionDecisions.getByPermissionIdentityKey(identityKey)) {
    return
  }
  const requested = findRequestedPayload(db, envelope.invocationId, payload.permissionRequestId)
  db.permissionDecisions.insert({
    permissionIdentityKey: identityKey,
    permissionRequestId: payload.permissionRequestId,
    invocationId: envelope.invocationId,
    ...(envelope.harnessGeneration !== undefined
      ? { harnessGeneration: envelope.harnessGeneration }
      : {}),
    ...(envelope.turnAttempt !== undefined ? { turnAttempt: envelope.turnAttempt } : {}),
    runtimeId: ctx.runtimeId,
    ...(ctx.runId !== undefined ? { runId: ctx.runId } : {}),
    kind: requested?.payload.kind ?? 'unknown',
    subjectDisplayJson: JSON.stringify(requested?.payload.subjectDisplay ?? null),
    defaultDecision: requested?.payload.defaultDecision ?? 'deny',
    decision: payload.decision,
    decidedBy: payload.decidedBy,
    policyJson: JSON.stringify({
      ...(payload.message !== undefined ? { message: payload.message } : {}),
      ...(stale ? { stale: true } : {}),
    }),
    requestedAt: requested?.time ?? now,
    decidedAt: now,
  })
}

export function auditPermissionCancelled(
  db: HrcDatabase,
  envelope: InvocationEventEnvelope,
  ctx: ProjectionContext,
  now: string,
  stale: boolean
): void {
  const payload = envelope.payload as PermissionCancelledPayload
  const identityKey = permissionIdentityKey({
    invocationId: envelope.invocationId,
    harnessGeneration: envelope.harnessGeneration ?? payload.harnessGeneration,
    turnAttempt: envelope.turnAttempt ?? payload.turnAttempt,
    permissionRequestId: payload.permissionRequestId,
  })
  if (db.permissionDecisions.getByPermissionIdentityKey(identityKey)) {
    return
  }
  const requested = findRequestedPayload(db, envelope.invocationId, payload.permissionRequestId)
  const harnessGeneration = envelope.harnessGeneration ?? payload.harnessGeneration
  const turnAttempt = envelope.turnAttempt ?? payload.turnAttempt
  const defaultDecision = requested?.payload.defaultDecision ?? 'deny'
  db.permissionDecisions.insert({
    permissionIdentityKey: identityKey,
    permissionRequestId: payload.permissionRequestId,
    invocationId: envelope.invocationId,
    ...(harnessGeneration !== undefined ? { harnessGeneration } : {}),
    ...(turnAttempt !== undefined ? { turnAttempt } : {}),
    runtimeId: ctx.runtimeId,
    ...(ctx.runId !== undefined ? { runId: ctx.runId } : {}),
    kind: requested?.payload.kind ?? 'unknown',
    subjectDisplayJson: JSON.stringify(requested?.payload.subjectDisplay ?? null),
    defaultDecision,
    decision: defaultDecision,
    decidedBy: 'policy',
    policyJson: JSON.stringify({
      cancelled: true,
      reason: payload.reason,
      ...(stale ? { stale: true } : {}),
    }),
    requestedAt: requested?.time ?? now,
    decidedAt: now,
  })
}

/**
 * Recover the originating `permission.requested` payload (kind / subjectDisplay
 * / defaultDecision) persisted on a prior event so the authoritative decision
 * row carries the full request context.
 */
function findRequestedPayload(
  db: HrcDatabase,
  invocationId: string,
  permissionRequestId: string
): { payload: PermissionRequestedPayload; time: string } | undefined {
  const rows = db.brokerInvocationEvents.listByInvocationId(invocationId)
  for (const row of rows) {
    if (row.type !== 'permission.requested') {
      continue
    }
    try {
      const payload = JSON.parse(row.brokerEventJson) as PermissionRequestedPayload
      if (payload.permissionRequestId === permissionRequestId) {
        return { payload, time: row.time }
      }
    } catch {
      // Ignore unparseable rows; fall through to the default-decision path.
    }
  }
  return undefined
}
